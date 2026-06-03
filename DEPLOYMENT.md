# Etymograph — Deployment Guide

This guide takes the project from a fresh clone to a live site: GitHub Pages frontend, Cloudflare Worker API, Cloudflare D1 database. Read `DESIGN.md` first for the architecture and component spec.

The flow is: process the dataset into a SQLite file → load it into D1 → deploy the Worker → deploy the frontend to Pages → wire them together.

---

## 0. Prerequisites

- **Node.js 18+** (Wrangler needs 16.17+; use 18 LTS or newer).
- **Python 3.10+** with `pip`.
- **A Cloudflare account** (free plan works for development; see the size constraint in section 4).
- **A GitHub account** with the repo pushed.
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

`scripts/preprocess.py` reads the dataset and produces two artifacts:
- `build/etymology.sql` (or `build/etymology.sqlite`) — the database for D1.
- `data/influence.json` — the language-influence matrix for the default view.

```bash
cd scripts
pip install -r requirements.txt          # polars, pyarrow, pandas
python preprocess.py \
    --input /path/to/etymology.parquet \
    --out-sql ../build/etymology.sql \
    --out-influence ../data/influence.json \
    --max-langs 40
```

When it finishes it prints the resulting database size. The source file is ~134 MB compressed, so the built database should land around 270–400 MB after table storage and indexes — under the 500 MB free-tier cap. Confirm the printed number is under 500 MB and proceed on the free plan.

Pruning is only a fallback. If the printed size somehow exceeds 500 MB, rerun with:

```bash
python preprocess.py ... --min-degree 2     # drop terms with fewer than 2 relationships
```

`--min-degree` trims the long tail of terms that link to nothing else, which cuts size while keeping well-connected words. The expected path needs no pruning.

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

## 4. Load the data — and the plan decision

**The plan: free tier, full dataset.** On the Cloudflare **free** plan, a single D1 database is capped at **500 MB**, a Worker may run at most **50 queries per invocation**, and the account allows **~150M row reads per month**. The source file is ~134 MB compressed. Loaded into D1 as tables plus indexes it expands (indexes add overhead, and SQLite stores text uncompressed), so expect something in the **270–400 MB** range. That stays under 500 MB, so the free tier covers the full dataset with no pruning.

**Confirm against the printed size.** The pipeline prints the final database size after building (section 2). If it comes in under 500 MB, load it as-is and stay on the free plan. If it somehow lands over 500 MB, prune the long tail with `--min-degree 2` and rebuild until it fits, or move to Workers Paid ($5/mo) for a 10 GB cap and a 1000-query-per-invocation limit. Build for the free tier by default; pruning is a fallback, not the expected path.

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

The frontend reads the API base URL from one constant. In `main.js`:

```js
const API_BASE = "https://etymograph-api.<subdomain>.workers.dev/api";
```

For local testing point it at `http://localhost:8787/api`. Keep this the only place the URL appears so the two environments differ by one line. Serve the frontend locally to test:

```bash
cd ..            # repo root
python -m http.server 8000
# open http://localhost:8000
```

Confirm: the influence graph loads on first paint, a word search rebuilds the graph, clicking a node expands it, and the relation/family color toggle recolors without a refetch.

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

1. Influence graph renders on load.
2. Search a common word (e.g. "water", "night", "mother") — graph rebuilds with roots, ancestors, and cross-language cognates.
3. A word in several languages shows all versions linked to shared ancestors.
4. Click a node — neighbors load and merge in.
5. Toggle relation-type vs language-family coloring — recolors instantly, no network call.
6. Search nonsense — a clean "no matches" state.

---

## 10. Updating the dataset

When a new `etymology-db` release lands:

1. Download the new file.
2. Rerun `preprocess.py` (section 2).
3. Decide whether to recreate the table or replace rows. Simplest is to drop and reload:
   ```bash
   wrangler d1 execute etymograph --remote --command "DROP TABLE edges; DROP TABLE terms;"
   wrangler d1 execute etymograph --remote --file=./schema.sql
   wrangler d1 execute etymograph --remote --file=../build/etymology.sql
   ```
4. Commit the regenerated `data/influence.json` and push; Pages redeploys the frontend.

---

## 11. Cost and limits summary

| Resource | Free plan | If you outgrow it |
|---|---|---|
| D1 database size | 500 MB | Workers Paid → 10 GB ($5/mo) |
| D1 row reads | ~150M / month | Paid → 25B included, then $0.001/M |
| Worker requests | 100K / day | Paid → higher allowances |
| Queries per Worker invocation | 50 | Paid → 1000 |
| GitHub Pages | Free for public repos | — |

The dataset fits the free tier (built database ~270–400 MB against the 500 MB cap), so a personal public project runs at no cost. Keep queries indexed so row reads stay low. Workers Paid ($5/mo) is only relevant if a future dataset release grows past 500 MB.

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
