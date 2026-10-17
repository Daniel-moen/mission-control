// Channels (task 0260) — the data half. Reads what Channels HQ on the Mac last pushed to the relay
// (GET /api/v1/channels), and sends Daniel's taps two ways at once, like HQ (lib/hq.js):
//
//   1. to Mia, as an ordinary chat line through miaSend, so she hears "[MC] Daniel: Channels: …" right away;
//   2. to the relay's queue (POST /api/v1/channels/action), which the Mac's sync files in
//      ~/.mission-control/mia/channels/actions.jsonl. Mia marks it done there; the status comes back here.
//
// Requests only. Nothing in the panel publishes, uploads or talks to YouTube: Mia does, after review.
// Pictures and videos come from the relay's media cache (the Mac uploads them on demand), so they work away
// from home too. Polling, not a socket frame, so the snapshot wire stays untouched.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { getMC, useMC, miaSend, toast } from './store.js';

const POLL_MS = 15000;
const LS_OUTBOX = 'mc.channels.outbox';

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

export const useChannels = create(() => ({
  resp: null, // { state, receivedAt, pending }
  loading: false,
  error: '',
  fetchedAt: 0,
  busy: {}, // action key → true while its POST is in flight
  outbox: loadOutbox(),
}));
const set = (p) => useChannels.setState(p);

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${getMC().token}`, 'Content-Type': 'application/json' },
  });
  let j = {};
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 404 ? 'this relay has no Channels yet' : `HTTP ${r.status}`));
  return j;
}

let inflight = null;
export function refreshChannels() {
  if (inflight) return inflight;
  if (!getMC().token) return Promise.resolve();
  set({ loading: true });
  inflight = api('/api/v1/channels')
    .then((j) => set({ resp: { state: j.state || null, receivedAt: j.receivedAt || 0, pending: j.pending || [] }, error: '', fetchedAt: Date.now() }))
    .catch((e) => set({ error: e.message || 'unreachable' }))
    .finally(() => {
      set({ loading: false });
      inflight = null;
    });
  return inflight;
}

function flushOutbox() {
  const { outbox } = useChannels.getState();
  if (!outbox.length || getMC().link !== 'linked') return;
  const left = outbox.filter((line) => !miaSend(line));
  if (left.length !== outbox.length) {
    set({ outbox: left });
    saveOutbox(left);
  }
}

export function useChannelsSync() {
  const link = useMC((s) => s.link);
  useEffect(() => {
    refreshChannels();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshChannels();
      flushOutbox();
    }, POLL_MS);
    const vis = () => document.visibilityState === 'visible' && refreshChannels();
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

// The view model: the pushed state with each action's latest status (the Mac's log wins over the relay queue).
export function useChannelsView() {
  const resp = useChannels((s) => s.resp);
  return useMemo(() => {
    const st = resp?.state;
    if (!st?.channels) return null;
    const actions = new Map();
    for (const a of st.actions || []) actions.set(a.id, a);
    for (const a of resp.pending || []) if (!actions.has(a.id)) actions.set(a.id, { ...a, status: 'queued', waiting: true });
    const byChannel = new Map(st.channels.map((c) => [c.key, { ...c, videos: [] }]));
    for (const v of st.videos || []) byChannel.get(v.channel)?.videos.push(v);
    const channels = [...byChannel.values()];
    return {
      ...st,
      channels,
      active: channels.filter((c) => c.active),
      parked: channels.filter((c) => !c.active),
      actions: [...actions.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))),
      receivedAt: resp.receivedAt,
      byKey: byChannel,
      video: (id) => (st.videos || []).find((v) => v.id === id),
    };
  }, [resp]);
}

// ---- media through the relay -----------------------------------------------------------------------------
// size: thumb (a resized picture) | poster (a frame of a video) | full (the file itself, mp4 with Range).
export function mediaUrl(m, size = 'thumb') {
  const id = typeof m === 'string' ? m : m?.id;
  if (!id) return '';
  return `/api/v1/channels/media/${encodeURIComponent(id)}?size=${size}&token=${encodeURIComponent(getMC().token || '')}`;
}

// ---- actions -----------------------------------------------------------------------------------------------
export const ACTION_LABEL = {
  approve: 'Approve', reject: 'Reject', make_next_10: 'Make the next 10', pause_channel: 'Pause channel',
  resume_channel: 'Resume channel', schedule: 'Schedule', publish_now: 'Publish now',
  regen_thumbnail: 'Regenerate thumbnail', change_title: 'Change title',
};

export function describe(a, channelName) {
  const bits = [ACTION_LABEL[a.action] || a.action];
  if (a.label) bits.push(`“${a.label}”`);
  if (a.slot) bits.push(`at ${a.slot}`);
  if (a.title) bits.push(`→ new title “${a.title}”`);
  if (a.note) bits.push(`(note: ${a.note})`);
  return `${bits.join(' ')} · ${channelName || a.channel}`;
}

const keyOf = (a) => `${a.action}:${a.channel}:${a.video || ''}`;
export const useActionBusy = (a) => useChannels((s) => !!s.busy[keyOf(a)]);

// One tap: queue it on the relay, tell Mia with the id, show it at once. Returns the queued action or null.
export async function channelAction(a, channelName) {
  const k = keyOf(a);
  if (useChannels.getState().busy[k]) return null;
  set({ busy: { ...useChannels.getState().busy, [k]: true } });
  const linked = getMC().link === 'linked';
  let queued = null;
  try {
    const j = await api('/api/v1/channels/action', { method: 'POST', body: JSON.stringify({ ...a, told: linked }) });
    queued = j.action;
    const resp = useChannels.getState().resp || { state: null, receivedAt: 0, pending: [] };
    set({ resp: { ...resp, pending: j.pending || [...(resp.pending || []), queued] } });
  } catch (e) {
    toast(`Channels: not sent (${e.message})`);
    return null;
  } finally {
    const b = { ...useChannels.getState().busy };
    delete b[k];
    set({ busy: b });
  }
  const line = `Channels: ${describe(a, channelName)}. Video ${a.video || '-'}. Action ${queued.id}: do it, then mark it with \`cd ~/channels-hq && .venv/bin/python -m hq.actions done ${queued.id}\`.`;
  if (!(linked && miaSend(line))) {
    const outbox = [...useChannels.getState().outbox, line].slice(-20);
    set({ outbox });
    saveOutbox(outbox);
    toast('Queued. Mia hears about it when the Mac is back.');
  } else {
    toast(`Sent to Mia: ${ACTION_LABEL[a.action]}`);
  }
  return queued;
}

// ---- small derived numbers -----------------------------------------------------------------------------------
// Days in a row (ending today, or yesterday if today has nothing yet) that hit the day's Shorts target.
export function streak(cad, fallbackTarget = 1) {
  const days = cad?.days || [];
  let n = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i];
    const tgt = d.target || fallbackTarget;
    if (d.posted >= tgt) n += 1;
    else if (i === days.length - 1) continue; // today isn't over
    else break;
  }
  return n;
}

// This plan week: Shorts posted vs the week's target (7 × today's per-day target).
export function weekProgress(cad, fallbackPerDay = 1) {
  const perDay = cad?.today_target || fallbackPerDay;
  if (!cad?.started) return { posted: 0, target: perDay * 7, perDay, started: false };
  const days = cad.days || [];
  const dayInWeek = ((cad.day - 1) % 7) + 1;
  const week = days.slice(-dayInWeek);
  return { posted: week.reduce((a, d) => a + d.posted, 0), target: perDay * 7, perDay, started: true, dayInWeek, week: cad.week };
}

export function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const a = Math.abs(s);
  const v = a < 60 ? 'now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  if (v === 'now') return 'just now';
  return s < 0 ? `in ${v}` : `${v} ago`;
}

export function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : '');
