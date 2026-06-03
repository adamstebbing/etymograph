// Etymograph Worker API (DESIGN.md section 6).
//   GET /api/influence          -> prebuilt language-influence matrix
//   GET /api/word?q=&lang=       -> a searched term's immediate neighborhood
//   GET /api/expand?id=          -> immediate neighbors of one term (click-to-expand)
//
// The influence matrix is bundled at build time (tiny, ~40 langs). Word/expand
// queries hit D1. Every walk is one hop and index-backed, so a request issues a
// handful of queries — well under the free-plan 50-per-invocation limit.

import influence from "../../data/influence.json";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  const h = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (ok && origin) h["Access-Control-Allow-Origin"] = origin;
  else if (allowed.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  return h;
}

function json(body, request, env, { cache = 0 } = {}) {
  const headers = { ...JSON_HEADERS, ...corsHeaders(request, env) };
  if (cache) headers["Cache-Control"] = `public, max-age=${cache}`;
  return new Response(JSON.stringify(body), { headers });
}

function nodeId(term_id, lang, term) {
  return term_id || `${lang || "?"}::${term || "?"}`;
}

// Build {nodes, links} for a set of seed term_ids, one hop out in both directions.
async function neighborhood(db, seeds, seedDepth) {
  const ids = [...new Set(seeds)].filter(Boolean);
  if (ids.length === 0) return { nodes: [], links: [] };
  const ph = ids.map(() => "?").join(",");

  const outgoing = await db
    .prepare(
      `SELECT term_id, term, lang, reltype, reltype_class,
              related_term_id, related_term, related_lang, position
         FROM edges WHERE term_id IN (${ph})`
    )
    .bind(...ids)
    .all();

  const incoming = await db
    .prepare(
      `SELECT term_id, term, lang, reltype, reltype_class,
              related_term_id, related_term, related_lang, position
         FROM edges WHERE related_term_id IN (${ph})`
    )
    .bind(...ids)
    .all();

  const rows = [...(outgoing.results || []), ...(incoming.results || [])];

  const nodes = new Map();
  const links = [];
  const linkSeen = new Set();

  function addNode(id, term, lang, depth) {
    if (!nodes.has(id)) nodes.set(id, { id, term, lang, family: null, era_rank: null, depth });
    else if (depth < nodes.get(id).depth) nodes.get(id).depth = depth;
  }

  const seedSet = new Set(ids);
  for (const r of rows) {
    const sid = nodeId(r.term_id, r.lang, r.term);
    const tid = nodeId(r.related_term_id, r.related_lang, r.related_term);
    if (!r.related_term && !r.related_term_id) continue;
    const sDepth = seedSet.has(r.term_id) ? seedDepth : seedDepth + 1;
    const tDepth = seedSet.has(r.related_term_id) ? seedDepth : seedDepth + 1;
    addNode(sid, r.term, r.lang, sDepth);
    addNode(tid, r.related_term, r.related_lang, tDepth);
    const key = `${sid}|${tid}|${r.reltype}`;
    if (!linkSeen.has(key)) {
      linkSeen.add(key);
      links.push({
        source: sid,
        target: tid,
        reltype: r.reltype,
        reltype_class: r.reltype_class,
      });
    }
  }

  // attach family + era_rank
  const nodeIds = [...nodes.keys()].filter((id) => !id.includes("::"));
  if (nodeIds.length) {
    const fph = nodeIds.map(() => "?").join(",");
    const fam = await db
      .prepare(`SELECT term_id, family, era_rank FROM terms WHERE term_id IN (${fph})`)
      .bind(...nodeIds)
      .all();
    for (const row of fam.results || []) {
      const n = nodes.get(row.term_id);
      if (n) { n.family = row.family; n.era_rank = row.era_rank; }
    }
  }
  for (const n of nodes.values()) {
    if (n.family == null) n.family = "Unknown";
    if (n.era_rank == null) n.era_rank = 5;
  }

  return { nodes: [...nodes.values()], links };
}

// reltype classes that point from a term to an older ancestor
const ANCESTRY = new Set(["inherited", "derived", "root"]);
const MAX_WORD_NODES = 250; // cap so big hubs (Latin, PIE) don't explode the graph

// Merge graph b into a (dedup nodes by id keeping min depth, links by key).
function mergeInto(a, b, cap) {
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) {
    if (byId.has(n.id)) {
      const e = byId.get(n.id);
      if (n.depth < e.depth) e.depth = n.depth;
    } else if (a.nodes.length < cap) {
      a.nodes.push(n);
      byId.set(n.id, n);
    }
  }
  const key = (l) => `${l.source}|${l.target}|${l.reltype}`;
  const seen = new Set(a.links.map(key));
  for (const l of b.links) {
    if (byId.has(l.source) && byId.has(l.target) && !seen.has(key(l))) {
      a.links.push(l);
      seen.add(key(l));
    }
  }
  return a;
}

async function handleWord(url, request, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const lang = (url.searchParams.get("lang") || "").trim();
  if (!q) return json({ query: q, nodes: [], links: [] }, request, env);

  const sql = lang
    ? "SELECT term_id, term, lang, family, era_rank FROM terms WHERE term = ? COLLATE NOCASE AND lang = ? LIMIT 200"
    : "SELECT term_id, term, lang, family, era_rank FROM terms WHERE term = ? COLLATE NOCASE LIMIT 200";
  const stmt = lang ? env.DB.prepare(sql).bind(q, lang) : env.DB.prepare(sql).bind(q);
  const matches = (await stmt.all()).results || [];

  if (matches.length === 0) return json({ query: q, nodes: [], links: [] }, request, env, { cache: 3600 });

  const seedIds = matches.map((m) => m.term_id);
  const seedSet = new Set(seedIds);
  const graph = await neighborhood(env.DB, seedIds, 0);

  // Second hop along ancestry only: re-expand the ancestor nodes reached from a
  // seed so their *other* children (sibling cognates) appear without a manual
  // expand. Bounded by node id type and the overall node cap.
  const ancestorIds = [];
  const seenAnc = new Set();
  for (const l of graph.links) {
    if (seedSet.has(l.source) && ANCESTRY.has(l.reltype_class) &&
        !l.target.includes("::") && !seenAnc.has(l.target)) {
      seenAnc.add(l.target);
      ancestorIds.push(l.target);
    }
  }
  if (ancestorIds.length) {
    const hop2 = await neighborhood(env.DB, ancestorIds, 1);
    mergeInto(graph, hop2, MAX_WORD_NODES);
  }

  // ensure matched nodes carry family/era and depth 0
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const m of matches) {
    const n = byId.get(m.term_id);
    if (n) { n.depth = 0; n.family = m.family || n.family; n.era_rank = m.era_rank ?? n.era_rank; }
    else graph.nodes.push({ id: m.term_id, term: m.term, lang: m.lang,
                            family: m.family || "Unknown", era_rank: m.era_rank ?? 5, depth: 0 });
  }
  return json({ query: q, nodes: graph.nodes, links: graph.links }, request, env, { cache: 3600 });
}

async function handleExpand(url, request, env) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ nodes: [], links: [] }, request, env);
  const seed = await env.DB.prepare("SELECT term_id, term, lang, family, era_rank FROM terms WHERE term_id = ?")
    .bind(id)
    .all();
  const { nodes, links } = await neighborhood(env.DB, [id], 0);
  const s = (seed.results || [])[0];
  if (s) {
    const n = nodes.find((x) => x.id === id);
    if (n) { n.family = s.family || n.family; n.era_rank = s.era_rank ?? n.era_rank; }
    else nodes.push({ id, term: s.term, lang: s.lang, family: s.family || "Unknown", era_rank: s.era_rank ?? 5, depth: 0 });
  }
  return json({ nodes, links }, request, env, { cache: 3600 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    try {
      switch (url.pathname) {
        case "/api/influence":
          return json(influence, request, env, { cache: 86400 });
        case "/api/word":
          return handleWord(url, request, env);
        case "/api/expand":
          return handleExpand(url, request, env);
        case "/api/health":
          return json({ ok: true }, request, env);
        default:
          return json({ error: "not found" }, request, env);
      }
    } catch (err) {
      return json({ error: String(err && err.message || err) }, request, env);
    }
  },
};
