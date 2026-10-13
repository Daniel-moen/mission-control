// `mia jarvis` (scripts/mia-jarvis, task 0199) against a temp MIA_DIR and a
// real relay: seed, the Mia commands, then the whole Mac ↔ relay loop — HQ
// taps queued on the relay, `mia jarvis sync` applies them to registry.json,
// switches the heartbeats, runs the health checks (a local server, no
// internet) and pushes the public view back.   node test/jarvis-cli-test.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jarvis-cli-'));
const MIA_DIR = path.join(TMP, 'mia');
const PORT = 8878;
const HPORT = 8879;
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const ENV = { ...process.env, MIA_DIR, MC_RELAY_URL: `http://localhost:${PORT}`, MC_TOKEN: 'test', MC_DOC_NO_DEFAULTS: '1' };
// Async on purpose: the health checks call back into this process's server.
const run = (args) =>
  new Promise((resolve) => {
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), ...args], { env: ENV });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const mia = (...args) => run(['jarvis', ...args]);
const reg = () => JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'jarvis', 'registry.json'), 'utf8'));
const findings = () => fs.readFileSync(path.join(MIA_DIR, 'jarvis', 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// health targets: /ok → 200, /bad → 500
let badCode = 500;
const hs = http.createServer((q, s) => { s.writeHead(q.url === '/bad' ? badCode : 200); s.end('x'); }).listen(HPORT);

fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [
  { id: 'hb_scout', label: 'Scout', enabled: true, prompt: 'x' },
  { id: 'hb_health', label: 'Health', everyMinutes: 180, enabled: true, prompt: 'x' },
  { id: 'hb_crystal', label: 'CG', everyMinutes: 60, enabled: false, prompt: 'x' },
  { id: 'hb_inbox', label: 'Inbox', everyMinutes: 30, enabled: true, prompt: 'x' },
], reminders: [] }));
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
fs.writeFileSync(path.join(MIA_DIR, 'tasks', '0500.json'), JSON.stringify({ id: '0500', title: 'Fix the stale leads', status: 'running', dir: path.join(os.homedir(), 'dryager-panel'), createdAt: now, updatedAt: now }));
fs.writeFileSync(path.join(MIA_DIR, 'tasks', '0501.json'), JSON.stringify({ id: '0501', title: 'Crystal Garden: pets', status: 'done', dir: '/tmp', createdAt: now, updatedAt: now, result: 'shipped' }));

const relay = spawn('node', ['server.js'], {
  cwd: path.join(DIR, '..'),
  env: { ...process.env, MC_TOKEN: 'test', PORT: String(PORT), JARVIS_STORE: path.join(TMP, 'relay-jarvis.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
  stdio: 'ignore',
});
const H = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
const api = async (p, opts = {}) => (await fetch(`http://localhost:${PORT}/api/v1${p}`, { headers: H, ...opts })).json();

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/health`); break; } catch { await sleep(100); }
  }

  console.log('seed + Mia commands');
  let r = await mia('show');
  ok(r.status !== 0 && /mia jarvis seed/.test(r.stderr), 'show before seed says how to seed');
  r = await mia('seed');
  ok(r.status === 0 && fs.existsSync(path.join(MIA_DIR, 'jarvis', 'README.md')), 'seed writes registry + README');
  ok((await mia('seed')).status !== 0, 'seed refuses to overwrite');
  const R0 = reg();
  ok(R0.companies.length === 8 && R0.projects.length >= 14, `8 companies, ${R0.projects.length} projects`);
  for (const id of ['oblivion', 'klear', 'dryager', 'games', 'video', 'propiq', 'civentropy', 'mission-control']) ok(R0.companies.some((c) => c.id === id), `company ${id}`);
  for (const id of ['prospect-engine', 'oblivion-site', 'penny', 'houston', 'crystal-garden', 'empire-clash', 'flip-this-house', 'crime-scene-cleaners']) ok(R0.projects.some((p) => p.id === id), `project ${id}`);
  ok(R0.projects.every((p) => p.autonomy === 2), 'every project starts at Suggest');

  // Point every check at the local server, no probes (no internet in tests).
  const R = reg();
  for (const p of R.projects) {
    p.probes = [];
    if (p.healthcheck) p.healthcheck = { type: 'http', target: `http://localhost:${HPORT}/ok` };
  }
  R.projects.find((p) => p.id === 'penny').healthcheck.target = `http://localhost:${HPORT}/bad`;
  R.projects.find((p) => p.id === 'propiq').healthcheck = { type: 'ssh', target: 'secret@10.0.0.9', command: 'true' };
  fs.writeFileSync(path.join(MIA_DIR, 'jarvis', 'registry.json'), JSON.stringify(R));

  ok((await mia('set-level', 'dry', 'fix')).stdout.includes('Fix with undo (3)'), 'set-level by prefix + name');
  ok((await mia('set-level', 'dryager-panel', '9')).status !== 0, 'bad level rejected');
  ok((await mia('set-level', 'c', '1')).status !== 0, 'ambiguous project rejected');
  r = await mia('metric', 'dryager-panel', 'stale_leads', '12', '--label', 'Stale leads', '--better', 'down');
  await mia('metric', 'dryager-panel', 'stale_leads', '9');
  const m = reg().projects.find((p) => p.id === 'dryager-panel').metrics[0];
  ok(m.value === 9 && m.history.length === 2 && m.better === 'down' && m.label === 'Stale leads', 'metric keeps history, label, direction');
  ok((await mia('metric', 'dryager-panel', 'x', 'abc')).status !== 0, 'non-number metric rejected');
  await mia('finding', 'dryager-panel', '12 leads untouched for a week');
  await mia('finding', '-', 'Weekly report sent', '--kind', 'shipped');
  ok(findings().some((f) => f.kind === 'found' && f.project === 'dryager-panel') && findings().some((f) => f.kind === 'shipped' && f.project === ''), 'findings logged (project + overall)');
  await mia('permit', 'dryager-panel', 'Restart the service when it is down');
  ok(reg().projects.find((p) => p.id === 'dryager-panel').permissions.length === 1, 'standing permission added');
  await mia('set', 'penny', 'doc', 'klear-penny-plan.md');
  ok(reg().projects.find((p) => p.id === 'penny').docs[0] === 'klear-penny-plan', 'doc pinned');

  console.log('sync loop');
  const c1 = await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'level', project: 'penny', level: 1, told: true }) });
  await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'pause' }) });
  await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'pitch', value: 'quieter' }) });
  await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'scout', project: 'crystal-garden' }) });
  await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'level', project: 'ghost', level: 1 }) });
  r = await mia('sync');
  if (process.env.E2E_VERBOSE) console.log(r.stdout, r.stderr);
  ok(r.status === 0 && r.stdout.trim().endsWith('pushed'), 'sync pushed');
  ok(/skipped .*no project 'ghost'/.test(r.stdout), 'unknown project skipped, not fatal');
  const R1 = reg();
  ok(R1.projects.find((p) => p.id === 'penny').autonomy === 1, 'level applied');
  ok(R1.jarvis.paused === true && R1.jarvis.pitchesPerDay === 0.5, 'pause + quieter applied');
  ok(R1.projects.find((p) => p.id === 'crystal-garden').scoutRequestedAt, 'scout stamped');
  const sch = JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'schedule.json'), 'utf8')).heartbeats;
  const en = Object.fromEntries(sch.map((h) => [h.id, h.enabled]));
  ok(en.hb_scout === false && en.hb_health === false && en.hb_crystal === false && en.hb_inbox === true, 'pause turned the proactive heartbeats off, inbox untouched');
  ok(JSON.stringify(R1.jarvis.pausedHeartbeats.sort()) === JSON.stringify(['hb_health', 'hb_scout']), 'remembers which ones it turned off');
  ok(R1.projects.find((p) => p.id === 'penny').health.status === 'down' && R1.projects.find((p) => p.id === 'dryager-panel').health.status === 'up', 'health checked (penny down, dry-ager up)');
  const st = await api('/jarvis');
  ok(st.pending.length === 0, 'relay queue drained');
  ok(st.state.registry.projects.find((p) => p.id === 'penny').autonomy === 1, 'relay has the new registry');
  ok(!JSON.stringify(st.state).includes('secret@10.0.0.9'), 'ssh target never leaves the Mac');
  ok(st.state.registry.projects.every((p) => !('probes' in p)) && !('pausedHeartbeats' in st.state.registry.jarvis), 'probes + heartbeat bookkeeping stripped');
  ok(st.state.tasks.find((t) => t.id === '0500')?.project === 'dryager-panel' && st.state.tasks.find((t) => t.id === '0501')?.project === 'crystal-garden', 'tasks tagged with projects');
  ok(st.state.findings.some((f) => f.kind === 'control' && f.by === 'daniel' && f.control === c1.control.id), 'HQ taps logged as Daniel');

  // A control the relay still lists (e.g. the push failed) is not applied twice.
  const before = findings().length;
  r = await mia('sync');
  ok(findings().length === before, 'second sync: nothing re-applied');

  console.log('health transitions + resume');
  badCode = 200;
  r = await mia('sync', '--health');
  ok(reg().projects.find((p) => p.id === 'penny').health.status === 'up' && findings().some((f) => f.project === 'penny' && /Back up after/.test(f.text)), 'down → up logged');
  await api('/jarvis/control', { method: 'POST', body: JSON.stringify({ action: 'resume' }) });
  await mia('sync');
  const en2 = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'schedule.json'), 'utf8')).heartbeats.map((h) => [h.id, h.enabled]));
  ok(reg().jarvis.paused === false && en2.hb_scout && en2.hb_health && en2.hb_crystal === false, 'resume restores exactly what pause turned off');
  r = await mia('pause');
  ok(r.status === 0 && reg().jarvis.paused, 'mia jarvis pause');
  r = await mia('resume');
  ok(r.status === 0 && !reg().jarvis.paused, 'mia jarvis resume');
  r = await mia('status');
  ok(/last push: 20/.test(r.stdout), 'status shows the last push');
  r = await mia('show', 'penny', '--json');
  ok(JSON.parse(r.stdout).id === 'penny', 'show <project> --json');
  r = await run(['help']);
  ok(r.stdout.includes('mia jarvis'), 'mia help lists jarvis');
} finally {
  relay.kill();
  hs.close();
}
await sleep(200);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
