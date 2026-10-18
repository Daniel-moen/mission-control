// Claude subscription usage on the relay (task 0290): what the Mac's
// `mia usage sync` last read from the plan-usage endpoint Claude Code's
// /usage uses — the 5-hour session and weekly limits, % used, reset times.
//
//   PUT  /api/v1/usage   the Mac pushes the normalised picture
//                        {source, at, plan, stale, error, windows:[{key, label, pct, resetsAt}]}
//   GET  /api/v1/usage   the panel reads it (Fleet's meter, the warning pill)
//
// The relay keeps only the numbers — never a token. One small JSON file on the
// Railway volume so a redeploy still shows the last reading.

'use strict';

const fs = require('fs');
const path = require('path');
const { dataFile } = require('./datafile');

const MAX_WINDOWS = 8;

function createUsage({ file, log = console } = {}) {
  const store = file || dataFile('usage.json', { override: process.env.USAGE_STORE, tag: 'usage', log });
  let data = { usage: null, receivedAt: 0 };
  try {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    if (d && typeof d === 'object') data = { usage: d.usage || null, receivedAt: Number(d.receivedAt) || 0 };
  } catch {}

  function save() {
    try {
      fs.mkdirSync(path.dirname(store), { recursive: true });
      const tmp = `${store}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, store);
    } catch (e) {
      log.warn(`usage: could not save ${store}: ${e.message}`);
    }
  }

  const str = (v, n = 80) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

  // The Mac's push → a clean record, or an error string. Only known fields
  // pass, so nothing else the Mac might carry (or a token) reaches the panel.
  function clean(b) {
    if (!b || typeof b !== 'object') return 'body must be a JSON object';
    if (!Array.isArray(b.windows)) return 'windows must be an array';
    const windows = [];
    for (const w of b.windows.slice(0, MAX_WINDOWS)) {
      if (!w || typeof w !== 'object') continue;
      const key = str(w.key, 40);
      const pct = Number(w.pct);
      if (!/^[a-z0-9_]+$/.test(key) || !Number.isFinite(pct)) continue;
      const out = { key, label: str(w.label, 40) || key, pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)), resetsAt: iso(w.resetsAt) };
      if (w.active === true) out.active = true;
      windows.push(out);
    }
    return {
      source: str(b.source, 40) || 'mac',
      at: iso(b.at) || new Date().toISOString(),
      plan: str(b.plan, 40),
      stale: b.stale === true,
      error: str(b.error, 200),
      windows,
    };
  }

  // null ⇒ not a usage route; else { status, body }.
  function route(rest, method, body) {
    if (rest.length !== 0) return null;
    if (method === 'GET') {
      return { status: 200, body: { ok: true, usage: data.usage, receivedAt: data.receivedAt || null } };
    }
    if (method === 'PUT' || method === 'POST') {
      const u = clean(body);
      if (typeof u === 'string') return { status: 400, body: { ok: false, error: u } };
      data = { usage: u, receivedAt: Date.now() };
      save();
      return { status: 200, body: { ok: true } };
    }
    return null;
  }

  return { route, file: store, _data: () => data };
}

module.exports = { createUsage };
