# Etymograph — Deployment Guide

This guide takes the project from a fresh clone to a live site: GitHub Pages frontend, Cloudflare Worker API, Cloudflare D1 database. Read `DESIGN.md` first for the architecture and component spec.

The flow is: process the dataset into a SQLite file → load it into D1 → deploy the Worker → deploy the frontend to Pages → wire them together.

---

## 0. Prerequisites

The **default static deployment needs only Python + a GitHub account.** Node,
Wrangler, and Cloudflare are required *only* for the optional full-dataset API
path (sections 3–6).

- **Python 3.10+** with `pip`. *(required)*
- **A GitHub account** with the repo pushed. *(required)*
- **Node.js 18+** — *optional*, Cloudflare path only (Wrangler needs 16.17+).
- **A Cloudflare account** — *optional*, Cloudflare path only; see the size constraint in section 4.
- **The dataset file** from `github.com/droher/etymology-db` (the Parquet file, or the gzipped CSV). It's linked from the repo README and hosted on OneDrive. Download it manually; it isn't in the repo.

Install Wrangler:

```bash
npm install -g wrangler
wrangler login
```

---

## 1. Clone and inspect

```bash
git clone https://github.com/<you>/etymograph.git
cd etymograph
```

Place the downloaded dataset somewhere outside the repo (it's large; don't commit it). Note its path for the next step.

---

## 2. Run the preprocessing pipeline

The build is **two steps**: `preprocess.py` turns the raw dataset into the full
SQLite + the influence matrix; `build_web_db.py` then derives the compact,
gzipped in-browser database the static site ships.

`scripts/preprocess.py` produces:
- `build/etymology.sqlite` — the full database (also the source for both the D1 path and the web DB). Add `--out-sql build/etymology.sql` for the D1 import file.
- `data/influence.json` — the influence matrix; each language carries `family`, `era_rank`, and `column` for the family-column default view.

It reads `data/lang_families.csv`, which is curated and carries one row per
language with `family`, `era_rank`, and `era_label` (see DESIGN.md section 11 for
the era scheme). Keep that file up to date when adding languages.

```bash
pip install -r scripts/requirements.txt   # only pyarrow, and only for Parquet input
python scripts/preprocess.py \
    --input etymology.csv.gz \
    --out-sqlite build/etymology.sqlite \
    --out-influence data/influence.json \
    --max-langs 40
```

When it finishes it prints the resulting database size. **Measured reality: the
full DB is ~1 GB**, not the 270–400 MB originally estimated — SQLite stores text
uncompressed and the indexes add overhead. That is over D1's 500 MB free cap, so
the full dataset is **not** free-tier-ready without pruning (section 4). The
default deploy uses the static path below, which does its own pruning.

### 2b. Build the static web database (default path)

`scripts/build_web_db.py` reads the full DB and writes a pruned SQLite limited to
a curated language set and a minimum term degree, then **gzips it** so the
committed file stays under GitHub Pages' 100 MB/file limit while carrying a
richer slice (the browser inflates it before handing it to sql.js).

```bash
python scripts/build_web_db.py \
    --full build/etymology.sqlite \
    --out data/etymology-web.sqlite \
    --min-degree 3 \
    --gzip                       # emits data/etymology-web.sqlite.gz
```

Lower `--min-degree` and a larger language set widen coverage (more low-degree
cognates like German *Knifte* survive) at the cost of size. Watch the printed
sizes: target the **committed `.gz` under ~90 MB**. `--min-degree 3` is the
current target; raise it if the gz overflows, lower it (toward 2) if you have
headroom. Commit `data/etymology-web.sqlite.gz`, not the uncompressed file.

> Coverage note: even with looser pruning, sibling cognates that hang off a
> shared ancestor surface at search time only because `/api/word` (and the
> static query that mirrors it) walks **two hops** along ancestry — see DESIGN.md
> section 6. Pruning controls which *direct* edges survive; the two-hop walk
> controls how many *siblings* you see without expanding by hand.

---

## 3. Create the D1 database

```bash
cd ../worker
wrangler d1 create etymograph
```

This prints a database binding block with a UUID. Put it in `worker/wrangler.toml`:

```toml
name = "etymograph-api"
main = "src/index.js"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "etymograph"
database_id = "<the-uuid-from-the-create-command>"
```

Create the schema, locally first, then remote:

```bash
# local (for testing)
wrangler d1 execute etymograph --local --file=./schema.sql

# remote (production)
wrangler d1 execute etymograph --remote --file=./schema.sql
```

---

> **The Cloudflare path (sections 3–6) is optional.** The default deployment is
> the static path (section 2b → section 8). Do these sections only if you want
> full-dataset coverage behind the Worker API.

## 4. Load the data — and the plan decision

**Corrected plan: the full dataset does NOT fit the free tier.** On the Cloudflare **free** plan a single D1 database is capped at **500 MB**, a Worker runs at most **50 queries per invocation**, and the account allows **~150M row reads per month**. The full built DB is **~1 GB** (measured — see section 2), roughly double the free cap. So one of:

- **Prune to fit free tier.** Rebuild a reduced full DB with `--min-degree` until it lands under 500 MB, accepting the long-tail loss:
  ```bash
  python scripts/preprocess.py --input etymology.csv.gz \
      --out-sqlite build/etymology.sqlite --out-sql build/etymology.sql \
      --out-influence data/influence.json --min-degree 2
  ```
- **Or go Workers Paid** ($5/mo) for a 10 GB cap and 1000 queries/invocation, and load the full ~1 GB DB as-is.

**Confirm against the printed size** before importing. The static path (section 2b) is the no-cost default and needs none of this.

**Import the SQL file** (the `d1 execute` file import limit is 5 GB, which covers both paths):

```bash
# local
wrangler d1 execute etymograph --local --file=../build/etymology.sql

# remote
wrangler d1 execute etymograph --remote --file=../build/etymology.sql
```

For very large imports, the SQL-file route can time out. If it does, use the REST API bulk-import path (`/import`), which is built for large loads — the script `scripts/import_d1.sh` wraps it; supply your account ID and an API token with D1 edit permission.

Verify the load:

```bash
wrangler d1 execute etymograph --remote --command "SELECT COUNT(*) FROM edges;"
```

---

## 5. Develop and test the Worker locally

`worker/src/index.js` implements the three routes (`/api/influence`, `/api/word`, `/api/expand`) from `DESIGN.md`, with CORS. Run it against local D1:

```bash
cd worker
wrangler dev --local
```

Test each route:

```bash
curl "http://localhost:8787/api/influence"
curl "http://localhost:8787/api/word?q=water"
curl "http://localhost:8787/api/expand?id=<a-term_id-from-the-previous-result>"
```

Confirm CORS headers are present and the JSON shape matches the spec. Keep each query indexed; an unindexed scan over millions of rows will blow the row-read budget and may exceed the 50-query free-plan limit if the Worker fans out.

---

## 6. Deploy the Worker

```bash
wrangler deploy
```

This prints the Worker's public URL, something like `https://etymograph-api.<subdomain>.workers.dev`. Copy it; the frontend needs it.

Smoke-test production:

```bash
curl "https://etymograph-api.<subdomain>.workers.dev/api/word?q=water"
```

### CORS
The Worker must allow the Pages origin. Set the allowed origin in the Worker (an env var in `wrangler.toml`, e.g. `ALLOWED_ORIGIN = "https://<you>.github.io"`). For local frontend testing, also allow `http://localhost:<port>`. Avoid a permanent wildcard `*` in production.

---

## 7. Configure the frontend

The frontend picks its data source from one constant in `main.js`:

```js
const DATA_SOURCE = "static";   // "static" (default) | "api"
const API_BASE = "https://etymograph-api.<subdomain>.workers.dev/api";
```

- **`static`** (default): loads `data/influence.json` and inflates
  `data/etymology-web.sqlite.gz` in the browser (vendored gzip inflater + sql.js).
  No backend. This is what GitHub Pages serves.
- **`api`**: points at the Worker from sections 3–6 for full-dataset coverage.
  For local Worker testing set `API_BASE = "http://localhost:8787/api"`.

Both sources return the same node/link shape (every node carrying `family` and
`era_rank`), so the layout, two-hop search, expand/collapse, and color toggle
behave identically either way.

Serve the frontend locally to test:

```bash
python -m http.server 8000      # from repo root; open http://localhost:8000
```

Confirm: the influence graph loads as **family columns stacked by era**; a word
search rebuilds the graph **leveled by era** with sibling cognates present;
clicking a node expands it and **clicking again collapses it**; the language
filter narrows a search; and the relation/family color toggle recolors without a
refetch.

---

## 8. Deploy the frontend to GitHub Pages

The frontend is static files at the repo root, so Pages serves it directly.

**Option A — Pages from branch (simplest).** In the GitHub repo: Settings → Pages → Source = "Deploy from a branch" → Branch = `main`, folder = `/ (root)`. Save. The site publishes at `https://<you>.github.io/etymograph/`.

Because the site lives in a subpath (`/etymograph/`), make sure all asset references in `index.html` are relative (`./main.js`, `./lib/...`), not absolute (`/main.js`). Absolute paths break under a project subpath.

**Option B — GitHub Actions.** `.github/workflows/pages.yml` (included) publishes the root on every push to `main` using the official Pages actions. Enable it under Settings → Pages → Source = "GitHub Actions".

After the first deploy, update the Worker's `ALLOWED_ORIGIN` to the real Pages URL and redeploy the Worker.

---

## 9. End-to-end check

On the live `github.io` URL:

1. Influence graph renders on load as **family columns**, each stacked by era (proto/old at top → modern at bottom), with thicker lines for stronger influence (Middle→Modern English thickest).
2. Search a common word (e.g. "knife", "water", "mother") — graph rebuilds **leveled by era**, the modern term at the bottom and roots rising to the top.
3. Sibling cognates under a shared ancestor (e.g. German/Swedish/Danish forms for "knife") appear **without** a manual expand (two-hop walk).
4. The **language filter** (e.g. term=knife, lang=English) narrows results to one language.
5. Click a node — neighbors merge in; **click it again — they collapse** (shared ancestors stay).
6. Toggle relation-type vs language-family coloring — recolors instantly, no network call.
7. Search nonsense — a clean "no matches" state.

---

## 10. Updating the dataset

When a new `etymology-db` release lands:

1. Download the new file.
2. Update `data/lang_families.csv` if the release adds languages you want columned/leveled.
3. Rerun `preprocess.py` then `build_web_db.py --gzip` (section 2 / 2b).
4. **Static path:** commit the regenerated `data/influence.json` and `data/etymology-web.sqlite.gz` and push; Pages redeploys the frontend.
5. **Cloudflare path (if used):** drop and reload D1:
   ```bash
   wrangler d1 execute etymograph --remote --command "DROP TABLE edges; DROP TABLE terms;"
   wrangler d1 execute etymograph --remote --file=./schema.sql
   wrangler d1 execute etymograph --remote --file=../build/etymology.sql
   ```

---

## 11. Cost and limits summary

| Resource | Free plan | If you outgrow it |
|---|---|---|
| D1 database size | 500 MB | Workers Paid → 10 GB ($5/mo) |
| D1 row reads | ~150M / month | Paid → 25B included, then $0.001/M |
| Worker requests | 100K / day | Paid → higher allowances |
| Queries per Worker invocation | 50 | Paid → 1000 |
| GitHub Pages | Free for public repos | — |

**The default static path runs at no cost** on GitHub Pages alone — no Cloudflare account needed. The full DB is ~1 GB and does **not** fit D1's free 500 MB cap, so the *optional* Cloudflare path requires either `--min-degree` pruning to fit free, or Workers Paid ($5/mo, 10 GB cap). Keep Worker queries indexed so row reads stay low.

---

## 12. Troubleshooting

- **CORS errors in the browser console.** The Worker's allowed origin doesn't match the Pages URL exactly (scheme, subdomain, trailing slash). Fix `ALLOWED_ORIGIN`, redeploy the Worker.
- **Assets 404 on Pages.** Asset paths are absolute; switch to relative paths for the project subpath.
- **`d1 execute` import times out.** Use the REST bulk-import route (section 4).
- **Queries hit the daily read limit.** A query is scanning instead of using an index. Confirm the indexes from `schema.sql` exist: `wrangler d1 execute etymograph --remote --command "PRAGMA index_list(edges);"`.
- **"Database full" on import.** You're over the 500 MB free cap. Prune with `--min-degree` or move to Workers Paid.

---

## Attribution

The dataset is from `github.com/droher/etymology-db`, derived from Wiktionary and licensed **CC BY-SA 3.0**. The site footer and the repo README must credit the dataset and Wiktionary and link the license. Code in this repo can carry your own license; the data and any redistributed slice of it stay under CC BY-SA 3.0.
