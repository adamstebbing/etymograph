# Etymograph

A 3D etymology explorer with a **layered, time-ordered layout**: vertical
position encodes language era (proto/old at the top, modern at the bottom). The
default view arranges each **language family as its own column**, stacked by era,
with edge thickness scaling to influence volume. Search a word and the graph
rebuilds around its etymology on the same era axis — roots, ancestors,
borrowings, and same-meaning cognates (a two-hop walk surfaces sibling cognates
up front). Nodes **expand on click and collapse on re-click**; a language filter
narrows a search; two color modes (relation type / language family) toggle
without refetching.

See [`DESIGN.md`](DESIGN.md) for the full spec, [`DEPLOYMENT.md`](DEPLOYMENT.md)
for the deploy guide, and [`TODO.md`](TODO.md) for the v0.2 change log.

## How it works

The frontend is static (vanilla JS, no build step) and runs on GitHub Pages. It
supports **two interchangeable data sources**, selected by one constant
(`DATA_SOURCE`) in [`main.js`](main.js):

| Mode | Backend | Coverage | Cost |
|---|---|---|---|
| **`static`** (default) | none — a pruned SQLite queried in-browser with [sql.js](https://github.com/sql-js/sql.js) | curated language set (~50 langs), well-connected terms | free, works on plain Pages |
| **`api`** | Cloudflare Worker + D1 ([`worker/`](worker/)) | the full 3.8M-edge dataset | Cloudflare free tier* |

\* The full database builds to **~1 GB**, which is over D1's 500 MB free cap, so
the `api` path needs `--min-degree` pruning (or Workers Paid) to fit. See
[Data sizes](#data-sizes). The default `static` mode needs none of this.

```
GitHub Pages (static frontend)
  ├─ static mode → data/etymology-web.sqlite.gz  (inflated in-browser, queried via sql.js)
  └─ api mode    → Cloudflare Worker → D1 (SQLite at the edge)
        both serve data/influence.json for the default view
```

## Quickstart (static, fully local)

```bash
# 1. Get the dataset (not committed; ~134 MB):
#    https://github.com/droher/etymology-db  ->  etymology.csv.gz

# 2. Build the full DB + influence.json (languages carry family/era/column):
python scripts/preprocess.py --input etymology.csv.gz

# 3. Build the compact, gzipped in-browser DB the static site ships:
python scripts/build_web_db.py --full build/etymology.sqlite \
    --out data/etymology-web.sqlite --min-degree 3 --gzip

# 4. Serve the site:
python -m http.server 8000
# open http://localhost:8000
```

`influence.json` and `etymology-web.sqlite.gz` (both under `data/`) are the only
data files the static site needs; both are committed so Pages can serve them.
The browser inflates the `.gz` with [fflate](https://github.com/101arrowz/fflate)
before handing it to sql.js, which keeps the committed file under Pages'
100 MB/file limit while shipping a richer slice.

## Deploying to GitHub Pages

Push the repo, then **Settings → Pages → Source = GitHub Actions**. The included
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the repo
root on every push to `main`. All asset paths are relative, so the site works
under the `/<repo>/` project subpath.

## Enabling full-dataset search (optional, Cloudflare)

Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) sections 3–6 to create D1, import the
database, and deploy the Worker. Then in [`main.js`](main.js) set:

```js
const DATA_SOURCE = "api";
const API_BASE = "https://etymograph-api.<subdomain>.workers.dev/api";
```

and set the Worker's `ALLOWED_ORIGIN` to your Pages URL.

## Data sizes (measured on the Dec 2023 release)

| Artifact | Size | Notes |
|---|---|---|
| `etymology.csv.gz` (input) | ~134 MB | not committed |
| `build/etymology.sqlite` (full) | **~1.0 GB** | full 3.8M edges + indexes; for the D1 path (needs pruning to fit the 500 MB free cap); gitignored |
| `data/etymology-web.sqlite.gz` (static) | see build output | pruned to a curated ~46-language set + `--min-degree 3`, gzipped; committed and inflated in-browser. Kept under Pages' 100 MB/file limit |
| `data/influence.json` | ~250 KB | 40 languages + `Other`; languages carry `family`, `era_rank`, `column` |

> **Note on DESIGN.md's estimate.** DESIGN.md §10 predicted a 270–400 MB built
> database that would fit D1's free tier. The actual build is ~1 GB (SQLite
> stores text uncompressed and the five indexes add overhead), so the full
> dataset does **not** fit the free tier as written — hence the pruned `static`
> default. The `api` path is fully implemented but needs `--min-degree` pruning
> or Workers Paid to host the full set.

## Dataset notes

The `lang` column holds full language **names** ("Latin", "English", "Ancient
Greek"), not ISO codes as some DESIGN.md JSON examples imply, so node ids and the
influence matrix key on names. Structural `group_*` rows are resolved (dropped)
during preprocessing; every surviving edge is a directed `term → related_term`
relationship. A `has_root` reltype present in the data but not listed in
DESIGN.md §2 is mapped to the `derived` class.

## Vendored libraries (pinned)

No CDN at runtime; minified libraries live in [`lib/`](lib/):

| Library | Version | Use |
|---|---|---|
| [3d-force-graph](https://github.com/vasturiano/3d-force-graph) | 1.73.4 | WebGL force graph (bundles its own Three.js) |
| [three](https://github.com/mrdoob/three.js) | 0.149.0 | vendored for reference |
| [sql.js](https://github.com/sql-js/sql.js) | 1.10.3 | in-browser SQLite for `static` mode |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.2 | inflates the gzipped web DB in the browser |

## Attribution

Data from [**droher/etymology-db**](https://github.com/droher/etymology-db),
derived from [Wiktionary](https://www.wiktionary.org/) and licensed
[**CC BY-SA 3.0**](https://creativecommons.org/licenses/by-sa/3.0/). Any
redistributed slice of the data (including `data/etymology-web.sqlite.gz` and
`data/influence.json`) remains under CC BY-SA 3.0. The code in this repository is
under the MIT License (see [`LICENSE`](LICENSE)).
