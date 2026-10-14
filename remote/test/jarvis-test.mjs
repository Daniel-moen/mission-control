// Jarvis HQ on the relay (jarvis.js, task 0199): the control queue and the
// state the Mac pushes, unit-level, plus the same routes through the real
// server with the bearer token.   node test/jarvis-test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createJarvis } = require('../jarvis.js');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jarvis-'));
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const quiet = { warn() {}, log() {} };

console.log('jarvis.js unit');
{
  const file = path.join(TMP, 'j1.json');
  const j = createJarvis({ file, log: quiet });
  let r = j.route([], 'GET');
  ok(r.status === 200 && r.body.state === null && r.body.pending.length === 0, 'empty GET: no state, no pending');
  r = j.route(['control'], 'POST', { action: 'level', project: 'dryager-panel', level: 3, told: true });
  ok(r.status === 200 && r.body.control.id.startsWith('c_') && r.body.control.level === 3 && r.body.control.told === true, 'level control queued with id');
  const id1 = r.body.control.id;
  for (const [body, why] of [
    [{ action: 'nope' }, 'unknown action'],
    [{ action: 'level', project: 'x', level: 4 }, 'level out of range'],
    [{ action: 'level', project: '../etc', level: 1 }, 'malformed project id'],
    [{ action: 'pitch', value: 'loud' }, 'bad pitch value'],
    [{ action: 'scout' }, 'scout without project'],
    [null, 'no body'],
  ]) ok(j.route(['control'], 'POST', body).status === 400, `rejects ${why}`);
  r = j.route(['control'], 'POST', { action: 'pause', project: 'ignored', extra: 'x'.repeat(5000) });
  ok(r.status === 200 && !('project' in r.body.control) && !('extra' in r.body.control), 'pause drops stray fields');
  ok(j.route(['control'], 'POST', { action: 'pitch', value: 'quieter' }).status === 200, 'pitch quieter queued');
  ok(j.route(['control'], 'POST', { action: 'scout', project: 'penny' }).status === 200, 'scout queued');
  r = j.route(['controls'], 'GET');
  ok(r.body.controls.length === 4, 'Mac sees 4 controls');
  ok(j.route(['state'], 'PUT', { nope: 1 }).status === 400, 'state without registry rejected');
  ok(j.route(['state'], 'PUT', { registry: { x: 'y'.repeat(1.6 * 1024 * 1024) } }).status === 413, 'oversized state rejected');
  r = j.route(['state'], 'PUT', { registry: { companies: [], projects: [] }, findings: [], tasks: [], applied: [id1] });
  ok(r.status === 200 && r.body.pending === 3, 'push applies id1, 3 left');
  r = j.route([], 'GET');
  ok(r.body.state.registry && !('applied' in r.body.state) && r.body.receivedAt > 0, 'GET returns pushed state without the applied list');
  ok(!r.body.pending.some((c) => c.id === id1), 'applied control left the queue');
  // persistence across a restart
  const j2 = createJarvis({ file, log: quiet });
  r = j2.route([], 'GET');
  ok(r.body.state?.registry && r.body.pending.length === 3, 'state + queue survive a restart');
  ok(j2.route(['bogus'], 'GET') === null, 'unknown sub-route → null (api 404s)');
  for (let i = 0; i < 230; i++) j2.route(['control'], 'POST', { action: 'pause' });
  ok(j2.route(['controls'], 'GET').body.controls.length === 200, 'queue capped at 200');
}

console.log('jarvis through the server');
{
  const PORT = 8877;
  const p = spawn('node', ['server.js'], {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: 'test', PORT: String(PORT), JARVIS_STORE: path.join(TMP, 'srv.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
    stdio: 'ignore',
  });
  try {
    const base = `http://localhost:${PORT}/api/v1`;
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await fetch(`http://localhost:${PORT}/health`); up = true; } catch { await sleep(100); }
    }
    ok(up, 'relay boots');
    const H = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
    let r = await fetch(`${base}/jarvis`);
    ok(r.status === 401, 'no token → 401');
    r = await fetch(`${base}/jarvis/control`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'level', project: 'penny', level: 1 }) });
    const j = await r.json();
    ok(r.status === 200 && j.control.project === 'penny', 'POST control with token');
    r = await fetch(`${base}/jarvis/controls`, { headers: H });
    ok((await r.json()).controls.length === 1, 'GET controls');
    r = await fetch(`${base}/jarvis/state`, { method: 'PUT', headers: H, body: JSON.stringify({ registry: { projects: [] }, applied: [j.control.id] }) });
    ok(r.status === 200 && (await r.json()).pending === 0, 'PUT state clears the queue');
    r = await fetch(`${base}`, { headers: H });
    const doc = JSON.stringify(await r.json());
    ok(doc.includes('/api/v1/jarvis'), 'API index lists the jarvis routes');
  } finally {
    p.kill();
  }
}

// The relay may still be writing its store as it dies: wait, then retry.
await sleep(300);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
