// End-to-end wire test for the document library over the REAL relay.
//
// Boots server.js on a free port with MC_TOKEN=test, connects the fake host
// (test/fake-host.mjs, which impersonates the Mac's RemoteBridge + DocLibrary),
// and drives a scripted viewer WebSocket through the whole doc lifecycle —
// snapshot → create → get → save → meta → search → research → delete — plus the
// relay's two guardrails (unknown types dropped, wrong token rejected). Every
// frame crosses the actual server.js fan-out, so a break anywhere in the
// allowlist, the host handlers, or the wire shapes surfaces here.
//
// Run:  cd remote && node test/wire-test.mjs   (or: npm run test:wire)
// One ok/FAIL line per assertion; non-zero exit on any failure; no child
// process or port is left behind, even when an assertion throws.

import net from 'net';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.js');
const HOST = path.join(HERE, 'fake-host.mjs');
const TOKEN = 'test';

const children = [];
const sockets = [];
let failures = 0;

// ---- process/port lifecycle -------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function spawnNode(file, port, label) {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child._label = label;
  child._out = '';
  child.stdout.on('data', (d) => { child._out += d; });
  child.stderr.on('data', (d) => { child._out += d; });
  children.push(child);
  return child;
}

// Kill every child and close every socket. Idempotent — safe to call from both
// the happy path's finally and an unexpected-exit handler, so nothing leaks.
let torndown = false;
function cleanup() {
  if (torndown) return;
  torndown = true;
  for (const ws of sockets) { try { ws.terminate(); } catch {} }
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: 'localhost', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('server never became healthy'));
      else setTimeout(tryOnce, 120);
    };
    tryOnce();
  });
}

// ---- scripted viewer --------------------------------------------------------
// Collects every frame; waitFrom(mark, pred) resolves with the first frame at or
// after `mark` (a msgs-length marker) satisfying pred — so an assertion can
// demand a frame produced strictly AFTER it triggered an action, never matching
// a stale snapshot from before.

function openViewer(port, token) {
  const url = `ws://localhost:${port}/ws?role=viewer&token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  sockets.push(ws);
  const msgs = [];
  const listeners = new Set();
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    msgs.push(m);
    for (const fn of [...listeners]) fn();
  });
  ws.opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.mark = () => msgs.length;
  ws.msgs = msgs;
  ws.waitFrom = (from, pred, timeoutMs, desc) => new Promise((resolve, reject) => {
    const scan = () => {
      for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i];
      return null;
    };
    const hit = scan();
    if (hit) return resolve(hit);
    const onmsg = () => {
      const h = scan();
      if (h) { done(); resolve(h); }
    };
    const timer = setTimeout(() => { done(); reject(new Error(`timeout waiting for ${desc}`)); }, timeoutMs);
    const done = () => { clearTimeout(timer); listeners.delete(onmsg); };
    listeners.add(onmsg);
  });
  ws.send = ((orig) => (obj) => orig.call(ws, JSON.stringify(obj)))(WebSocket.prototype.send);
  return ws;
}

// ---- assertion harness ------------------------------------------------------

async function step(desc, fn) {
  try {
    await fn();
    console.log(`ok   - ${desc}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL - ${desc}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const isSnap = (m) => m.type === 'snapshot';
const docIn = (snap, id) => (snap.docs || []).find((d) => d.id === id);

// ---- the run ----------------------------------------------------------------

async function main() {
  const port = await freePort();
  spawnNode(SERVER, port, 'server');
  await waitHealthy(port, 8000);
  spawnNode(HOST, port, 'fake-host');

  const v = openViewer(port, TOKEN);
  await v.opened;

  const SEEDED = 'checkout-revamp--3fa9c2d1.md';
  const RESEARCH_SEED = 'acme-corp-pricing-teardown--7b2e9f14.md';
  let createdId = null;
  let researchId = null;

  // 1 — snapshot carries `docs`.
  await step('1. viewer receives a snapshot carrying docs', async () => {
    const snap = await v.waitFrom(0, (m) => isSnap(m) && Array.isArray(m.docs) && m.docs.length > 0, 8000, 'snapshot with docs');
    assert(snap.docs.some((d) => d.id === SEEDED), 'seeded plan missing from snapshot docs');
    assert(!('plans' in snap), 'snapshot still carries a legacy `plans` field');
    const d = snap.docs.find((x) => x.id === SEEDED);
    for (const k of ['id', 'title', 'kind', 'status', 'preview', 'words', 'updatedAt']) {
      assert(k in d, `doc metadata missing '${k}'`);
    }
  });

  // 2 — docCreate → ack ok+id → doc frame with that id.
  await step('2. docCreate acks ok with an id, then a doc frame arrives', async () => {
    const mk = v.mark();
    v.send({ type: 'docCreate', title: 'Wire test doc', kind: 'research', subject: 'Widget Co', tags: ['alpha', 'beta'], dir: '/Users/demo/widget', content: '# Wire test doc\n\noriginal body\n' });
    const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'docCreate', 5000, 'docCreate ack');
    assert(ack.ok === true, `docCreate ack not ok: ${ack.detail}`);
    assert(typeof ack.id === 'string' && ack.id.length > 0, 'docCreate ack carried no id');
    createdId = ack.id;
    const doc = await v.waitFrom(mk, (m) => m.type === 'doc' && m.id === createdId, 5000, 'doc frame for created id');
    assert(doc.content.includes('original body'), 'created doc frame lacked its body');
    assert(doc.kind === 'research', 'created doc frame lost its kind');
  });

  // 3 — docGet on a seeded id returns its body.
  await step('3. docGet on a seeded id returns its body', async () => {
    const mk = v.mark();
    v.send({ type: 'docGet', id: SEEDED });
    const doc = await v.waitFrom(mk, (m) => m.type === 'doc' && m.id === SEEDED, 5000, 'doc frame for seeded id');
    assert(doc.content.includes('Checkout revamp'), 'seeded doc body was not returned');
    assert(doc.kind === 'plan', 'seeded doc kind should be plan');
  });

  // 4 — docSave → ack ok; a later docGet returns the new body.
  await step('4. docSave persists a new body a later docGet reads back', async () => {
    assert(createdId, 'no created doc to save (step 2 failed)');
    const mk = v.mark();
    v.send({ type: 'docSave', id: createdId, content: '# Wire test doc\n\nUPDATED body sentinel-4242\n' });
    const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'docSave', 5000, 'docSave ack');
    assert(ack.ok === true, `docSave ack not ok: ${ack.detail}`);
    const mk2 = v.mark();
    v.send({ type: 'docGet', id: createdId });
    const doc = await v.waitFrom(mk2, (m) => m.type === 'doc' && m.id === createdId, 5000, 'doc frame after save');
    assert(doc.content.includes('sentinel-4242'), 'saved body did not come back');
  });

  // 5 — docMeta patch: only status changes; kind/subject/tags untouched.
  await step('5. docMeta {status:archived} changes status alone', async () => {
    assert(createdId, 'no created doc to patch (step 2 failed)');
    const mk = v.mark();
    v.send({ type: 'docMeta', id: createdId, status: 'archived' });
    const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'docMeta', 5000, 'docMeta ack');
    assert(ack.ok === true, `docMeta ack not ok: ${ack.detail}`);
    const snap = await v.waitFrom(mk, (m) => isSnap(m) && docIn(m, createdId)?.status === 'archived', 6000, 'snapshot with archived status');
    const d = docIn(snap, createdId);
    assert(d.kind === 'research', `kind changed to ${d.kind} (should stay research)`);
    assert(d.subject === 'Widget Co', `subject changed to ${d.subject}`);
    assert(Array.isArray(d.tags) && d.tags.join(',') === 'alpha,beta', `tags changed to ${JSON.stringify(d.tags)}`);
  });

  // 6 — docSearch: a body-only string returns exactly its one doc, with a snippet.
  await step('6. docSearch finds the one body containing a unique word', async () => {
    const mk = v.mark();
    v.send({ type: 'docSearch', q: 'zephyrite' });
    const res = await v.waitFrom(mk, (m) => m.type === 'docSearchResult', 5000, 'docSearchResult');
    assert(res.q === 'zephyrite', `search echoed wrong q: ${res.q}`);
    assert(Array.isArray(res.hits) && res.hits.length === 1, `expected 1 hit, got ${res.hits?.length}`);
    assert(res.hits[0].id === RESEARCH_SEED, `hit was ${res.hits[0].id}`);
    assert(Array.isArray(res.hits[0].snippets) && res.hits[0].snippets.length >= 1, 'hit carried no snippet');
    assert(res.hits[0].snippets.some((s) => s.toLowerCase().includes('zephyrite')), 'snippet did not contain the match');
  });

  // 7 — research: ack ok+id; doc appears active; then flips to done with a longer body.
  await step('7. research seeds an active doc that later flips to done', async () => {
    const mk = v.mark();
    v.send({ type: 'research', topic: 'GraphQL adoption', subject: 'Platform', dir: '/Users/demo/widget', model: 'sonnet', tags: ['infra'] });
    const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'research', 5000, 'research ack');
    assert(ack.ok === true, `research ack not ok: ${ack.detail}`);
    assert(typeof ack.id === 'string' && ack.id.length > 0, 'research ack carried no id');
    researchId = ack.id;
    const activeSnap = await v.waitFrom(mk, (m) => isSnap(m) && docIn(m, researchId)?.status === 'active', 6000, 'snapshot with active research doc');
    const activeWords = docIn(activeSnap, researchId).words;
    const doneSnap = await v.waitFrom(mk, (m) => isSnap(m) && docIn(m, researchId)?.status === 'done', 12000, 'snapshot with done research doc');
    const doneDoc = docIn(doneSnap, researchId);
    assert(doneDoc.kind === 'research', 'research doc lost its kind');
    assert(doneDoc.words > activeWords, `body did not grow (active ${activeWords} → done ${doneDoc.words})`);
  });

  // 8 — docDelete → ack ok; the doc leaves the next snapshot.
  await step('8. docDelete removes the doc from later snapshots', async () => {
    assert(createdId, 'no created doc to delete (step 2 failed)');
    const mk = v.mark();
    v.send({ type: 'docDelete', id: createdId });
    const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'docDelete', 5000, 'docDelete ack');
    assert(ack.ok === true, `docDelete ack not ok: ${ack.detail}`);
    await v.waitFrom(mk, (m) => isSnap(m) && !docIn(m, createdId), 6000, 'snapshot without the deleted doc');
  });

  // 9 — an unknown message type is dropped by the relay (no ack, no crash).
  await step('9. an unknown message type is dropped, connection survives', async () => {
    const mk = v.mark();
    v.send({ type: 'evil', id: 'boom' });
    await sleep(1500);
    const echoed = v.msgs.slice(mk).some((m) => m.type === 'evil' || (m.type === 'ack' && m.cmd === 'evil'));
    assert(!echoed, 'relay reflected or acked an unknown type');
    // Still alive: a fresh snapshot must arrive after the evil frame.
    await v.waitFrom(mk, (m) => isSnap(m), 4000, 'snapshot after unknown-type frame');
  });

  // 10 — wrong token rejected, correct token accepted.
  await step('10. wrong token is rejected, correct token is accepted', async () => {
    await new Promise((resolve, reject) => {
      const bad = new WebSocket(`ws://localhost:${port}/ws?role=viewer&token=wrong`, { handshakeTimeout: 4000 });
      sockets.push(bad);
      let settled = false;
      const ok = () => { if (!settled) { settled = true; resolve(); } };
      bad.on('open', () => { if (!settled) { settled = true; reject(new Error('wrong token was accepted')); } });
      bad.on('unexpected-response', ok);
      bad.on('error', ok);
      bad.on('close', ok);
    });
    const good = openViewer(port, TOKEN);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('correct token did not connect')), 4000);
      good.on('open', () => { clearTimeout(t); resolve(); });
      good.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  });
}

main()
  .catch((err) => {
    failures += 1;
    console.log(`FAIL - harness error: ${err.stack || err.message}`);
    // Startup failures are usually visible in the children's output.
    for (const c of children) if (c._out.trim()) console.log(`--- ${c._label} output ---\n${c._out.trim()}`);
  })
  .finally(async () => {
    // Give in-flight frames a moment so a passing run doesn't race teardown.
    await sleep(100);
    cleanup();
    console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nAll assertions passed');
    process.exit(failures ? 1 : 0);
  });
