# Etymograph — v2 redesign TODO

Changes agreed after the first deploy review. They turn the single-web layout
into an **era-leveled, family-columned** layout, add **collapse-on-re-click**, a
**language filter**, a **two-hop** search neighborhood, and a **looser, gzipped**
static DB. Specs: `DESIGN.md` §6, §7, §11; `DEPLOYMENT.md` §2, §2b, §4, §7.

Decisions locked (from review):
- Vertical level = **one curated era table everywhere** (not per-word chain depth).
- Default view = **family columns, era-stacked**.
- Rendering = **3D with Y locked to era level** (and X locked to family column in the default view).
- Coverage = **two-hop search + looser web-DB pruning**.

Legend: `[ ]` todo · `[~]` partial/decision-needed.

---

## 1. Data & curated era table

- [ ] **Extend `data/lang_families.csv`** to `lang,family,era_rank,era_label`
      (currently `lang,family`). Fill `era_rank` per DESIGN.md §11:
      0 family-root proto · 1 branch proto · 2 ancient/classical ·
      3 old · 4 middle · 5 modern. Cover at least every language in the
      `build_web_db.py` curated set plus the influence top-40.
- [ ] Decide `era_label` strings (for left-edge band labels): e.g.
      `Proto (root)`, `Proto`, `Ancient`, `Old`, `Middle`, `Modern`.

## 2. `scripts/preprocess.py`

- [ ] Load `lang_families.csv` with the new columns; build a
      `lang -> (family, era_rank)` map.
- [ ] **Prefix fallback for era** when a lang isn't in the table:
      `Proto-Indo-European`/top-family protos → 0; other `Proto-…` → 1;
      `Ancient …` → 2; `Old …` → 3; `Middle …` → 4; else → 5.
- [ ] Add `era_rank INTEGER` to the `terms` table; populate it alongside `family`.
- [ ] **`influence.json`:** add `era_rank` to each language, and a `column`
      index per family (sort families by total edge volume desc, assign 0..N).
      Keep `family`. (Shape in DESIGN.md §6.)
- [ ] Keep `--out-sql` optional for the D1 path.

## 3. `scripts/build_web_db.py`

- [ ] Carry `era_rank` into the web `terms` table (currently copies
      `term_id,term,lang,family` — add `era_rank`).
- [ ] Lower default `--min-degree` from 6 → **3** (target richer coverage; see
      size note below) and confirm the curated language list still covers the
      cognate languages users will hit (German, Dutch, Swedish, Danish, etc.).
- [ ] **Add `--gzip`**: after VACUUM, write `data/etymology-web.sqlite.gz`
      (and optionally delete the uncompressed file). Print both sizes.
- [ ] Verify committed `.gz` is **< ~90 MB** (Pages 100 MB/file hard limit).
      If over: raise `--min-degree`, trim the language set, or shard.

## 4. `worker/` (Cloudflare path — keep parity)

- [ ] `schema.sql`: add `era_rank INTEGER` to `terms`.
- [ ] `src/index.js`: include `era_rank` in node objects from `/api/word` and
      `/api/expand`.
- [ ] **Two-hop `/api/word`:** after the one-hop neighborhood, take the ancestor
      nodes reached via `inherited`/`derived`/`root` edges and pull *their*
      children too (the sibling-cognate fan-out), capped at a max node count.
- [ ] Keep `/api/expand` one-hop.
- [ ] Confirm queries stay index-backed and under the 50-query/invocation limit.

## 5. Frontend — data layer (`main.js`)

- [ ] **`StaticSource.init`:** fetch `etymology-web.sqlite.gz`, inflate with a
      vendored gzip lib (see §8) before `new SQL.Database(...)`.
- [ ] Add `era_rank` to every node the static queries build.
- [ ] **Two-hop static `word()`:** mirror the Worker — one-hop neighborhood,
      then expand ancestor nodes one more hop, dedup, cap node count.
- [ ] Thread an optional `lang` through `word()` (already half-wired) and expose
      it to the UI (§7).

## 6. Frontend — layout engine (`main.js`)

- [ ] **Era Y-lock:** set each node's `fy = (MAX_ERA - era_rank) * LEVEL_GAP`.
      Use 3d-force-graph's fixed-coordinate support (`node.fy`), recompute on
      every graphData rebuild and on merge/collapse.
- [ ] **Default view — family columns:** also set `fx = column * COLUMN_GAP`
      from the influence `column`; leave Z free. Add per-column family headers.
- [ ] **Search view:** lock Y only (X/Z free).
- [ ] **Weighted edges:** `linkWidth` ∝ log(weight) for influence edges so
      Middle→Modern English is thickest, French/Latin medium, Greek thin;
      brightness/opacity track weight.
- [ ] **Same-level tiebreaker:** within an era band, nudge a node that is the
      *source* of another visible node up by `< LEVEL_GAP` (recovers the
      knife ON-above-OE reading without breaking bands).
- [ ] Optional: faint horizontal era bands / left-edge era labels.

## 7. Frontend — interaction (`main.js`, `index.html`, `styles.css`)

- [ ] **Collapse-on-re-click:** on expand, record the node+link ids introduced;
      on re-click of an expanded node, remove them **except** nodes still
      anchored to the search seeds or another expanded node. Toggle the node's
      expanded/collapsed marker each click.
- [ ] **Language filter UI:** a selector that appears when a term matches
      multiple languages (and/or `word @ Language` shorthand parsing in the
      box). Empty = all languages; passes `lang` to `word()`.
- [ ] Hover/label: add **era** (and keep term, language, relation).
- [ ] Legend/affordances unchanged; ensure family color ↔ family column stay
      consistent.

## 8. Vendored libs & packaging

- [ ] Vendor a small gzip inflater into `lib/` (e.g. **fflate** UMD, ~?KB) and
      load it in `index.html` before `main.js`.
- [ ] Commit `data/etymology-web.sqlite.gz`; **remove** the uncommitted/old
      `data/etymology-web.sqlite` from the repo (keep it gitignored as a build
      artifact). Update `.gitignore`/`.gitattributes` accordingly.
- [ ] README: bump the libs table (add fflate + version) and the data-sizes
      table (gzipped web DB).

## 9. Verification (Preview tool + curl)

- [ ] Default view renders as columns stacked by era; thick Middle→Modern
      English line; thin Greek line.
- [ ] `knife` (lang=English) shows the chain English→Middle→Old + Old Norse,
      Proto-Germanic (two related forms same level), PIE at top, **and** German
      / Swedish / Danish sibling cognates without manual expand.
- [ ] Expand a node, then click again → its subtree collapses; shared ancestors
      remain.
- [ ] Language filter narrows results.
- [ ] Color toggle still instant; no-match state clean.
- [ ] Live `.gz` asset serves and inflates in-browser (check first bytes +
      console for sql.js load).

## 10. Ship

- [ ] Rebuild artifacts, commit, push to `main` (Pages auto-deploys).
- [ ] Re-run the DEPLOYMENT.md §9 end-to-end checklist on the live URL.

---

### Open sub-decisions to confirm while implementing
- **`--min-degree 3` size:** if the gzipped web DB exceeds ~90 MB, do we raise
  the floor (less coverage) or shard the file? (Default plan: raise the floor.)
- **Two-hop cap:** node ceiling for `/api/word` before it stops fanning out
  (proposal: ~250 nodes) to keep big hubs like Latin/PIE from exploding.
- **Tiebreaker scope:** apply the same-level source-nudge in the default view
  too, or search view only? (Proposal: search view only.)
