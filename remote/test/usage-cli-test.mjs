// `mia usage` (scripts/mia-usage, task 0290) against a temp MIA_DIR, a fake
// plan-usage endpoint and a fake relay — no internet, no Keychain, nothing
// under ~/.mission-control: normalisation (limits + the five_hour/seven_day
// fallback), the human table, --json, the 4-minute cache, 401 → stale, 429
// backoff, the relay push, thresholds firing once per period, exact alert
// text, and the token never leaking.   node test/usage-cli-test.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-usage-cli-'));
const TOKEN = 'sk-ant-oat01-TEST-SECRET-usage-token-0290';
const RELAY_TOKEN = 'relay-test-token';
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};

// ---- fake usage endpoint ---------------------------------------------------
let hits = 0;
let lastHeaders = {};
let reply = { code: 200, body: {} };
const us = http.createServer((q, s) => {
  hits += 1;
  lastHeaders = q.headers;
  const h = { 'Content-Type': 'application/json' };
  if (reply.retryAfter) h['Retry-After'] = String(reply.retryAfter);
  s.writeHead(reply.code, h);
  s.end(JSON.stringify(reply.body));
});
// ---- fake relay -------------------------------------------------------------
const puts = [];
const rs = http.createServer((q, s) => {
  let b = '';
  q.on('data', (d) => (b += d));
  q.on('end', () => {
    puts.push({ method: q.method, url: q.url, auth: q.headers.authorization, body: b ? JSON.parse(b) : null });
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end('{"ok":true}');
  });
});
await new Promise((r) => us.listen(0, '127.0.0.1', r));
await new Promise((r) => rs.listen(0, '127.0.0.1', r));
const USAGE_URL = `http://127.0.0.1:${us.address().port}/api/oauth/usage`;
const RELAY_URL = `http://127.0.0.1:${rs.address().port}`;

const outputs = [];
const dirs = [];
const newDir = (name) => { const d = path.join(TMP, name); dirs.push(d); return d; };
const run = (miaDir, args, extraEnv = {}) =>
  new Promise((resolve) => {
    const env = { ...process.env, MIA_DIR: miaDir, MIA_USAGE_URL: USAGE_URL, MIA_USAGE_TOKEN: TOKEN, MIA_USAGE_PLAN: 'max_5x',
      MC_DOC_NO_DEFAULTS: '1', MC_RELAY_URL: '', MC_TOKEN: '', ...extraEnv };
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), 'usage', ...args], { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => { outputs.push(stdout, stderr); resolve({ status, stdout, stderr }); });
  });
const withRelay = { MC_RELAY_URL: RELAY_URL, MC_TOKEN: RELAY_TOKEN };
const readJ = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
const writeJ = (d, f, o) => fs.writeFileSync(path.join(d, f), JSON.stringify(o));

// ---- helpers for times ------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const isoMicro = (t) => new Date(t).toISOString().replace('Z', '937082+00:00'); // like the real endpoint
const isoZ = (t) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const NOW = Date.now();
// +30 s of slack so "in 1h 36m" holds while the script runs.
const S_RESET = Math.floor((NOW + (96 * 60 + 30) * 1000) / 1000) * 1000;
const W_RESET = Math.floor((NOW + (3 * 86400 + 7 * 3600 + 30) * 1000) / 1000) * 1000;

const limitsBody = (session, weekly = 63, fable = 25, sReset = S_RESET) => ({
  five_hour: { utilization: session, resets_at: isoMicro(sReset) },
  seven_day: { utilization: weekly, resets_at: isoMicro(W_RESET) },
  seven_day_fable_codename: { utilization: 1 },
  limits: [
    { kind: 'session', group: 'session', percent: session, severity: 'normal', resets_at: isoMicro(sReset), scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal', resets_at: isoMicro(W_RESET), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: fable, resets_at: isoMicro(W_RESET), scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  extra_usage: { is_enabled: false },
});

try {
  // ---------------------------------------------------------------------------
  console.log('normalisation from limits + --json');
  const A = newDir('a');
  reply = { code: 200, body: limitsBody(32) };
  let r = await run(A, ['--json']);
  ok(r.status === 0, '`mia usage --json` exits 0');
  const u = JSON.parse(r.stdout);
  ok(JSON.stringify(Object.keys(u)) === JSON.stringify(['source', 'at', 'plan', 'stale', 'error', 'windows']), 'top-level keys exactly source/at/plan/stale/error/windows');
  ok(u.source === 'oauth-usage' && u.plan === 'max_5x' && u.stale === false && u.error === '', 'source, plan, not stale, no error');
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(u.at) && Math.abs(Date.parse(u.at) - Date.now()) < 60000, 'at is a fresh ISO Z time');
  ok(u.windows.map((w) => w.key).join() === 'session,weekly,weekly_fable', 'windows session, weekly, weekly_fable (codename keys ignored)');
  const [ws, ww, wf] = u.windows;
  ok(ws.label === 'Session (5h)' && ws.pct === 32 && ws.resetsAt === isoZ(S_RESET) && ws.severity === 'normal' && !('active' in ws), 'session window');
  ok(ww.label === 'Week' && ww.pct === 63 && ww.resetsAt === isoZ(W_RESET) && ww.active === true, 'weekly window (active)');
  ok(wf.label === 'Week · Fable' && wf.pct === 25 && !('active' in wf), 'weekly_fable window');
  ok(hits === 1, 'one endpoint hit');
  ok(lastHeaders.authorization === `Bearer ${TOKEN}` && lastHeaders['anthropic-beta'] === 'oauth-2025-04-20' && /^claude-code\//.test(lastHeaders['user-agent']), 'bearer + anthropic-beta + claude-code UA headers');
  ok(JSON.stringify(readJ(A, 'usage.json')) === JSON.stringify(u), 'cache file = printed object');

  console.log('cache reuse within 4 minutes');
  r = await run(A, []);
  ok(r.status === 0 && hits === 1, 'second `mia usage` reuses the cache (no hit)');
  ok(r.stdout.includes('Session (5h)') && /32%\s+resets \d\d:\d\d \(in 1h 36m\)/.test(r.stdout), 'human: session 32%, resets HH:MM (in 1h 36m)');
  ok(r.stdout.includes(`resets ${hhmm(S_RESET)} (in 1h 36m)`), 'human: local reset time');
  const wd = new Date(W_RESET).toLocaleDateString('en-US', { weekday: 'short' });
  ok(r.stdout.includes(`Week`) && r.stdout.includes(`63%`) && r.stdout.includes(`resets ${wd} ${hhmm(W_RESET)} (in 3d 7h)`), 'human: weekly shows weekday for >24h');
  ok(r.stdout.includes('Week · Fable') && /25%/.test(r.stdout), 'human: Fable line');
  ok(/as of \d\d:\d\d/.test(r.stdout) && !r.stdout.includes('stale'), 'human: as of HH:MM, not stale');
  r = await run(A, ['--refresh']);
  ok(r.status === 0 && hits === 2, '--refresh forces a fetch');

  console.log('clamp + rounding');
  reply = { code: 200, body: { limits: [{ kind: 'session', percent: 133.7, resets_at: isoMicro(S_RESET) }, { kind: 'weekly_all', percent: 33.333, resets_at: null }] } };
  r = await run(A, ['--refresh', '--json']);
  let j = JSON.parse(r.stdout);
  ok(j.windows[0].pct === 100 && j.windows[1].pct === 33.3 && j.windows[1].resetsAt === '', 'pct clamped to 100, 1 decimal, null reset → ""');

  console.log('fallback: five_hour / seven_day');
  reply = { code: 200, body: {
    five_hour: { utilization: 41.26, resets_at: isoMicro(S_RESET) },
    seven_day: { utilization: 12, resets_at: isoMicro(W_RESET) },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 7, resets_at: isoMicro(W_RESET) },
    seven_day_oauth_apps: null,
    seven_day_fable_codename: { utilization: 99, resets_at: isoMicro(W_RESET) },
  } };
  r = await run(A, ['--refresh', '--json']);
  j = JSON.parse(r.stdout);
  ok(j.windows.map((w) => `${w.key}:${w.label}:${w.pct}`).join('|') === 'session:Session (5h):41.3|weekly:Week:12|weekly_sonnet:Week · Sonnet:7', 'five_hour/seven_day/seven_day_sonnet mapped; null + codename keys ignored');

  console.log('401 → stale, old numbers kept');
  reply = { code: 200, body: limitsBody(32) };
  await run(A, ['--refresh']);
  const before = readJ(A, 'usage.json');
  reply = { code: 401, body: { error: { type: 'authentication_error' } } };
  const h0 = hits;
  r = await run(A, ['--refresh', '--json']);
  j = JSON.parse(r.stdout);
  ok(r.status === 0 && hits === h0 + 1, '401 does not crash');
  ok(j.stale === true && j.error === 'login token expired — Claude Code refreshes it on its next request', 'stale with the expired-login error');
  ok(JSON.stringify(j.windows) === JSON.stringify(before.windows) && j.at === before.at, 'previous numbers and their time kept');
  r = await run(A, []);
  ok(r.stdout.includes('(stale: login token expired — Claude Code refreshes it on its next request)'), 'human output says stale + why');
  reply = { code: 403, body: {} };
  r = await run(A, ['--refresh', '--json']);
  ok(JSON.parse(r.stdout).stale === true, '403 is treated the same');

  console.log('401 with no cache yet');
  const B = newDir('b');
  reply = { code: 401, body: {} };
  r = await run(B, ['--json']);
  j = JSON.parse(r.stdout);
  ok(r.status === 0 && j.stale === true && j.windows.length === 0 && j.plan === 'max_5x', 'empty stale object, exit 0');
  r = await run(B, ['--refresh']);
  ok(r.status === 0 && r.stdout.includes('no usage numbers yet') && r.stdout.includes('(stale: login token expired'), 'human output copes');

  console.log('429 backoff');
  const C = newDir('c');
  reply = { code: 200, body: limitsBody(50) };
  await run(C, []);
  reply = { code: 429, body: {}, retryAfter: 5 };
  const t429 = Date.now() / 1000;
  r = await run(C, ['--refresh', '--json']);
  j = JSON.parse(r.stdout);
  ok(j.stale === true && /^rate limited by the usage endpoint — next try \d\d:\d\d$/.test(j.error) && j.windows[0].pct === 50, '429 → stale, says when, numbers kept');
  let st = readJ(C, 'usage-state.json');
  ok(st.nextTryAt >= t429 + 600 - 2, 'nextTryAt at least 10 minutes out (Retry-After 5 s ignored as too short)');
  reply = { code: 200, body: limitsBody(55) };
  st.lastAttemptAt = 0; // past the 4-minute cache, still inside the backoff
  writeJ(C, 'usage-state.json', st);
  let h1 = hits;
  r = await run(C, ['--json']);
  ok(hits === h1 && JSON.parse(r.stdout).stale === true, 'no request while backing off');
  r = await run(C, ['sync', '--json']);
  ok(hits === h1, 'sync respects the backoff too');
  st = readJ(C, 'usage-state.json');
  st.nextTryAt = 0;
  st.lastAttemptAt = 0;
  writeJ(C, 'usage-state.json', st);
  r = await run(C, ['--json']);
  j = JSON.parse(r.stdout);
  ok(hits === h1 + 1 && j.stale === false && j.windows[0].pct === 55 && j.error === '', 'after the backoff: fetched, fresh again');
  ok(!('nextTryAt' in readJ(C, 'usage-state.json')), 'backoff cleared on success');

  console.log('sync pushes to the relay');
  const E = newDir('e');
  reply = { code: 200, body: limitsBody(20) };
  puts.length = 0;
  r = await run(E, ['sync', '--json'], withRelay);
  j = JSON.parse(r.stdout);
  ok(r.status === 0 && j.pushed === true && Array.isArray(j.alerts) && j.alerts.length === 0, 'sync --json: pushed, no alerts at 20%');
  ok(JSON.stringify(Object.keys(j)) === JSON.stringify(['usage', 'alerts', 'pushed']), 'sync --json keys usage/alerts/pushed');
  ok(puts.length === 1 && puts[0].method === 'PUT' && puts[0].url === '/api/v1/usage' && puts[0].auth === `Bearer ${RELAY_TOKEN}`, 'PUT /api/v1/usage with the relay bearer');
  ok(JSON.stringify(puts[0].body) === JSON.stringify(j.usage) && JSON.stringify(j.usage) === JSON.stringify(readJ(E, 'usage.json')), 'pushed body = normalised object = cache');
  const h2 = hits;
  r = await run(E, ['sync', '--json'], withRelay);
  ok(hits === h2 && puts.length === 2, 'sync within 4 min: cached numbers, pushed again');
  r = await run(E, ['sync', '--json'], { MC_RELAY_URL: 'http://127.0.0.1:1', MC_TOKEN: 'x' });
  ok(r.status === 0 && JSON.parse(r.stdout).pushed === false, 'relay down: pushed false, exit 0');
  r = await run(E, ['sync']);
  ok(r.status === 0 && /not pushed: no relay configured \(not fatal\)/.test(r.stdout) && r.stdout.includes('Session (5h)'), 'sync (human) notes the relay failure');
  r = await run(E, ['sync', '--quiet']);
  ok(r.status === 0 && r.stdout === '', 'sync --quiet prints nothing');

  console.log('thresholds');
  const T = newDir('t');
  const sync = async (session, opts = {}) => {
    reply = { code: 200, body: limitsBody(session, opts.weekly ?? 63, opts.fable ?? 25, opts.sReset ?? S_RESET) };
    const x = await run(T, ['sync', '--force', '--json']);
    return JSON.parse(x.stdout).alerts;
  };
  let al = await sync(70);
  ok(al.length === 0, '70%: nothing');
  al = await sync(83);
  const exp80 = `[MC] Usage: 83% of the 5-hour session, resets ${hhmm(S_RESET)} (in 1h 36m). Throttle: pause big executors, keep small work going.`;
  ok(al.length === 1 && al[0].key === 'session' && al[0].threshold === 80 && al[0].pct === 83 && al[0].resetsAt === isoZ(S_RESET), '83%: one alert at 80 for session');
  ok(al[0] && al[0].text === exp80, `80 text exact: ${al[0] && al[0].text}`);
  al = await sync(85);
  ok(al.length === 0, '85%: 80 already announced this period');
  al = await sync(96);
  const exp95 = `[MC] Usage: 96% of the 5-hour session, resets ${hhmm(S_RESET)} (in 1h 36m). Near the limit: hold new dispatches; only finish what's running.`;
  ok(al.length === 1 && al[0].threshold === 95 && al[0].text === exp95, `96%: 95 fires, text exact`);
  al = await sync(99);
  ok(al.length === 0, '99%: nothing new');
  // Jitter in resets_at (same hour) is the same period.
  al = await sync(99, { sReset: S_RESET + 2000 });
  ok(al.length === 0, 'reset time jitter within the hour: same period, nothing');
  // A reset re-arms; a jump past both fires only the highest.
  const NEXT = S_RESET + 5 * 3600 * 1000;
  al = await sync(10, { sReset: NEXT });
  ok(al.length === 0, 'after the reset: 10%, nothing');
  al = await sync(82, { sReset: NEXT });
  ok(al.length === 1 && al[0].threshold === 80, 'new period: 80 fires again');
  const T2 = newDir('t2');
  reply = { code: 200, body: limitsBody(70) };
  await run(T2, ['sync', '--force', '--json']);
  reply = { code: 200, body: limitsBody(96) };
  r = await run(T2, ['sync', '--force', '--json']);
  al = JSON.parse(r.stdout).alerts;
  ok(al.length === 1 && al[0].threshold === 95, '70 → 96: only 95 fires');
  reply = { code: 200, body: limitsBody(97) };
  r = await run(T2, ['sync', '--force', '--json']);
  ok(JSON.parse(r.stdout).alerts.length === 0, '…and 80 does not fire afterwards');
  // Weekly windows: names in the text.
  al = await sync(10, { sReset: NEXT, weekly: 81, fable: 96 });
  const wk = al.find((a) => a.key === 'weekly');
  const fb = al.find((a) => a.key === 'weekly_fable');
  ok(al.length === 2 && wk && fb, 'weekly + weekly_fable alerts');
  ok(wk && wk.text === `[MC] Usage: 81% of the weekly limit, resets ${new Date(W_RESET).toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(W_RESET)} (in 3d 7h). Throttle: pause big executors, keep small work going.`, `weekly text: ${wk && wk.text}`);
  ok(fb && fb.threshold === 95 && fb.text.startsWith('[MC] Usage: 96% of the weekly Fable limit, resets ') && fb.text.endsWith("Near the limit: hold new dispatches; only finish what's running."), `fable text: ${fb && fb.text}`);
  // Stale numbers never announce.
  reply = { code: 401, body: {} };
  r = await run(T2, ['sync', '--force', '--json']);
  ok(JSON.parse(r.stdout).alerts.length === 0, 'stale usage: no alerts');
  // MIA_USAGE_THRESHOLDS
  const T3 = newDir('t3');
  reply = { code: 200, body: limitsBody(55) };
  r = await run(T3, ['sync', '--force', '--json'], { MIA_USAGE_THRESHOLDS: '50,90' });
  al = JSON.parse(r.stdout).alerts;
  ok(al.length === 2 && al.every((a) => a.threshold === 50) && al[0].key === 'session' && al[0].text.endsWith('Throttle: pause big executors, keep small work going.'), 'MIA_USAGE_THRESHOLDS=50,90 honoured (session 55 + weekly 63 → 50)');
  r = await run(T, ['sync', '--json']);
  ok(r.status === 0, 'sync human mode (no --force) fine');

  console.log('help + mia help');
  r = await run(A, ['--help']);
  ok(r.status === 0 && r.stdout.includes('mia usage sync') && r.stdout.includes('95%'), '`mia usage --help`');
  r = await new Promise((resolve) => {
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), 'help'], { env: { ...process.env, MIA_DIR: A } });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.on('close', () => resolve(o));
  });
  ok(r.includes('mia usage [--refresh] [--json]') && r.includes('mia usage sync'), '`mia help` lists usage');

  console.log('the token never leaks');
  ok(!outputs.some((o) => o.includes(TOKEN) || o.includes('TEST-SECRET')), 'not in any stdout/stderr');
  const leaks = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (fs.readFileSync(p, 'latin1').includes('TEST-SECRET')) leaks.push(p);
    }
  };
  for (const d of dirs) if (fs.existsSync(d)) walk(d);
  ok(leaks.length === 0, `not in any file under MIA_DIR ${leaks.join(' ')}`);
  ok(!puts.some((p) => JSON.stringify(p).includes('TEST-SECRET')), 'not in anything pushed to the relay');
} finally {
  us.close();
  rs.close();
}
await sleep(100);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
