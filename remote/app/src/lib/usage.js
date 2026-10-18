// Claude subscription usage (task 0290). The Mac's `mia usage sync` reads the
// plan-usage endpoint Claude Code's /usage uses and pushes the numbers to the
// relay; here we poll GET /api/v1/usage. One refresh a minute is plenty — the
// Mac itself only re-reads every five.
//
// Levels: under 80% calm, 80% warn (amber), 95% crit (red) — the same lines
// Mia gets an [MC] Usage event at.

import { useEffect } from 'react';
import { create } from 'zustand';
import { getMC } from './store.js';

const POLL_MS = 60000;
export const WARN = 80;
export const CRIT = 95;

export const useUsage = create(() => ({
  usage: null, // { source, at, plan, stale, error, windows: [{ key, label, pct, resetsAt }] }
  receivedAt: 0,
  missing: false, // this relay has no /api/v1/usage yet
}));

let inflight = null;
export function refreshUsage() {
  if (inflight) return inflight;
  const token = getMC().token;
  if (!token) return Promise.resolve();
  inflight = fetch('/api/v1/usage', { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => {
      if (r.status === 404) return useUsage.setState({ missing: true });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) useUsage.setState({ usage: j.usage || null, receivedAt: j.receivedAt || 0, missing: false });
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Mounted once at the root: keeps the numbers warm for Fleet and the pill.
export function useUsageSync() {
  useEffect(() => {
    refreshUsage();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshUsage();
    }, POLL_MS);
    const vis = () => document.visibilityState === 'visible' && refreshUsage();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
}

export const levelOf = (pct) => (pct >= CRIT ? 'crit' : pct >= WARN ? 'warn' : 'ok');

// A window whose reset time has passed is back at zero, whatever the last
// reading said (the Mac may be asleep).
export function liveWindows(usage, now = Date.now()) {
  return (usage?.windows || []).map((w) => {
    const r = Date.parse(w.resetsAt || '');
    return Number.isFinite(r) && r <= now ? { ...w, pct: 0, reset: true } : w;
  });
}

// The window that matters most right now (highest % used).
export function worstWindow(usage, now = Date.now()) {
  const ws = liveWindows(usage, now);
  return ws.reduce((a, w) => (!a || w.pct > a.pct ? w : a), null);
}

export function fmtReset(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const ms = t - now;
  if (ms <= 0) return 'reset';
  const m = Math.round(ms / 60000);
  const rel = m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = ms > 20 * 3600e3 ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ` : '';
  return `resets ${day}${clock} · in ${rel}`;
}
