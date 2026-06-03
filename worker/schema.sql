-- Etymograph D1 schema (DESIGN.md section 5).
-- Run with: wrangler d1 execute etymograph --local|--remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS edges (
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

CREATE TABLE IF NOT EXISTS terms (
    term_id   TEXT PRIMARY KEY,
    term      TEXT NOT NULL,
    lang      TEXT NOT NULL,
    family    TEXT                     -- language family for color mode
);

CREATE INDEX IF NOT EXISTS idx_edges_term         ON edges(term_id);
CREATE INDEX IF NOT EXISTS idx_edges_related      ON edges(related_term_id);
CREATE INDEX IF NOT EXISTS idx_terms_term         ON terms(term);
CREATE INDEX IF NOT EXISTS idx_terms_term_lang    ON terms(term, lang);
CREATE INDEX IF NOT EXISTS idx_terms_term_nocase  ON terms(term COLLATE NOCASE);
