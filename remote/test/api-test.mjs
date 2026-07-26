// REST API test — boots the real relay (server.js) + the fake host, then
// exercises every /api/v1 route over plain HTTP the way OpenClaw would.
//
//   cd remote && npm run test:api
//
// Asserts auth, agent listing/detail/loose-matching, live screen reads, reply/
// key/kill/broadcast/launch acks, the full doc CRUD + search cycle, and the
// one-shot research flow (active → done).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8897;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}/api/v1`;

let passed = 0;
let failed = 0;
const procs = [];

function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function boot(cmd, args, name) {
  const p = spawn(cmd, args, {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.API_TEST_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}

async function api(method, route, body, { token = TOKEN } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON = bug, caught by asserts */ }
  return { status: res.status, data };
}

async function main() {
  boot('node', ['server.js'], 'relay');
  boot('node', ['test/fake-host.mjs'], 'host');

  // Wait for the relay to be up AND the fake host to be linked + snapshotting.
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const h = await (await fetch(`http://localhost:${PORT}/health`)).json();
      if (h.host) {
        const s = await api('GET', '/status');
        if (s.data?.agents > 0) { up = true; break; }
      }
    } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) throw new Error('relay/fake-host never came up');

  console.log('auth');
  ok((await api('GET', '/', null, { token: '' })).status === 401, '401 without a token');
  ok((await api('GET', '/', null, { token: 'wrong' })).status === 401, '401 with a bad token');
  const index = await api('GET', '/');
  ok(index.status === 200 && index.data.endpoints, 'index lists the API');
  const viaQuery = await fetch(`${BASE}/status?token=${TOKEN}`);
  ok(viaQuery.status === 200, '?token= works too');

  console.log('agents');
  const agents = await api('GET', '/agents');
  ok(agents.status === 200 && agents.data.agents.length === 7, 'lists all 7 agents');
  ok(agents.data.summary && typeof agents.data.summary.totalTokens === 'number', 'carries the fleet summary');
  ok(agents.data.agents.every((a) => !('screen' in a) && !('log' in a)), 'list view is light (no screens/logs)');

  const one = await api('GET', '/agents/acme-worker-1');
  ok(one.status === 200 && typeof one.data.agent.screen === 'string', 'agent detail includes the screen');
  const loose = await api('GET', '/agents/webapp');
  ok(loose.status === 200 && loose.data.agent.id === 'webapp-ask', 'unique folder name resolves to the agent');
  ok((await api('GET', '/agents/acme')).status === 409, 'ambiguous name is a 409');
  ok((await api('GET', '/agents/nope')).status === 404, 'unknown agent is a 404');

  const screen = await api('GET', '/agents/webapp-ask/screen');
  ok(screen.status === 200 && screen.data.source === 'live' && screen.data.text.length > 0, 'live screen via watch lease');

  console.log('actions');
  const reply = await api('POST', '/agents/webapp-ask/reply', { text: 'Take option 1' });
  ok(reply.status === 200 && reply.data.ok, 'reply acks ok');
  ok((await api('POST', '/agents/webapp-ask/reply', {})).status === 400, 'reply without text is a 400');
  const key = await api('POST', '/agents/webapp-ask/key', { key: '1' });
  ok(key.status === 200 && key.data.ok, 'key press acks ok');
  const bcast = await api('POST', '/broadcast', { text: 'Status update please' });
  ok(bcast.status === 200 && bcast.data.ok, 'broadcast acks ok');

  const launch = await api('POST', '/launch', { mission: 'Fix the login bug', dir: '/Users/demo/acme', model: 'sonnet' });
  ok(launch.status === 200 && launch.data.ok, 'launch acks ok');
  await sleep(3500); // fake host materializes the agent after 2s + snapshot tick
  const after = await api('GET', '/agents');
  ok(after.data.agents.some((a) => a.id.startsWith('launched-')), 'launched agent shows up in the fleet');

  const kill = await api('POST', '/agents/tools-done/kill', {});
  ok(kill.status === 200 && kill.data.ok, 'kill acks ok');

  console.log('docs');
  const docs = await api('GET', '/docs');
  ok(docs.status === 200 && docs.data.docs.length >= 3, 'library metadata lists docs');
  const docId = 'checkout-revamp--3fa9c2d1.md';
  const doc = await api('GET', `/docs/${docId}`);
  ok(doc.status === 200 && doc.data.doc.content.includes('Checkout revamp'), 'doc body round-trips');
  ok((await api('GET', '/docs/missing.md')).status === 404, 'missing doc is a 404');

  const search = await api('GET', '/docs/search?q=zephyrite');
  ok(search.status === 200 && search.data.hits.length === 1, 'full-text search finds the unique token');

  const created = await api('POST', '/docs', { title: 'OpenClaw notes', kind: 'note', content: '# OpenClaw notes\n\nhello\n' });
  ok(created.status === 200 && created.data.ok && created.data.id, 'create returns the new id');
  const newId = created.data.id;
  const saved = await api('PUT', `/docs/${newId}`, { content: '# OpenClaw notes\n\nedited body\n' });
  ok(saved.status === 200 && saved.data.ok, 'save acks ok');
  const reread = await api('GET', `/docs/${newId}`);
  ok(reread.data.doc.content.includes('edited body'), 'saved body reads back');
  const meta = await api('PATCH', `/docs/${newId}`, { status: 'done', tags: ['openclaw'] });
  ok(meta.status === 200 && meta.data.ok, 'metadata patch acks ok');
  const del = await api('DELETE', `/docs/${newId}`);
  ok(del.status === 200 && del.data.ok, 'delete acks ok');
  ok((await api('GET', `/docs/${newId}`)).status === 404, 'deleted doc is gone');

  console.log('research');
  const research = await api('POST', '/research', { topic: 'Best task queue for Node', model: 'sonnet' });
  ok(research.status === 200 && research.data.ok && research.data.id, 'research acks with a doc id');
  await sleep(5000); // fake agent finishes after ~4s
  const report = await api('GET', `/docs/${research.data.id}`);
  ok(report.status === 200 && report.data.doc.status === 'done', 'research doc flips to done');

  console.log('errors');
  ok((await api('GET', '/nope')).status === 404, 'unknown route is a 404');
  ok((await api('POST', '/launch', {})).status === 422 || (await api('POST', '/launch', {})).data.ok === false, 'empty launch is rejected by the host');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { for (const p of procs) p.kill(); });
