// The panel's one source of truth (zustand) + the relay link.
//
// Same wire contract as the classic panel (remote/app/src/lib/store.js), so
// the relay and the Mac need no changes:
//   socket  /ws?role=viewer&build=…&token=…   (JSON text frames)
//     in : snapshot (~1 Hz) · hostState · ack · screen · doc · docSearchResult
//          · panel (a `mia panel …` command) · panelFocus
//     out: reply · key · kill · launch · watch · doc* · research · mia* ·
//          viewerActive · panelDone
//   HTTP fallback when a network blocks WebSocket upgrades:
//     GET /api/v1/snapshot (poll) · POST /api/v1/cmd · GET /api/v1/screens
//   plus GET /api/v1/usage (plan usage the Mac pushes).
//
// Reliability (kept from the classic panel, learnt the hard way on iPad):
// capped backoff, redial the moment iOS hands the page back, a silence
// watchdog for zombie sockets, and the HTTP poll fallback.

import { create } from 'zustand';
import type { Agent, DocBody, DocMeta, Jobs, Mia, Model, Summary, SystemInfo, Usage } from './types';

export const BUILD = process.env.NEXT_PUBLIC_MC_BUILD || 'dev';
const LS_TOKEN = 'mc_token';

export type Link = 'offline' | 'relay' | 'linked';

export interface MiaLocal {
  sent: { text: string; at: number; baseline: number }[];
  answered: Record<string, string>;
  dismissed: Record<string, true>;
  readUpTo: string;
}

export interface State {
  booted: boolean;
  token: string;
  needsToken: boolean;
  gateReason: string;
  verifying: boolean;
  link: Link;
  transport: 'ws' | 'poll';
  lastSnapshotAt: number;
  now: number;

  agents: Agent[];
  summary: Summary;
  system: SystemInfo | null;
  models: Model[];
  knownDirs: string[];
  lastDir: string;
  caps: string[];
  docs: DocMeta[];
  docBodies: Record<string, DocBody>;
  search: { q: string; hits: { id: string; snippets?: string[] }[]; at: number };
  screens: Record<string, { seq: number; text: string; at: number }>;
  mia: Mia | null;
  miaLocal: MiaLocal;
  usage: Usage | null;
  spark: number[]; // fleet tokens/sec, one sample per snapshot
  // rolling series for the live sparklines: a:<agentId> tokens/sec, j:<jobId> cost, fleet:cost
  hist: Record<string, number[]>;
  toast: { text: string; n: number } | null;
  primary: boolean;
  // A `mia panel …` command waiting for the UI to run it.
  panelCmd: { id: string; action: string; arg: string; heading?: string; n: number } | null;
}

export const useMC = create<State>(() => ({
  booted: false,
  token: '',
  needsToken: false,
  gateReason: '',
  verifying: false,
  link: 'offline',
  transport: 'ws',
  lastSnapshotAt: 0,
  now: Date.now(),
  agents: [],
  summary: {},
  system: null,
  models: [],
  knownDirs: [],
  lastDir: '',
  caps: [],
  docs: [],
  docBodies: {},
  search: { q: '', hits: [], at: 0 },
  screens: {},
  mia: null,
  miaLocal: { sent: [], answered: {}, dismissed: {}, readUpTo: '' },
  usage: null,
  spark: [],
  hist: {},
  toast: null,
  primary: true,
  panelCmd: null,
}));

export const getMC = () => useMC.getState();
const set = (p: Partial<State>) => useMC.setState(p);

// ---- toast --------------------------------------------------------------------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  set({ toast: { text, n: (getMC().toast?.n || 0) + 1 } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 2800);
}

// ---- token --------------------------------------------------------------------
export function cleanToken(t: string): string {
  t = String(t || '');
  const m = t.match(/[?&#]token=([^&#\s]+)/);
  if (m) {
    try {
      t = decodeURIComponent(m[1]);
    } catch {
      t = m[1];
    }
  }
  return t.replace(/[\s​-‍⁠﻿]/g, '');
}

const REJECTED = 'The relay rejected this token. Check it and enter it again.';

async function checkToken(t: string): Promise<'ok' | 'bad' | 'unknown'> {
  try {
    const { status } = await httpJSON('/api/v1', { headers: { Authorization: `Bearer ${t}` } }, 8000);
    return status === 401 ? 'bad' : status === 200 ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function gate(reason: string, usedToken?: string) {
  const mc = getMC();
  if (usedToken !== undefined && usedToken !== mc.token) return;
  if (mc.verifying) return;
  relayUp = false;
  hostOnline = false;
  setLink();
  set({ needsToken: true, gateReason: reason });
}

export async function saveToken(raw: string) {
  const t = cleanToken(raw);
  if (!t || getMC().verifying) return;
  set({ verifying: true, gateReason: '' });
  const r = await checkToken(t);
  if (r === 'bad') {
    set({ verifying: false, gateReason: 'That token was rejected by the relay. Check it and try again.' });
    return;
  }
  localStorage.setItem(LS_TOKEN, t);
  set({ token: t, needsToken: false, verifying: false, gateReason: '' });
  connect();
  refreshUsage();
}

export function forgetToken() {
  localStorage.removeItem(LS_TOKEN);
  location.reload();
}

// ---- boot ---------------------------------------------------------------------
export function boot() {
  if (getMC().booted || typeof window === 'undefined') return;
  set({ booted: true });
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    localStorage.setItem(LS_TOKEN, cleanToken(params.get('token') || ''));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const token = localStorage.getItem(LS_TOKEN) || '';
  set({ token, needsToken: !token });

  document.addEventListener('visibilitychange', () => {
    reportActive(document.visibilityState !== 'hidden');
    if (document.visibilityState === 'visible') reconnectNow();
  });
  window.addEventListener('pageshow', reconnectNow);
  window.addEventListener('online', reconnectNow);
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, noteInteraction, { passive: true });

  setInterval(() => {
    set({ now: Date.now() });
    if (ws && ws.readyState === 1 && Date.now() - lastFrameAt > ZOMBIE_MS) connect();
    setLink();
  }, 1000);
  setInterval(refreshUsage, 5 * 60000);

  if (!token) return;
  connect();
  refreshUsage();
  checkToken(token).then((r) => r === 'bad' && gate(REJECTED, token));
}

// ---- presence (who gets Mia's `mia panel` commands) ---------------------------
let lastInteraction = Date.now();
let lastActiveSent = 0;
function noteInteraction() {
  lastInteraction = Date.now();
  if (Date.now() - lastActiveSent > 15000) reportActive(true);
}
function reportActive(visible: boolean) {
  lastActiveSent = Date.now();
  sendRelay({ type: 'viewerActive', visible });
}
function sendRelay(obj: object) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  // Poll mode reports presence through the X-MC-Idle/X-MC-Visible headers.
}

// ---- socket -------------------------------------------------------------------
let ws: WebSocket | null = null;
let retry = 0;
let relayUp = false;
let hostOnline = false;
let lastFrameAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let wsFails = 0;
const STALE_MS = 12000;
const ZOMBIE_MS = 20000;
const WS_FAILS_TO_POLL = 3;
const WS_CONNECT_TIMEOUT_MS = 8000;

function snapshotFresh() {
  const at = getMC().lastSnapshotAt;
  return !!at && Date.now() - at <= STALE_MS;
}
function setLink() {
  const link: Link = hostOnline && snapshotFresh() ? 'linked' : relayUp ? 'relay' : 'offline';
  if (getMC().link !== link) set({ link });
}

export function connect() {
  const token = getMC().token;
  if (!token) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=viewer&build=${encodeURIComponent(BUILD)}&token=${encodeURIComponent(token)}`;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch {
    wsFailed();
    if (!isPoll()) scheduleReconnect();
    return;
  }
  ws = sock;
  let opened = false;
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (ws === sock && sock.readyState === 0 && !isPoll()) enterPoll();
  }, WS_CONNECT_TIMEOUT_MS);
  sock.onopen = () => {
    opened = true;
    clearTimeout(connectTimer);
    retry = 0;
    wsFails = 0;
    exitPoll();
    relayUp = true;
    lastFrameAt = Date.now();
    setLink();
    sendAllWatches();
    if (document.visibilityState !== 'hidden') reportActive(true);
  };
  sock.onmessage = (e) => {
    lastFrameAt = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleFrame(msg);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    clearTimeout(connectTimer);
    if (e.code === 4001 || e.code === 1008) return gate(REJECTED);
    if (!opened) wsFailed();
    if (isPoll()) return;
    relayUp = false;
    hostOnline = false;
    setLink();
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect() {
  const mc = getMC();
  if (reconnectTimer || mc.needsToken || !mc.token || isPoll()) return;
  const base = Math.min(5000, 600 * Math.pow(2, retry++));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, base / 2 + Math.random() * (base / 2));
}

export function reconnectNow() {
  const mc = getMC();
  if (!mc.token || mc.needsToken) return;
  if (isPoll()) pollOnce();
  retry = 0;
  if (ws && ws.readyState === 1) {
    if (!snapshotFresh() && Date.now() - lastFrameAt > STALE_MS) connect();
    return;
  }
  connect();
}

// ---- HTTP poll fallback -------------------------------------------------------
const POLL_MS = 1500;
const CLIENT_ID = `v6${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wsRetryTimer: ReturnType<typeof setInterval> | null = null;
let screenTimer: ReturnType<typeof setTimeout> | null = null;
let pollBusy = false;
let lastPollSeq: unknown = null;

const isPoll = () => getMC().transport === 'poll';

export async function httpJSON(path: string, opts: RequestInit = {}, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const token = getMC().token;
  try {
    const r = await fetch(path, {
      cache: 'no-store',
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MC-Client': CLIENT_ID,
        'X-MC-Idle': String(Math.max(0, Date.now() - lastInteraction)),
        'X-MC-Visible': document.visibilityState === 'hidden' ? '0' : '1',
        ...((opts.headers as Record<string, string>) || {}),
      },
      signal: ctl.signal,
    });
    let data: any = null;
    try {
      data = await r.json();
    } catch {}
    return { status: r.status, data, token };
  } finally {
    clearTimeout(timer);
  }
}

function wsFailed() {
  wsFails += 1;
  if (!isPoll() && wsFails >= WS_FAILS_TO_POLL) enterPoll();
}

function enterPoll() {
  if (isPoll()) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  set({ transport: 'poll' });
  lastPollSeq = null;
  pollTimer = setInterval(pollOnce, POLL_MS);
  wsRetryTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) connect();
  }, 60000);
  pollOnce();
  sendAllWatches();
  syncScreenPoll();
}

function exitPoll() {
  if (!isPoll()) return;
  if (pollTimer) clearInterval(pollTimer);
  if (wsRetryTimer) clearInterval(wsRetryTimer);
  pollTimer = wsRetryTimer = null;
  set({ transport: 'ws' });
  syncScreenPoll();
}

async function pollOnce() {
  const mc = getMC();
  if (!isPoll() || pollBusy || !mc.token || mc.needsToken) return;
  pollBusy = true;
  try {
    const { status, data, token } = await httpJSON('/api/v1/snapshot');
    if (!isPoll()) return;
    if (status === 401) gate(REJECTED, token);
    else if (status === 200 && data?.snapshot) {
      relayUp = true;
      hostOnline = !!data.hostOnline;
      if (data.seq !== lastPollSeq) {
        lastPollSeq = data.seq;
        set({ lastSnapshotAt: Date.now() - (typeof data.ageMs === 'number' ? data.ageMs : 0) });
        ingest(data.snapshot);
      }
      if (typeof data.primary === 'boolean') set({ primary: data.primary });
      for (const f of Array.isArray(data.panel) ? data.panel : []) handleFrame(f);
    } else if (status === 502) {
      relayUp = true;
      hostOnline = false;
    } else {
      relayUp = hostOnline = false;
    }
  } catch {
    relayUp = hostOnline = false;
  } finally {
    pollBusy = false;
    setLink();
  }
}

function syncScreenPoll() {
  const want = isPoll() && watchLeases.size > 0;
  if (want && !screenTimer) screenTimer = setTimeout(pollScreens, 0);
  else if (!want && screenTimer) {
    clearTimeout(screenTimer);
    screenTimer = null;
  }
}

async function pollScreens() {
  screenTimer = null;
  if (!isPoll() || !watchLeases.size) return;
  try {
    const ids = [...watchLeases.keys()].map(encodeURIComponent).join(',');
    const { status, data } = await httpJSON(`/api/v1/screens?ids=${ids}`);
    if (status === 200 && data?.screens) {
      for (const [sessionId, f] of Object.entries<any>(data.screens)) ingestScreen({ sessionId, seq: f.seq, text: f.text });
    }
  } catch {}
  if (isPoll() && watchLeases.size && !screenTimer) screenTimer = setTimeout(pollScreens, 2000);
}

async function postCmd(obj: any, silent = false) {
  try {
    const { status, data, token } = await httpJSON(
      '/api/v1/cmd',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) },
      20000,
    );
    if (status === 200 && data) {
      if (data.type) handleFrame(data);
      return;
    }
    if (status === 401) return gate(REJECTED, token);
    if (!silent) cmdFailed(obj, status === 502 ? 'Your Mac is offline' : status === 504 ? 'No answer from your Mac' : 'Not connected');
  } catch {
    if (!silent) cmdFailed(obj, 'Not connected');
  }
}

function cmdFailed(obj: any, text: string) {
  if (obj.type === 'miaSend') setMiaLocal((l) => ({ sent: l.sent.slice(1) }));
  toast(text);
}

// ---- outgoing -----------------------------------------------------------------
export function send(obj: any): boolean {
  if (isPoll()) {
    postCmd(obj);
    return true;
  }
  if (!ws || ws.readyState !== 1) {
    toast(getMC().link === 'offline' ? 'Not connected' : 'Your Mac is offline');
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

// ---- watch leases (live terminal streams) -------------------------------------
const watchLeases = new Map<string, { n: number; hot: number }>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
function sendWatch(sessionId: string) {
  const l = watchLeases.get(sessionId);
  const frame = { type: 'watch', sessionId, hot: !!l?.hot };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  else if (isPoll()) postCmd(frame, true);
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
export function watchAgent(sessionId: string, hot = false) {
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

function ingestScreen(msg: { sessionId?: string; seq?: number; text?: string; keep?: number }) {
  if (!msg.sessionId) return;
  const prev = getMC().screens[msg.sessionId];
  let text = msg.text;
  if (typeof msg.keep === 'number') {
    if (!prev || msg.seq !== prev.seq + 1 || prev.text.length < msg.keep) return;
    text = prev.text.slice(0, msg.keep) + (msg.text || '');
  }
  if (typeof text !== 'string') return;
  if (prev && typeof msg.seq === 'number' && msg.seq <= prev.seq && msg.seq > prev.seq - 1000) return;
  useMC.setState((s) => ({ screens: { ...s.screens, [msg.sessionId as string]: { seq: msg.seq ?? 0, text: text as string, at: Date.now() } } }));
}

// ---- incoming -----------------------------------------------------------------
function handleFrame(msg: any) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'snapshot':
      hostOnline = true;
      set({ lastSnapshotAt: Date.now() });
      setLink();
      ingest(msg);
      break;
    case 'screen':
      ingestScreen(msg);
      break;
    case 'doc':
      if (msg.id && typeof msg.content === 'string') {
        useMC.setState((s) => ({
          docBodies: {
            ...s.docBodies,
            [msg.id]: { content: msg.content, title: msg.title || '', kind: msg.kind || 'note', status: msg.status || 'draft', updatedAt: Number(msg.updatedAt) || 0 },
          },
        }));
      }
      break;
    case 'docSearchResult':
      set({ search: { q: msg.q || '', hits: Array.isArray(msg.hits) ? msg.hits : [], at: Date.now() } });
      break;
    case 'hostState':
      hostOnline = !!msg.online;
      relayUp = true;
      setLink();
      break;
    case 'ack':
      handleAck(msg);
      break;
    case 'panel':
      set({ panelCmd: { id: String(msg.id || ''), action: String(msg.action || ''), arg: String(msg.arg || ''), heading: msg.heading, n: (getMC().panelCmd?.n || 0) + 1 } });
      break;
    case 'panelFocus':
      set({ primary: msg.primary !== false });
      break;
  }
}

export function panelDone(cmd: { id: string; action: string; arg: string }, ok: boolean, detail = '') {
  const frame = { type: 'panelDone', id: cmd.id, action: cmd.action, arg: cmd.arg, ok, detail };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  else if (isPoll()) postCmd(frame, true);
}

const ACK_OK: Record<string, string> = {
  miaTaskAdd: 'Task added',
  miaTaskCancel: 'Task cancelled',
  miaTaskSet: 'Task updated',
  miaStart: 'Starting Mia',
  miaStop: 'Mia stopped',
  miaRestart: 'Restarting Mia',
  miaSetModel: 'Model saved, applies on her next start',
  miaPushTest: 'Test notification sent',
  launch: 'Agent launched',
  kill: 'Stopped',
  docSave: 'Saved',
  research: 'Research started',
};

function handleAck(msg: any) {
  if (!msg.ok) {
    if (msg.cmd === 'miaRead' || msg.cmd === 'watch') return;
    if (msg.cmd === 'miaSend') setMiaLocal((l) => ({ sent: l.sent.slice(1) }));
    if (msg.cmd === 'miaDismiss') setMiaLocal(() => ({ dismissed: {} }));
    toast(msg.detail || 'That didn’t go through');
    return;
  }
  const t = ACK_OK[msg.cmd];
  if (t) toast(msg.cmd === 'miaPushTest' && msg.detail ? msg.detail : t);
}

// ---- snapshot ingest -----------------------------------------------------------
let docsKey = '';
let dirsKey = '';
let modelsKey = '';
let miaKey = '';

const statusRank = (a: Agent) => (a.alive === false && a.status !== 'done' ? 2 : a.status === 'active' ? 0 : a.status === 'idle' ? 1 : 3);

function ingest(s: any) {
  const mc = getMC();
  const patch: Partial<State> = {};
  patch.summary = s.summary || {};
  patch.system = s.system && typeof s.system.cpu === 'number' ? s.system : null;
  patch.caps = Array.isArray(s.caps) ? s.caps : [];
  const agents: Agent[] = [...(s.agents || [])].sort(
    (a: Agent, b: Agent) => statusRank(a) - statusRank(b) || String(a.name || a.folder).localeCompare(String(b.name || b.folder)),
  );
  patch.agents = agents;
  const ids = new Set(agents.map((a) => a.id));
  let screens = mc.screens;
  for (const id of Object.keys(screens)) {
    if (!ids.has(id)) {
      if (screens === mc.screens) screens = { ...screens };
      delete screens[id];
    }
  }
  if (screens !== mc.screens) patch.screens = screens;
  const spark = [...mc.spark, s.summary?.tokensPerSec ?? 0];
  if (spark.length > 90) spark.shift();
  patch.spark = spark;
  const hist: Record<string, number[]> = {};
  const push = (k: string, v: number) => {
    const prev = mc.hist[k] || [];
    hist[k] = prev.length >= 48 ? [...prev.slice(1), v] : [...prev, v];
  };
  for (const a of agents) push(`a:${a.id}`, a.tokensPerSec || 0);
  let fleetCost = 0;
  for (const j of (s.mia?.jobs?.jobs || []) as any[]) {
    if (j.status === 'running' || j.status === 'waiting') {
      push(`j:${j.id}`, Number(j.costUsd) || 0);
      fleetCost += Number(j.costUsd) || 0;
    }
  }
  for (const a of agents) fleetCost += a.cost || 0;
  push('fleet:cost', fleetCost);
  patch.hist = hist;

  const dk = (s.docs || []).map((d: DocMeta) => `${d.id}@${d.updatedAt}`).join('|');
  if (dk !== docsKey) {
    docsKey = dk;
    const docs: DocMeta[] = (s.docs || []).map((d: DocMeta) => (d && d.kind !== 'page' && (d.tags || []).includes('page') ? { ...d, kind: 'page' } : d));
    patch.docs = docs;
    let bodies = mc.docBodies;
    for (const id of Object.keys(bodies)) {
      const meta = docs.find((d) => d.id === id);
      if (!meta || (meta.updatedAt ?? 0) > (bodies[id].updatedAt ?? 0)) {
        if (bodies === mc.docBodies) bodies = { ...bodies };
        delete bodies[id];
      }
    }
    if (bodies !== mc.docBodies) patch.docBodies = bodies;
  }
  const dirs = JSON.stringify(s.knownDirs || []);
  if (dirs !== dirsKey) {
    dirsKey = dirs;
    patch.knownDirs = (s.knownDirs || []).map((d: any) => (typeof d === 'string' ? d : d?.dir || d?.path || '')).filter(Boolean);
  }
  if (!mc.lastDir && s.lastDir) patch.lastDir = s.lastDir;
  const mk = (s.models || []).map((m: Model) => m.flag).join('|');
  if (s.models?.length && mk !== modelsKey) {
    modelsKey = mk;
    patch.models = s.models;
  }
  ingestMia(s, mc, patch);
  set(patch);
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const str = (v: unknown) => (v == null ? '' : String(v));

export function normMia(m: any): Mia | null {
  if (!m || typeof m !== 'object') return null;
  const j = m.jobs && typeof m.jobs === 'object' ? m.jobs : null;
  const jobs: Jobs | null = j ? { ...j, jobs: arr(j.jobs) } : null;
  return {
    enabled: !!m.enabled,
    online: !!m.online,
    sessionId: str(m.sessionId),
    model: str(m.model),
    runningModel: str(m.runningModel),
    restarts: Number(m.restarts) || 0,
    readUpTo: str(m.readUpTo),
    messages: arr(m.messages),
    tasks: arr(m.tasks),
    pendingQuestions: arr(m.pendingQuestions),
    oldQuestions: arr(m.oldQuestions),
    closedQuestions: m.closedQuestions && typeof m.closedQuestions === 'object' ? m.closedQuestions : {},
    questionMaxAgeHours: Number.isFinite(Number(m.questionMaxAgeHours)) && m.questionMaxAgeHours !== null ? Number(m.questionMaxAgeHours) : null,
    schedule: m.schedule ?? null,
    pushKey: str(m.pushKey),
    jobs,
  };
}

function ingestMia(s: any, mc: State, patch: Partial<State>) {
  const k = s.mia ? JSON.stringify(s.mia) : '';
  if (k === miaKey) return;
  miaKey = k;
  const mia = normMia(s.mia);
  patch.mia = mia;
  const loc = mc.miaLocal;
  const msgs = mia?.messages || [];
  const sent = loc.sent.filter((p) => {
    if (Date.now() - p.at > 30000) return false;
    const seen = msgs.filter((m) => m.from === 'daniel' && m.kind === 'chat' && m.text === p.text).length;
    return seen <= p.baseline;
  });
  const pending = new Set([...(mia?.pendingQuestions || []), ...(mia?.oldQuestions || [])].map((q) => q.questionId));
  const retire = <T,>(map: Record<string, T>) => {
    let out = map;
    for (const id of Object.keys(map)) {
      if (!pending.has(id)) {
        if (out === map) out = { ...map };
        delete out[id];
      }
    }
    return out;
  };
  const answered = retire(loc.answered);
  const dismissed = retire(loc.dismissed);
  if (sent.length !== loc.sent.length || answered !== loc.answered || dismissed !== loc.dismissed) {
    patch.miaLocal = { ...loc, sent, answered, dismissed };
  }
}

function setMiaLocal(fn: (l: MiaLocal) => Partial<MiaLocal>) {
  useMC.setState((s) => ({ miaLocal: { ...s.miaLocal, ...fn(s.miaLocal) } }));
}

// ---- usage (plan limits) -------------------------------------------------------
export async function refreshUsage() {
  if (!getMC().token) return;
  try {
    const { status, data } = await httpJSON('/api/v1/usage');
    if (status === 200 && data) set({ usage: data.usage || (data.windows ? data : null) });
  } catch {}
}

// ---- commands -------------------------------------------------------------------
export const VOICE_TAG = '(voice) ';

export function miaSend(text: string, { voice = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  const body = voice ? VOICE_TAG + t : t;
  const msgs = getMC().mia?.messages || [];
  const baseline = msgs.filter((m) => m.from === 'daniel' && m.kind === 'chat' && m.text === body).length;
  if (!send({ type: 'miaSend', text: body })) return false;
  setMiaLocal((l) => ({ sent: [...l.sent, { text: body, at: Date.now(), baseline }] }));
  return true;
}
export function miaAnswer(questionId: string, text: string) {
  if (!questionId || !send({ type: 'miaAnswer', questionId, text })) return false;
  setMiaLocal((l) => ({ answered: { ...l.answered, [questionId]: text } }));
  return true;
}
export function miaDismiss(questionIds: string[]) {
  if (!questionIds.length || !send({ type: 'miaDismiss', questionIds })) return false;
  setMiaLocal((l) => ({ dismissed: { ...l.dismissed, ...Object.fromEntries(questionIds.map((id) => [id, true as const])) } }));
  return true;
}
export function miaRead(upTo: string) {
  if (!upTo || getMC().miaLocal.readUpTo === upTo) return;
  setMiaLocal(() => ({ readUpTo: upTo }));
  if (isPoll()) postCmd({ type: 'miaRead', upTo }, true);
  else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'miaRead', upTo }));
}
export const miaTaskAdd = (title: string, detail = '', dir = '') => !!title && send({ type: 'miaTaskAdd', title, ...(detail ? { detail } : {}), ...(dir ? { dir } : {}) });
export const miaTaskCancel = (id: string) => !!id && send({ type: 'miaTaskCancel', id });
export const miaTaskSet = (id: string, field: string, value: unknown) => !!id && send({ type: 'miaTaskSet', id, field, value });
export const miaStart = () => send({ type: 'miaStart' });
export const miaSetModel = (model: string) => !!model && send({ type: 'miaSetModel', model });
export const miaPushTest = () => send({ type: 'miaPushTest' });
export function miaRestart() {
  if (getMC().caps.includes('miaRestart')) return send({ type: 'miaRestart' });
  if (!send({ type: 'miaStop' })) return false;
  setTimeout(() => send({ type: 'miaStart' }), 1500);
  return true;
}
export const reply = (sessionId: string, text: string) => !!text.trim() && send({ type: 'reply', sessionId, text });
export const sendKey = (sessionId: string, key: string) => send({ type: 'key', sessionId, key: String(key) });
export const kill = (sessionId: string) => send({ type: 'kill', sessionId });
export const launch = (p: { dir: string; mission: string; model?: string }) =>
  !!p.mission.trim() && send({ type: 'launch', mission: p.mission.trim(), dir: p.dir.trim(), managerModel: null, workerModels: [p.model || ''] });
export const docGet = (id: string) => send({ type: 'docGet', id });
export const docSearch = (q: string) => send({ type: 'docSearch', q });
export const research = (topic: string, model = '') => send({ type: 'research', topic, subject: '', dir: '', model, tags: [] });
