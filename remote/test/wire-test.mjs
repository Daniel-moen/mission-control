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
// Steps 17+ cover `mia panel` (docs/mia.md §8.2): the real CLI writes
// panel.jsonl, the fake host ships it like MiaManager, and the relay hands it
// to exactly one viewer — the most recently active — never fanning it out;
// off-list actions and "no panel open" come back to the host as panelResult.
//
// Steps 11+ cover Mia (docs/mia.md §8): every mia* command crosses the relay and
// is acked, the host learns the VAPID key, /push/* is token-gated, and a host
// `push` frame becomes a Web Push (web-push is mocked via test/mock-web-push.cjs,
// preloaded into the relay) without ever reaching a viewer.
//
// Run:  cd remote && node test/wire-test.mjs   (or: npm run test:wire)
// One ok/FAIL line per assertion; non-zero exit on any failure; no child
// process or port is left behind, even when an assertion throws.

import net from 'net';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import * as require_cp from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.js');
const HOST = path.join(HERE, 'fake-host.mjs');
const MOCK_PUSH = path.join(HERE, 'mock-web-push.cjs');
const PUSH_STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wire-')), 'push-subscriptions.json');
const MIA_DIR = path.join(path.dirname(PUSH_STORE), 'mia');
const MIA_CLI = path.join(HERE, '..', '..', 'scripts', 'mia');
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

function spawnNode(file, port, label, extraEnv = {}) {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(port), ...extraEnv },
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
  try { fs.rmSync(path.dirname(PUSH_STORE), { recursive: true, force: true }); } catch {}
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

// Plain HTTP against the relay; `token` goes in a Bearer header, `query` in ?token=.
async function http_(port, method, route, { body, token, query } = {}) {
  const qs = query != null ? `?token=${encodeURIComponent(query)}` : '';
  const res = await fetch(`http://localhost:${port}${route}${qs}`, {
    method,
    headers: {
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const fakeSub = (name) => ({
  endpoint: `https://push.example.test/${name}`,
  keys: { p256dh: 'BPlaceholderP256dhKeyForTests', auth: 'placeholderAuth' },
});
const docIn = (snap, id) => (snap.docs || []).find((d) => d.id === id);

// ---- the run ----------------------------------------------------------------

async function main() {
  const port = await freePort();
  const server = spawnNode(SERVER, port, 'server', {
    NODE_OPTIONS: `--require ${MOCK_PUSH}`,
    PUSH_STORE,
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
  });
  await waitHealthy(port, 8000);
  spawnNode(HOST, port, 'fake-host', { MIA_DIR });

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

  // ---- Mia ------------------------------------------------------------------

  // 11 — the snapshot's mia block passes through untouched.
  await step('11. snapshot carries the mia block', async () => {
    const snap = await v.waitFrom(0, (m) => isSnap(m) && m.mia, 5000, 'snapshot with mia');
    for (const k of ['enabled', 'online', 'model', 'messages', 'tasks', 'pendingQuestions', 'schedule']) {
      assert(k in snap.mia, `mia block missing '${k}'`);
    }
    assert(snap.mia.pendingQuestions.some((q) => q.questionId === 'q_seed1'), 'seeded question not pending');
  });

  // 12 — every mia* command type crosses the relay and is acked by the host.
  await step('12. all twelve mia* commands pass through and are acked', async () => {
    const cmds = [
      { type: 'miaSend', text: 'hello Mia' },
      { type: 'miaAnswer', questionId: 'q_seed1', text: 'Whole app' },
      { type: 'miaRead', upTo: 'm_2' },
      { type: 'miaTaskAdd', title: 'Wire task', detail: 'from the wire test', dir: '/Users/demo/shop', priority: 1 },
      { type: 'miaTaskSet', id: '0001', field: 'priority', value: 1 },
      { type: 'miaTaskCancel', id: '0001' },
      { type: 'miaStop' },
      { type: 'miaStart' },
      { type: 'miaSetModel', model: 'claude-fable-5-1' },
      { type: 'miaRestart' },
      { type: 'miaSchedule', op: 'addReminder', item: { id: 'r_wire', at: '2030-01-01T09:00:00Z', text: 'Chase the invoice' } },
      { type: 'miaPushTest' },
    ];
    for (const c of cmds) {
      const mk = v.mark();
      v.send(c);
      const ack = await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === c.type, 5000, `${c.type} ack`);
      assert(ack.ok === true, `${c.type} ack not ok: ${ack.detail}`);
      if (c.type === 'miaTaskAdd') assert(/^\d{4}$/.test(ack.id || ''), `miaTaskAdd ack id was ${ack.id}`);
    }
    const snap = await v.waitFrom(v.mark(), isSnap, 4000, 'snapshot after mia commands');
    assert(snap.mia.tasks.some((t) => t.title === 'Wire task' && t.priority === 1), 'added task missing from snapshot');
    assert(!snap.mia.pendingQuestions.some((q) => q.questionId === 'q_seed1'), 'answered question still pending');
    assert(snap.mia.schedule.reminders.some((r) => r.id === 'r_wire'), 'reminder missing from snapshot');
    // miaSetModel → saved model; miaRestart → her session now runs on it.
    assert(snap.mia.model === 'claude-fable-5-1', `model after miaSetModel was ${snap.mia.model}`);
    assert(snap.mia.runningModel === 'claude-fable-5-1' && snap.mia.online, `runningModel after miaRestart was ${snap.mia.runningModel}`);
    assert((snap.caps || []).includes('miaRestart'), 'host caps lack miaRestart');
  });

  // 13 — /push/key is token-gated; the host was told the same key on connect.
  let pushKey = null;
  await step('13. /push/key needs the token and matches the key the host got', async () => {
    assert((await http_(port, 'GET', '/push/key')).status === 401, 'no token was accepted');
    assert((await http_(port, 'GET', '/push/key', { token: 'wrong' })).status === 401, 'bad token was accepted');
    const viaBearer = await http_(port, 'GET', '/push/key', { token: TOKEN });
    assert(viaBearer.status === 200 && typeof viaBearer.data.key === 'string' && viaBearer.data.key.length > 40, 'bearer: no key');
    const viaQuery = await http_(port, 'GET', '/push/key', { query: TOKEN });
    assert(viaQuery.status === 200 && viaQuery.data.key === viaBearer.data.key, '?token= did not return the same key');
    pushKey = viaBearer.data.key;
    const snap = await v.waitFrom(v.mark(), (m) => isSnap(m) && m.mia?.pushKey, 4000, 'snapshot with mia.pushKey');
    assert(snap.mia.pushKey === pushKey, 'host was sent a different pushKey');
  });

  // 14 — /push/subscribe is token-gated, validates, and persists to PUSH_STORE.
  await step('14. /push/subscribe needs the token, validates, and persists', async () => {
    assert((await http_(port, 'POST', '/push/subscribe', { body: fakeSub('phone') })).status === 401, 'no token was accepted');
    assert((await http_(port, 'POST', '/push/subscribe', { body: { endpoint: 'nope' }, token: TOKEN })).status === 400, 'junk subscription accepted');
    const a = await http_(port, 'POST', '/push/subscribe', { body: { ...fakeSub('phone'), label: 'iPhone' }, token: TOKEN });
    assert(a.status === 200 && a.data.ok, `subscribe failed: ${a.status}`);
    const again = await http_(port, 'POST', '/push/subscribe', { body: fakeSub('phone'), query: TOKEN });
    assert(again.status === 200 && again.data.subscriptions === 1, 're-subscribing duplicated the endpoint');
    const gone = await http_(port, 'POST', '/push/subscribe', { body: fakeSub('gone'), token: TOKEN });
    assert(gone.data.subscriptions === 2, 'second subscription not stored');
    const stored = JSON.parse(fs.readFileSync(PUSH_STORE, 'utf8'));
    assert(stored.length === 2 && stored.some((s) => s.endpoint.endsWith('/phone')), 'PUSH_STORE not written');
  });

  // 15 — a host push frame → Web Push to every subscription; never to viewers;
  // a 410 endpoint is dropped.
  await step('15. host push frame reaches subscriptions, not viewers; 410 is dropped', async () => {
    const mk = v.mark();
    const outBefore = server._out.length;
    v.send({ type: 'miaPushTest' });
    await v.waitFrom(mk, (m) => m.type === 'ack' && m.cmd === 'miaPushTest', 5000, 'miaPushTest ack');
    const deadline = Date.now() + 4000;
    while (!server._out.slice(outBefore).includes('MOCK_PUSH') && Date.now() < deadline) await sleep(50);
    const line = server._out.slice(outBefore).split('\n').find((l) => l.startsWith('MOCK_PUSH '));
    assert(line, 'no web push was sent');
    const sent = JSON.parse(line.slice('MOCK_PUSH '.length));
    assert(sent.endpoint.endsWith('/phone'), `pushed to ${sent.endpoint}`);
    const p = sent.payload;
    assert(p.title === 'Mia' && p.body.includes('Test notification') && p.tag === 'mia-test' && p.url === '/#mia' && p.urgent === false, `payload wrong: ${JSON.stringify(p)}`);
    await sleep(500);
    assert(!v.msgs.slice(mk).some((m) => m.type === 'push'), 'push frame was fanned out to a viewer');
    const health = await http_(port, 'GET', '/health');
    assert(health.data.pushSubscriptions === 1, `gone endpoint not dropped (${health.data.pushSubscriptions} left)`);
    const stored = JSON.parse(fs.readFileSync(PUSH_STORE, 'utf8'));
    assert(stored.length === 1 && stored[0].endpoint.endsWith('/phone'), 'drop not persisted');
  });

  // 16 — /push/unsubscribe is token-gated and removes the endpoint.
  await step('16. /push/unsubscribe needs the token and removes the endpoint', async () => {
    const body = { endpoint: fakeSub('phone').endpoint };
    assert((await http_(port, 'POST', '/push/unsubscribe', { body })).status === 401, 'no token was accepted');
    const r = await http_(port, 'POST', '/push/unsubscribe', { body, token: TOKEN });
    assert(r.status === 200 && r.data.removed === true && r.data.subscriptions === 0, `unsubscribe: ${JSON.stringify(r.data)}`);
  });


  // ---- 17+ — `mia panel` routing --------------------------------------------
  const mia = (...args) => {
    const { execFileSync } = require_cp;
    return execFileSync(MIA_CLI, args, { env: { ...process.env, MIA_DIR }, encoding: 'utf8' }).trim();
  };
  const results = () => {
    try {
      return fs.readFileSync(path.join(MIA_DIR, 'panel-results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const v2 = openViewer(port, TOKEN);
  await v2.opened;

  await step('17. panelFocus marks exactly one viewer primary; activity moves it', async () => {
    await v2.waitFrom(0, (m) => m.type === 'panelFocus', 3000, 'v2 panelFocus');
    const mk1 = v.mark();
    const mk2 = v2.mark();
    v.send({ type: 'viewerActive', visible: true });
    await v.waitFrom(mk1, (m) => m.type === 'panelFocus' && m.primary === true, 3000, 'v primary');
    await v2.waitFrom(mk2, (m) => m.type === 'panelFocus' && m.primary === false, 3000, 'v2 demoted');
    const mk3 = v2.mark();
    v2.send({ type: 'viewerActive', visible: true });
    await v2.waitFrom(mk3, (m) => m.type === 'panelFocus' && m.primary === true, 3000, 'v2 primary again');
  });

  await step('18. `mia panel open-doc` reaches only the most recently active viewer', async () => {
    const mk1 = v.mark();
    const mk2 = v2.mark();
    const id = mia('panel', 'open-doc', RESEARCH_SEED, '--at', 'Sources');
    assert(/^p_\d+$/.test(id), `CLI printed ${id}`);
    const f = await v2.waitFrom(mk2, (m) => m.type === 'panel', 4000, 'panel frame on v2');
    assert(f.action === 'open-doc' && f.arg === RESEARCH_SEED && f.heading === 'Sources' && f.id === id, `frame ${JSON.stringify(f)}`);
    await sleep(400);
    assert(!v.msgs.slice(mk1).some((m) => m.type === 'panel'), 'panel frame was fanned out to the other viewer');
  });

  await step('19. a hidden panel loses to a visible one', async () => {
    const mk1 = v.mark();
    v2.send({ type: 'viewerActive', visible: false });
    await v.waitFrom(mk1, (m) => m.type === 'panelFocus' && m.primary === true, 3000, 'v promoted');
    const mk = v.mark();
    mia('panel', 'view', 'library');
    const f = await v.waitFrom(mk, (m) => m.type === 'panel', 4000, 'panel frame on v');
    assert(f.action === 'view' && f.arg === 'library', `frame ${JSON.stringify(f)}`);
  });

  await step('20. panelDone from the panel reaches the host as panelResult', async () => {
    v.send({ type: 'panelDone', id: 'p_test1', action: 'open-doc', arg: 'nope.md', ok: false, detail: 'no Library doc matches' });
    const deadline = Date.now() + 3000;
    while (!results().some((r) => r.id === 'p_test1') && Date.now() < deadline) await sleep(50);
    const r = results().find((x) => x.id === 'p_test1');
    assert(r && r.ok === false && r.detail.includes('no Library doc') && r.action === 'open-doc', `result ${JSON.stringify(r)}`);
  });

  await step('21. off-list actions and bad links are dropped at the relay', async () => {
    const mk = v.mark();
    fs.appendFileSync(path.join(MIA_DIR, 'panel.jsonl'), JSON.stringify({ id: 'p_bad1', action: 'kill', arg: 'everything' }) + '\n');
    fs.appendFileSync(path.join(MIA_DIR, 'panel.jsonl'), JSON.stringify({ id: 'p_bad2', action: 'open-url', arg: 'javascript:alert(1)' }) + '\n');
    const deadline = Date.now() + 3000;
    while (!(results().some((r) => r.id === 'p_bad1') && results().some((r) => r.id === 'p_bad2')) && Date.now() < deadline) await sleep(50);
    for (const id of ['p_bad1', 'p_bad2']) {
      const r = results().find((x) => x.id === id);
      assert(r && r.ok === false && /not an allowed/.test(r.detail), `${id}: ${JSON.stringify(r)}`);
    }
    await sleep(300);
    assert(!v.msgs.slice(mk).some((m) => m.type === 'panel'), 'an off-list panel frame reached a viewer');
    let threw = false;
    try { mia('panel', 'open-url', 'http://insecure.example'); } catch { threw = true; }
    assert(threw, 'CLI accepted a non-https link');
  });

  await step('22. with no panel open, the host hears "no panel is open"', async () => {
    for (const w of sockets) w.close(); // every viewer this run opened
    await sleep(400);
    const id = mia('panel', 'open-task', '14');
    const deadline = Date.now() + 3000;
    while (!results().some((r) => r.id === id) && Date.now() < deadline) await sleep(50);
    const r = results().find((x) => x.id === id);
    assert(r && r.ok === false && r.detail === 'no panel is open', `result ${JSON.stringify(r)}`);
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
