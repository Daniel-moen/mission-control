// REST API test — boots the real relay (server.js) + the fake host, then
// exercises every /api/v1 route over plain HTTP the way OpenClaw would.
//
//   cd remote && npm run test:api
//
// Asserts auth, agent listing/detail/loose-matching, live screen reads, reply/
// key/kill/broadcast/launch acks, the full doc CRUD + search cycle, and the
// one-shot research flow (active → done), Mia (/api/v1/mia*), and the panel's
// HTTP fallback transport (/snapshot, /cmd, /screens) with and without a host.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8897;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}/api/v1`;
// Keep the relay's push store out of the repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-api-'));

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
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), PUSH_STORE: path.join(TMP, 'push-subscriptions.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.API_TEST_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}

async function api(method, route, body, { token = TOKEN, headers = {} } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON = bug, caught by asserts */ }
  return { status: res.status, data };
}

async function main() {
  boot('node', ['server.js'], 'relay');

  // Before any host: the fallback routes must say "Mac offline", not hang.
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* not yet */ }
    await sleep(100);
  }
  console.log('fallback, no host');
  const noSnap = await api('GET', '/snapshot');
  ok(noSnap.status === 502 && noSnap.data.hostOnline === false, 'snapshot is a 502 with hostOnline:false before the Mac connects');
  ok((await api('POST', '/cmd', { type: 'broadcast', text: 'hi' })).status === 502, 'cmd is a 502 while the Mac is offline');
  ok((await api('POST', '/cmd', { type: 'bogus' })).status === 400, 'disallowed type is a 400 even offline');

  const host = boot('node', ['test/fake-host.mjs'], 'host');

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

  console.log('mia');
  ok(index.data.endpoints['GET  /api/v1/mia'], 'index lists the Mia routes');
  const miaGet = await api('GET', '/mia');
  ok(miaGet.status === 200 && miaGet.data.mia && Array.isArray(miaGet.data.mia.tasks), 'GET /mia returns the mia block');
  ok(miaGet.data.mia.pendingQuestions.some((q) => q.questionId === 'q_seed1'), 'mia block lists the pending question');
  const miaMsg = await api('POST', '/mia/message', { text: 'Anything in my inbox?' });
  ok(miaMsg.status === 200 && miaMsg.data.ok, 'message acks ok');
  ok((await api('POST', '/mia/message', {})).status === 400, 'message without text is a 400');
  const badAnswer = await api('POST', '/mia/answer', { questionId: 'q_nope', text: 'Yes' });
  ok(badAnswer.status === 422 && badAnswer.data.ok === false, 'answer to an unknown question is a 422');
  ok((await api('POST', '/mia/answer', { text: 'Yes' })).status === 400, 'answer without questionId is a 400');
  const answer = await api('POST', '/mia/answer', { questionId: 'q_seed1', text: 'Whole app' });
  ok(answer.status === 200 && answer.data.ok, 'answer acks ok');
  const task = await api('POST', '/mia/tasks', { title: 'Renew the SSL cert', detail: 'expires Friday', dir: '/Users/demo/tools', priority: 1 });
  ok(task.status === 200 && task.data.ok && /^\d{4}$/.test(task.data.id), 'task add acks with a task id');
  ok((await api('POST', '/mia/tasks', { detail: 'no title' })).status === 400, 'task without a title is a 400');
  ok((await api('POST', '/mia/tasks', { title: 'x', priority: 'high' })).status === 400, 'non-numeric priority is a 400');
  await sleep(1200); // next snapshot tick
  const miaAfter = (await api('GET', '/mia')).data.mia;
  ok(miaAfter.tasks.some((t) => t.id === task.data.id && t.priority === 1 && t.dir === '/Users/demo/tools'), 'new task shows up in the mia block');
  ok(!miaAfter.pendingQuestions.some((q) => q.questionId === 'q_seed1'), 'answered question is no longer pending');
  ok(miaAfter.messages.some((m) => m.from === 'daniel' && m.text === 'Anything in my inbox?'), 'message shows up in the thread');
  ok((await api('GET', '/mia', null, { token: '' })).status === 401, 'mia routes need the token');

  console.log('fallback transport');
  const snapR = await api('GET', '/snapshot', null, { headers: { 'x-mc-client': 'api-test' } });
  ok(snapR.status === 200 && snapR.data.hostOnline === true && snapR.data.snapshot.type === 'snapshot', 'snapshot carries hostOnline + the raw snapshot');
  ok(typeof snapR.data.seq === 'number' && snapR.data.seq > 0 && typeof snapR.data.ageMs === 'number', 'snapshot carries seq and ageMs');
  const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
  ok(health.pollers === 1, 'an X-MC-Client poller is counted as a viewer');
  const gz = await fetch(`${BASE}/snapshot`, { headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' } });
  ok(gz.headers.get('content-encoding') === 'gzip' && (await gz.json()).ok, 'snapshot is gzipped when accepted');

  const cmdReply = await api('POST', '/cmd', { type: 'reply', sessionId: 'webapp-ask', text: 'via cmd' });
  ok(cmdReply.status === 200 && cmdReply.data.type === 'ack' && cmdReply.data.cmd === 'reply' && cmdReply.data.ok, 'cmd reply returns the host ack frame verbatim');
  const cmdDoc = await api('POST', '/cmd', { type: 'docGet', id: docId });
  ok(cmdDoc.status === 200 && cmdDoc.data.type === 'doc' && cmdDoc.data.id === docId, 'cmd docGet returns the doc frame');
  const cmdMissing = await api('POST', '/cmd', { type: 'docGet', id: 'missing.md' });
  ok(cmdMissing.status === 200 && cmdMissing.data.type === 'ack' && cmdMissing.data.ok === false, 'cmd docGet of a missing doc returns the failing ack');
  const cmdSearch = await api('POST', '/cmd', { type: 'docSearch', q: ' zephyrite ' });
  ok(cmdSearch.status === 200 && cmdSearch.data.type === 'docSearchResult' && cmdSearch.data.hits.length === 1, 'cmd docSearch returns docSearchResult');
  const cmdMeta = await api('POST', '/cmd', { type: 'docMeta', id: docId, tags: ['x'] });
  ok(cmdMeta.status === 200 && cmdMeta.data.cmd === 'docMeta', 'cmd docMeta returns its ack');
  const cmdLegacy = await api('POST', '/cmd', { type: 'planGet', id: docId });
  ok(cmdLegacy.status === 200 && cmdLegacy.data.type === 'doc', 'legacy planGet resolves with the doc frame');
  ok((await api('POST', '/cmd', { type: 'bogus' })).status === 400, 'cmd with a disallowed type is a 400');
  ok((await api('POST', '/cmd', { nope: 1 })).status === 400, 'cmd without a type is a 400');
  ok((await api('POST', '/cmd', { type: 'push', title: 'x' })).status === 400, 'host-only types cannot be injected');

  const t0 = Date.now();
  const cmdWatch = await api('POST', '/cmd', { type: 'watch', sessionId: 'acme-worker-1' });
  ok(cmdWatch.status === 200 && cmdWatch.data.ok === true && Date.now() - t0 < 1000, 'cmd watch returns {ok:true} immediately');
  await sleep(100); // the lease is open on the host before we type into it
  const cmdTyping = await api('POST', '/cmd', { type: 'key', sessionId: 'acme-worker-1', text: 'abc' });
  ok(cmdTyping.status === 200 && cmdTyping.data.ok === true && !cmdTyping.data.type, 'console typing returns {ok:true} at once');
  let scr = null;
  for (let i = 0; i < 12 && !scr; i++) {
    await sleep(500);
    const r = await api('GET', '/screens?ids=acme-worker-1,nope');
    if (r.data.screens['acme-worker-1']) scr = r.data;
  }
  ok(scr && scr.screens['acme-worker-1'].text.includes('scrollback line') && typeof scr.screens['acme-worker-1'].seq === 'number', 'screens returns the streamed buffer after a watch');
  ok(scr && !('nope' in scr.screens), 'screens omits unknown ids');
  ok(scr && scr.screens['acme-worker-1'].text.includes('❯ abc'), 'typed text reaches the assembled screen');
  // Let several delta frames land, then check the assembled buffer is coherent:
  // it must equal the latest full render (scrollback + input line), not a torn mix.
  await api('POST', '/cmd', { type: 'watch', sessionId: 'acme-worker-1' });
  await sleep(3500);
  const later = (await api('GET', '/screens?ids=acme-worker-1')).data.screens['acme-worker-1'];
  ok(later && later.seq > scr.screens['acme-worker-1'].seq, 'screens advance as the host streams (deltas applied)');
  ok(later && later.text.split('\n').length >= 100 && /❯ abc█$/.test(later.text), 'assembled buffer stays coherent across deltas');

  console.log('errors');
  ok((await api('GET', '/nope')).status === 404, 'unknown route is a 404');
  ok((await api('POST', '/launch', {})).status === 422 || (await api('POST', '/launch', {})).data.ok === false, 'empty launch is rejected by the host');

  console.log('fallback, host gone');
  host.kill();
  await sleep(500);
  const gone = await api('GET', '/snapshot');
  ok(gone.status === 200 && gone.data.hostOnline === false && gone.data.snapshot, 'last-known snapshot is served with hostOnline:false after the Mac leaves');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    for (const p of procs) p.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  });
