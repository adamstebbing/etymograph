/* Etymograph frontend (DESIGN.md sections 7 & 11) — v0.2.
 *
 * Layered, era-ordered layout: a node's vertical position is fixed by its
 * language era (curated era table → era_rank), proto/old at top, modern at
 * bottom. The default view arranges each language family as its own vertical
 * column; a word search lays the word's etymology on the same era axis with a
 * two-hop neighborhood so sibling cognates appear up front. Nodes expand on
 * click and collapse on re-click.
 *
 * Two interchangeable data sources (DATA_SOURCE): "static" queries a pruned,
 * gzipped SQLite in-browser via sql.js; "api" calls the Cloudflare Worker.
 */

// ---------------------------------------------------------------- config -----
const DATA_SOURCE = "static";                 // "static" | "api"
const API_BASE = "https://etymograph-api.<subdomain>.workers.dev/api";
const INFLUENCE_URL = "./data/influence.json";
const WEB_DB_URL = "./data/etymology-web.sqlite.gz";
const SQL_WASM_DIR = "./lib/sqljs/";

// layout constants
const MAX_ERA = 5;            // modern
const COLUMN_GAP = 240;      // horizontal px between family columns (word view legacy)
const TIEBREAK_FRAC = 0.6;   // max intra-era nudge, as a fraction of LEVEL_GAP
const MAX_WORD_NODES = 250;

// Tunable layout settings (exposed via the settings panel). In the influence
// view each language family is laid out as its own circle in the X/Z plane;
// the families are packed in a phyllotaxis spiral so the largest (most
// influential) family sits dead-center and smaller ones ring outward. Era
// stays on the Y axis. Defaults keep CIRCLE_DISTANCE === 2 × CIRCLE_RADIUS so
// neighbouring family circles sit just tangent.
const SETTINGS = {
  circleRadius: 60,     // radius of each family's circle (X/Z), px
  circleDistance: 120,  // center-to-center spacing of family circles, px
  levelGap: 80,         // vertical px between era levels
  maxLinkWidth: 6,      // thickest rendered link
};
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈137.5° — even spiral packing
let maxInfluenceWeight = 1;   // largest edge weight in the current influence graph

// reltype classes that point from a term to an older ancestor
const ANCESTRY = new Set(["inherited", "derived", "root"]);

// --------------------------------------------------------------- palette -----
const RELATION_COLORS = {
  inherited: "#4ade80", borrowed: "#f472b6", derived: "#fbbf24",
  root: "#a78bfa", cognate: "#38bdf8", other: "#94a3b8",
};
const RELATION_LABELS = {
  inherited: "Inherited", borrowed: "Borrowed", derived: "Derived",
  root: "Root", cognate: "Cognate / related",
};
const FAMILY_COLORS = {
  Germanic: "#60a5fa", Romance: "#f472b6", Hellenic: "#facc15", Slavic: "#34d399",
  Baltic: "#22d3ee", "Balto-Slavic": "#2dd4bf", "Indo-Iranian": "#fb923c",
  Celtic: "#a3e635", Albanian: "#c084fc", Armenian: "#f87171", Tocharian: "#e879f9",
  "Indo-European": "#818cf8", Uralic: "#fbbf24", Turkic: "#fca5a5", Afroasiatic: "#f59e0b",
  Japonic: "#f472b6", Koreanic: "#38bdf8", "Sino-Tibetan": "#ef4444", "Tai-Kadai": "#14b8a6",
  Austroasiatic: "#84cc16", Austronesian: "#22d3ee", Mongolic: "#eab308", Kartvelian: "#d946ef",
  "Niger-Congo": "#f97316", Constructed: "#9ca3af", Translingual: "#cbd5e1",
  Isolate: "#94a3b8", Unknown: "#5b6776",
};
const familyColor = (f) => FAMILY_COLORS[f] || FAMILY_COLORS.Unknown;

// -------------------------------------------------------------- elements -----
const el = (id) => document.getElementById(id);
const statusEl = el("status");
const legendEl = el("legend");
const langFilterEl = el("lang-filter");

// state
let colorMode = "relation";       // "relation" | "family"
let isInfluenceView = true;
let currentTerm = "";            // last searched term (for the language filter)
const coreIds = new Set();        // node ids from the current search/influence core
const expanded = new Set();       // node ids currently expanded
const expansions = new Map();     // nodeId -> { added:[ids], linkKeys:[keys] }

const lid = (x) => (typeof x === "object" && x ? x.id : x);
const linkKey = (l) => `${lid(l.source)}|${lid(l.target)}|${l.reltype}`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function setStatus(html, isError = false) {
  statusEl.innerHTML = html;
  statusEl.classList.toggle("error", isError);
}
const spinner = (text) => setStatus(`<span class="spinner"></span>${text}`);

// ------------------------------------------------------------ data layer -----
// Shared neighborhood builder for the static source (mirrors the Worker).
function buildGraph(rows, seedIds, metaById, seedDepth = 0) {
  const seedSet = new Set(seedIds);
  const nodes = new Map();
  const links = [];
  const linkSeen = new Set();
  const addNode = (id, term, lang, depth) => {
    if (!id) return;
    if (!nodes.has(id)) {
      const m = metaById.get(id) || {};
      nodes.set(id, { id, term, lang, family: m.family || "Unknown", era_rank: m.era_rank ?? 5, depth });
    } else if (depth < nodes.get(id).depth) nodes.get(id).depth = depth;
  };
  for (const r of rows) {
    if (!r.related_term && !r.related_term_id) continue;
    const sid = r.term_id || `${r.lang}::${r.term}`;
    const tid = r.related_term_id || `${r.related_lang || "?"}::${r.related_term}`;
    addNode(sid, r.term, r.lang, seedSet.has(r.term_id) ? seedDepth : seedDepth + 1);
    addNode(tid, r.related_term, r.related_lang, seedSet.has(r.related_term_id) ? seedDepth : seedDepth + 1);
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
    const gz = await fetch(WEB_DB_URL).then((r) => {
      if (!r.ok) throw new Error(`could not load ${WEB_DB_URL} (${r.status})`);
      return r.arrayBuffer();
    });
    const bytes = fflate.gunzipSync(new Uint8Array(gz));
    this.db = new SQL.Database(bytes);
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
  // one hop in both directions from seedIds, with family+era attached
  neighborhood(seedIds, seedDepth = 0) {
    if (seedIds.length === 0) return { nodes: [], links: [] };
    const ph = seedIds.map(() => "?").join(",");
    const cols = `term_id, term, lang, reltype, reltype_class, related_term_id, related_term, related_lang`;
    const rows = this.query(`SELECT ${cols} FROM edges WHERE term_id IN (${ph})`, seedIds)
      .concat(this.query(`SELECT ${cols} FROM edges WHERE related_term_id IN (${ph})`, seedIds));
    const ids = new Set();
    for (const r of rows) { if (r.term_id) ids.add(r.term_id); if (r.related_term_id) ids.add(r.related_term_id); }
    const metaById = new Map();
    const idList = [...ids];
    if (idList.length) {
      const fph = idList.map(() => "?").join(",");
      for (const t of this.query(`SELECT term_id, family, era_rank FROM terms WHERE term_id IN (${fph})`, idList))
        metaById.set(t.term_id, t);
    }
    return buildGraph(rows, seedIds, metaById, seedDepth);
  },
  async word(q, lang) {
    await this.init();
    const sql = lang
      ? `SELECT term_id, term, lang, family, era_rank FROM terms WHERE term = ? COLLATE NOCASE AND lang = ? LIMIT 200`
      : `SELECT term_id, term, lang, family, era_rank FROM terms WHERE term = ? COLLATE NOCASE LIMIT 200`;
    const matches = this.query(sql, lang ? [q, lang] : [q]);
    if (matches.length === 0) return { query: q, nodes: [], links: [], matchLangs: [] };

    const seedIds = matches.map((m) => m.term_id);
    const seedSet = new Set(seedIds);
    const g = this.neighborhood(seedIds, 0);

    // second hop along ancestry only → sibling cognates under shared ancestors
    const ancestorIds = [];
    const seenAnc = new Set();
    for (const l of g.links) {
      if (seedSet.has(l.source) && ANCESTRY.has(l.reltype_class) &&
          !String(l.target).includes("::") && !seenAnc.has(l.target)) {
        seenAnc.add(l.target);
        ancestorIds.push(l.target);
      }
    }
    if (ancestorIds.length) mergeGraphs(g, this.neighborhood(ancestorIds, 1));

    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const m of matches) {
      const n = byId.get(m.term_id);
      if (n) { n.depth = 0; n.family = m.family || n.family; n.era_rank = m.era_rank ?? n.era_rank; }
      else g.nodes.push({ id: m.term_id, term: m.term, lang: m.lang, family: m.family || "Unknown", era_rank: m.era_rank ?? 5, depth: 0 });
    }
    const matchLangs = [...new Set(matches.map((m) => m.lang))].sort();
    return { query: q, nodes: g.nodes, links: g.links, matchLangs };
  },
  async expand(id) {
    await this.init();
    return this.neighborhood([id], 0);
  },
};

const ApiSource = {
  async influence() { return fetch(`${API_BASE}/influence`).then((r) => r.json()); },
  async word(q, lang) {
    const u = new URL(`${API_BASE}/word`);
    u.searchParams.set("q", q);
    if (lang) u.searchParams.set("lang", lang);
    const d = await fetch(u).then((r) => r.json());
    d.matchLangs = [...new Set((d.nodes || []).filter((n) => n.depth === 0).map((n) => n.lang))].sort();
    return d;
  },
  async expand(id) {
    const u = new URL(`${API_BASE}/expand`);
    u.searchParams.set("id", id);
    return fetch(u).then((r) => r.json());
  },
};

const source = DATA_SOURCE === "api" ? ApiSource : StaticSource;

// dedupe-merge graph b into a (mutates a)
function mergeGraphs(a, b, cap = MAX_WORD_NODES) {
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) {
    if (byId.has(n.id)) { const e = byId.get(n.id); if (n.depth < e.depth) e.depth = n.depth; }
    else if (a.nodes.length < cap) { a.nodes.push(n); byId.set(n.id, n); }
  }
  const seen = new Set(a.links.map(linkKey));
  for (const l of b.links) {
    if (byId.has(lid(l.source)) && byId.has(lid(l.target)) && !seen.has(linkKey(l))) {
      a.links.push(l); seen.add(linkKey(l));
    }
  }
  return a;
}

// ---------------------------------------------------------------- graph ------
const Graph = ForceGraph3D()(el("graph"))
  .showNavInfo(false)           // built-in hint would be wrong after the button swap
  .backgroundColor("#0a0c10")
  .nodeRelSize(4)
  .nodeOpacity(0.95)
  .nodeVal((n) => n.__val || 1)
  .nodeColor(nodeColor)
  .nodeLabel(nodeLabel)
  .linkColor(linkColor)
  .linkWidth(linkWidth)
  .linkOpacity(0.5)
  .linkLabel(linkLabel)
  .onNodeClick(onNodeClick);
Graph.width(window.innerWidth).height(window.innerHeight);
window.addEventListener("resize", () => Graph.width(window.innerWidth).height(window.innerHeight));

// Swap drag buttons: left-drag pans, right-drag rotates (TrackballControls
// defaults to the reverse). Re-applied on a tick in case controls init late.
function swapDragButtons() {
  const c = Graph.controls();
  if (!c || !c.mouseButtons) return false;
  const { LEFT, RIGHT } = c.mouseButtons;
  c.mouseButtons.LEFT = RIGHT;
  c.mouseButtons.RIGHT = LEFT;
  return true;
}
if (!swapDragButtons()) setTimeout(swapDragButtons, 0);

// Re-orient the camera to a clean front view: world X horizontal, Y vertical,
// looking straight down the Z axis at the graph's center, pulled back far
// enough to frame the whole graph.
function reorientToX() {
  const ns = Graph.graphData().nodes;
  const c = { x: 0, y: 0, z: 0 };
  let halfW = 0, halfH = 0, halfD = 0;
  if (ns.length) {
    let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity, zn = Infinity, zx = -Infinity;
    for (const n of ns) {
      const x = n.x || 0, y = n.y || 0, z = n.z || 0;
      if (x < xn) xn = x; if (x > xx) xx = x;
      if (y < yn) yn = y; if (y > yx) yx = y;
      if (z < zn) zn = z; if (z > zx) zx = z;
    }
    c.x = (xn + xx) / 2; c.y = (yn + yx) / 2; c.z = (zn + zx) / 2;
    halfW = (xx - xn) / 2; halfH = (yx - yn) / 2; halfD = (zx - zn) / 2;
  }
  const cam = Graph.camera();
  cam.up.set(0, 1, 0);
  const fovV = ((cam.fov || 50) * Math.PI) / 180;
  const aspect = (Graph.width() || window.innerWidth) / (Graph.height() || window.innerHeight);
  const t = Math.tan(fovV / 2) || 0.5;
  const fit = Math.max(halfH / t, halfW / (t * aspect)) * 1.15 + halfD;
  Graph.cameraPosition({ x: c.x, y: c.y, z: c.z + (fit || 600) }, c, 700);
}

function nodeColor(n) {
  if (colorMode === "family") return familyColor(n.family);
  if (isInfluenceView) return "#9fb3cc";
  return n.__relColor || "#9fb3cc";
}
function linkColor(l) {
  if (colorMode === "family") return "rgba(150,170,200,0.30)";
  return RELATION_COLORS[l.reltype_class] || RELATION_COLORS.other;
}
function linkWidth(l) {
  if (l.weight) { // influence: thickness ∝ log(weight), scaled so the heaviest edge hits maxLinkWidth
    const t = Math.log10(l.weight + 1) / Math.log10(maxInfluenceWeight + 1);
    return Math.max(0.5, t * SETTINGS.maxLinkWidth);
  }
  const w = ANCESTRY.has(l.reltype_class) ? 1.4 : 0.7;                 // word: ancestry a touch bolder
  return Math.min(w, SETTINGS.maxLinkWidth);
}
function nodeLabel(n) {
  const era = ERA_LABEL[n.era_rank] || "";
  if (isInfluenceView) return `<b>${esc(n.term)}</b> · <span style="color:#6ea8fe">${esc(n.family)}</span> · ${esc(era)}`;
  return `<b>${esc(n.term)}</b> <span style="color:#6ea8fe;font-family:monospace">${esc(n.lang || "")}</span><br><span style="color:#8b97a8">${esc(era)}</span>`;
}
function linkLabel(l) {
  if (l.weight) return `${esc(l.reltype_class)} · ${l.weight.toLocaleString()}`;
  return esc((l.reltype || "").replace(/_/g, " "));
}
const ERA_LABEL = { 0: "Proto (root)", 1: "Proto", 2: "Ancient", 3: "Old", 4: "Middle", 5: "Modern" };

// color each term node in relation mode by the class of its strongest link
function decorateRelColors(nodes, links) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const PRI = { root: 5, inherited: 4, borrowed: 3, derived: 2, cognate: 1, other: 0 };
  nodes.forEach((n) => { n.__relColor = "#9fb3cc"; n.__relPri = -1; });
  for (const l of links) {
    const c = RELATION_COLORS[l.reltype_class] || RELATION_COLORS.other;
    const p = PRI[l.reltype_class] ?? 0;
    const t = byId.get(lid(l.target));
    if (t && t.__relPri < p) { t.__relColor = c; t.__relPri = p; }
  }
}

// ------------------------------------------------------ layout (era-lock) ----
// Assign each influence node a family index (0 = largest family) and a slot
// within that family, so circular positions can be recomputed cheaply when the
// settings sliders move. Families are ranked by total incoming weight.
function assignFamilyLayout(nodes) {
  const byFamily = new Map();
  for (const n of nodes) (byFamily.get(n.family) || byFamily.set(n.family, []).get(n.family)).push(n);
  const fams = [...byFamily.keys()].sort((a, b) => {
    const w = (f) => byFamily.get(f).reduce((s, n) => s + (n.__weight || 0), 0);
    return w(b) - w(a);
  });
  fams.forEach((f, fi) => {
    const arr = byFamily.get(f);
    arr.forEach((n, j) => { n.__famI = fi; n.__slot = j; n.__slotN = arr.length; });
  });
}

// Center of family circle `fi` in the X/Z plane: a phyllotaxis spiral so fi=0
// lands at the origin and the rest pack outward with even spacing.
function familyCenter(fi) {
  const r = SETTINGS.circleDistance * Math.sqrt(fi);
  const a = fi * GOLDEN_ANGLE;
  return { x: r * Math.cos(a), z: r * Math.sin(a) };
}

function applyLayout(nodes, links) {
  for (const n of nodes) {
    n.fy = (MAX_ERA - (n.era_rank ?? 5)) * SETTINGS.levelGap;
    if (isInfluenceView) {
      const c = familyCenter(n.__famI || 0);
      if ((n.__slotN || 1) <= 1) { n.fx = c.x; n.fz = c.z; }
      else {
        const a = (n.__slot / n.__slotN) * Math.PI * 2;
        n.fx = c.x + SETTINGS.circleRadius * Math.cos(a);
        n.fz = c.z + SETTINGS.circleRadius * Math.sin(a);
      }
      n.x = n.fx; n.z = n.fz;            // snap so changes read instantly
    } else { delete n.fx; delete n.fz; } // free X/Z in the word view
    n.y = n.fy;
  }
  if (!isInfluenceView) applyTiebreaker(nodes, links);
}

// Within one era band, nudge nodes deeper in the ancestry chain slightly higher
// so a derived-from chain (e.g. Old Norse above Old English) reads top-to-bottom
// without breaking the era banding. Bounded to < LEVEL_GAP.
function applyTiebreaker(nodes, links) {
  const depth = new Map();
  nodes.forEach((n) => depth.set(n.id, n.depth === 0 ? 0 : Infinity));
  const anc = links.filter((l) => ANCESTRY.has(l.reltype_class)).map((l) => [lid(l.source), lid(l.target)]);
  let changed = true, guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (const [s, t] of anc) {
      const ds = depth.get(s);
      if (ds != null && ds !== Infinity && ds + 1 < (depth.get(t) ?? Infinity)) { depth.set(t, ds + 1); changed = true; }
    }
  }
  const groups = new Map();
  for (const n of nodes) { const e = n.era_rank ?? 5; (groups.get(e) || groups.set(e, []).get(e)).push(n); }
  for (const arr of groups.values()) {
    const ds = [...new Set(arr.map((n) => { const d = depth.get(n.id); return d == null || d === Infinity ? 0 : d; }))].sort((a, b) => a - b);
    if (ds.length <= 1) continue;
    const rankOf = new Map(ds.map((d, i) => [d, i]));
    const span = ds.length - 1;
    for (const n of arr) {
      let d = depth.get(n.id); if (d == null || d === Infinity) d = 0;
      n.fy += (rankOf.get(d) / span) * (SETTINGS.levelGap * TIEBREAK_FRAC);
    }
  }
}

function commit(nodes, links) {
  applyLayout(nodes, links);
  if (colorMode === "relation" && !isInfluenceView) decorateRelColors(nodes, links);
  Graph.cooldownTicks(140).graphData({ nodes, links });
}

// ------------------------------------------------------------- rendering -----
function renderInfluence(data) {
  isInfluenceView = true;
  resetInteractionState();
  langFilterWrap(false);
  const incoming = new Map();
  for (const e of data.edges) incoming.set(e.target, (incoming.get(e.target) || 0) + e.weight);
  const nodes = data.languages.map((l) => ({
    id: l.id, term: l.name, lang: l.id, family: l.family, era_rank: l.era_rank ?? 5,
    __weight: incoming.get(l.id) || 0,
    __val: Math.max(1, Math.log10((incoming.get(l.id) || 0) + 10) * 3),
  }));
  const links = data.edges.map((e) => ({
    source: e.source, target: e.target, reltype: e.reltype_class, reltype_class: e.reltype_class, weight: e.weight,
  }));
  maxInfluenceWeight = Math.max(1, ...links.map((l) => l.weight || 0));
  assignFamilyLayout(nodes);
  const familyCount = new Set(nodes.map((n) => n.family)).size;
  nodes.forEach((n) => coreIds.add(n.id));
  commit(nodes, links);
  setStatus(`Influence graph — ${nodes.length} languages in ${familyCount} family circles, ` +
            `largest family centered, stacked by era (proto/old on top). Search a word to explore it.`);
  renderLegend();
  frameGraph();
}

function renderWord(data, query) {
  isInfluenceView = false;
  resetInteractionState();
  currentTerm = query;
  if (!data.nodes || data.nodes.length === 0) {
    Graph.graphData({ nodes: [], links: [] });
    langFilterWrap(false);
    setStatus(`No matches for <code>${esc(query)}</code>. Try another word — the static ` +
              `database covers a curated set of languages.`, true);
    return;
  }
  sizeByDepth(data.nodes);
  data.nodes.forEach((n) => coreIds.add(n.id));
  commit(data.nodes, data.links);
  populateLangFilter(data.matchLangs);
  const langs = new Set(data.nodes.map((n) => n.lang)).size;
  setStatus(`<code>${esc(query)}</code> — ${data.nodes.length} terms across ${langs} languages, ` +
            `leveled by era. Click a node to expand; click it again to collapse.`);
  renderLegend();
  frameGraph();
}

function sizeByDepth(nodes) {
  for (const n of nodes) n.__val = n.depth === 0 ? 6 : n.depth === 1 ? 2.6 : 1.6;
}
function resetInteractionState() {
  coreIds.clear(); expanded.clear(); expansions.clear();
}
function frameGraph() { setTimeout(() => Graph.zoomToFit(600, 90), 700); }

// --------------------------------------------------- expand / collapse -------
function onNodeClick(node) {
  if (isInfluenceView || !node || String(node.id).includes("::")) return;
  if (expanded.has(node.id)) collapseNode(node);
  else expandNode(node);
}

function expandNode(node) {
  spinner(`Expanding ${esc(node.term)}…`);
  Promise.resolve(source.expand(node.id)).then((res) => {
    const { nodes, links } = Graph.graphData();
    const haveNodes = new Set(nodes.map((n) => n.id));
    const haveLinks = new Set(links.map(linkKey));
    const added = [];
    for (const n of res.nodes) if (!haveNodes.has(n.id)) { nodes.push(n); haveNodes.add(n.id); added.push(n.id); n.__val = n.__val || 2; }
    const addedLinks = [];
    for (const l of res.links) {
      const k = linkKey(l);
      if (!haveLinks.has(k) && haveNodes.has(lid(l.source)) && haveNodes.has(lid(l.target))) {
        links.push(l); haveLinks.add(k); addedLinks.push(k);
      }
    }
    expansions.set(node.id, { added, linkKeys: addedLinks });
    expanded.add(node.id);
    commit(nodes, links);
    setStatus(`Expanded <code>${esc(node.term)}</code> (+${added.length}). Click it again to collapse.`);
  }).catch((e) => setStatus(`Expand failed: ${esc(e.message)}`, true));
}

// Remove what this expansion introduced, keeping anything still reachable from
// the search core or another live expansion (shared ancestors survive).
function collapseNode(node) {
  const rec = expansions.get(node.id);
  if (!rec) return;
  expansions.delete(node.id);
  expanded.delete(node.id);
  const { nodes, links } = Graph.graphData();
  const removedLinks = new Set(rec.linkKeys);
  const surviving = links.filter((l) => !removedLinks.has(linkKey(l)));

  const adj = new Map();
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); };
  for (const l of surviving) { link(lid(l.source), lid(l.target)); link(lid(l.target), lid(l.source)); }

  const present = new Set(nodes.map((n) => n.id));
  const keep = new Set();
  const stack = [...coreIds, ...expanded].filter((id) => present.has(id));
  for (const id of stack) keep.add(id);
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adj.get(cur) || []) if (!keep.has(nb)) { keep.add(nb); stack.push(nb); }
  }
  const newNodes = nodes.filter((n) => keep.has(n.id));
  const keepIds = new Set(newNodes.map((n) => n.id));
  const newLinks = surviving.filter((l) => keepIds.has(lid(l.source)) && keepIds.has(lid(l.target)));
  // drop now-orphaned expansion records (their anchor disappeared)
  for (const eid of [...expansions.keys()]) if (!keepIds.has(eid)) { expansions.delete(eid); expanded.delete(eid); }
  commit(newNodes, newLinks);
  setStatus(`Collapsed <code>${esc(node.term)}</code> (−${nodes.length - newNodes.length}).`);
}

// --------------------------------------------------------- language filter ---
function populateLangFilter(matchLangs) {
  if (!langFilterEl) return;
  if (!matchLangs || matchLangs.length <= 1) { langFilterWrap(false); return; }
  langFilterEl.innerHTML = `<option value="">All languages (${matchLangs.length})</option>` +
    matchLangs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  langFilterWrap(true);
}
function langFilterWrap(show) {
  if (langFilterEl) langFilterEl.hidden = !show;
}

// --------------------------------------------------------------- legend ------
function renderLegend() {
  let items;
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
  const { nodes, links } = Graph.graphData();
  if (colorMode === "relation" && !isInfluenceView) decorateRelColors(nodes, links);
  Graph.nodeColor(nodeColor).linkColor(linkColor);
  renderLegend();
});

function parseQuery(raw) {
  const m = raw.match(/^(.*?)\s*@\s*(.+)$/);   // "knife @ English" shorthand
  if (m) return { term: m[1].trim(), lang: m[2].trim() };
  return { term: raw.trim(), lang: "" };
}

function runSearch(term, lang) {
  if (!term) return;
  spinner(`Searching “${esc(term)}”${lang ? ` in ${esc(lang)}` : ""}…`);
  Promise.resolve(source.word(term, lang))
    .then((data) => renderWord(data, term))
    .catch((err) => setStatus(`Search failed: ${esc(err.message)}`, true));
}

el("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const { term, lang } = parseQuery(el("search-input").value);
  runSearch(term, lang);
});

if (langFilterEl) langFilterEl.addEventListener("change", () => runSearch(currentTerm, langFilterEl.value));
el("reset-btn").addEventListener("click", loadInfluence);
el("search-input").addEventListener("focus", () => el("panel").classList.remove("collapsed"));

// ----------------------------------------------------------- settings --------
// Re-apply the current layout settings to whatever graph is on screen.
function relayout() {
  const { nodes, links } = Graph.graphData();
  if (isInfluenceView) assignFamilyLayout(nodes);
  applyLayout(nodes, links);
  Graph.cooldownTicks(60).graphData({ nodes, links });
}

const SETTINGS_INPUTS = [
  { id: "set-radius", key: "circleRadius", out: "out-radius" },
  { id: "set-dist", key: "circleDistance", out: "out-dist" },
  { id: "set-level", key: "levelGap", out: "out-level" },
  { id: "set-width", key: "maxLinkWidth", out: "out-width" },
];
for (const s of SETTINGS_INPUTS) {
  const input = el(s.id), out = el(s.out);
  if (!input) continue;
  input.value = SETTINGS[s.key];
  if (out) out.textContent = SETTINGS[s.key];
  input.addEventListener("input", () => {
    SETTINGS[s.key] = Number(input.value);
    if (out) out.textContent = input.value;
    if (s.key === "maxLinkWidth") Graph.linkWidth(linkWidth); // width-only: no relayout
    else relayout();
  });
}

el("settings-toggle").addEventListener("click", () => {
  const p = el("settings-panel");
  p.hidden = !p.hidden;
  el("settings-toggle").classList.toggle("active", !p.hidden);
});

el("reorient-btn").addEventListener("click", reorientToX);

// ----------------------------------------------------------------- boot ------
function loadInfluence() {
  spinner("Loading influence graph…");
  Promise.resolve(source.influence())
    .then(renderInfluence)
    .catch((err) => setStatus(`Could not load influence data: ${esc(err.message)}`, true));
}

loadInfluence();
