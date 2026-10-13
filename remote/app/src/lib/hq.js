// Jarvis HQ — the state half (task 0199). Reads what the Mac last pushed to
// the relay (GET /api/v1/jarvis), and sends Daniel's controls two ways at once:
//
//   1. to Mia, as an ordinary chat line through the existing miaSend path, so
//      she hears "[MC] Daniel: HQ: …" right away (it shows in the thread too);
//   2. to the relay's control queue (POST /api/v1/jarvis/control), which the
//      Mac's `mia jarvis sync` applies to registry.json — that is what makes
//      the change stick.
//
// If the Mac is offline the chat line can't go yet; it waits in a small outbox
// (this device, localStorage) and goes out the moment the link is back. The
// queued control is safe on the relay either way.
//
// Polling, not a socket frame: HQ is a calm view, a 15 s refresh while it is
// open is plenty, and it keeps the snapshot wire (store.js) untouched.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { getMC, useMC, miaSend, toast } from './store.js';
import { overlay, miaLine, makeMatcher, mergeTasks } from './hqModel.js';

const POLL_MS = 15000;
const LS_OUTBOX = 'mc.hq.outbox';

function loadOutbox() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-20) : [];
  } catch {
    return [];
  }
}
function saveOutbox(list) {
  try {
    localStorage.setItem(LS_OUTBOX, JSON.stringify(list));
  } catch {}
}

export const useHQ = create(() => ({
  resp: null, // { state, receivedAt, pending } from the relay
  loading: false,
  error: '', // last fetch problem, shown quietly in the header
  fetchedAt: 0,
  busy: {}, // control key → true while its POST is in flight
  outbox: loadOutbox(), // HQ lines for Mia that couldn't be sent yet
}));
const set = (p) => useHQ.setState(p);

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${getMC().token}`, 'Content-Type': 'application/json' },
  });
  let j = {};
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 404 ? 'this relay has no HQ yet' : `HTTP ${r.status}`));
  return j;
}

let inflight = null;
export function refreshHQ() {
  if (inflight) return inflight;
  if (!getMC().token) return Promise.resolve();
  set({ loading: true });
  inflight = api('/api/v1/jarvis')
    .then((j) => set({ resp: { state: j.state || null, receivedAt: j.receivedAt || 0, pending: j.pending || [] }, error: '', fetchedAt: Date.now() }))
    .catch((e) => set({ error: e.message || 'unreachable' }))
    .finally(() => {
      set({ loading: false });
      inflight = null;
    });
  return inflight;
}

function flushOutbox() {
  const { outbox } = useHQ.getState();
  if (!outbox.length || getMC().link !== 'linked') return;
  const left = [];
  for (const line of outbox) if (!miaSend(line)) left.push(line);
  if (left.length !== outbox.length) {
    set({ outbox: left });
    saveOutbox(left);
  }
}

// Mount once per open HQ: fetch now, every 15 s while visible, on return to
// the tab, and whenever the Mac link comes back (that's also when the outbox
// can drain).
export function useHQSync() {
  const link = useMC((s) => s.link);
  useEffect(() => {
    refreshHQ();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshHQ();
      flushOutbox();
    }, POLL_MS);
    const vis = () => document.visibilityState === 'visible' && refreshHQ();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  useEffect(() => {
    if (link === 'linked') flushOutbox();
  }, [link]);
}

// The view model: the Mac's registry with pending taps on top, plus tasks
// merged with the live snapshot. Memoised on its inputs — a fresh object per
// render would re-render HQ at the snapshot's 1 Hz for nothing.
export function useHQView() {
  const resp = useHQ((s) => s.resp);
  const liveTasks = useMC((s) => s.mia?.tasks);
  return useMemo(() => {
    const st = resp?.state;
    if (!st?.registry) return null;
    const registry = overlay(st.registry, resp.pending);
    const match = makeMatcher(registry.projects, st.home || '');
    const tasks = mergeTasks(st.tasks, liveTasks, match);
    return { registry, match, tasks, findings: Array.isArray(st.findings) ? st.findings : [], pushedAt: st.at, receivedAt: resp.receivedAt, pending: resp.pending };
  }, [resp, liveTasks]);
}

const keyOf = (c) => `${c.action}:${c.project || ''}`;

// One control: tell Mia (chat path), queue it for the Mac (relay), show it at
// once (pending overlay). Returns true when it was saved.
export async function hqControl(c, registry) {
  const k = keyOf(c);
  if (useHQ.getState().busy[k]) return false;
  const line = miaLine(c, registry);
  const told = line ? miaSend(line) : false;
  set({ busy: { ...useHQ.getState().busy, [k]: true } });
  try {
    const j = await api('/api/v1/jarvis/control', { method: 'POST', body: JSON.stringify({ ...c, told }) });
    const resp = useHQ.getState().resp || { state: null, receivedAt: 0, pending: [] };
    set({ resp: { ...resp, pending: j.pending || [...(resp.pending || []), j.control] } });
  } catch (e) {
    toast(`HQ: not saved (${e.message})${told ? ' but Mia was told' : ''}`);
    return false;
  } finally {
    const b = { ...useHQ.getState().busy };
    delete b[k];
    set({ busy: b });
  }
  if (line && !told) {
    const outbox = [...useHQ.getState().outbox, line].slice(-20);
    set({ outbox });
    saveOutbox(outbox);
    toast('Saved. Mia hears about it when the Mac is back.');
  }
  return true;
}

export const useBusy = (c) => useHQ((s) => !!s.busy[keyOf(c)]);
