#!/usr/bin/env python3
"""Build the compact, fully-static web database from an already-built full DB.

The static GitHub Pages frontend downloads this file once and queries it in the
browser with plain sql.js (no backend, no HTTP Range requests), so it must stay
small. We keep edges whose *both* endpoints fall in a curated language set and
whose endpoints clear a minimum degree, which trims the long tail hard while
preserving the well-connected core (English, the classical and proto languages,
the major European and a few world languages).

Run after preprocess.py has produced build/etymology.sqlite:

    python scripts/build_web_db.py --full build/etymology.sqlite \
        --out data/etymology-web.sqlite --min-degree 2
"""

import argparse
import os
import sqlite3
import time


# Curated language set for the compact web db. Chosen for connectivity and for
# covering the etymological backbone of common English/European searches.
DEFAULT_LANGS = [
    "English", "Old English", "Middle English",
    "Latin", "Late Latin", "Medieval Latin", "New Latin", "Vulgar Latin",
    "Ancient Greek", "Greek",
    "French", "Old French", "Middle French",
    "Italian", "Spanish", "Portuguese", "Catalan", "Romanian",
    "German", "Old High German", "Middle High German", "Dutch", "Middle Dutch",
    "Old Norse", "Swedish", "Danish", "Icelandic", "Gothic",
    "Proto-Indo-European", "Proto-Germanic", "Proto-West Germanic", "Proto-Italic",
    "Proto-Slavic", "Proto-Celtic",
    "Sanskrit", "Persian",
    "Russian", "Polish", "Czech", "Old Church Slavonic",
    "Irish", "Old Irish", "Welsh", "Lithuanian",
    "Arabic", "Hebrew",
]


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def human(n):
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024 or u == "GB":
            return f"{n:.1f} {u}"
        n /= 1024


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--full", default="build/etymology.sqlite")
    p.add_argument("--out", default="data/etymology-web.sqlite")
    p.add_argument("--min-degree", type=int, default=3)
    p.add_argument("--gzip", action="store_true",
                   help="also emit <out>.gz (the file the static site ships)")
    p.add_argument("--keep-uncompressed", action="store_true",
                   help="with --gzip, keep the uncompressed .sqlite too")
    p.add_argument("--langs-file", help="optional newline-delimited language list")
    args = p.parse_args()

    langs = DEFAULT_LANGS
    if args.langs_file:
        with open(args.langs_file, encoding="utf-8") as f:
            langs = [ln.strip() for ln in f if ln.strip()]

    if os.path.exists(args.out):
        os.remove(args.out)
    con = sqlite3.connect(args.full)
    cur = con.cursor()
    cur.execute("PRAGMA synchronous = OFF")
    cur.execute("ATTACH DATABASE ? AS web", (args.out,))
    cur.execute("PRAGMA web.page_size = 4096")
    cur.executescript("""
        CREATE TEMP TABLE keep_lang (lang TEXT PRIMARY KEY);
        CREATE TABLE web.terms (
            term_id TEXT PRIMARY KEY, term TEXT NOT NULL, lang TEXT NOT NULL,
            family TEXT, era_rank INTEGER);
        CREATE TABLE web.edges (
            term_id TEXT NOT NULL, term TEXT NOT NULL, lang TEXT NOT NULL,
            reltype TEXT NOT NULL, reltype_class TEXT NOT NULL,
            related_term_id TEXT, related_term TEXT, related_lang TEXT, position INTEGER);
    """)
    cur.executemany("INSERT INTO keep_lang VALUES (?)", ((l,) for l in langs))

    # Set-based, index-backed pruning (correlated subqueries are far too slow at
    # 3.8M rows). keep_term = terms whose total degree clears the threshold.
    log("computing term degrees ...")
    cur.execute("""CREATE TEMP TABLE keep_term AS
        SELECT id FROM (
            SELECT term_id AS id FROM edges
            UNION ALL
            SELECT related_term_id FROM edges WHERE related_term_id IS NOT NULL
        ) GROUP BY id HAVING COUNT(*) >= ?""", (args.min_degree,))
    cur.execute("CREATE INDEX temp.idx_keep_term ON keep_term(id)")

    log(f"selecting edges for {len(langs)} languages (min_degree={args.min_degree}) ...")
    # Both endpoints must be in the kept language set AND clear the degree floor.
    cur.execute("""
        INSERT INTO web.edges
        SELECT e.term_id, e.term, e.lang, e.reltype, e.reltype_class,
               e.related_term_id, e.related_term, e.related_lang, e.position
        FROM edges e
        JOIN keep_lang la ON e.lang = la.lang
        JOIN keep_lang lb ON e.related_lang = lb.lang
        JOIN keep_term ka ON e.term_id = ka.id
        JOIN keep_term kb ON e.related_term_id = kb.id
    """)

    cur.execute("""INSERT OR IGNORE INTO web.terms
        SELECT t.* FROM terms t
        JOIN (SELECT term_id AS id FROM web.edges
              UNION SELECT related_term_id FROM web.edges) u ON t.term_id = u.id""")
    con.commit()

    cur.executescript("""
        CREATE INDEX web.idx_edges_term         ON edges(term_id);
        CREATE INDEX web.idx_edges_related      ON edges(related_term_id);
        CREATE INDEX web.idx_terms_term_nocase  ON terms(term COLLATE NOCASE);
    """)
    con.commit()
    ne = cur.execute("SELECT COUNT(*) FROM web.edges").fetchone()[0]
    nt = cur.execute("SELECT COUNT(*) FROM web.terms").fetchone()[0]
    cur.execute("VACUUM web")
    con.commit()
    con.close()
    raw = os.path.getsize(args.out)
    log(f"web db: {args.out}  ({nt:,} terms, {ne:,} edges, {human(raw)})")

    if args.gzip:
        import gzip as _gz
        gz_path = args.out + ".gz"
        log("gzipping ...")
        with open(args.out, "rb") as fin, _gz.open(gz_path, "wb", compresslevel=9) as fout:
            while True:
                chunk = fin.read(1 << 20)
                if not chunk:
                    break
                fout.write(chunk)
        gz = os.path.getsize(gz_path)
        log(f"gzipped: {gz_path}  ({human(gz)}, {100 * gz / raw:.0f}% of raw)")
        if gz > 100 * 1024 * 1024:
            log("  WARNING: gzipped web db exceeds GitHub Pages' 100MB/file limit. "
                "Raise --min-degree, trim languages, or shard.")
        if not args.keep_uncompressed:
            os.remove(args.out)
            log(f"removed uncompressed {args.out} (commit the .gz; it is a build artifact)")


if __name__ == "__main__":
    main()
