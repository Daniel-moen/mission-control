// Mission Control panel v23 — single source of truth (zustand).
//
// Owns the viewer WebSocket to the relay, the latest fleet snapshot, the
// per-session streamed terminal screens, and every command the panel can
// issue. Wire protocol (JSON text frames over /ws?role=viewer&token=…):
//   in : { type:'snapshot', at, summary, agents, fleets, knownDirs, lastDir,
//          models, docs, system?, mia? }          ~1 Hz, resent ≥ every 10s
//                                                 (mia: see the Mia section at the foot)
//   in : { type:'hostState', online }             relay → Mac link changes
//   in : { type:'ack', ok, cmd, detail, id? }     command results (id on
//                                                 docCreate + research acks)
//   in : { type:'screen', sessionId, seq, text, keep? }  terminal buffer for a
//                                                 session we hold a watch lease
//                                                 on; with `keep`, a delta on
//                                                 top of frame seq-1
//   in : { type:'doc', id, title, kind, status, subject, tags, dir, content,
//          updatedAt }                             a document body, replying to docGet
//   in : { type:'docSearchResult', q, hits:[{id, snippets}] }  library search
//   out: { type:'reply'|'broadcast'|'kill'|'key'|'launch', ... }
//   out: { type:'key', sessionId, key }           named keystroke (esc, up, ctrl-c, a digit)
//   out: { type:'key', sessionId, text }          literal typing from the console
//   out: { type:'watch', sessionId, hot }         lease heartbeat (~3s); hot ⇒ being typed into
//   out: document library — docGet/docSave/docCreate/docDelete/docMeta/
//        docSearch, and the one-shot `research` launch. Mia: miaSend/miaAnswer/
//        miaRead/miaTaskAdd/miaTaskCancel/miaTaskSet/miaStart/miaStop/
//        miaSetModel/miaSchedule/miaPushTest (docs/mia.md §8). See the command
//        section at the foot of this file for each frame's shape.
//
// Transport: the socket above is the normal path. Where a network blocks
// WebSocket upgrades (seen on an iPhone: the socket loops connecting → closed
// and the relay never sees it), the panel falls back to HTTP polling through
// the relay's REST API — same frames, same MC_TOKEN: GET /api/v1/snapshot
// every 1.5s, POST /api/v1/cmd per outgoing frame (the answering frame comes
// back in the response), GET /api/v1/screens for watched terminals. See the
// "HTTP polling fallback" section below.
//
// The document library lives in ~/.mission-control/library on the Mac as plain
// markdown files (kind: plan | research | note). The snapshot carries only each
// doc's METADATA (id/title/kind/status/subject/tags/dir/folder/preview/…); a
// body is pulled on demand with docGet and cached in `docDocs`, and invalidated
// the moment its `updatedAt` moves on disk — which is how a research agent's
// freshly-written report reaches the panel.
//
// NEW snapshot fields (system, per-agent pid/cpu/mem/branch/alive, docs) may be
// ABSENT when an older Mac host connects — every consumer degrades gracefully.
//
// React note: state lives in a zustand store, so every mutation goes through
// `useMC.setState` with NEW references for the fields that changed (never a
// mutation in place — nothing would re-render). `ingest()` runs at 1 Hz and
// screen frames arrive at up to 3 Hz per watched session, so each writer only
// sets the fields that actually moved.

import { create } from 'zustand';
import { stripAnsi } from './ansi.js';
import { fmtTokens, fmtInt, fmtMem, clockOf } from './format.js';

export { fmtTokens, fmtInt, fmtMem, clockOf };

const LS_TOKEN = 'mc_token';

export const useMC = create(() => ({
  token: '',
  link: 'offline', // 'offline' | 'relay' | 'linked'
  transport: 'ws', // 'ws' | 'poll' — poll = HTTP fallback when WebSockets can't get through
  needsToken: false,
  // Socket diagnostics for the #diag screen — what the panel can't otherwise
  // say out loud when a device won't connect.
  diag: {
    opens: 0, closes: 0, errors: 0, frames: 0, lastClose: null, lastFrameType: '', lastAttemptAt: 0, lastUrl: '',
    wsFails: 0, switchReason: '', switchedAt: 0,
    polls: 0, lastPollStatus: '', lastPollAt: 0, lastCmdStatus: '', lastCmdAt: 0,
  },

  snapshot: null,
  agents: [], // sorted: working → needs-you → exited → done, then by name
  summary: {},
  fleets: [],
  system: null, // { cpu, cores, memUsedMB, memTotalMB } or null (older host)

  activity: [], // { t, id, folder, who, text } — newest last, capped
  tps: [], // rolling fleet tokens/sec, one sample per snapshot, capped
  history: [], // { t, tps, cost, tokens, active } — for the timeseries graph, capped

  models: [],
  knownDirs: [],
  lastDir: '',
  localDirs: [], // folders launched into from this device, newest first (localStorage)

  // Document library — markdown files in ~/.mission-control/library on the Mac.
  docs: [], // metadata from the snapshot: { id, title, kind, status, subject, tags, dir, folder, session, preview, words, created, updatedAt }
  docDocs: {}, // id → { content, title, kind, status, subject, tags, dir, updatedAt, at } — bodies fetched via docGet
  lastCreatedDocId: '', // set by a docCreate/research ack so the Library can open it
  search: { q: '', hits: [], at: 0 }, // last full-text search: { id, snippets } hits from docSearch

  screens: {}, // sessionId → { seq, text, at } — streamed watch-lease frames

  // Mia, the persistent assistant (docs/mia.md). `mia` is the snapshot's block,
  // normalised; null when the host sends none (older Mac app, or not set up).
  mia: null,
  // Optimistic local echo so the thread and badge react before the next
  // snapshot: messages sent but not yet seen, answers given, read marker.
  miaLocal: { sent: [], answered: {}, readUpTo: '' },
  push: 'idle', // Web Push state for this device — see lib/push.js

  filter: 'all', // dashboard status filter — lives here so the strip chips drive it
  toast: '',
  lastSnapshotAt: 0,
  now: Date.now(), // 1 Hz clock for staleness ages ("live" / "6s ago")
}));

export const getMC = () => useMC.getState();
const set = (patch) => useMC.setState(patch);

export const PANEL_BUILD = 'v23 · 2026-09-22 · studio motion';

// ---- status helpers ---------------------------------------------------------
// Status semantics: working = green, needs-you = amber, done = quiet neutral,
// exited = red tint. An agent whose process died (`alive === false`) before
// reporting done is "exited" — it needs eyes, not celebration.
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
export function counts(agents) {
  const c = { working: 0, waiting: 0, done: 0, exited: 0 };
  for (const a of agents || []) c[agentStatus(a)]++;
  return c;
}
export function agentById(id) {
  return getMC().agents.find((a) => a.id === id) || null;
}
// Display title. `name` is Claude Code's own per-session name (unique-ish; THE
// way to tell two agents in the same folder apart) — newer hosts only, so fall
// back to the folder. When a name exists, folder/branch demote to metadata.
export function agentName(a) {
  return a?.name || a?.folder || '';
}

// ---- document library helpers -----------------------------------------------
// Pure lookups over the library metadata, shared by every view that renders a
// doc. `kind` and `status` cross the wire as the raw enum strings DocLibrary
// writes into frontmatter — map them here so the labels live in one place.
export function kindLabel(kind) {
  return kind === 'plan' ? 'Plan' : kind === 'research' ? 'Research' : 'Note';
}
// The icon NAME the UI looks up in its glyph set; an unknown kind degrades to
// the note glyph, matching DocLibrary's Kind(loose:).
export function kindIcon(kind) {
  return kind === 'plan' ? 'plan' : kind === 'research' ? 'research' : 'note';
}
// `statusLabel` above is the AGENT status; a doc's status is a different enum
// (draft/active/done/archived), so it gets its own name. `active` reads as
// "Working" because that's what it means — an agent is writing the doc now.
export function docStatusLabel(status) {
  return status === 'active' ? 'Working' : status === 'done' ? 'Done' : status === 'archived' ? 'Archived' : 'Draft';
}
// Every distinct tag across the library, sorted, for the tag filter chips.
export function allTags(docs) {
  const set_ = new Set();
  for (const d of docs || []) for (const t of d.tags || []) if (t) set_.add(t);
  return [...set_].sort((a, b) => a.localeCompare(b));
}
// Client-side filter for the library list. `kind`/`status`/`tag` of 'all' or ''
// impose no constraint; `q` is a case-insensitive substring over the fields a
// reader can see without opening the doc (title/subject/tags/preview) — the
// deep full-text search is the host's docSearch, this is the instant local sieve.
export function filterDocs(docs, { kind = 'all', status = 'all', tag = 'all', q = '' } = {}) {
  const query = (q || '').trim().toLowerCase();
  return (docs || []).filter((d) => {
    if (kind && kind !== 'all' && d.kind !== kind) return false;
    if (status && status !== 'all' && d.status !== status) return false;
    if (tag && tag !== 'all' && !(d.tags || []).includes(tag)) return false;
    if (!query) return true;
    const hay = `${d.title || ''} ${d.subject || ''} ${(d.tags || []).join(' ')} ${d.preview || ''}`.toLowerCase();
    return hay.includes(query);
  });
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
  for (const a of agents || []) {
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

// ---- terminal scrubbing -----------------------------------------------------
// Strip the Claude Code TUI chrome (spinner, tips, input box, footer) so the
// mirror shows only the conversation. Ported verbatim from v6.
// WezTerm captures carry ANSI color codes (rendered by the Terminal views), so
// every regex here runs against a code-stripped shadow of each line while the
// RAW line — colors and all — is what gets kept.
const SPINNER_RX = /^\s*[✢✳✶✻✽·∗＊+*]\s*\S+…/;
const BOXTOP_RX = /^\s*[╭┌][─┄╌]/;
const RULE_RX = /^[\s]*[─━_]{8,}[\s]*$/;
const FOOTER_RX =
  /auto mode on|shift\+tab to cycle|esc to interrupt|\? for shortcuts|accept edits|bypass permissions|plan mode on|for agents$/i;

export function cleanScreen(raw) {
  if (!raw) return raw;
  const lines = String(raw).replace(/\s+$/, '').split('\n');
  const plain = lines.map(stripAnsi);
  const win = Math.max(0, lines.length - 16);
  let cut = lines.length;
  for (let i = win; i < lines.length; i++) {
    if (SPINNER_RX.test(plain[i])) {
      cut = i;
      break;
    }
  }
  if (cut === lines.length) {
    for (let i = win; i < lines.length; i++) {
      if (BOXTOP_RX.test(plain[i]) || RULE_RX.test(plain[i])) {
        cut = i;
        break;
      }
    }
  }
  const tail = Math.max(0, cut - 8);
  const kept = [];
  for (let i = 0; i < cut; i++) {
    if (i >= tail && (FOOTER_RX.test(plain[i]) || /^\s*[❯>]\s*$/.test(plain[i]))) continue;
    kept.push(lines[i]);
  }
  while (kept.length && !stripAnsi(kept[kept.length - 1]).trim()) kept.pop();
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
  // Menu detection is pure text logic — colors only get in the way.
  const all = stripAnsi(String(screen)).replace(/\s+$/, '').split('\n');
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
// Mia's own session. Between events she sits idle at her prompt — that is not
// "needs you" (her real questions arrive as kind 'mia' items instead).
export function isMiaAgent(a) {
  if (!a) return false;
  if (a.isMia === true) return true;
  const sid = getMC().mia?.sessionId;
  return !!sid && a.id === sid;
}
export function attentionInfo(a) {
  const st = agentStatus(a);
  if (st === 'exited') return { kind: 'exited', prompt: null };
  if (st !== 'waiting') return null;
  const prompt = parsePrompt(rawScreenFor(a));
  return { kind: prompt ? 'menu' : 'idle', prompt };
}
// Pending Mia questions ride the same queue as kind 'mia' (no agent — the card
// answers with miaAnswer). They lead: Mia only asks when she is truly blocked.
// Opt-in: only callers that pass `mia` get them — TV and car mode index every
// item by `.agent`, so their lists stay agent-only.
export function attentionList(agents, mia = null) {
  const items = [];
  for (const q of miaOpenQuestions(mia)) items.push({ kind: 'mia', key: `mia:${q.questionId}`, question: q });
  for (const a of agents || []) {
    if (isMiaAgent(a)) continue; // idle is her resting state, not a question

    const info = attentionInfo(a);
    if (info) items.push({ agent: a, key: a.id, ...info });
  }
  return items;
}

// ---- streamed screens & watch leases ----------------------------------------
// The workspace holds a "watch lease" on its session: we tell the host we're
// looking ({type:'watch'}) immediately, every 3s while open, and again on every
// reconnect; the host streams {type:'screen', sessionId, seq, text} frames
// (~400 lines incl. scrollback) at ~1 Hz while the lease is fresh. Leases are
// cheap — send liberally. The host expires them after 8s.
// A "hot" lease additionally says someone is TYPING into that terminal from the
// console — the host then mirrors it at ~3 Hz instead of 1 Hz.
const watchLeases = new Map(); // sessionId → { n, hot } — refcounts
let watchTimer = null;

function sendWatch(sessionId) {
  const l = watchLeases.get(sessionId);
  const frame = { type: 'watch', sessionId, hot: !!l?.hot };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  else if (isPoll()) postCmd(frame, { silent: true });
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
  syncScreenPoll();
}
// Acquire a lease; returns a release function. Refcounted so two views of the
// same session don't cancel each other.
export function watchAgent(sessionId, { hot = false } = {}) {
  const l = watchLeases.get(sessionId) || { n: 0, hot: 0 };
  l.n += 1;
  if (hot) l.hot += 1;
  watchLeases.set(sessionId, l);
  sendWatch(sessionId);
  syncWatchTimer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = watchLeases.get(sessionId);
    if (!cur) return;
    cur.n -= 1;
    if (hot) cur.hot = Math.max(0, cur.hot - 1);
    if (cur.n <= 0) watchLeases.delete(sessionId);
    syncWatchTimer();
  };
}

function ingestScreen(msg) {
  if (!msg.sessionId) return;
  const prev = getMC().screens[msg.sessionId];
  let text = msg.text;
  // Delta frame: the host kept the first `keep` characters (UTF-16 units) of the
  // frame BEFORE this one and sent only the tail. Applicable solely on top of
  // that exact frame — otherwise drop it and wait for the next full one (the
  // host forces one every few frames, so a viewer that joined mid-stream
  // catches up).
  if (typeof msg.keep === 'number') {
    if (!prev || msg.seq !== prev.seq + 1 || prev.text.length < msg.keep) return;
    text = prev.text.slice(0, msg.keep) + (msg.text || '');
  }
  if (typeof text !== 'string') return;
  // Drop out-of-order frames — but accept a sequence restart (host relaunch).
  if (prev && typeof msg.seq === 'number' && msg.seq <= prev.seq && msg.seq > prev.seq - 1000) return;
  const frame = { seq: msg.seq ?? 0, text, at: Date.now() };
  useMC.setState((s) => ({ screens: { ...s.screens, [msg.sessionId]: frame } }));
}

// Best available RAW screen for an agent: streamed frame first (full buffer,
// 1 Hz), else the snapshot's ~50-line tail. NEVER returns blank because a frame
// didn't arrive — last-known text is kept until the agent leaves the board.
export function rawScreenFor(a) {
  const s = getMC().screens[a?.id];
  return s?.text || a?.screen || '';
}
// { text, at, streamed } — `at` powers the staleness age in the terminal chrome.
export function screenInfoFor(a) {
  const mc = getMC();
  const s = mc.screens[a?.id];
  if (s?.text) return { text: s.text, at: s.at, streamed: true };
  return { text: a?.screen || '', at: mc.lastSnapshotAt, streamed: false };
}

// ---- per-agent burn sparklines ----------------------------------------------
// A rolling tokens/sec trace per agent for the card sparklines. Plain module
// Map (not store state) — cards already re-render each snapshot, so reads keyed
// off `agents`/`lastSnapshotAt` stay fresh without diffing 50 arrays at 1 Hz.
const sparks = new Map(); // id → number[]
const SPARK_CAP = 30;
export function sparkOf(id) {
  return sparks.get(id) || [];
}
function trackSparks(agents) {
  const seen = new Set();
  for (const a of agents) {
    seen.add(a.id);
    // A fresh array per sample: consumers memoise on the reference, so pushing
    // in place would leave every sparkline frozen on its first frame.
    const prev = sparks.get(a.id) || [];
    sparks.set(a.id, [...prev.slice(-(SPARK_CAP - 1)), a.tokensPerSec ?? 0]);
  }
  for (const id of sparks.keys()) if (!seen.has(id)) sparks.delete(id);
}

// ---- toast ------------------------------------------------------------------
let toastTimer = null;
export function toast(text) {
  set({ toast: text });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: '' }), 2600);
}

// ---- dashboard filter -------------------------------------------------------
export function setFilter(f) {
  set({ filter: f });
}

// ---- token ------------------------------------------------------------------
export function initToken() {
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    localStorage.setItem(LS_TOKEN, params.get('token'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const token = localStorage.getItem(LS_TOKEN) || '';
  set({ token, needsToken: !token });
  if (token) connect();
}
export function saveToken(t) {
  t = (t || '').trim();
  if (!t) return;
  localStorage.setItem(LS_TOKEN, t);
  set({ token: t, needsToken: false });
  connect();
}
export function changeToken() {
  set({ needsToken: true });
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
// When the relay last said anything on this socket (any frame, or the open
// itself). Silence past STALE_MS on an "open" socket means a zombie: iOS
// resumes a suspended web app with a socket that still reports open but will
// never deliver again, and never fires onclose. hostOnline can't catch that
// case — a socket that opened but never got its first frame stays offline.
let lastFrameAt = 0;
let reconnectTimer = null;
let modelsKey = '';
let docsKey = '';
let dirsKey = '';

const STALE_MS = 12000;
// A live relay sends a snapshot ~1/s while the Mac is up and hostState frames
// otherwise, so a socket silent this long is not a healthy one.
const ZOMBIE_MS = 20000;

function snapshotFresh() {
  const at = getMC().lastSnapshotAt;
  return at && Date.now() - at <= STALE_MS;
}
function setLink() {
  const link = hostOnline && snapshotFresh() ? 'linked' : relayUp ? 'relay' : 'offline';
  if (getMC().link !== link) set({ link });
}
// Seconds since the last snapshot, for the connection banner. Reads `now` so
// consumers that subscribe to it tick once a second.
export function dataAge() {
  const mc = getMC();
  if (!mc.lastSnapshotAt) return null;
  return Math.max(0, Math.round((mc.now - mc.lastSnapshotAt) / 1000));
}

export function connect() {
  const token = getMC().token;
  if (!token) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    // Replace, never stack: silence the old socket's handlers first.
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=viewer&token=${encodeURIComponent(token)}`;
  diagPatch({ lastAttemptAt: Date.now(), lastUrl: url.replace(/token=[^&]*/, 'token=…') });
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (err) {
    diagPatch({ errors: getMC().diag.errors + 1, lastClose: { code: 0, reason: String(err && err.message || err), at: Date.now() } });
    wsFailed(`socket threw: ${String(err && err.message || err)}`);
    if (!isPoll()) scheduleReconnect();
    return;
  }
  ws = sock;
  let opened = false;
  // A socket that sits in `connecting` this long is being held by something on
  // the path — don't wait it out; go to HTTP now. It's left dialing: if it does
  // open, onopen switches straight back.
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (ws === sock && sock.readyState === 0 && !isPoll()) enterPoll(`stuck connecting > ${WS_CONNECT_TIMEOUT_MS / 1000}s`);
  }, WS_CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    opened = true;
    clearTimeout(connectTimer);
    retry = 0;
    wsFails = 0;
    exitPoll(); // a socket got through — it wins over HTTP immediately
    relayUp = true;
    lastFrameAt = Date.now();
    diagPatch({ opens: getMC().diag.opens + 1, wsFails: 0 });
    setLink();
    sendAllWatches(); // re-assert leases on every (re)connect
  };
  ws.onmessage = (e) => {
    let msg;
    lastFrameAt = Date.now();
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    diagPatch({ frames: getMC().diag.frames + 1, lastFrameType: msg.type || '' });
    handleFrame(msg);
  };
  ws.onclose = (e) => {
    diagPatch({ closes: getMC().diag.closes + 1, lastClose: { code: e.code, reason: e.reason || '', at: Date.now() } });
    if (ws !== sock) return; // an old, replaced socket — ignore
    ws = null;
    clearTimeout(connectTimer);
    if (e.code === 4001 || e.code === 1008) {
      relayUp = false;
      hostOnline = false;
      setLink();
      set({ needsToken: true });
      return;
    }
    if (!opened) wsFailed(`socket closed before open (code ${e.code})`);
    // On HTTP the link state belongs to the poller; this was only a background
    // probe, and the poll-mode retry interval dials the next one.
    if (isPoll()) return;
    relayUp = false;
    hostOnline = false;
    setLink();
    scheduleReconnect();
  };
  ws.onerror = () => {
    diagPatch({ errors: getMC().diag.errors + 1 });
    if (sock) sock.close();
  };
}

function diagPatch(p) {
  set({ diag: { ...getMC().diag, ...p } });
}
export function socketState() {
  return !ws ? 'none' : ['connecting', 'open', 'closing', 'closed'][ws.readyState] || String(ws.readyState);
}

function scheduleReconnect() {
  const mc = getMC();
  if (reconnectTimer || mc.needsToken || !mc.token) return;
  if (isPoll()) return; // poll mode redials on its own slow interval
  const base = Math.min(5000, 600 * Math.pow(2, retry++));
  const delay = base / 2 + Math.random() * (base / 2); // jitter, capped at 5s
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Skip the backoff entirely — used when the OS hands the page back to us.
export function reconnectNow() {
  const mc = getMC();
  if (!mc.token || mc.needsToken) return;
  if (isPoll()) pollOnce(); // refresh the HTTP view now; the socket retry below is a free probe
  retry = 0;
  if (ws && ws.readyState === 1) {
    // Socket claims to be open; if the relay has spoken recently, trust it.
    // If it's been silent past the heartbeat window, it's a zombie — redial
    // through the same path. (Judged on relay silence, not on hostOnline: a
    // socket that never received its first frame is the common zombie.)
    if (!snapshotFresh() && Date.now() - lastFrameAt > STALE_MS) connect();
    return;
  }
  connect();
}

// ---- HTTP polling fallback --------------------------------------------------
// Some networks block the WebSocket upgrade while plain HTTPS to the same host
// works. After WS_FAILS_TO_POLL sockets in a row die before opening (or one
// sits in `connecting` past WS_CONNECT_TIMEOUT_MS), the panel switches to
// `transport: 'poll'`:
//   • GET /api/v1/snapshot every POLL_MS → the same ingest() the socket uses
//     (seq-deduped, so an unchanged snapshot isn't counted twice in history);
//   • send() POSTs /api/v1/cmd and routes the answering frame through
//     handleFrame() — acks, doc bodies and search results land exactly as if
//     they'd arrived on the socket;
//   • watch leases go out via /cmd, and GET /api/v1/screens feeds the leased
//     sessions' buffers into ingestScreen() while any lease is held.
// A WebSocket is still tried every WS_RETRY_IN_POLL_MS; the moment one opens,
// polling stops and the socket takes over (see onopen → exitPoll()).
const WS_FAILS_TO_POLL = 3;
const WS_CONNECT_TIMEOUT_MS = 8000;
const POLL_MS = 1500;
const SCREEN_POLL_MS = 2000;
const SCREEN_POLL_HOT_MS = 700; // someone is typing into the console
const WS_RETRY_IN_POLL_MS = 60000;
const CMD_TIMEOUT_MS = 20000; // the relay itself gives up at 15s
// Identifies this tab to the relay so it counts as a viewer (the Mac only
// captures screens while someone is watching).
const CLIENT_ID = `p${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

let wsFails = 0;
let connectTimer = null;
let pollTimer = null;
let wsRetryTimer = null;
let pollBusy = false;
let lastPollSeq = null;
let screenPollTimer = null;
let screenPollBusy = false;

function isPoll() {
  return getMC().transport === 'poll';
}

async function httpJSON(path, opts = {}, timeoutMs = 10000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(path, {
      cache: 'no-store',
      ...opts,
      headers: { Authorization: `Bearer ${getMC().token}`, 'X-MC-Client': CLIENT_ID, ...(opts.headers || {}) },
      signal: ctl ? ctl.signal : undefined,
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* non-JSON (a proxy's error page) — status alone speaks */
    }
    return { status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function wsFailed(why) {
  wsFails += 1;
  diagPatch({ wsFails });
  if (!isPoll() && wsFails >= WS_FAILS_TO_POLL) enterPoll(`${wsFails} sockets failed — last: ${why}`);
}

function enterPoll(why) {
  if (isPoll()) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  set({ transport: 'poll' });
  diagPatch({ switchReason: why, switchedAt: Date.now() });
  lastPollSeq = null;
  clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_MS);
  clearInterval(wsRetryTimer);
  wsRetryTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) connect();
  }, WS_RETRY_IN_POLL_MS);
  pollOnce();
  sendAllWatches();
  syncScreenPoll();
}

function exitPoll() {
  if (!isPoll()) return;
  clearInterval(pollTimer);
  clearInterval(wsRetryTimer);
  pollTimer = wsRetryTimer = null;
  set({ transport: 'ws' });
  diagPatch({ switchReason: 'socket opened — back on WebSocket', switchedAt: Date.now() });
  syncScreenPoll();
}

async function pollOnce() {
  const mc = getMC();
  if (!isPoll() || pollBusy || !mc.token || mc.needsToken) return;
  pollBusy = true;
  let status = '';
  try {
    const { status: st, data } = await httpJSON('/api/v1/snapshot');
    if (!isPoll()) return; // the socket took over mid-flight
    status = String(st);
    if (st === 401) {
      relayUp = false;
      hostOnline = false;
      set({ needsToken: true });
    } else if (st === 200 && data && data.snapshot) {
      relayUp = true;
      hostOnline = !!data.hostOnline;
      if (data.seq !== lastPollSeq) {
        lastPollSeq = data.seq;
        // Freshness is when the relay got it from the Mac, not when we polled.
        const age = typeof data.ageMs === 'number' ? data.ageMs : 0;
        set({ lastSnapshotAt: Date.now() - age });
        ingest(data.snapshot);
      }
    } else if (st === 502) {
      relayUp = true;
      hostOnline = false;
    } else {
      relayUp = false;
      hostOnline = false;
    }
  } catch (err) {
    status = `error: ${(err && err.message) || err}`;
    relayUp = false;
    hostOnline = false;
  } finally {
    pollBusy = false;
    if (status) {
      diagPatch({ polls: getMC().diag.polls + 1, lastPollStatus: status, lastPollAt: Date.now() });
      setLink();
    }
  }
}

function syncScreenPoll() {
  const want = isPoll() && watchLeases.size > 0;
  if (want && !screenPollTimer) {
    screenPollTimer = setTimeout(pollScreens, 0);
  } else if (!want && screenPollTimer) {
    clearTimeout(screenPollTimer);
    screenPollTimer = null;
  }
}

async function pollScreens() {
  screenPollTimer = null;
  if (!isPoll() || !watchLeases.size) return;
  if (!screenPollBusy && !getMC().needsToken) {
    screenPollBusy = true;
    try {
      const ids = [...watchLeases.keys()].map(encodeURIComponent).join(',');
      const { status, data } = await httpJSON(`/api/v1/screens?ids=${ids}`);
      if (status === 200 && data && data.screens && isPoll()) {
        for (const [sessionId, f] of Object.entries(data.screens)) {
          if (watchLeases.has(sessionId)) ingestScreen({ sessionId, seq: f.seq, text: f.text }); // full frames
        }
      }
    } catch {
      /* the snapshot poll reports link trouble; screens just try again */
    } finally {
      screenPollBusy = false;
    }
  }
  if (!isPoll() || !watchLeases.size || screenPollTimer) return;
  const hot = [...watchLeases.values()].some((l) => l.hot > 0);
  screenPollTimer = setTimeout(pollScreens, hot ? SCREEN_POLL_HOT_MS : SCREEN_POLL_MS);
}

// Outgoing frames in poll mode. Keystrokes go through one ordered queue (each
// is its own HTTP request, and typed characters must not overtake each other
// or the Enter that follows them); runs of literal typing are merged.
const keyQueue = [];
let keyBusy = false;

function postCmd(obj, { silent = false } = {}) {
  if (obj.type === 'key') {
    keyQueue.push(obj);
    drainKeys();
    return;
  }
  runCmd(obj, silent);
}

async function drainKeys() {
  if (keyBusy) return;
  keyBusy = true;
  try {
    while (keyQueue.length) {
      let f = keyQueue.shift();
      if (f.text) {
        while (keyQueue.length && keyQueue[0].text && keyQueue[0].sessionId === f.sessionId) {
          f = { ...f, text: f.text + keyQueue.shift().text };
        }
      }
      await runCmd(f, false);
    }
  } finally {
    keyBusy = false;
  }
}

async function runCmd(obj, silent) {
  let label = '';
  try {
    const { status, data } = await httpJSON(
      '/api/v1/cmd',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) },
      CMD_TIMEOUT_MS,
    );
    label = `${obj.type} → ${status}`;
    if (status === 200 && data) {
      if (data.type) handleFrame(data); // the host's answer, exactly as the socket would deliver it
      return;
    }
    if (status === 401) {
      set({ needsToken: true });
      return;
    }
    if (status === 502) {
      hostOnline = false;
      setLink();
    }
    if (!silent) cmdFailed(obj, status === 502 ? 'Your Mac is offline' : status === 504 ? 'No answer from your Mac' : 'Not connected');
  } catch (err) {
    label = `${obj.type} → error: ${(err && err.message) || err}`;
    if (!silent) cmdFailed(obj, 'Not connected');
  } finally {
    diagPatch({ lastCmdStatus: label, lastCmdAt: Date.now() });
  }
}

function cmdFailed(obj, text) {
  // Same rate limit as a failing key ack: typing can fail once per keystroke.
  if (obj.type === 'key') {
    if (Date.now() - lastKeyFailAt < 4000) return;
    lastKeyFailAt = Date.now();
  }
  if (obj.type === 'miaSend') setMiaLocal((l) => ({ sent: l.sent.slice(1) })); // undo the optimistic echo
  toast(text);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectNow();
  });
  window.addEventListener('pageshow', reconnectNow);
  window.addEventListener('online', reconnectNow);
}

// Watchdog + 1 Hz staleness clock. If the host is nominally online but silent
// past the heartbeat window, assume a zombie socket and redial.
setInterval(() => {
  set({ now: Date.now() });
  if (ws && ws.readyState === 1 && Date.now() - lastFrameAt > ZOMBIE_MS) {
    // No frame at all for a while on a socket that says it's open — zombie
    // (or a relay that has gone quiet, which a redial also sorts out).
    connect(); // tears down the zombie and redials immediately
  }
  setLink(); // freshness feeds link state — keep it honest even with no events
}, 1000);

const lastActivity = new Map();
// Returns the feed entries this snapshot added (the caller folds them into a
// NEW activity array — one write per snapshot instead of one per agent).
function trackActivity(agents) {
  const added = [];
  for (const a of agents) {
    const act = (a.activity || '').trim();
    if (!act || act === '—') continue;
    if (lastActivity.get(a.id) === act) continue;
    lastActivity.set(a.id, act);
    // Keep the id: with `name`, two agents can share a folder, so the folder is
    // no longer a reliable back-reference. `who` is the display label.
    added.push({ t: Date.now(), id: a.id, folder: a.folder, who: agentName(a), text: act });
  }
  return added;
}

function ingest(s) {
  const mc = getMC();
  const patch = { snapshot: s };
  const sum = s.summary || {};
  patch.summary = sum;
  patch.system = s.system && typeof s.system.cpu === 'number' ? s.system : null;

  // Fleet list barely ever changes — keep the reference stable so fleet views
  // don't re-render at 1 Hz.
  const fleets = s.fleets || [];
  if (JSON.stringify(fleets) !== JSON.stringify(mc.fleets)) patch.fleets = fleets;

  const agents = [...(s.agents || [])].sort(
    (a, b) => statusRank(agentStatus(a)) - statusRank(agentStatus(b)) || String(a.folder).localeCompare(String(b.folder)),
  );
  patch.agents = agents;
  const added = trackActivity(agents);
  if (added.length) {
    const activity = [...mc.activity, ...added];
    while (activity.length > 80) activity.shift();
    patch.activity = activity;
  }
  trackSparks(agents);

  // Drop streamed screens for sessions that left the board.
  const ids = new Set(agents.map((a) => a.id));
  let screens = mc.screens;
  for (const id of Object.keys(screens)) {
    if (!ids.has(id)) {
      if (screens === mc.screens) screens = { ...screens };
      delete screens[id];
    }
  }
  if (screens !== mc.screens) patch.screens = screens;

  const tps = [...mc.tps, sum.tokensPerSec ?? 0];
  if (tps.length > 150) tps.shift();
  patch.tps = tps;

  // Richer rolling history for the timeseries graph. One sample per snapshot;
  // ~4 min of history at a 1 Hz snapshot cadence.
  const history = [
    ...mc.history,
    {
      t: Date.now(),
      tps: sum.tokensPerSec ?? 0,
      cost: sum.totalCost ?? 0,
      tokens: sum.totalTokens ?? 0,
      active: sum.active ?? 0,
    },
  ];
  if (history.length > 240) history.shift();
  patch.history = history;

  // Document library metadata — replace only on real change so open views and
  // the list don't churn at 1 Hz. updatedAt moves when a file is written.
  const dgk = (s.docs || []).map((d) => `${d.id}@${d.updatedAt}`).join('|');
  if (dgk !== docsKey) {
    docsKey = dgk;
    const docs = s.docs || [];
    patch.docs = docs;
    // A doc that changed on disk (or vanished) invalidates its cached body. This
    // is the main path a research report lands: the agent rewrites the file, its
    // updatedAt jumps, and the next docGet re-fetches instead of showing stale text.
    let docDocs = mc.docDocs;
    for (const id of Object.keys(docDocs)) {
      const meta = docs.find((d) => d.id === id);
      if (!meta || meta.updatedAt > (docDocs[id].updatedAt ?? 0)) {
        if (docDocs === mc.docDocs) docDocs = { ...docDocs };
        delete docDocs[id];
      }
    }
    if (docDocs !== mc.docDocs) patch.docDocs = docDocs;
  }

  // Launch metadata — only replace when it actually changes so native pickers
  // don't get rebuilt mid-selection (Swift serialises dicts in unstable order).
  const dk = JSON.stringify(s.knownDirs || []);
  if (dk !== dirsKey) {
    dirsKey = dk;
    patch.knownDirs = s.knownDirs || [];
  }
  if (!mc.lastDir && s.lastDir) patch.lastDir = s.lastDir;
  ingestMia(s, mc, patch);

  const mk = (s.models || []).map((m) => m.flag).join('|');
  if (s.models && s.models.length && mk !== modelsKey) {
    modelsKey = mk;
    patch.models = s.models;
  }

  set(patch);
}

// One host frame, from either transport: the socket's onmessage, or the frame
// a POST /api/v1/cmd returned in poll mode.
function handleFrame(msg) {
  if (msg.type === 'snapshot') {
    hostOnline = true;
    set({ lastSnapshotAt: Date.now() });
    setLink();
    ingest(msg);
  } else if (msg.type === 'screen') {
    ingestScreen(msg);
  } else if (msg.type === 'doc') {
    ingestDoc(msg);
  } else if (msg.type === 'docSearchResult') {
    set({ search: { q: msg.q || '', hits: Array.isArray(msg.hits) ? msg.hits : [], at: Date.now() } });
  } else if (msg.type === 'hostState') {
    hostOnline = msg.online;
    setLink();
  } else if (msg.type === 'ack') {
    handleAck(msg);
  }
}

function ingestDoc(msg) {
  if (!msg.id || typeof msg.content !== 'string') return;
  const doc = {
    content: msg.content,
    title: msg.title || '',
    kind: msg.kind || 'note',
    status: msg.status || 'draft',
    subject: msg.subject || '',
    tags: Array.isArray(msg.tags) ? msg.tags : [],
    dir: msg.dir || '',
    updatedAt: msg.updatedAt ?? 0,
    at: Date.now(),
  };
  useMC.setState((s) => ({ docDocs: { ...s.docDocs, [msg.id]: doc } }));
}

let lastKeyFailAt = 0;

function handleAck(msg) {
  // Both docCreate and research mint a new file and carry its id back so the
  // Library can jump straight to it; research additionally spins up an agent.
  if (msg.cmd === 'docCreate') {
    if (msg.ok && msg.id) set({ lastCreatedDocId: msg.id });
    toast(msg.ok ? 'Document created' : `Couldn't create — ${msg.detail || 'unknown error'}`);
    return;
  }
  if (msg.cmd === 'research') {
    if (msg.ok && msg.id) set({ lastCreatedDocId: msg.id });
    toast(msg.ok ? 'Research agent launched' : `Couldn't launch research — ${msg.detail || 'unknown error'}`);
    return;
  }
  if (msg.cmd === 'docGet') {
    if (!msg.ok) toast(msg.detail || "Couldn't load that document");
    return;
  }
  if (typeof msg.cmd === 'string' && msg.cmd.startsWith('mia')) {
    handleMiaAck(msg);
    return;
  }
  // The Launch sheet shows its own optimistic overlay on click, so a successful
  // launch ack needs no toast; only surface launch failures.
  if (msg.cmd === 'launch') {
    if (!msg.ok) toast(`Launch failed — ${msg.detail || 'unknown error'}`);
    return;
  }
  // Key presses succeed silently — the screen mirror visibly updates; only
  // surface a failure so a tap into thin air isn't confusing. Console typing can
  // fail once per keystroke, so the complaint is rate-limited to one every 4s.
  if (msg.cmd === 'key') {
    if (msg.ok) return;
    if (Date.now() - lastKeyFailAt < 4000) return;
    lastKeyFailAt = Date.now();
    toast(`Couldn't send — ${msg.detail || 'unknown error'}`);
    return;
  }
  toast(msg.ok ? msg.detail || 'Delivered' : `Failed — ${msg.detail || 'unknown error'}`);
}

// ---- commands ---------------------------------------------------------------
function send(obj) {
  if (isPoll()) {
    if (!relayUp) {
      toast('Not connected');
      return false;
    }
    if (!hostOnline) {
      toast('Your Mac is offline');
      return false;
    }
    postCmd(obj); // the answer (ack/doc/…) arrives through handleFrame
    return true;
  }
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
// Literal typing from the console — every character reaches the tty exactly as
// typed. Deliberately a DIFFERENT field from `key`: sending it as a key name
// would make someone typing "up" press the up arrow.
export function sendText(sessionId, text) {
  if (!text) return false;
  return send({ type: 'key', sessionId, text: String(text) });
}

// ---- directory memory (this device) -----------------------------------------
// Every folder launched into from the panel is kept in localStorage, so the
// project drop-down still has history when the Mac is fresh, restarted, or
// offline. The host's knownDirs (live agents + its own launch history) comes
// first; this device's list fills in behind it.
const DIRS_KEY = 'mc.recentDirs';
try {
  const stored = JSON.parse(localStorage.getItem(DIRS_KEY) || '[]');
  if (Array.isArray(stored) && stored.length) set({ localDirs: stored });
} catch {
  /* corrupt entry (or no localStorage at all) — start fresh */
}
export function rememberDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return;
  const localDirs = [d, ...getMC().localDirs.filter((x) => x !== d)].slice(0, 12);
  set({ localDirs });
  try {
    localStorage.setItem(DIRS_KEY, JSON.stringify(localDirs));
  } catch {
    /* private mode — memory-only for this visit */
  }
}
export function allDirs() {
  const mc = getMC();
  const seen = new Set();
  const out = [];
  for (const d of [...mc.knownDirs, ...mc.localDirs]) {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

export function launch(payload) {
  rememberDir(payload.dir);
  return send({ type: 'launch', ...payload });
}

// ---- document library commands ----------------------------------------------
export function docGet(id) {
  return send({ type: 'docGet', id });
}
export function docSave(id, content) {
  const ok = send({ type: 'docSave', id, content });
  if (ok && getMC().docDocs[id]) {
    useMC.setState((s) => (s.docDocs[id] ? { docDocs: { ...s.docDocs, [id]: { ...s.docDocs[id], content } } } : {})); // optimistic
  }
  return ok;
}
export function docCreate({ title = '', kind = 'note', subject = '', tags = [], dir = '', content = '' } = {}) {
  return send({ type: 'docCreate', title, kind, subject, tags, dir, content });
}
export function docDelete(id) {
  const ok = send({ type: 'docDelete', id });
  if (ok) {
    useMC.setState((s) => {
      if (!(id in s.docDocs)) return {};
      const docDocs = { ...s.docDocs };
      delete docDocs[id];
      return { docDocs };
    });
  }
  return ok;
}
// Metadata-only edit: send just the keys the caller wants to change so the host
// leaves everything else on the file untouched (its update() treats absent as
// "leave alone"). `type` and `id` are always present; nothing else unless asked.
export function docMeta(id, patch = {}) {
  const msg = { type: 'docMeta', id };
  for (const k of ['kind', 'status', 'subject', 'tags', 'dir']) {
    if (k in patch) msg[k] = patch[k];
  }
  return send(msg);
}
export function docSearch(q) {
  return send({ type: 'docSearch', q: String(q ?? '') });
}
// One-shot: the host creates a research doc and launches an agent that writes
// its report into that exact file; the ack carries the new doc's id.
export function research({ topic = '', subject = '', dir = '', model = '', tags = [] } = {}) {
  rememberDir(dir);
  return send({ type: 'research', topic, subject, dir, model, tags });
}
export function stopAll() {
  const n = getMC().agents.filter((a) => a.status !== 'done').length;
  if (!n) {
    toast('Nothing to stop');
    return;
  }
  send({ type: 'broadcast', text: 'Stop' });
  toast(`Sent “Stop” to ${n} agent${n === 1 ? '' : 's'}`);
}

// ---- Mia --------------------------------------------------------------------
// The persistent assistant (docs/mia.md §8). The host puts a `mia` block on the
// snapshot: { enabled, online, sessionId, model, restarts, readUpTo, messages,
// tasks, pendingQuestions, schedule, pushKey }. Every field is optional here —
// an absent block means "Mia is off / host predates her", never a crash.

export const MIA_DEFAULT_MODEL = 'claude-opus-5-5';
export const MIA_MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
];

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const str = (v) => (v == null ? '' : String(v));

function normMia(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    enabled: !!m.enabled,
    online: !!m.online,
    sessionId: str(m.sessionId),
    model: str(m.model) || MIA_DEFAULT_MODEL,
    restarts: Number(m.restarts) || 0,
    readUpTo: str(m.readUpTo),
    messages: arr(m.messages),
    tasks: arr(m.tasks),
    pendingQuestions: arr(m.pendingQuestions),
    schedule: m.schedule && typeof m.schedule === 'object' ? m.schedule : null,
    pushKey: str(m.pushKey),
  };
}

let miaKey = '';
function ingestMia(s, mc, patch) {
  // The block is small (≤200 messages + open tasks); a string compare keeps
  // the reference stable so the Mia view doesn't re-render at 1 Hz for nothing.
  const k = s.mia ? JSON.stringify(s.mia) : '';
  if (k === miaKey) return;
  miaKey = k;
  const mia = normMia(s.mia);
  patch.mia = mia;

  // Retire optimistic echoes the host has now caught up with.
  const loc = mc.miaLocal;
  const msgs = mia?.messages || [];
  const sent = loc.sent.filter((p) => {
    if (Date.now() - p.at > 30000) return false; // give up — the ack already spoke
    const seen = msgs.filter((m) => m.from === 'daniel' && m.kind === 'chat' && m.text === p.text).length;
    return seen <= p.baseline;
  });
  const pending = new Set((mia?.pendingQuestions || []).map((q) => q.questionId));
  let answered = loc.answered;
  for (const id of Object.keys(answered)) {
    if (!pending.has(id)) {
      if (answered === loc.answered) answered = { ...answered };
      delete answered[id];
    }
  }
  if (sent.length !== loc.sent.length || answered !== loc.answered) patch.miaLocal = { ...loc, sent, answered };
}

// Where "after <id>" starts in the message list. Ids are `m_<epoch ms>`, so an
// id that has scrolled out of the 200-line window still orders numerically.
function cutAfter(msgs, id) {
  if (!id) return 0;
  const i = msgs.findIndex((m) => m.id === id);
  if (i >= 0) return i + 1;
  const n = Number(String(id).replace(/^\D+/, ''));
  if (!Number.isFinite(n) || !n) return 0;
  const j = msgs.findIndex((m) => Number(String(m.id || '').replace(/^\D+/, '')) > n);
  return j < 0 ? msgs.length : j;
}

// Questions still waiting on Daniel, minus the ones he just answered here.
export function miaOpenQuestions(mia, local = getMC().miaLocal) {
  if (!mia) return [];
  const answered = local?.answered || {};
  return mia.pendingQuestions.filter((q) => q.questionId && !(q.questionId in answered));
}

// Dock badge: unread Mia messages + open questions. A question that is both
// unread and open counts once — it is one thing asking for you, not two.
export function miaBadge(mia, local = getMC().miaLocal) {
  if (!mia) return 0;
  const open = miaOpenQuestions(mia, local);
  const openIds = new Set(open.map((q) => q.questionId));
  const msgs = mia.messages;
  const cut = Math.max(cutAfter(msgs, mia.readUpTo), cutAfter(msgs, local?.readUpTo));
  let unread = 0;
  for (let i = cut; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.from !== 'mia') continue;
    if (m.kind === 'question' && openIds.has(m.questionId)) continue;
    unread++;
  }
  return unread + open.length;
}

// Daniel's answer to a question, from wherever it is recorded: a local echo,
// an `answer` line in the thread, or the task's question record.
export function miaAnswerFor(mia, questionId, local = getMC().miaLocal) {
  if (!questionId) return null;
  if (local?.answered?.[questionId] != null) return local.answered[questionId];
  for (const m of mia?.messages || []) {
    if (m.kind === 'answer' && m.questionId === questionId) return m.text || '';
  }
  for (const t of mia?.tasks || []) {
    for (const q of arr(t.questions)) if (q.id === questionId && q.answer != null) return String(q.answer);
  }
  return null;
}

function setMiaLocal(fn) {
  useMC.setState((s) => ({ miaLocal: { ...s.miaLocal, ...fn(s.miaLocal) } }));
}

const MIA_ACK_OK = {
  miaTaskAdd: 'Task added',
  miaTaskCancel: 'Task cancelled',
  miaTaskSet: 'Task updated',
  miaStart: 'Starting Mia',
  miaStop: 'Mia stopped',
  miaSetModel: 'Model saved — applies on her next start',
  miaSchedule: 'Schedule updated',
  miaPushTest: 'Test notification sent',
};

function handleMiaAck(msg) {
  if (!msg.ok) {
    if (msg.cmd === 'miaRead') return; // housekeeping — never worth a toast
    if (msg.cmd === 'miaSend') setMiaLocal((l) => ({ sent: l.sent.slice(1) }));
    toast(`Mia: ${msg.detail || 'that didn’t go through'}`);
    return;
  }
  // The thread itself shows a sent message or an answer — no toast for those.
  const t = MIA_ACK_OK[msg.cmd];
  if (t) toast(msg.cmd === 'miaPushTest' && msg.detail ? msg.detail : t);
}

export function miaSend(text) {
  text = (text || '').trim();
  if (!text) return false;
  const msgs = getMC().mia?.messages || [];
  const baseline = msgs.filter((m) => m.from === 'daniel' && m.kind === 'chat' && m.text === text).length;
  if (!send({ type: 'miaSend', text })) return false;
  setMiaLocal((l) => ({ sent: [...l.sent, { id: `local_${Date.now()}`, text, at: Date.now(), baseline }] }));
  return true;
}
export function miaAnswer(questionId, text) {
  text = (text || '').trim();
  if (!questionId || !text) return false;
  if (!send({ type: 'miaAnswer', questionId, text })) return false;
  setMiaLocal((l) => ({ answered: { ...l.answered, [questionId]: text } }));
  return true;
}
// Mark the thread read up to a message id. Silent: no toast either way, and it
// only goes out when it moves the marker.
export function miaRead(upTo) {
  if (!upTo) return false;
  const mc = getMC();
  if (mc.miaLocal.readUpTo === upTo || mc.mia?.readUpTo === upTo) return false;
  if (!hostOnline) return false;
  if (isPoll()) postCmd({ type: 'miaRead', upTo }, { silent: true });
  else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'miaRead', upTo }));
  else return false;
  setMiaLocal(() => ({ readUpTo: upTo }));
  return true;
}
export function miaTaskAdd({ title = '', detail = '', dir = '', priority } = {}) {
  title = String(title).trim();
  if (!title) return false;
  const msg = { type: 'miaTaskAdd', title };
  if (String(detail).trim()) msg.detail = String(detail).trim();
  if (String(dir).trim()) {
    msg.dir = String(dir).trim();
    rememberDir(msg.dir);
  }
  if (priority != null && priority !== '') msg.priority = Number(priority);
  return send(msg);
}
export function miaTaskCancel(id) {
  return !!id && send({ type: 'miaTaskCancel', id });
}
export function miaTaskSet(id, field, value) {
  return !!id && send({ type: 'miaTaskSet', id, field, value });
}
export function miaStart() {
  return send({ type: 'miaStart' });
}
export function miaStop() {
  return send({ type: 'miaStop' });
}
export function miaSetModel(model) {
  return !!model && send({ type: 'miaSetModel', model });
}
// op: addReminder | removeReminder | setHeartbeat | removeHeartbeat; `item` is
// the reminder / heartbeat object (just `{ id }` for the remove ops).
export function miaSchedule(op, item = {}) {
  return send({ type: 'miaSchedule', op, item });
}
export function miaPushTest() {
  return send({ type: 'miaPushTest' });
}
