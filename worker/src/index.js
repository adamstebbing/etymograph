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
    if (!nodes.has(id)) nodes.set(id, { id, term, lang, family: null, depth });
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

  // attach families
  const nodeIds = [...nodes.keys()].filter((id) => !id.includes("::"));
  if (nodeIds.length) {
    const fph = nodeIds.map(() => "?").join(",");
    const fam = await db
      .prepare(`SELECT term_id, family FROM terms WHERE term_id IN (${fph})`)
      .bind(...nodeIds)
      .all();
    for (const row of fam.results || []) {
      if (nodes.has(row.term_id)) nodes.get(row.term_id).family = row.family;
    }
  }
  for (const n of nodes.values()) if (n.family == null) n.family = "Unknown";

  return { nodes: [...nodes.values()], links };
}

async function handleWord(url, request, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const lang = (url.searchParams.get("lang") || "").trim();
  if (!q) return json({ query: q, nodes: [], links: [] }, request, env);

  const sql = lang
    ? "SELECT term_id, term, lang, family FROM terms WHERE term = ? COLLATE NOCASE AND lang = ? LIMIT 200"
    : "SELECT term_id, term, lang, family FROM terms WHERE term = ? COLLATE NOCASE LIMIT 200";
  const stmt = lang ? env.DB.prepare(sql).bind(q, lang) : env.DB.prepare(sql).bind(q);
  const matches = (await stmt.all()).results || [];

  if (matches.length === 0) return json({ query: q, nodes: [], links: [] }, request, env, { cache: 3600 });

  const { nodes, links } = await neighborhood(env.DB, matches.map((m) => m.term_id), 0);
  // make sure the matched nodes carry their family + depth 0
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const m of matches) {
    const n = byId.get(m.term_id);
    if (n) {
      n.depth = 0;
      n.family = m.family || n.family;
    } else {
      nodes.push({ id: m.term_id, term: m.term, lang: m.lang, family: m.family || "Unknown", depth: 0 });
    }
  }
  return json({ query: q, nodes, links }, request, env, { cache: 3600 });
}

async function handleExpand(url, request, env) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ nodes: [], links: [] }, request, env);
  const seed = await env.DB.prepare("SELECT term_id, term, lang, family FROM terms WHERE term_id = ?")
    .bind(id)
    .all();
  const { nodes, links } = await neighborhood(env.DB, [id], 0);
  const s = (seed.results || [])[0];
  if (s) {
    const n = nodes.find((x) => x.id === id);
    if (n) n.family = s.family || n.family;
    else nodes.push({ id, term: s.term, lang: s.lang, family: s.family || "Unknown", depth: 0 });
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
