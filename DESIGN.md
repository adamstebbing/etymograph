# Etymograph — Design Document

A 3D etymology explorer. The default view is a force-directed graph of language-to-language influence (a "heatmap" of borrowing and inheritance volume across ~40 major languages). When a user searches a word, the graph rebuilds to show that word's etymological neighborhood: its roots, its ancestors, the languages it was borrowed into and out of, and every same-meaning cognate across languages. Nodes expand on click.

This document is the build spec. The companion `DEPLOYMENT.md` covers running the pipeline and deploying.

---

## 1. Goals and non-goals

**Goals**
- A public, static frontend on GitHub Pages.
- Full-coverage word lookups backed by the complete `droher/etymology-db` dataset (4.2M relationships, 2M terms, 3300+ languages).
- A default language-influence graph that loads without a search.
- A searched word shows its full immediate neighborhood, expandable node-by-node.
- Two color modes the user toggles between without refetching: by relation type, and by language family.

**Non-goals**
- No user accounts, no saved state, no write operations.
- No attempt to validate or correct Wiktionary's data. The dataset is reproduced as-is.
- No SSR, no framework, no build step on the frontend.

---

## 2. Data source

`github.com/droher/etymology-db`, December 2023 release. Distributed as a gzipped CSV and a Parquet file (hosted on OneDrive, linked from the repo README). Licensed CC BY-SA 3.0; attribution is required and carried in the site footer and repo.

### Source schema (one row per relationship)

| Column | Meaning |
|---|---|
| `term_id` | Hash of term + language. Primary key for a term. |
| `lang` | Language/dialect of the term. |
| `term` | The term (word, prefix, or multi-word expression). |
| `reltype` | Relationship type (see below). |
| `related_term_id` | Hash of the related term + its language. |
| `related_lang` | Language of the related term. NULL for root parent nodes. |
| `related_term` | The related term. NULL for root parent nodes. |
| `position` | Zero-indexed position within a multi-term relation (compounds). |
| `group_tag` | Random ID, set only on root nodes of nested relationships. |
| `parent_tag` | `group_tag` of the immediate parent in a nested structure. NULL otherwise. |
| `parent_position` | Position of the relation inside its nested structure. NULL if flat. |

### Relation types

The 31 `reltype` values fall into groups the frontend collapses for color coding:

- **Inherited** — `inherited_from`.
- **Borrowed** — `borrowed_from`, `learned_borrowing_from`, `semi_learned_borrowing_from`, `orthographic_borrowing_from`, `unadapted_borrowing_from`, `calque_of`, `semantic_loan_of`, `phono-semantic_matching_of`.
- **Derived** — `derived_from`, `has_prefix`, `has_prefix_with_root`, `has_suffix`, `has_suffix_with_root`, `has_confix`, `has_affix`, `compound_of`, `back-formation_from`, `blend_of`, `clipping_of`, `abbreviation_of`, `initialism_of`, `doublet_with`.
- **Root** — `root`.
- **Cognate / related** — `cognate_of`, `etymologically_related_to`, `is_onomatopoeic`, `named_after`.
- **Group nodes** — `group_affix_root`, `group_related_root`, `group_derived_root`. These are structural; the pipeline resolves them rather than rendering them as graph nodes.

A `reltype_class` column (one of `inherited`, `borrowed`, `derived`, `root`, `cognate`) is derived during preprocessing so the frontend never has to map 31 values itself.

---

## 3. Architecture

```
┌─────────────────────────────┐
│ GitHub Pages (static)       │
│  index.html / main.js / css │
│  3d-force-graph + Three.js  │
└──────────────┬──────────────┘
               │  HTTPS + CORS
               ▼
┌─────────────────────────────┐
│ Cloudflare Worker (API)     │
│  GET /api/influence         │
│  GET /api/word              │
│  GET /api/expand            │
└──────────────┬──────────────┘
               │  D1 binding
               ▼
┌─────────────────────────────┐
│ Cloudflare D1 (SQLite)      │
│  edges table + indexes      │
└─────────────────────────────┘
```

The frontend is fully static and deploys to GitHub Pages. Word lookups can't run against millions of rows from static hosting, so a Cloudflare Worker fronts a D1 (edge SQLite) database and answers queries. The Worker and D1 are in the same platform, so there's no egress cost between them. The default influence matrix is small and could be a static JSON, but serving it from the Worker keeps one API surface and lets it be cached at the edge.

### Why this split
- GitHub Pages stays the canonical public URL, which is the stated goal.
- Cloudflare's free tier covers a personal project: Workers allow a large number of free daily requests, and D1 has a free allotment of rows read per day.
- D1 is SQLite, so the same file the pipeline builds runs locally for testing and at the edge in production.

---

## 4. Preprocessing pipeline

`scripts/preprocess.py`, run once per dataset release. Input is the uploaded CSV or Parquet. Outputs are a SQLite database for import into D1 and a small influence-matrix JSON.

### Steps

1. **Load.** Read Parquet (preferred) or gzipped CSV with pandas or polars. Polars handles the row count with less memory; the script supports both and picks polars when available.
2. **Derive `reltype_class`.** Map each of the 31 `reltype` values to its class per the table in section 2.
3. **Resolve group nodes.** Rows with `group_*` reltypes are nested-structure markers. Flatten them so a term links directly to its constituent terms, using `group_tag` / `parent_tag` / `parent_position`. The output graph has no `group_*` nodes.
4. **Build the edges table.** One row per directed relationship: `(term_id, term, lang, reltype, reltype_class, related_term_id, related_term, related_lang, position)`. Drop rows where both related fields are NULL once their root meaning is captured on the parent.
5. **Build the influence matrix.** For the top ~40 languages by edge count, aggregate directed edge counts per `(lang, related_lang, reltype_class)`. Languages outside the top 40 are bucketed as `Other` so totals stay honest. Write to `data/influence.json`.
6. **Assign language families.** Join `lang` against a bundled `lang_families.csv` (built from the repo's `wiktionary_codes.csv` plus a hand-maintained family map for the top languages). Store family on each node for the frontend's family color mode.
7. **Index and emit.** Create the SQLite indexes (section 5), `VACUUM`, and report final file size so we know whether it fits the D1 free tier or needs trimming.

### Size management
The full edge set may exceed D1's free-tier size. The pipeline takes a `--max-langs` and an optional `--min-degree` flag to prune low-connectivity terms. Default build keeps everything and prints the size; if it's over budget, rerun with pruning. The decision point is documented in `DEPLOYMENT.md`.

---

## 5. Database schema (SQLite / D1)

```sql
CREATE TABLE edges (
    term_id          TEXT NOT NULL,
    term             TEXT NOT NULL,
    lang             TEXT NOT NULL,
    reltype          TEXT NOT NULL,
    reltype_class    TEXT NOT NULL,   -- inherited | borrowed | derived | root | cognate
    related_term_id  TEXT,
    related_term     TEXT,
    related_lang     TEXT,
    position         INTEGER
);

CREATE TABLE terms (
    term_id   TEXT PRIMARY KEY,
    term      TEXT NOT NULL,
    lang      TEXT NOT NULL,
    family    TEXT                     -- language family for color mode
);

CREATE INDEX idx_edges_term       ON edges(term_id);
CREATE INDEX idx_edges_related    ON edges(related_term_id);
CREATE INDEX idx_terms_term       ON terms(term);
CREATE INDEX idx_terms_term_lang  ON terms(term, lang);
```

Search resolves a typed word against `terms.term` (case-folded), returning all `term_id`s across languages that match. Neighborhood expansion reads `edges` in both directions for a given `term_id`.

---

## 6. The Worker API

Base path `/api`. All responses JSON, with CORS allowing the GitHub Pages origin. All responses cached at the edge where the input is stable.

### `GET /api/influence`
Returns the prebuilt language-influence matrix. Loaded once on first paint.

```json
{
  "languages": [
    { "id": "en", "name": "English", "family": "Indo-European" }
  ],
  "edges": [
    { "source": "la", "target": "en", "reltype_class": "borrowed", "weight": 18342 }
  ]
}
```

### `GET /api/word?q=<term>&lang=<optional>`
Resolves the search term and returns its full immediate neighborhood: the matching term node(s), every directly related term (both directions), and the relation between them. If `lang` is omitted and the term exists in several languages, all matching term nodes are returned and linked to their shared ancestors, which satisfies the "show all versions across languages" requirement.

```json
{
  "query": "water",
  "nodes": [
    { "id": "en:water", "term": "water", "lang": "en", "family": "Indo-European", "depth": 0 },
    { "id": "ang:wæter", "term": "wæter", "lang": "ang", "family": "Indo-European", "depth": 1 },
    { "id": "ine-pro:*wódr̥", "term": "*wódr̥", "lang": "ine-pro", "family": "Indo-European", "depth": 2 }
  ],
  "links": [
    { "source": "en:water", "target": "ang:wæter", "reltype": "inherited_from", "reltype_class": "inherited" }
  ]
}
```

Node `id` is the `term_id` from the dataset; the `lang:term` strings above are illustrative. `depth` is hops from the query and drives initial layout.

### `GET /api/expand?id=<term_id>`
Returns the immediate neighbors of one term, for click-to-expand. Same node/link shape as `/api/word`. The frontend merges results into the existing graph, deduping by node id.

### Query semantics
- Neighborhood walks are bounded (one hop per call). The frontend grows the graph by calling `/api/expand`, which keeps any single query cheap and predictable against D1's per-query row limits.
- Term matching is case-insensitive on a normalized column. Diacritics are preserved, since they're meaningful in many of these terms.

---

## 7. Frontend

Vanilla JS, no build step, no bundler. Three files plus vendored libraries.

```
/index.html
/main.js
/styles.css
/lib/3d-force-graph.min.js
/lib/three.min.js
/data/        (optional static fallbacks)
```

### Libraries
`3d-force-graph` (which wraps Three.js and a force engine) handles the WebGL graph, camera, and layout. Vendoring the minified files into `/lib` keeps the site dependency-free at runtime and avoids a CDN dependency. Pin exact versions and record them in the README.

### Default view
On load, `main.js` calls `/api/influence` and renders the ~40 language nodes. Edge thickness and brightness scale with influence weight (log-scaled, since counts span orders of magnitude). This is the "heatmap" of cross-language influence.

### Search view
A search box issues `/api/word`. The graph clears and rebuilds around the result. All same-meaning terms across languages appear as distinct nodes linked to shared ancestors. The camera frames the new graph.

### Expansion
Clicking a node calls `/api/expand` and merges the returned neighbors in, so the user grows the neighborhood outward at will. A node already expanded is marked so repeat clicks don't refetch.

### Color toggle
A control switches between two modes, recoloring in place with no network call (both attributes ship on every node/link):
- **Relation type** — links colored by `reltype_class`: inherited, borrowed, derived, root, cognate.
- **Language family** — nodes colored by `family`.

A legend updates with the active mode.

### Other UI
- Hover shows term, language, and relation.
- A reset control returns to the influence view.
- Loading and empty states (a searched term with no matches says so plainly).
- Mobile: the graph is usable on touch; the control panel collapses.

### Design language
Follow a dark, low-chrome aesthetic so the graph carries the screen. Use a restrained categorical palette with enough separation for the five relation classes and the language families. Keep typography to one clean sans for UI and a mono accent for term/language codes.

---

## 8. Repository layout

```
/
├── index.html
├── main.js
├── styles.css
├── lib/
│   ├── 3d-force-graph.min.js
│   └── three.min.js
├── data/
│   ├── influence.json            # generated; also served by Worker
│   └── lang_families.csv         # source for family assignment
├── scripts/
│   └── preprocess.py             # dataset -> SQLite + influence.json
├── worker/
│   ├── src/index.js              # Worker entry, routes, CORS
│   ├── wrangler.toml             # D1 binding, routes
│   └── schema.sql                # table + index DDL
├── .github/workflows/
│   └── pages.yml                 # deploy frontend to Pages
├── DESIGN.md
├── DEPLOYMENT.md
└── README.md
```

---

## 9. Build order for Claude Code

1. `scripts/preprocess.py` and `worker/schema.sql` — the pipeline and schema. Validate against the real uploaded file.
2. `worker/` — the Worker, its routes, CORS, and `wrangler.toml` with the D1 binding. Test locally with `wrangler dev` against a local D1.
3. Frontend — `index.html`, `main.js`, `styles.css`, vendored `lib/`. Test against the local Worker.
4. `.github/workflows/pages.yml` — Pages deploy.
5. `README.md` — attribution, versions, quickstart.

Each stage is testable before the next. The frontend points at a configurable API base URL so local and production differ by one constant.

---

## 10. Open decisions to confirm during build

- **D1 size — resolved.** The source file is ~134 MB compressed; the built database lands around 270–400 MB, under the 500 MB free-tier cap. Build for the free tier with the full dataset. Pruning is a fallback only if a future release grows past the cap.
- **Top-language cutoff.** ~40 is the target for the influence view; the exact set comes from edge-count ranking in the data.
- **Family map coverage.** The bundled family map covers the top languages well; long-tail languages may show as `Unknown` in family color mode, which is acceptable.
