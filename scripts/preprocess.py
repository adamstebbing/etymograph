#!/usr/bin/env python3
"""Etymograph preprocessing pipeline.

Reads the droher/etymology-db release (gzipped CSV or Parquet) and emits:

  * a full SQLite database  (--out-sqlite)        -> import into Cloudflare D1
  * an optional SQL dump     (--out-sql)           -> `wrangler d1 execute --file`
  * the influence matrix     (--out-influence)     -> default GitHub Pages view

The compact in-browser database the static site ships is built separately, from
the full DB this script produces, by scripts/build_web_db.py.

See DESIGN.md sections 2 and 4 for the contract this implements.

The dataset's `lang` column holds full language names ("Latin", "English",
"Ancient Greek"), not ISO codes, so node ids and the influence matrix key on
names. Group-structure rows (reltype `group_*`) carry no related term and are
dropped; every surviving row with a non-null related_term_id is a directed
edge term -> related_term.
"""

import argparse
import csv
import gzip
import json
import os
import sqlite3
import sys
import time

# --- reltype -> reltype_class map (DESIGN.md section 2) ----------------------

RELTYPE_CLASS = {}
for r in ["inherited_from"]:
    RELTYPE_CLASS[r] = "inherited"
for r in ["borrowed_from", "learned_borrowing_from", "semi_learned_borrowing_from",
          "orthographic_borrowing_from", "unadapted_borrowing_from", "calque_of",
          "semantic_loan_of", "phono-semantic_matching_of"]:
    RELTYPE_CLASS[r] = "borrowed"
for r in ["derived_from", "has_prefix", "has_prefix_with_root", "has_suffix",
          "has_suffix_with_root", "has_confix", "has_affix", "has_root", "has_root_with",
          "compound_of", "back-formation_from", "blend_of", "clipping_of",
          "abbreviation_of", "initialism_of", "doublet_with"]:
    RELTYPE_CLASS[r] = "derived"
for r in ["root"]:
    RELTYPE_CLASS[r] = "root"
for r in ["cognate_of", "etymologically_related_to", "is_onomatopoeic", "named_after"]:
    RELTYPE_CLASS[r] = "cognate"

GROUP_RELTYPES = {"group_affix_root", "group_related_root", "group_derived_root"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def human(nbytes):
    for unit in ["B", "KB", "MB", "GB"]:
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024


def open_rows(path):
    """Yield dict rows from a gzipped/plain CSV or a Parquet file."""
    if path.endswith(".parquet"):
        try:
            import pyarrow.parquet as pq
        except ImportError:
            sys.exit("Parquet input needs pyarrow: pip install pyarrow")
        table = pq.read_table(path)
        cols = table.column_names
        for batch in table.to_batches(max_chunksize=50_000):
            d = batch.to_pydict()
            n = len(d[cols[0]])
            for i in range(n):
                yield {c: d[c][i] for c in cols}
        return
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        yield from reader


def norm(v):
    """Empty string / None -> None; everything else stripped of surrounding ws kept as-is."""
    if v is None:
        return None
    v = str(v)
    return v if v != "" else None


def build_full_db(args):
    if os.path.exists(args.out_sqlite):
        os.remove(args.out_sqlite)
    con = sqlite3.connect(args.out_sqlite)
    cur = con.cursor()
    cur.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE edges (
            term_id         TEXT NOT NULL,
            term            TEXT NOT NULL,
            lang            TEXT NOT NULL,
            reltype         TEXT NOT NULL,
            reltype_class   TEXT NOT NULL,
            related_term_id TEXT,
            related_term    TEXT,
            related_lang    TEXT,
            position        INTEGER
        );
    """)

    influence = {}          # (src_lang, tgt_lang, class) -> count   (src influenced tgt)
    lang_edges = {}         # lang -> edge count (for top-N ranking)
    degree = {}             # term_id -> incident edge count (for --min-degree)

    batch = []
    total = kept = skipped_group = skipped_null = 0
    BATCH = 50_000
    INSERT = ("INSERT INTO edges (term_id,term,lang,reltype,reltype_class,"
              "related_term_id,related_term,related_lang,position) VALUES (?,?,?,?,?,?,?,?,?)")

    for row in open_rows(args.input):
        total += 1
        reltype = norm(row.get("reltype"))
        if reltype in GROUP_RELTYPES:
            skipped_group += 1
            continue
        related_term_id = norm(row.get("related_term_id"))
        related_term = norm(row.get("related_term"))
        if related_term_id is None and related_term is None:
            skipped_null += 1
            continue
        term_id = norm(row.get("term_id"))
        term = norm(row.get("term"))
        lang = norm(row.get("lang"))
        if term_id is None or term is None or lang is None:
            skipped_null += 1
            continue
        related_lang = norm(row.get("related_lang"))
        rclass = RELTYPE_CLASS.get(reltype, "derived")
        try:
            position = int(row.get("position")) if norm(row.get("position")) is not None else None
        except (TypeError, ValueError):
            position = None

        batch.append((term_id, term, lang, reltype, rclass,
                      related_term_id, related_term, related_lang, position))
        kept += 1

        # influence: edge term(lang) -> related_term(related_lang) means
        # related_lang *influenced* lang, so source=related_lang, target=lang.
        if related_lang and lang:
            key = (related_lang, lang, rclass)
            influence[key] = influence.get(key, 0) + 1
        lang_edges[lang] = lang_edges.get(lang, 0) + 1
        degree[term_id] = degree.get(term_id, 0) + 1
        if related_term_id:
            degree[related_term_id] = degree.get(related_term_id, 0) + 1

        if len(batch) >= BATCH:
            cur.executemany(INSERT, batch)
            batch.clear()
            if kept % 500_000 == 0:
                log(f"  loaded {kept:,} edges ...")

    if batch:
        cur.executemany(INSERT, batch)
    con.commit()
    log(f"read {total:,} rows -> kept {kept:,} edges "
        f"(dropped {skipped_group:,} group, {skipped_null:,} null/invalid)")

    # --- terms table: union of both endpoints, with family ------------------
    log("building terms table ...")
    cur.executescript("""
        CREATE TABLE terms (
            term_id TEXT PRIMARY KEY,
            term    TEXT NOT NULL,
            lang    TEXT NOT NULL,
            family  TEXT
        );
        INSERT OR IGNORE INTO terms (term_id, term, lang)
            SELECT term_id, term, lang FROM edges;
        INSERT OR IGNORE INTO terms (term_id, term, lang)
            SELECT related_term_id, related_term, related_lang FROM edges
            WHERE related_term_id IS NOT NULL AND related_term IS NOT NULL
                  AND related_lang IS NOT NULL;
    """)
    con.commit()

    # families
    fam = {}
    with open(args.families, "rt", encoding="utf-8", newline="") as f:
        for rec in csv.DictReader(f):
            fam[rec["lang"]] = rec["family"]
    cur.execute("CREATE TEMP TABLE lang_family (lang TEXT PRIMARY KEY, family TEXT)")
    cur.executemany("INSERT OR REPLACE INTO lang_family VALUES (?,?)", list(fam.items()))
    cur.execute("""UPDATE terms SET family = COALESCE(
                       (SELECT family FROM lang_family WHERE lang_family.lang = terms.lang),
                       'Unknown')""")
    con.commit()
    nterms = cur.execute("SELECT COUNT(*) FROM terms").fetchone()[0]
    log(f"terms: {nterms:,}")

    # --- indexes + vacuum ---------------------------------------------------
    log("creating indexes ...")
    cur.executescript("""
        CREATE INDEX idx_edges_term    ON edges(term_id);
        CREATE INDEX idx_edges_related ON edges(related_term_id);
        CREATE INDEX idx_terms_term      ON terms(term);
        CREATE INDEX idx_terms_term_lang ON terms(term, lang);
        CREATE INDEX idx_terms_term_nocase ON terms(term COLLATE NOCASE);
    """)
    con.commit()
    log("vacuuming full db ...")
    cur.execute("VACUUM")
    con.commit()
    con.close()
    log(f"full db: {args.out_sqlite}  ({human(os.path.getsize(args.out_sqlite))})")

    return influence, lang_edges, degree, fam


def write_influence(args, influence, lang_edges, fam):
    top = sorted(lang_edges, key=lang_edges.get, reverse=True)[: args.max_langs]
    topset = set(top)

    def bucket(l):
        return l if l in topset else "Other"

    agg = {}
    for (src, tgt, cls), w in influence.items():
        s, t = bucket(src), bucket(tgt)
        if s == t:
            continue
        agg[(s, t, cls)] = agg.get((s, t, cls), 0) + w

    langs = [{"id": l, "name": l, "family": fam.get(l, "Unknown")} for l in top]
    langs.append({"id": "Other", "name": "Other", "family": "Unknown"})
    edges = [{"source": s, "target": t, "reltype_class": c, "weight": w}
             for (s, t, c), w in sorted(agg.items(), key=lambda kv: kv[1], reverse=True)]
    out = {"languages": langs, "edges": edges}
    with open(args.out_influence, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    log(f"influence: {args.out_influence}  "
        f"({len(langs)} langs, {len(edges)} edges, {human(os.path.getsize(args.out_influence))})")
    return top


def dump_sql(args):
    con = sqlite3.connect(args.out_sqlite)
    with open(args.out_sql, "w", encoding="utf-8") as f:
        for line in con.iterdump():
            f.write(line + "\n")
    con.close()
    log(f"sql dump: {args.out_sql}  ({human(os.path.getsize(args.out_sql))})")


def main():
    p = argparse.ArgumentParser(description="Etymograph dataset preprocessor")
    p.add_argument("--input", required=True, help="etymology.csv.gz or .parquet")
    p.add_argument("--out-sqlite", default="build/etymology.sqlite")
    p.add_argument("--out-influence", default="data/influence.json")
    p.add_argument("--out-sql", default=None, help="optional full SQL dump for D1 import")
    p.add_argument("--families", default="data/lang_families.csv")
    p.add_argument("--max-langs", type=int, default=40, help="languages in the influence view")
    args = p.parse_args()

    t0 = time.time()
    influence, lang_edges, degree, fam = build_full_db(args)
    top = write_influence(args, influence, lang_edges, fam)
    if args.out_sql:
        dump_sql(args)
    log(f"done in {time.time() - t0:.0f}s. influence top langs: {', '.join(top[:10])} ...")
    log("next: scripts/build_web_db.py to produce the compact static db.")


if __name__ == "__main__":
    main()
