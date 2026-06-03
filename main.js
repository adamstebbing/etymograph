/* Etymograph frontend (DESIGN.md section 7).
 *
 * Two interchangeable data sources, selected by DATA_SOURCE below:
 *   "static" — query a small pruned SQLite shipped with the site, in-browser via
 *              sql.js. Zero backend; works on plain GitHub Pages.
 *   "api"    — call the Cloudflare Worker from DESIGN.md section 6 for full-dataset
 *              coverage. Set API_BASE and flip DATA_SOURCE to "api".
 * Both expose the same three methods (influence / word / expand) returning the
 * same {nodes, links} shape, so the rest of the app is source-agnostic.
 */

// ---------------------------------------------------------------- config -----
const DATA_SOURCE = "static";                 // "static" | "api"
const API_BASE = "https://etymograph-api.<subdomain>.workers.dev/api";
const INFLUENCE_URL = "./data/influence.json";
const WEB_DB_URL = "./data/etymology-web.sqlite";
const SQL_WASM_DIR = "./lib/sqljs/";

// --------------------------------------------------------------- palette -----
const RELATION_COLORS = {
  inherited: "#4ade80",
  borrowed: "#f472b6",
  derived: "#fbbf24",
  root: "#a78bfa",
  cognate: "#38bdf8",
  other: "#94a3b8",
};
const RELATION_LABELS = {
  inherited: "Inherited",
  borrowed: "Borrowed",
  derived: "Derived",
  root: "Root",
  cognate: "Cognate / related",
};
const FAMILY_COLORS = {
  Germanic: "#60a5fa",
  Romance: "#f472b6",
  Hellenic: "#facc15",
  Slavic: "#34d399",
  Baltic: "#22d3ee",
  "Balto-Slavic": "#2dd4bf",
  "Indo-Iranian": "#fb923c",
  Celtic: "#a3e635",
  Albanian: "#c084fc",
  Armenian: "#f87171",
  Tocharian: "#e879f9",
  "Indo-European": "#818cf8",
  Uralic: "#fbbf24",
  Turkic: "#fca5a5",
  Afroasiatic: "#f59e0b",
  Japonic: "#f472b6",
  Koreanic: "#38bdf8",
  "Sino-Tibetan": "#ef4444",
  "Tai-Kadai": "#14b8a6",
  Austroasiatic: "#84cc16",
  Austronesian: "#22d3ee",
  Mongolic: "#eab308",
  Kartvelian: "#d946ef",
  "Niger-Congo": "#f97316",
  Constructed: "#9ca3af",
  Translingual: "#cbd5e1",
  Isolate: "#94a3b8",
  Unknown: "#5b6776",
};
function familyColor(fam) {
  return FAMILY_COLORS[fam] || FAMILY_COLORS.Unknown;
}

// -------------------------------------------------------------- elements -----
const el = (id) => document.getElementById(id);
const statusEl = el("status");
const legendEl = el("legend");

let colorMode = "relation"; // "relation" | "family"
let isInfluenceView = true;
const expanded = new Set(); // node ids already expanded

function setStatus(html, isError = false) {
  statusEl.innerHTML = html;
  statusEl.classList.toggle("error", isError);
}
function spinner(text) {
  setStatus(`<span class="spinner"></span>${text}`);
}

// ------------------------------------------------------------ data layer -----
// Shared neighborhood builder used by the static source (mirrors the Worker).
function buildGraph(rows, seedIds, familyById) {
  const seedSet = new Set(seedIds);
  const nodes = new Map();
  const links = [];
  const linkSeen = new Set();
  const addNode = (id, term, lang, depth) => {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, term, lang, family: familyById.get(id) || "Unknown", depth });
    else if (depth < nodes.get(id).depth) nodes.get(id).depth = depth;
  };
  for (const r of rows) {
    if (!r.related_term && !r.related_term_id) continue;
    const sid = r.term_id || `${r.lang}::${r.term}`;
    const tid = r.related_term_id || `${r.related_lang || "?"}::${r.related_term}`;
    addNode(sid, r.term, r.lang, seedSet.has(r.term_id) ? 0 : 1);
    addNode(tid, r.related_term, r.related_lang, seedSet.has(r.related_term_id) ? 0 : 1);
    const key = `${sid}|${tid}|${r.reltype}`;
    if (!linkSeen.has(key)) {
      linkSeen.add(key);
      links.push({ source: sid, target: tid, reltype: r.reltype, reltype_class: r.reltype_class });
    }
  }
  return { nodes: [...nodes.values()], links };
}

const StaticSource = {
  db: null,
  async init() {
    if (this.db) return;
    spinner("Loading database…");
    const SQL = await initSqlJs({ locateFile: (f) => SQL_WASM_DIR + f });
    const buf = await fetch(WEB_DB_URL).then((r) => {
      if (!r.ok) throw new Error(`could not load ${WEB_DB_URL} (${r.status})`);
      return r.arrayBuffer();
    });
    this.db = new SQL.Database(new Uint8Array(buf));
  },
  query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  },
  async influence() {
    const r = await fetch(INFLUENCE_URL);
    if (!r.ok) throw new Error(`could not load ${INFLUENCE_URL}`);
    return r.json();
  },
  neighborhood(seedIds) {
    if (seedIds.length === 0) return { nodes: [], links: [] };
    const ph = seedIds.map(() => "?").join(",");
    const cols = `term_id, term, lang, reltype, reltype_class, related_term_id, related_term, related_lang`;
    const out = this.query(`SELECT ${cols} FROM edges WHERE term_id IN (${ph})`, seedIds);
    const inc = this.query(`SELECT ${cols} FROM edges WHERE related_term_id IN (${ph})`, seedIds);
    const rows = out.concat(inc);
    const ids = new Set();
    for (const r of rows) {
      if (r.term_id) ids.add(r.term_id);
      if (r.related_term_id) ids.add(r.related_term_id);
    }
    const famById = new Map();
    const idList = [...ids];
    if (idList.length) {
      const fph = idList.map(() => "?").join(",");
      for (const t of this.query(`SELECT term_id, family FROM terms WHERE term_id IN (${fph})`, idList))
        famById.set(t.term_id, t.family);
    }
    return buildGraph(rows, seedIds, famById);
  },
  async word(q, lang) {
    await this.init();
    const sql = lang
      ? `SELECT term_id, term, lang, family FROM terms WHERE term = ? COLLATE NOCASE AND lang = ? LIMIT 200`
      : `SELECT term_id, term, lang, family FROM terms WHERE term = ? COLLATE NOCASE LIMIT 200`;
    const matches = this.query(sql, lang ? [q, lang] : [q]);
    if (matches.length === 0) return { query: q, nodes: [], links: [] };
    const g = this.neighborhood(matches.map((m) => m.term_id));
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const m of matches) {
      const n = byId.get(m.term_id);
      if (n) { n.depth = 0; n.family = m.family || n.family; }
      else g.nodes.push({ id: m.term_id, term: m.term, lang: m.lang, family: m.family || "Unknown", depth: 0 });
    }
    return { query: q, nodes: g.nodes, links: g.links };
  },
  async expand(id) {
    await this.init();
    return this.neighborhood([id]);
  },
};

const ApiSource = {
  async influence() {
    return fetch(`${API_BASE}/influence`).then((r) => r.json());
  },
  async word(q, lang) {
    const u = new URL(`${API_BASE}/word`);
    u.searchParams.set("q", q);
    if (lang) u.searchParams.set("lang", lang);
    return fetch(u).then((r) => r.json());
  },
  async expand(id) {
    const u = new URL(`${API_BASE}/expand`);
    u.searchParams.set("id", id);
    return fetch(u).then((r) => r.json());
  },
};

const source = DATA_SOURCE === "api" ? ApiSource : StaticSource;

// ---------------------------------------------------------------- graph ------
const graphEl = el("graph");
const Graph = ForceGraph3D()(graphEl)
  .backgroundColor("#0a0c10")
  .nodeRelSize(4)
  .nodeOpacity(0.95)
  .nodeVal((n) => n.__val || 1)
  .nodeColor(nodeColor)
  .nodeLabel(nodeLabel)
  .linkColor(linkColor)
  .linkWidth(linkWidth)
  .linkOpacity(0.45)
  .linkDirectionalParticles(0)
  .linkLabel(linkLabel)
  .onNodeClick(onNodeClick)
  .onBackgroundClick(() => {});

window.addEventListener("resize", () => {
  Graph.width(window.innerWidth).height(window.innerHeight);
});
Graph.width(window.innerWidth).height(window.innerHeight);

function nodeColor(n) {
  if (colorMode === "family") return familyColor(n.family);
  // relation mode: color a term node by the class of its strongest incident link
  if (isInfluenceView) return "#9fb3cc";
  return n.__relColor || "#9fb3cc";
}
function linkColor(l) {
  if (colorMode === "family") return "rgba(150,170,200,0.35)";
  return RELATION_COLORS[l.reltype_class] || RELATION_COLORS.other;
}
function linkWidth(l) {
  if (l.weight) return Math.max(0.4, Math.log10(l.weight + 1) * 0.9);
  return 0.8;
}
function nodeLabel(n) {
  if (isInfluenceView) return `<b>${esc(n.term)}</b> · <span style="color:#6ea8fe">${esc(n.family)}</span>`;
  return `<b>${esc(n.term)}</b> <span style="color:#6ea8fe;font-family:monospace">${esc(n.lang || "")}</span>`;
}
function linkLabel(l) {
  if (l.weight) return `${esc(l.reltype_class)} · ${l.weight.toLocaleString()}`;
  return esc((l.reltype || "").replace(/_/g, " "));
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// color each term node in relation mode by the class of its strongest link
function decorateRelColors(nodes, links) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const PRI = { root: 5, inherited: 4, borrowed: 3, derived: 2, cognate: 1, other: 0 };
  for (const l of links) {
    const c = RELATION_COLORS[l.reltype_class] || RELATION_COLORS.other;
    const t = byId.get(typeof l.target === "object" ? l.target.id : l.target);
    if (t && (t.__relPri || -1) < (PRI[l.reltype_class] ?? 0)) { t.__relColor = c; t.__relPri = PRI[l.reltype_class] ?? 0; }
    const s = byId.get(typeof l.source === "object" ? l.source.id : l.source);
    if (s && s.__relColor == null) s.__relColor = "#9fb3cc";
  }
}

// ------------------------------------------------------------- rendering -----
function renderInfluence(data) {
  isInfluenceView = true;
  expanded.clear();
  const incoming = new Map();
  for (const e of data.edges) incoming.set(e.target, (incoming.get(e.target) || 0) + e.weight);
  const nodes = data.languages.map((l) => ({
    id: l.id, term: l.name, lang: l.id, family: l.family,
    __val: Math.max(1, Math.log10((incoming.get(l.id) || 0) + 10) * 3),
  }));
  const links = data.edges.map((e) => ({
    source: e.source, target: e.target,
    reltype: e.reltype_class, reltype_class: e.reltype_class, weight: e.weight,
  }));
  Graph.cooldownTicks(120).graphData({ nodes, links });
  Graph.linkDirectionalParticles(0);
  setStatus(`Language-influence graph — ${nodes.length} languages, ${links.length} flows. ` +
            `Search a word to explore its etymology.`);
  renderLegend();
}

function renderWord(data, query) {
  isInfluenceView = false;
  expanded.clear();
  if (!data.nodes || data.nodes.length === 0) {
    Graph.graphData({ nodes: [], links: [] });
    setStatus(`No matches for <code>${esc(query)}</code>. Try another word — the static ` +
              `database covers a curated set of languages.`, true);
    return;
  }
  sizeByDepth(data.nodes);
  decorateRelColors(data.nodes, data.links);
  Graph.cooldownTicks(120).graphData({ nodes: data.nodes, links: data.links });
  const langs = new Set(data.nodes.map((n) => n.lang)).size;
  setStatus(`<code>${esc(query)}</code> — ${data.nodes.length} terms across ${langs} languages. ` +
            `Click any node to expand.`);
  renderLegend();
  frameGraph();
}

function sizeByDepth(nodes) {
  for (const n of nodes) n.__val = n.depth === 0 ? 6 : n.depth === 1 ? 2.5 : 1.5;
}

function onNodeClick(node) {
  if (isInfluenceView || !node || expanded.has(node.id)) return;
  if (String(node.id).includes("::")) return; // synthetic node with no term_id
  expanded.add(node.id);
  spinner(`Expanding ${esc(node.term)}…`);
  Promise.resolve(source.expand(node.id)).then((res) => {
    mergeGraph(res);
    setStatus(`Expanded <code>${esc(node.term)}</code>.`);
  }).catch((e) => setStatus(`Expand failed: ${esc(e.message)}`, true));
}

function mergeGraph(res) {
  const { nodes, links } = Graph.graphData();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of res.nodes) {
    if (!byId.has(n.id)) {
      n.__val = n.__val || 2;
      nodes.push(n);
      byId.set(n.id, n);
    }
  }
  const linkKey = (l) => `${typeof l.source === "object" ? l.source.id : l.source}|${typeof l.target === "object" ? l.target.id : l.target}|${l.reltype}`;
  const seen = new Set(links.map(linkKey));
  for (const l of res.links) {
    if (!seen.has(linkKey(l))) { links.push(l); seen.add(linkKey(l)); }
  }
  decorateRelColors(nodes, links);
  Graph.graphData({ nodes, links });
}

function frameGraph() {
  setTimeout(() => Graph.zoomToFit(600, 80), 700);
}

// --------------------------------------------------------------- legend ------
function renderLegend() {
  let items = [];
  if (colorMode === "relation") {
    items = Object.keys(RELATION_LABELS).map((k) =>
      `<span class="item"><span class="swatch" style="background:${RELATION_COLORS[k]}"></span>${RELATION_LABELS[k]}</span>`);
  } else {
    const fams = new Set();
    Graph.graphData().nodes.forEach((n) => fams.add(n.family || "Unknown"));
    items = [...fams].sort().slice(0, 14).map((f) =>
      `<span class="item"><span class="swatch" style="background:${familyColor(f)}"></span>${esc(f)}</span>`);
  }
  legendEl.innerHTML = items.join("");
}

// ----------------------------------------------------------- interactions ----
el("color-mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  colorMode = btn.dataset.mode;
  document.querySelectorAll("#color-mode button").forEach((b) => b.classList.toggle("active", b === btn));
  Graph.nodeColor(nodeColor).linkColor(linkColor); // re-trigger accessors, no refetch
  renderLegend();
});

el("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el("search-input").value.trim();
  if (!q) return;
  spinner(`Searching “${esc(q)}”…`);
  Promise.resolve(source.word(q)).then((data) => renderWord(data, q))
    .catch((err) => setStatus(`Search failed: ${esc(err.message)}`, true));
});

el("reset-btn").addEventListener("click", loadInfluence);

el("search-input").addEventListener("focus", () => el("panel").classList.remove("collapsed"));

// ----------------------------------------------------------------- boot ------
function loadInfluence() {
  spinner("Loading language-influence graph…");
  Promise.resolve(source.influence())
    .then(renderInfluence)
    .catch((err) => setStatus(`Could not load influence data: ${esc(err.message)}`, true));
}

loadInfluence();
