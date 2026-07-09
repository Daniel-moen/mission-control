// Mission Control panel v8 — single source of truth.
//
// Owns the viewer WebSocket to the relay, the latest fleet snapshot, the
// per-session streamed terminal screens, and every command the panel can
// issue. Wire protocol (JSON text frames over /ws?role=viewer&token=…):
//   in : { type:'snapshot', at, summary, agents, fleets, knownDirs, lastDir,
//          models, system? }                      ~1 Hz, resent ≥ every 10s
//   in : { type:'hostState', online }             relay → Mac link changes
//   in : { type:'ack', ok, cmd, detail }          command results
//   in : { type:'screen', sessionId, seq, text }  full terminal buffer for a
//                                                 session we hold a watch lease on
//   out: { type:'reply'|'broadcast'|'kill'|'key'|'launch', ... }
//   out: { type:'watch', sessionId }              lease heartbeat (~3s)
//
// NEW snapshot fields (system, per-agent pid/cpu/mem/branch/alive) may be
// ABSENT when an older Mac host connects — every consumer degrades gracefully.

const LS_TOKEN = 'mc_token';

export const mc = $state({
  token: '',
  link: 'offline', // 'offline' | 'relay' | 'linked'
  needsToken: false,

  snapshot: null,
  agents: [], // sorted: working → needs-you → exited → done, then by name
  summary: {},
  fleets: [],
  system: null, // { cpu, cores, memUsedMB, memTotalMB } or null (older host)

  activity: [], // { t, folder, text } — newest last, capped
  tps: [], // rolling fleet tokens/sec, one sample per snapshot, capped
  history: [], // { t, tps, cost, tokens, active } — for the timeseries graph, capped

  models: [],
  knownDirs: [],
  lastDir: '',

  // Plan library — markdown files in ~/.mission-control/plans on the Mac.
  plans: [], // metadata from the snapshot: { id, title, dir, folder, session, preview, created, updatedAt }
  planDocs: {}, // id → { content, title, dir, updatedAt, at } — bodies fetched via planGet
  lastCreatedPlanId: '', // set by a planCreate ack so the Plans tab can open it

  screens: {}, // sessionId → { seq, text, at } — streamed watch-lease frames

  filter: 'all', // dashboard status filter — lives here so the strip chips drive it
  toast: '',
  lastSnapshotAt: 0,
  now: Date.now(), // 1 Hz clock for staleness ages ("live" / "6s ago")
});

export const PANEL_BUILD = 'v11 · 2026-07-09 · plans';

// ---- status helpers ---------------------------------------------------------
// v8 status semantics: working = cyan, needs-you = amber, done = green,
// exited = neutral/red tint. An agent whose process died (`alive === false`)
// before reporting done is "exited" — it needs eyes, not celebration.
export function statusClass(s) {
  return s === 'active' ? 'working' : s === 'idle' ? 'waiting' : 'done';
}
export function agentStatus(a) {
  if (a && a.alive === false && a.status !== 'done') return 'exited';
  return statusClass(a?.status);
}
function statusRank(cls) {
  return cls === 'working' ? 0 : cls === 'waiting' ? 1 : cls === 'exited' ? 2 : 3;
}
export function statusLabel(cls) {
  return cls === 'working' ? 'Working' : cls === 'waiting' ? 'Needs you' : cls === 'exited' ? 'Exited' : 'Done';
}
export function fmtTokens(n) {
  n = n ?? 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
export function fmtInt(n) {
  return (n ?? 0).toLocaleString();
}
export function fmtMem(mb) {
  if (mb == null) return '';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}
export function counts(agents) {
  const c = { working: 0, waiting: 0, done: 0, exited: 0 };
  for (const a of agents) c[agentStatus(a)]++;
  return c;
}
export function agentById(id) {
  return mc.agents.find((a) => a.id === id) || null;
}
// Display title. `name` is Claude Code's own per-session name (unique-ish; THE
// way to tell two agents in the same folder apart) — newer hosts only, so fall
// back to the folder. When a name exists, folder/branch demote to metadata.
export function agentName(a) {
  return a?.name || a?.folder || '';
}

// ---- fleet grouping ---------------------------------------------------------
// Fold the flat agent list into fleet units. Agents that share a `fleetId` are
// one unit (the manager + its workers); everything else is a solo agent. Input
// `agents` is expected already sorted, so member order stays stable (no flicker
// — see commit 9b298f0). Returns { groups, solo }; a group only counts as a
// fleet in the UI once it has ≥2 members — the caller folds singletons back in.
export function groupFleets(agents, fleets) {
  const order = new Map((fleets || []).map((f, i) => [f.id, i]));
  const byId = new Map();
  const ensure = (id, fleet) => {
    let g = byId.get(id);
    if (!g) {
      g = { id, fleet: fleet || null, manager: null, workers: [] };
      byId.set(id, g);
    }
    if (fleet && !g.fleet) g.fleet = fleet;
    return g;
  };
  (fleets || []).forEach((f) => ensure(f.id, f));

  const solo = [];
  for (const a of agents) {
    if (a.fleetId) {
      const g = ensure(a.fleetId, null);
      if (a.isManager && !g.manager) g.manager = a;
      else g.workers.push(a);
    } else {
      solo.push(a);
    }
  }
  const groups = [...byId.values()]
    .filter((g) => g.manager || g.workers.length)
    .sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9));
  return { groups, solo };
}

// Members of a group in render order: manager first, then workers.
export function fleetMembers(g) {
  return g.manager ? [g.manager, ...g.workers] : g.workers;
}

// Aggregate todo completion across every member of a fleet.
export function fleetProgress(g) {
  let done = 0;
  let total = 0;
  for (const a of fleetMembers(g)) {
    const td = a.todos || [];
    total += td.length;
    done += td.filter((t) => t.status === 'completed').length;
  }
  return total ? { done, total, pct: Math.round((100 * done) / total) } : null;
}
export function clockOf(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- terminal scrubbing -----------------------------------------------------
// Strip the Claude Code TUI chrome (spinner, tips, input box, footer) so the
// mirror shows only the conversation. Ported verbatim from v6.
const SPINNER_RX = /^\s*[✢✳✶✻✽·∗＊+*]\s*\S+…/;
const BOXTOP_RX = /^\s*[╭┌][─┄╌]/;
const RULE_RX = /^[\s]*[─━_]{8,}[\s]*$/;
const FOOTER_RX =
  /auto mode on|shift\+tab to cycle|esc to interrupt|\? for shortcuts|accept edits|bypass permissions|plan mode on|for agents$/i;

export function cleanScreen(raw) {
  if (!raw) return raw;
  const lines = String(raw).replace(/\s+$/, '').split('\n');
  const win = Math.max(0, lines.length - 16);
  let cut = lines.length;
  for (let i = win; i < lines.length; i++) {
    if (SPINNER_RX.test(lines[i])) {
      cut = i;
      break;
    }
  }
  if (cut === lines.length) {
    for (let i = win; i < lines.length; i++) {
      if (BOXTOP_RX.test(lines[i]) || RULE_RX.test(lines[i])) {
        cut = i;
        break;
      }
    }
  }
  let kept = lines.slice(0, cut);
  const tail = Math.max(0, kept.length - 8);
  kept = kept.filter((l, i) => i < tail || (!FOOTER_RX.test(l) && !/^\s*[❯>]\s*$/.test(l)));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

// ---- interactive prompt detection -------------------------------------------
// Claude Code (and plain CLI tools) pause on numbered selection menus —
// permission asks, plan approval, "which option?" questions. cleanScreen() hides
// the box, so we parse the RAW screen here and surface tappable options. Returns
// { question, options:[{n,label,selected}] } or null when there's no menu.
// Handles both the classic boxed permission/approval prompt ("❯ 1. Yes …") and
// the AskUserQuestion picker (numbered "N. [ ] Label" rows each followed by a
// description, a ──── divider, and an "Enter to select · ↑/↓ to navigate"
// footer). Returns { question, options:[{n,label,desc,selected,checked}] }.
export function parsePrompt(screen) {
  if (!screen) return null;
  const all = String(screen).replace(/\s+$/, '').split('\n');
  const lines = all.slice(-40); // menus live at the bottom of the screen
  const optRx = /^[\s│|]*([❯>›])?\s*(\d{1,2})[.)]\s+(.+?)[\s│|]*$/;

  // Every "N. label" line in the tail (options aren't contiguous — descriptions
  // and dividers sit between them).
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(optRx);
    if (m) raw.push({ i, n: +m[2], selected: !!m[1], text: m[3] });
  }
  if (raw.length < 2) return null;

  // Keep the trailing block whose numbers run 1,2,3,… — that's the real menu,
  // not a stray numbered list up in the scrollback.
  let opts = [];
  for (const o of raw) {
    if (opts.length === 0) { if (o.n === 1) opts = [o]; }
    else if (o.n === opts[opts.length - 1].n + 1) opts.push(o);
    else if (o.n === 1) opts = [o];
  }
  if (opts.length < 2) return null;
  if (opts[opts.length - 1].i < lines.length - 10) return null; // must end near the bottom

  const cbRx = /^\[[ xX✔✓·]?\]\s*/; // an AskUserQuestion checkbox prefix
  const hintRx = /(Enter to|to navigate|to select|esc to|shift\+tab|↑\/↓)/i;
  const nextI = (k) => (k + 1 < opts.length ? opts[k + 1].i : lines.length);
  for (let k = 0; k < opts.length; k++) {
    const o = opts[k];
    o.checkbox = cbRx.test(o.text); // did this row render a [ ] / [x] box?
    o.checked = /^\[[xX✔✓]\]/.test(o.text);
    o.label = o.text.replace(cbRx, '').replace(/\s*\(esc\)\s*$/i, '').trim();
    const desc = [];
    for (let j = o.i + 1; j < nextI(k); j++) {
      const t = lines[j].replace(/[│|]/g, '').trim();
      if (!t) continue;
      if (/^[─━]{4,}$/.test(t) || hintRx.test(t)) break;
      desc.push(t);
    }
    o.desc = desc.join(' ').slice(0, 200);
  }

  // The question: the contiguous text block just above the first option, minus
  // tab headers ("← ☐ Goal ✔ Submit →") and nav hints.
  const qlines = [];
  for (let j = opts[0].i - 1; j >= 0 && j > opts[0].i - 12; j--) {
    const t = lines[j].replace(/[│|╭╮╰╯]/g, '').replace(/^[\s►❯]+/, '').trim();
    if (!t || /^[─━]{4,}$/.test(t)) { if (qlines.length) break; else continue; }
    if (hintRx.test(t) || /^[←→]|✔ Submit|☐ /.test(t)) continue;
    qlines.unshift(t);
  }
  const question = qlines.join(' ').replace(/\s+/g, ' ').trim();

  // A checkbox on any row ⇒ it's a multi-select: the "chosen" rows are the
  // ticked ones, and ❯ is only the cursor. Otherwise ❯ marks the choice itself.
  const multi = opts.some((o) => o.checkbox);
  return {
    multi,
    question,
    options: opts.map((o) => ({ n: o.n, label: o.label, desc: o.desc, selected: o.selected, checked: o.checked, checkbox: o.checkbox })),
  };
}

// ---- attention --------------------------------------------------------------
// Which agents need a human right now, and why. Drives the amber attention
// queue on the home screen and the fleet auto-expand. Uses the snapshot's
// screen tail (refreshed ~3s) since queue rows hold no watch lease.
export function attentionInfo(a) {
  const st = agentStatus(a);
  if (st === 'exited') return { kind: 'exited', prompt: null };
  if (st !== 'waiting') return null;
  const prompt = parsePrompt(rawScreenFor(a));
  return { kind: prompt ? 'menu' : 'idle', prompt };
}
export function attentionList(agents) {
  const items = [];
  for (const a of agents) {
    const info = attentionInfo(a);
    if (info) items.push({ agent: a, ...info });
  }
  return items;
}

// ---- streamed screens & watch leases ----------------------------------------
// The workspace holds a "watch lease" on its session: we tell the host we're
// looking ({type:'watch'}) immediately, every 3s while open, and again on every
// reconnect; the host streams {type:'screen', sessionId, seq, text} frames
// (~400 lines incl. scrollback) at ~1 Hz while the lease is fresh. Leases are
// cheap — send liberally. The host expires them after 8s.
const watchLeases = new Map(); // sessionId → refcount
let watchTimer = null;

function sendWatch(sessionId) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'watch', sessionId }));
}
function sendAllWatches() {
  for (const id of watchLeases.keys()) sendWatch(id);
}
function syncWatchTimer() {
  if (watchLeases.size && !watchTimer) watchTimer = setInterval(sendAllWatches, 3000);
  else if (!watchLeases.size && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
// Acquire a lease; returns a release function. Refcounted so two views of the
// same session don't cancel each other.
export function watchAgent(sessionId) {
  watchLeases.set(sessionId, (watchLeases.get(sessionId) || 0) + 1);
  sendWatch(sessionId);
  syncWatchTimer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (watchLeases.get(sessionId) || 1) - 1;
    if (n <= 0) watchLeases.delete(sessionId);
    else watchLeases.set(sessionId, n);
    syncWatchTimer();
  };
}

function ingestScreen(msg) {
  if (!msg.sessionId || typeof msg.text !== 'string') return;
  const prev = mc.screens[msg.sessionId];
  // Drop out-of-order frames — but accept a sequence restart (host relaunch).
  if (prev && typeof msg.seq === 'number' && msg.seq <= prev.seq && msg.seq > prev.seq - 1000) return;
  mc.screens[msg.sessionId] = { seq: msg.seq ?? 0, text: msg.text, at: Date.now() };
}

// Best available RAW screen for an agent: streamed frame first (full buffer,
// 1 Hz), else the snapshot's ~50-line tail. NEVER returns blank because a frame
// didn't arrive — last-known text is kept until the agent leaves the board.
export function rawScreenFor(a) {
  const s = mc.screens[a?.id];
  return s?.text || a?.screen || '';
}
// { text, at, streamed } — `at` powers the staleness age in the terminal chrome.
export function screenInfoFor(a) {
  const s = mc.screens[a?.id];
  if (s?.text) return { text: s.text, at: s.at, streamed: true };
  return { text: a?.screen || '', at: mc.lastSnapshotAt, streamed: false };
}

// ---- per-agent burn sparklines ----------------------------------------------
// A rolling tokens/sec trace per agent for the card sparklines. Plain module
// Map (not $state) — cards already re-render each snapshot, so reads keyed off
// mc.lastSnapshotAt stay fresh without deep-proxying 50 arrays at 1 Hz.
const sparks = new Map(); // id → number[]
const SPARK_CAP = 30;
export function sparkOf(id) {
  return sparks.get(id) || [];
}
function trackSparks(agents) {
  const seen = new Set();
  for (const a of agents) {
    seen.add(a.id);
    let arr = sparks.get(a.id);
    if (!arr) sparks.set(a.id, (arr = []));
    arr.push(a.tokensPerSec ?? 0);
    if (arr.length > SPARK_CAP) arr.shift();
  }
  for (const id of sparks.keys()) if (!seen.has(id)) sparks.delete(id);
}

// ---- toast ------------------------------------------------------------------
let toastTimer = null;
export function toast(text) {
  mc.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (mc.toast = ''), 2600);
}

// ---- token ------------------------------------------------------------------
export function initToken() {
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    localStorage.setItem(LS_TOKEN, params.get('token'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  mc.token = localStorage.getItem(LS_TOKEN) || '';
  mc.needsToken = !mc.token;
  if (mc.token) connect();
}
export function saveToken(t) {
  t = (t || '').trim();
  if (!t) return;
  localStorage.setItem(LS_TOKEN, t);
  mc.token = t;
  mc.needsToken = false;
  connect();
}
export function changeToken() {
  mc.needsToken = true;
}
export function forgetToken() {
  localStorage.removeItem(LS_TOKEN);
  location.reload();
}

// ---- websocket + reliability layer ------------------------------------------
// iPad Safari suspends WebSockets in the background, and a suspended socket can
// come back as a zombie: open, silent, dead. Three defenses:
//   1. Reconnect with exponential backoff CAPPED at 5s (+ jitter) — never the
//      long tail that used to leave the panel stale for 15s+.
//   2. Reconnect IMMEDIATELY (skip backoff) on visibilitychange→visible,
//      pageshow and online — the moments Safari hands the page back.
//   3. Watchdog: the host resends snapshots at least every 10s, so a linked
//      panel that hasn't heard one in >12s is on a zombie socket — close it and
//      redial. Link state stays honest the whole time.
let ws = null;
let retry = 0;
let relayUp = false;
let hostOnline = false;
let reconnectTimer = null;
let modelsKey = '';

const STALE_MS = 12000;

function snapshotFresh() {
  return mc.lastSnapshotAt && Date.now() - mc.lastSnapshotAt <= STALE_MS;
}
function setLink() {
  mc.link = hostOnline && snapshotFresh() ? 'linked' : relayUp ? 'relay' : 'offline';
}
// Seconds since the last snapshot, for the connection banner. Reads mc.now so
// consumers tick once a second.
export function dataAge() {
  if (!mc.lastSnapshotAt) return null;
  return Math.max(0, Math.round((mc.now - mc.lastSnapshotAt) / 1000));
}

export function connect() {
  if (!mc.token) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    // Replace, never stack: silence the old socket's handlers first.
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock;
  try {
    sock = new WebSocket(`${proto}://${location.host}/ws?role=viewer&token=${encodeURIComponent(mc.token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  ws.onopen = () => {
    retry = 0;
    relayUp = true;
    setLink();
    sendAllWatches(); // re-assert leases on every (re)connect
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      hostOnline = true;
      mc.lastSnapshotAt = Date.now();
      setLink();
      ingest(msg);
    } else if (msg.type === 'screen') {
      ingestScreen(msg);
    } else if (msg.type === 'plan') {
      ingestPlan(msg);
    } else if (msg.type === 'hostState') {
      hostOnline = msg.online;
      setLink();
    } else if (msg.type === 'ack') {
      handleAck(msg);
    }
  };
  ws.onclose = (e) => {
    if (ws !== sock) return; // an old, replaced socket — ignore
    ws = null;
    relayUp = false;
    hostOnline = false;
    setLink();
    if (e.code === 4001 || e.code === 1008) {
      mc.needsToken = true;
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => sock && sock.close();
}

function scheduleReconnect() {
  if (reconnectTimer || mc.needsToken || !mc.token) return;
  const base = Math.min(5000, 600 * Math.pow(2, retry++));
  const delay = base / 2 + Math.random() * (base / 2); // jitter, capped at 5s
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Skip the backoff entirely — used when the OS hands the page back to us.
export function reconnectNow() {
  if (!mc.token || mc.needsToken) return;
  retry = 0;
  if (ws && ws.readyState === 1) {
    // Socket claims to be open; if data is fresh, trust it. If stale, it's a
    // zombie — redial through the same path.
    if (hostOnline && !snapshotFresh()) connect();
    return;
  }
  connect();
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectNow();
  });
  window.addEventListener('pageshow', reconnectNow);
  window.addEventListener('online', reconnectNow);
}

// Watchdog + 1 Hz staleness clock. If the host is nominally online but silent
// past the heartbeat window, assume a zombie socket and redial.
setInterval(() => {
  mc.now = Date.now();
  if (ws && ws.readyState === 1 && hostOnline && mc.lastSnapshotAt && !snapshotFresh()) {
    connect(); // tears down the zombie and redials immediately
  }
  setLink(); // freshness feeds link state — keep it honest even with no events
}, 1000);

const lastActivity = new Map();
function trackActivity(a) {
  const act = (a.activity || '').trim();
  if (!act || act === '—') return;
  if (lastActivity.get(a.id) === act) return;
  lastActivity.set(a.id, act);
  // Keep the id: with `name`, two agents can share a folder, so the folder is
  // no longer a reliable back-reference. `who` is the display label.
  mc.activity.push({ t: Date.now(), id: a.id, folder: a.folder, who: agentName(a), text: act });
  if (mc.activity.length > 80) mc.activity.shift();
}

function ingest(s) {
  mc.snapshot = s;
  const sum = s.summary || {};
  mc.summary = sum;
  mc.fleets = s.fleets || [];
  mc.system = s.system && typeof s.system.cpu === 'number' ? s.system : null;

  mc.agents = [...(s.agents || [])].sort(
    (a, b) => statusRank(agentStatus(a)) - statusRank(agentStatus(b)) || String(a.folder).localeCompare(String(b.folder)),
  );
  mc.agents.forEach(trackActivity);
  trackSparks(mc.agents);

  // Drop streamed screens for sessions that left the board.
  const ids = new Set(mc.agents.map((a) => a.id));
  for (const id of Object.keys(mc.screens)) if (!ids.has(id)) delete mc.screens[id];

  mc.tps.push(sum.tokensPerSec ?? 0);
  if (mc.tps.length > 150) mc.tps.shift();

  // Richer rolling history for the timeseries graph. One sample per snapshot;
  // ~4 min of history at a 1 Hz snapshot cadence.
  mc.history.push({
    t: Date.now(),
    tps: sum.tokensPerSec ?? 0,
    cost: sum.totalCost ?? 0,
    tokens: sum.totalTokens ?? 0,
    active: sum.active ?? 0,
  });
  if (mc.history.length > 240) mc.history.shift();

  // Plan library metadata — replace only on real change so open views and the
  // list don't churn at 1 Hz. updatedAt moves when a file is written.
  const pk = (s.plans || []).map((p) => `${p.id}@${p.updatedAt}`).join('|');
  if (pk !== mc._plansKey) {
    mc._plansKey = pk;
    mc.plans = s.plans || [];
    // A plan that changed on disk (or vanished) invalidates its cached body.
    for (const id of Object.keys(mc.planDocs)) {
      const meta = mc.plans.find((p) => p.id === id);
      if (!meta || meta.updatedAt > (mc.planDocs[id].updatedAt ?? 0)) delete mc.planDocs[id];
    }
  }

  // Launch metadata — only replace when it actually changes so native pickers
  // don't get rebuilt mid-selection (Swift serialises dicts in unstable order).
  const dk = JSON.stringify(s.knownDirs || []);
  if (dk !== mc._dirsKey) {
    mc._dirsKey = dk;
    mc.knownDirs = s.knownDirs || [];
  }
  if (!mc.lastDir && s.lastDir) mc.lastDir = s.lastDir;
  const mk = (s.models || []).map((m) => m.flag).join('|');
  if (s.models && s.models.length && mk !== modelsKey) {
    modelsKey = mk;
    mc.models = s.models;
  }
}

function ingestPlan(msg) {
  if (!msg.id || typeof msg.content !== 'string') return;
  mc.planDocs[msg.id] = {
    content: msg.content,
    title: msg.title || '',
    dir: msg.dir || '',
    updatedAt: msg.updatedAt ?? 0,
    at: Date.now(),
  };
}

function handleAck(msg) {
  if (msg.cmd === 'planCreate') {
    if (msg.ok && msg.id) mc.lastCreatedPlanId = msg.id;
    toast(msg.ok ? 'Plan created' : `Couldn't create — ${msg.detail || 'unknown error'}`);
    return;
  }
  if (msg.cmd === 'planGet') {
    if (!msg.ok) toast(msg.detail || "Couldn't load that plan");
    return;
  }
  // The Launch sheet shows its own optimistic overlay on click, so a successful
  // launch ack needs no toast; only surface launch failures.
  if (msg.cmd === 'launch') {
    if (!msg.ok) toast(`Launch failed — ${msg.detail || 'unknown error'}`);
    return;
  }
  // Key presses succeed silently — the screen mirror visibly updates; only
  // surface a failure so a tap into thin air isn't confusing.
  if (msg.cmd === 'key') {
    if (!msg.ok) toast(`Couldn't send — ${msg.detail || 'unknown error'}`);
    return;
  }
  toast(msg.ok ? msg.detail || 'Delivered' : `Failed — ${msg.detail || 'unknown error'}`);
}

// ---- commands ---------------------------------------------------------------
function send(obj) {
  if (!ws || ws.readyState !== 1) {
    toast('Not connected');
    return false;
  }
  if (!hostOnline) {
    toast('Your Mac is offline');
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

export function reply(sessionId, text) {
  text = (text || '').trim();
  if (!text) return false;
  return send({ type: 'reply', sessionId, text });
}
export function broadcast(text) {
  text = (text || '').trim();
  if (!text) return false;
  const ok = send({ type: 'broadcast', text });
  if (ok) toast('Broadcast to all agents');
  return ok;
}
export function kill(sessionId) {
  return send({ type: 'kill', sessionId });
}
// Raw keystroke — a digit selects a numbered menu option; named keys ("up",
// "down", "enter", "esc") navigate/confirm. No trailing newline is added.
export function sendKey(sessionId, key) {
  return send({ type: 'key', sessionId, key: String(key) });
}
export function launch(payload) {
  return send({ type: 'launch', ...payload });
}
// ---- plan library commands ----
export function planGet(id) {
  return send({ type: 'planGet', id });
}
export function planSave(id, content) {
  const ok = send({ type: 'planSave', id, content });
  if (ok && mc.planDocs[id]) mc.planDocs[id] = { ...mc.planDocs[id], content }; // optimistic
  return ok;
}
export function planCreate({ title = '', dir = '', content = '' } = {}) {
  return send({ type: 'planCreate', title, dir, content });
}
export function planDelete(id) {
  const ok = send({ type: 'planDelete', id });
  if (ok) delete mc.planDocs[id];
  return ok;
}
export function stopAll() {
  const n = mc.agents.filter((a) => a.status !== 'done').length;
  if (!n) {
    toast('Nothing to stop');
    return;
  }
  send({ type: 'broadcast', text: 'Stop' });
  toast(`Sent “Stop” to ${n} agent${n === 1 ? '' : 's'}`);
}
