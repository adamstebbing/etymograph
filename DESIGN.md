# Etymograph — Design Document

A 3D etymology explorer with a **layered, time-ordered layout**. Vertical
position encodes language era: proto- and ancient languages sit at the top,
modern languages at the bottom, so every graph reads as a descent through time.

The default view is a graph of language-to-language influence in which each
**language family is its own vertical column**, languages stacked by era within
it; inheritance flows straight down a column, borrowings cross between columns,
and edge thickness scales with influence volume. When a user searches a word,
the graph rebuilds to show that word's etymological neighborhood — its roots,
its ancestors, the languages it was borrowed into and out of, and every
same-meaning cognate — laid out on the same vertical era axis. Nodes expand on
click and collapse when clicked again.

This document is the build spec. The companion `DEPLOYMENT.md` covers running the
pipeline and deploying.

> **Revision note (v2).** Sections 4–7 and 10 were revised after first deploy to
> add: a curated language-**era** axis driving vertical layout; family-column
> arrangement in the default view; weighted (thickness-scaled) influence edges;
> a **two-hop** search neighborhood so sibling cognates under a shared ancestor
> appear immediately; **collapse-on-re-click**; and a **language filter** on
> search. The original single-web force layout is replaced by an era-locked
> layout. See section 11 for the layout model in full.

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

### Dataset realities (confirmed against the Dec 2023 file)

- `lang` holds full language **names** ("Latin", "English", "Ancient Greek"), not
  ISO codes. Node ids, the influence matrix, the family map, and the era map all
  key on names.
- The data contains a `has_root` reltype not listed among the 31 above; it is
  mapped to the `derived` class.
- Two derived attributes are attached to every term during preprocessing and
  drive layout: **`family`** (language family, for color and for the default
  view's columns) and **`era_rank`** (an integer era level, for vertical
  position — see section 11).

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
5. **Assign families and eras.** Join `lang` against the bundled `data/lang_families.csv`, which carries one row per language with `family`, `era_rank`, and `era_label` columns (see section 11 for the era scheme). Long-tail languages fall back to `family = Unknown` and an era inferred from name prefixes (`Proto-…`, `Old …`, `Middle …`, `Ancient …`), defaulting to the modern level. Store `family` and `era_rank` on every term.
6. **Build the influence matrix.** For the top ~40 languages by edge count, aggregate directed edge counts per `(lang, related_lang, reltype_class)`. Languages outside the top 40 are bucketed as `Other`. Each language entry in `influence.json` carries `family`, `era_rank`, and a `column` index (its family's horizontal slot) so the default view can place it without extra lookups. Write to `data/influence.json`.
7. **Index and emit.** Create the SQLite indexes (section 5), `VACUUM`, and report final file size.
8. **Build the compact web DB (separate script).** `scripts/build_web_db.py` reads the full DB and emits the pruned, in-browser SQLite the static site ships. See section 7 and `DEPLOYMENT.md` for the coverage/size tradeoff and the gzip packaging that keeps it under GitHub Pages' 100 MB/file limit.

### Size management
The full edge set is ~1 GB (measured), well over D1's free-tier size — the original 270–400 MB estimate was wrong (SQLite stores text uncompressed and the indexes add overhead). The static path therefore ships a pruned subset; the Cloudflare path needs `--min-degree` pruning or Workers Paid. The pipeline takes `--max-langs` and `--min-degree`; `build_web_db.py` takes a curated language set and a `--min-degree` floor. The decision point is documented in `DEPLOYMENT.md`.

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
    family    TEXT,                    -- language family (column + color)
    era_rank  INTEGER                  -- vertical era level (0 = oldest/top)
);

CREATE INDEX idx_edges_term         ON edges(term_id);
CREATE INDEX idx_edges_related      ON edges(related_term_id);
CREATE INDEX idx_terms_term         ON terms(term);
CREATE INDEX idx_terms_term_lang    ON terms(term, lang);
CREATE INDEX idx_terms_term_nocase  ON terms(term COLLATE NOCASE);
```

Search resolves a typed word against `terms.term` (case-folded), optionally constrained by `lang`, returning matching `term_id`s. Neighborhood expansion reads `edges` in both directions for a given `term_id`. `family` and `era_rank` ride along on every term node so the frontend lays it out and colors it without a second query.

---

## 6. The Worker API

Base path `/api`. All responses JSON, with CORS allowing the GitHub Pages origin. All responses cached at the edge where the input is stable.

### `GET /api/influence`
Returns the prebuilt language-influence matrix. Loaded once on first paint. Each language carries the attributes the default view needs to place it: `family` (its column group), `era_rank` (its vertical level), and `column` (the family's horizontal slot, assigned in the prebuild).

```json
{
  "languages": [
    { "id": "English", "name": "English", "family": "Germanic", "era_rank": 5, "column": 0 },
    { "id": "Middle English", "name": "Middle English", "family": "Germanic", "era_rank": 4, "column": 0 }
  ],
  "edges": [
    { "source": "Middle English", "target": "English", "reltype_class": "inherited", "weight": 15829 },
    { "source": "Latin", "target": "English", "reltype_class": "borrowed", "weight": 8123 }
  ]
}
```

### `GET /api/word?q=<term>&lang=<optional>`
Resolves the search term and returns its etymological neighborhood. To satisfy "show every same-meaning cognate" up front, the walk is **two hops along ancestry**: the matched term(s), their direct neighbors, and — crucially — the *other children of any shared ancestor* reached on the first hop. That second hop is what surfaces sibling cognates (e.g. for `knife`, German *Knifte* / Swedish *kniv* / Danish *kniv* hanging off Proto-Germanic `*knībaz`) without the user having to expand the ancestor by hand.

If `lang` is given, only term nodes in that language seed the walk (the search box exposes this as a language filter; see section 7). If `lang` is omitted and the term exists in several languages, all matching nodes seed it and link to their shared ancestors.

```json
{
  "query": "knife",
  "nodes": [
    { "id": "<id>", "term": "knife",   "lang": "English",         "family": "Germanic", "era_rank": 5, "depth": 0 },
    { "id": "<id>", "term": "knyf",    "lang": "Middle English",  "family": "Germanic", "era_rank": 4, "depth": 1 },
    { "id": "<id>", "term": "cnīf",    "lang": "Old English",     "family": "Germanic", "era_rank": 3, "depth": 1 },
    { "id": "<id>", "term": "*knībaz", "lang": "Proto-Germanic",  "family": "Germanic", "era_rank": 1, "depth": 2 },
    { "id": "<id>", "term": "Knifte",  "lang": "German",          "family": "Germanic", "era_rank": 5, "depth": 2 }
  ],
  "links": [
    { "source": "<knife>", "target": "<cnīf>",    "reltype": "inherited_from", "reltype_class": "inherited" },
    { "source": "<knife>", "target": "<*knībaz>", "reltype": "derived_from",   "reltype_class": "derived"   },
    { "source": "<Knifte>","target": "<*knībaz>", "reltype": "inherited_from", "reltype_class": "inherited" }
  ]
}
```

Node `id` is the dataset `term_id`. `era_rank` drives vertical position; `depth` (hops from the query) is retained for camera framing and dimming. The two-hop fan-out is bounded: only ancestor nodes (those reached by an inherited/derived/root edge) are re-expanded on the second hop, and the total node count is capped so a single query stays cheap against D1's per-query limits.

### `GET /api/expand?id=<term_id>`
Returns the immediate (one-hop) neighbors of one term, for click-to-expand. Same node/link shape as `/api/word`, every node carrying `family` and `era_rank`. The frontend merges results into the existing graph, deduping by node id, and remembers which nodes a given expansion introduced so it can **collapse** them on re-click (section 7).

### Query semantics
- `/api/word` walks two hops along ancestry (capped); `/api/expand` walks one hop. Both are index-backed.
- Term matching is case-insensitive on a normalized column; the optional `lang` is matched exactly. Diacritics are preserved.

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

### Layout engine — era-locked positioning
The graph stays 3D (`3d-force-graph`), but **the Y axis is pinned, not simulated.** Each node's `fy` (fixed y) is set from its `era_rank` so it cannot drift vertically: `fy = (MAX_ERA − era_rank) * LEVEL_GAP`, putting era 0 (proto/root) at the top and the modern era at the bottom. The force engine is left free on X and Z, so nodes spread organically *within* their level. In the default view, X is also pinned per node to its family `column` (`fx = column * COLUMN_GAP`), producing discrete family columns; Z stays free. In the search view, X/Z are free (only Y is locked), so a word's tree settles naturally under its era bands. See section 11 for the era model.

### Default view — family columns, era-stacked
On load, `main.js` calls `/api/influence` and renders the language nodes as **one column per family**, languages stacked by era within the column (proto/old at top → modern at bottom). Edges:
- **Inheritance** (`inherited`/`derived`/`root`) runs mostly vertically *within* a column — e.g. Middle English → Modern English.
- **Borrowing**/**cognate** edges cross *between* columns — e.g. Latin → English, French → English.
- **Thickness scales with influence weight**, log-scaled since counts span orders of magnitude, so the strongest line into Modern English (from Middle English) is the thickest, French/Latin medium, Greek thin. Brightness/opacity track weight too.

A column header labels each family. This replaces the old undifferentiated "web".

### Search view — the word's etymology, leveled
A search box issues `/api/word` (with the optional language filter, below). The graph clears and rebuilds with the matched term at the bottom (its era level) and ancestors rising level by level to the root at top. Rules:
- Vertical position is the term's `era_rank` (curated era table — section 11). Modern English `knife` at the bottom; Middle English a level up; Old English / Old Norse on the "Old" level; Proto-Germanic above; Proto-Indo-European at the top.
- **`etymologically_related_to` terms in the same language share a level** (they are siblings, not ancestors), so two Proto-Germanic forms related to each other sit side by side on the same band.
- The two-hop walk means **sibling cognates appear immediately** (German, Swedish, Danish forms under the shared Proto-Germanic ancestor), each placed on its own era level.
- The camera frames the new graph top-to-bottom.

#### Same-level tiebreaker (knife nuance)
Because the era table is the single source of vertical truth, Old English and Old Norse land on the *same* level (both "Old"), whereas the motivating example sketched Old Norse just above Old English (it being the source of the English form). As a refinement, within one era level a node that is the **source** of another currently-visible node is nudged a small fraction of a level upward, so a derived-from chain still reads top-to-bottom without breaking the era banding. This is cosmetic and bounded to less than one level gap.

### Language filter
The search supports constraining to one language (the `lang` param), matching the "filter on term=knife and lang=English" workflow:
- Typing a bare word searches all languages.
- A small language selector (populated from the distinct languages a term matches, or accepting `word @ Language` / `word/Language` shorthand in the box) pins results to one language. Clearing it returns to all-languages.

### Expansion and collapse
Clicking an un-expanded node calls `/api/expand`, merges the one-hop neighbors in (deduped by id), and **records the set of node and link ids that expansion introduced**. Clicking the same node again **collapses** it: the recorded nodes/links are removed, *except* any node that is still anchored — i.e. also reachable from the original search seeds or from another still-expanded node — so shared ancestors and the search core never disappear. A node toggles between expanded and collapsed on each click; its marker reflects state. Re-expanding refetches only if the cache was dropped.

### Color toggle
A control switches between two modes, recoloring in place with no network call (both attributes ship on every node/link):
- **Relation type** — links colored by `reltype_class`: inherited, borrowed, derived, root, cognate.
- **Language family** — nodes colored by `family`.

A legend updates with the active mode. (Family color and family column are consistent, so the default view is legible in either mode.)

### Other UI
- Hover shows term, language, era, and relation.
- A reset control returns to the influence view.
- Loading and empty states (a searched term with no matches says so plainly).
- Mobile: the graph is usable on touch; the control panel collapses.

### Design language
Follow a dark, low-chrome aesthetic so the graph carries the screen. Use a restrained categorical palette with enough separation for the five relation classes and the language families. Keep typography to one clean sans for UI and a mono accent for term/language codes. Subtle horizontal era bands (faint gridlines or labels at the left edge) help the eye read the vertical time axis.

---

## 8. Repository layout

```
/
├── index.html
├── main.js
├── styles.css
├── lib/
│   ├── 3d-force-graph.min.js
│   ├── three.min.js
│   ├── sqljs/                    # sql.js wasm for the static path
│   └── (gzip inflater)           # e.g. fflate, for the .gz web DB
├── data/
│   ├── influence.json            # generated; languages carry family+era_rank+column
│   ├── lang_families.csv         # curated: lang -> family, era_rank, era_label
│   └── etymology-web.sqlite.gz   # generated; pruned in-browser DB (gzipped)
├── scripts/
│   ├── preprocess.py             # dataset -> full SQLite + influence.json
│   └── build_web_db.py           # full SQLite -> pruned + gzipped web DB
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

## 10. Resolved decisions

- **DB size — corrected.** The full built database is **~1 GB** (measured), not the 270–400 MB first estimated, so it does *not* fit D1's 500 MB free tier. The default site uses the **static** path (a pruned in-browser SQLite); the Cloudflare path needs `--min-degree` pruning or Workers Paid.
- **Static DB packaging.** To carry a richer (looser-pruned) subset while staying under GitHub Pages' 100 MB/file limit, the web DB is **gzipped** (`etymology-web.sqlite.gz`) and inflated in the browser before handing it to sql.js. Target the committed `.gz` under ~90 MB; if even that overflows, split into shards or fall back to Cloudflare.
- **Top-language cutoff.** ~40 for the influence view, by edge-count ranking. The static web DB uses a curated ~46-language set (section 7 / `DEPLOYMENT.md`).
- **Family / era map coverage.** The bundled map covers the top languages; long-tail languages fall back to `family = Unknown` and a prefix-inferred era. Acceptable.
- **Leveling model.** A single curated **era table** drives vertical position in both views (see section 11), with a bounded same-level tiebreaker for ancestry chains (section 7).

---

## 11. Layout model — eras and family columns

The whole visual language hangs on two per-language attributes computed in
preprocessing and carried on every node: **`era_rank`** (vertical) and
**`family` → `column`** (horizontal, default view).

### Era ranks

`era_rank` is a small integer; **lower = older = higher on screen.** A single
curated table in `data/lang_families.csv` assigns it per language, with a
prefix-based fallback for the long tail. The scheme:

| rank | era | examples |
|---|---|---|
| 0 | Family root proto | Proto-Indo-European, Proto-Uralic, Proto-Turkic |
| 1 | Branch proto | Proto-Germanic, Proto-Italic, Proto-Slavic, Proto-Celtic, Proto-Hellenic, Proto-Indo-Iranian |
| 2 | Ancient / classical | Latin, Ancient Greek, Sanskrit, Gothic, Old Church Slavonic, Avestan, Old Persian |
| 3 | Old / early-medieval | Old English, Old Norse, Old French, Old High German, Old Irish |
| 4 | Middle / medieval | Middle English, Middle French, Middle High German, Middle Dutch |
| 5 | Modern | English, German, French, Spanish, Russian, Hindi, … |

Fallback when a language isn't in the table: name starting `Proto-…` → 1
(or 0 if it is a top family proto such as `Proto-Indo-European`), `Ancient …` → 2,
`Old …` → 3, `Middle …` → 4, otherwise 5. The curated table overrides the
fallback wherever the prefix would mislead (e.g. `Latin` has no prefix but is era
2; `Vulgar/Late/Medieval/New Latin` stay era 2 alongside it; `Old Church
Slavonic` is era 2 not 3).

Frontend mapping: `fy = (MAX_ERA − era_rank) * LEVEL_GAP`. Optional left-edge
labels/bands annotate each rank.

**Known simplification (accepted):** because era is by language, contemporaries
across a single era share a level — Old English and Old Norse both at rank 3 —
even though a specific word's chain may derive one from the other. The
same-level source-nudge tiebreaker (section 7) recovers readability for the
common ancestry-chain case without splitting eras per word.

### Family columns

In the default view each `family` occupies a horizontal slot. The prebuild sorts
families (by total edge volume, descending) and assigns each a `column` index;
`influence.json` carries it per language so the frontend sets
`fx = column * COLUMN_GAP`. Within a column, languages float free on Z and are
pinned on Y by era, so a column reads as that family's timeline. Borrowing and
cognate edges crossing columns visualize cross-family influence; their thickness
encodes weight.

In the **search view** families are *not* forced into columns (a single word
rarely spans enough families to warrant it); only the era Y-lock applies, and
nodes are colored by family in family mode. This keeps a word's tree compact
while preserving the time axis.
