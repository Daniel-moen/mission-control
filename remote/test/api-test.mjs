// REST API test — boots the real relay (server.js) + the fake host, then
// exercises every /api/v1 route over plain HTTP the way OpenClaw would.
//
//   cd remote && npm run test:api
//
// Asserts auth, agent listing/detail/loose-matching, live screen reads, reply/
// key/kill/broadcast/launch acks, the full doc CRUD + search cycle, and the
// one-shot research flow (active → done), Mia (/api/v1/mia*), and the panel's
// HTTP fallback transport (/snapshot, /cmd, /screens) with and without a host.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

// A stand-in for OpenAI's realtime client_secrets endpoint: records what the
// relay asked for so the session config can be asserted. The relay never
// talks to the real OpenAI in this test.
const OPENAI_PORT = 8896;
const openaiSeen = [];
const http = require('node:http');
const mockOpenAI = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    openaiSeen.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/v1/realtime/client_secrets' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'ek_mock_123', expires_at: Math.floor(Date.now() / 1000) + 120, session: {} }));
      return;
    }
    if (req.url === '/v1/realtime/calls' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/sdp', location: '/v1/realtime/calls/rtc_mock1' });
      res.end('v=0\r\nmock-answer\r\n');
      return;
    }
    if (/^\/v1\/realtime\/calls\/[\w-]+\/hangup$/.test(req.url) && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/v1/audio/speech' && req.method === 'POST') {
      if (/"input":"FAIL/.test(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock refusal' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.write(Buffer.from('ID3fake-'));
      res.end(Buffer.from('mp3-bytes'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

function boot(cmd, args, name, extraEnv = {}) {
  const p = spawn(cmd, args, {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      MC_TOKEN: TOKEN,
      PORT: String(PORT),
      PUSH_STORE: path.join(TMP, 'push-subscriptions.json'),
      REALTIME_STORE: path.join(TMP, 'realtime-usage.json'),
      TTS_STORE: path.join(TMP, 'tts-usage.json'),
      TTS_DAILY_CHARS: '1000',
      OPENAI_API_KEY: '',
      ...extraEnv,
    },
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
  await new Promise((r) => mockOpenAI.listen(OPENAI_PORT, r));
  boot('node', ['server.js'], 'relay', { OPENAI_API_KEY: 'sk-test-relay-only', OPENAI_BASE_URL: `http://localhost:${OPENAI_PORT}` });

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
  ok((await api('POST', '/mia/dismiss', {})).status === 400, 'dismiss with no ids and no old:true is a 400');
  const badDismiss = await api('POST', '/mia/dismiss', { questionId: 'q_nope' });
  ok(badDismiss.status === 422 && badDismiss.data.ok === false, 'dismissing an unknown question is a 422');
  const noOld = await api('POST', '/mia/dismiss', { old: true });
  ok(noOld.status === 422 && /No old questions/.test(noOld.data.detail || noOld.data.error || ''), 'dismiss old:true with none old is a 422');
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

  console.log('stt (talk mode)');
  {
    const STT = `http://localhost:${PORT}/stt`;
    ok((await fetch(STT)).status === 401, 'stt needs the token');
    const info = await (await fetch(STT, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    ok(info.ok === true && 'provider' in info, 'GET /stt reports the provider');
    const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
    ok('stt' in health, '/health says whether talk mode can transcribe');
    const { clean } = require('../stt.js');
    ok(clean(' [BLANK_AUDIO] ') === '' && clean(' Thank you.') === '' && clean('(music) Call Sam at 3.') === 'Call Sam at 3.', 'whisper filler and silence hallucinations are dropped');
    const post = (body, type = 'audio/wav') =>
      fetch(STT, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': type }, body });
    if (!info.provider) {
      ok((await post(Buffer.alloc(4000))).status === 503, 'without a transcriber POST /stt is a 503 (talk mode shows why)');
      console.log('    (set WHISPER_MODEL=<ggml model> with whisper-cli on PATH to exercise real transcription)');
    } else {
      ok((await post(Buffer.alloc(4000), 'audio/wav')).status === (info.provider === 'whisper' ? 415 : 502), 'non-WAV body is refused before whisper runs');
      ok((await post(Buffer.alloc(10))).status === 400, 'an empty recording is a 400');
      const wav = path.join(TMP, 'say.wav');
      const said = spawnSync('say', ['-o', wav, '--data-format=LEI16@16000', 'Remind me to call the dentist tomorrow at three.']);
      if (said.status === 0) {
        const r = await (await post(fs.readFileSync(wav))).json();
        ok(r.ok && /dentist/i.test(r.text), `a spoken WAV comes back as text (${r.ms}ms: "${r.text}")`);
      }
    }
  }

  console.log('realtime voice');
  {
    const RT = `http://localhost:${PORT}/realtime`;
    const bearer = { authorization: `Bearer ${TOKEN}` };
    ok((await fetch(`${RT}/session`, { method: 'POST' })).status === 401, 'minting a realtime session needs the token (401 without)');
    ok((await fetch(`${RT}/session`, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status === 401, 'a wrong token is a 401 too');
    ok((await fetch(RT)).status === 401, 'GET /realtime needs the token');
    const info = await (await fetch(RT, { headers: bearer })).json();
    ok(info.ok && info.available === true && info.model === 'gpt-realtime-2.1-mini' && info.models.premium === 'gpt-realtime-2.1' && info.voice === 'marin', 'GET /realtime: Standard is gpt-realtime-2.1-mini, Premium gpt-realtime-2.1, voice marin');
    ok(info.limits.idleSeconds === 30 && info.limits.awaitSeconds === 90 && info.limits.maxSeconds === 600, 'limits: 30 s quiet, 90 s awaiting Mia, 10 min cap');
    ok(info.budget.cap === 1.5 && info.budget.over === false && info.week.days.length === 7, 'GET /realtime: $1.50 daily budget and the last 7 days');

    const s = await (await fetch(`${RT}/session`, { method: 'POST', headers: bearer })).json();
    ok(s.ok && s.id && s.callsUrl === `/realtime/calls/${s.id}` && s.model === 'gpt-realtime-2.1-mini', 'POST /realtime/session → the ephemeral session, SDP routed through the relay');
    ok(!JSON.stringify(s).includes('sk-test-relay-only'), 'the OpenAI key never appears in the response');
    const minted = openaiSeen.find((x) => x.url === '/v1/realtime/client_secrets');
    ok(minted && minted.auth === 'Bearer sk-test-relay-only', 'the relay mints with its own key');
    const cfg = minted ? JSON.parse(minted.body) : {};
    const sess = cfg.session || {};
    ok(sess.type === 'realtime' && sess.model === 'gpt-realtime-2.1-mini' && sess.audio?.output?.voice === 'marin', 'session: mini model + voice by default');
    const td = sess.audio?.input?.turn_detection || {};
    ok(td.type === 'semantic_vad' && td.eagerness === 'low' && td.interrupt_response === true, 'session: semantic VAD, low eagerness, with barge-in');
    ok(sess.audio?.input?.noise_reduction?.type === 'near_field', 'session: near-field noise reduction');
    ok(!sess.audio?.input?.transcription, 'session: no input transcription unless asked for');
    ok(sess.truncation?.type === 'retention_ratio' && sess.truncation.retention_ratio > 0 && sess.truncation.token_limits?.post_instructions <= 4000, 'session: truncation keeps only the last few turns');
    ok(sess.reasoning?.effort === 'low', 'session: low reasoning effort');
    ok(['send_to_mia', 'get_status', 'answer_question', 'end_session'].every((n) => (sess.tools || []).some((t) => t.name === n)), 'session: the four relay tools');
    ok(/you do not answer from memory/i.test(sess.instructions || '') && /call send_to_mia/.test(sess.instructions || ''), 'session: persona routes everything substantive, never answers itself');
    ok(/Never reveal how you work inside/.test(sess.instructions || '') && !/Mia says/.test(JSON.stringify(sess)), 'session: one assistant — no hand-off talk, no "Mia says"');
    ok(/like Jarvis/.test(sess.instructions || '') && /One or two short sentences/.test(sess.instructions || '') && /Never repeat his request/.test(sess.instructions || '') && /Never read a list aloud/.test(sess.instructions || '') && /lead with the answer/.test(sess.instructions || ''), 'session: Jarvis-brief persona (short, no filler, no echo, no lists, answer first)');
    ok(sess.max_output_tokens === 300, 'session: output capped at 300 tokens per response');
    ok(/at most about 20 words/.test(sess.instructions || '') && /Finish each sentence/.test(sess.instructions || ''), 'session: mini gets the firmer length rule (short, ends at a sentence)');
    ok(/never call send_to_mia for them/.test(sess.instructions || '') && /Can you hear me/.test(sess.instructions || '') && /Not for greetings or small talk/.test((sess.tools || []).find((t) => t.name === 'send_to_mia')?.description || ''), 'session: greetings and small talk are answered directly, not sent on');
    ok((sess.tools || []).every((t) => !/to Mia|Mia's|\bagent|Claude|relay/i.test(t.description)), 'session: tool descriptions don\'t leak the architecture');
    ok(cfg.expires_after?.seconds <= 600, 'the client secret is short-lived');

    const prem = await (await fetch(`${RT}/session`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ quality: 'premium', transcript: true }) })).json();
    const pcfg = JSON.parse(openaiSeen.filter((x) => x.url === '/v1/realtime/client_secrets').pop().body).session;
    ok(prem.ok && prem.model === 'gpt-realtime-2.1' && pcfg.model === 'gpt-realtime-2.1' && pcfg.audio.input.transcription?.model === 'gpt-4o-mini-transcribe' && prem.transcript === true, 'Premium + transcript: gpt-realtime-2.1 with input transcription');
    ok(!/at most about 20 words/.test(pcfg.instructions) && /never call send_to_mia for them/.test(pcfg.instructions), 'Premium keeps the shared persona (small-talk rule, no mini length rule)');

    const sdp = (id, body = 'v=0\r\nfake-offer\r\n') => fetch(`http://localhost:${PORT}/realtime/calls/${id}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/sdp' }, body });
    ok((await fetch(`http://localhost:${PORT}/realtime/calls/${s.id}`, { method: 'POST', body: 'x' })).status === 401, 'the SDP route needs the token');
    const ans = await sdp(s.id);
    const fwd = openaiSeen.find((x) => x.url === '/v1/realtime/calls');
    ok(ans.status === 201 && (await ans.text()).includes('mock-answer') && fwd?.auth === 'Bearer ek_mock_123' && fwd.body.includes('fake-offer'), 'SDP offer relayed to OpenAI with the ephemeral secret; answer returned');
    ok((await sdp(s.id)).status === 404, 'a session secret opens one call only');

    const rep = async (body) => fetch(`${RT}/usage`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    ok((await rep({ id: 'rt_bogus', seconds: 10 })).status === 404, 'usage for an unknown session is refused');
    await rep({ id: s.id, seconds: 90, usage: { audioIn: 1000, audioOut: 2000 } });
    const r2 = await (await rep({ id: s.id, seconds: 90, usage: { audioIn: 1000, audioOut: 2000 } })).json();
    ok(r2.ok && r2.today.minutes >= 1.5 && r2.today.sessions === 2 && r2.today.open === 2, 'usage: running totals, a repeat report is not double-counted; open calls count');
    await rep({ id: s.id, seconds: 99999, final: 'done' });
    await sleep(300);
    const capped = await (await fetch(RT, { headers: bearer })).json();
    const rec = capped.days.find((d) => d.day === capped.today.day);
    ok(capped.today.open === 1 && capped.today.minutes <= 10.6, 'usage: a final report settles the session; one session can\'t log past the 10-minute cap');
    ok(Math.abs(rec.tokens.audioIn - 1000) < 1 && Math.abs(rec.tokens.audioOut - 2000) < 1, 'usage: per-session tokens recorded in the day');
    ok((await rep({ id: s.id, seconds: 100 })).status === 200, 'a late report for a settled session is harmless');
    const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
    ok(health.realtime && health.realtime.available === true && typeof health.realtime.today.minutes === 'number', '/health shows realtime minutes used today');
    ok(health.stt !== 'openai', '/stt never switches to OpenAI, even with OPENAI_API_KEY set');
    await sleep(700);
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'realtime-usage.json'), 'utf8'));
    ok(Object.values(saved.days)[0]?.sessions === 2 && saved.log.some((e) => e.id === s.id && e.model === 'gpt-realtime-2.1-mini') && saved.open[prem.id], 'usage is persisted per day, with a per-session log and the open calls');

    const { createRealtime } = require('../realtime.js');
    const quiet = { log() {}, warn() {}, error() {} };
    const fakeRes = () => { const r = { status: 0, body: '' }; r.writeHead = (st) => { r.status = st; }; r.end = (b) => { r.body = b; }; r.headersSent = false; return r; };
    const fakeReq = (method, body) => {
      const h = new (require('node:events').EventEmitter)();
      Object.assign(h, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      setImmediate(() => { if (body) h.emit('data', body); h.emit('end'); });
      return h;
    };
    const noKey = createRealtime({ tokenOk: (t) => t === TOKEN, env: { REALTIME_STORE: path.join(TMP, 'rt2.json') }, log: quiet });
    const res503 = fakeRes();
    await noKey.handle({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, res503, new URL('http://x/realtime/session'));
    ok(res503.status === 503 && noKey.info().available === false, 'without OPENAI_API_KEY minting is a 503 (the panel falls back to basic)');
    noKey.close();

    // Watchdog + durable tally + budget, on an instance with a fake OpenAI.
    const seen = [];
    const lines = [];
    const fakeFetch = async (url, o = {}) => {
      seen.push({ url: String(url), method: o.method });
      if (/client_secrets$/.test(url)) return new Response(JSON.stringify({ value: 'ek_unit' }), { status: 200 });
      if (/\/calls$/.test(url)) return new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/realtime/calls/rtc_unit' } });
      if (/hangup$/.test(url)) return new Response('{}', { status: 200 });
      return new Response('', { status: 404 });
    };
    const store3 = path.join(TMP, 'rt3', 'realtime-usage.json');
    const env3 = { OPENAI_API_KEY: 'sk-unit', RAILWAY_VOLUME_MOUNT_PATH: path.join(TMP, 'rt3'), REALTIME_SILENT_SECONDS: '0.2', REALTIME_DAILY_USD: '0.05' };
    const logger = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push('WARN ' + a.join(' ')), error: (...a) => lines.push('ERR ' + a.join(' ')) };
    const rt3 = createRealtime({ tokenOk: (t) => t === TOKEN, env: env3, log: logger, fetchImpl: fakeFetch });
    const call3 = async (method, route, body) => { const r = fakeRes(); await rt3.handle(fakeReq(method, body), r, new URL(`http://x${route}`)); return { status: r.status, body: r.body && r.body[0] === '{' ? JSON.parse(r.body) : r.body }; };
    const m3 = await call3('POST', '/realtime/session', '{}');
    await call3('POST', m3.body.callsUrl, 'v=0\r\noffer\r\n');
    await call3('POST', '/realtime/usage', JSON.stringify({ id: m3.body.id, seconds: 20, usage: { audioIn: 600, audioOut: 1200, textIn: 1500, textInCached: 3000 } }));
    await sleep(400);
    await rt3.watchdog();
    ok(seen.some((x) => x.url.endsWith('/v1/realtime/calls/rtc_unit/hangup')), 'watchdog: a call whose panel went silent is hung up relay-side');
    const endLine = lines.find((l) => /session .* ended \(watchdog: panel went silent\)/.test(l));
    ok(endLine && /min · tokens in \d+ .* out \d+ · \$\d/.test(endLine), `one log line per ended session with minutes, tokens and $ ("${(endLine || '').slice(10, 140)}…")`);
    rt3.close();
    ok(fs.existsSync(store3), 'with a Railway volume mounted, the tally lives on it');
    // "Redeploy": a fresh instance on the same volume keeps the tally.
    const rt4 = createRealtime({ tokenOk: (t) => t === TOKEN, env: env3, log: logger, fetchImpl: fakeFetch });
    const t4 = rt4.info().today;
    ok(t4.sessions === 1 && t4.usd > 0, `the tally survives a restart ($${t4.usd})`);
    // Past the budget: an open session that never reported an end counts, then new sessions are refused.
    const r4 = fakeRes();
    await rt4.handle(fakeReq('POST', '{}'), r4, new URL('http://x/realtime/session'));
    const id4 = JSON.parse(r4.body).id;
    const r4b = fakeRes();
    await rt4.handle(fakeReq('POST', JSON.stringify({ id: id4, seconds: 60, usage: { audioIn: 2000, audioOut: 2000 } })), r4b, new URL('http://x/realtime/usage'));
    ok(lines.some((l) => /^WARN realtime: \d+% of today's \$0.05 voice budget used/.test(l)), 'warns at 80% of the daily budget');
    const r5 = fakeRes();
    await rt4.handle(fakeReq('POST', '{}'), r5, new URL('http://x/realtime/session'));
    ok(r5.status === 429 && /budget/.test(JSON.parse(r5.body).error), 'past REALTIME_DAILY_USD new sessions are refused (429 → the panel uses Basic)');
    rt4.close();
    const rt5 = createRealtime({ tokenOk: (t) => t === TOKEN, env: env3, log: logger, fetchImpl: fakeFetch });
    ok(rt5.info().today.open === 1, 'a call open across a restart is still counted');
    rt5.close();
  }

  console.log('announcement voice (/tts)');
  {
    const TTS = `http://localhost:${PORT}/tts`;
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const say = (text, headers = bearer) => fetch(TTS, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    ok((await say('Hello', {})).status === 401, 'POST /tts needs the token (401 without)');
    ok((await say('Hello', { authorization: 'Bearer nope' })).status === 401, 'a wrong token is a 401 too');
    ok((await fetch(TTS)).status === 401, 'GET /tts needs the token');
    const info = await (await fetch(TTS, { headers: bearer })).json();
    ok(info.ok && info.available && info.model === 'gpt-4o-mini-tts' && info.voice === 'marin', 'GET /tts: gpt-4o-mini-tts in the realtime voice (marin)');
    ok(info.limits.maxChars === 400 && info.limits.dailyChars === 1000, 'GET /tts: length cap 400, daily cap from TTS_DAILY_CHARS');

    const before = openaiSeen.length;
    const r = await say('Task 17 is done.   Anything else?');
    const bytes = Buffer.from(await r.arrayBuffer()).toString();
    ok(r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && bytes === 'ID3fake-mp3-bytes', 'POST /tts streams the mp3 back');
    ok(r.headers.get('x-tts-cache') === 'miss' && r.headers.get('x-tts-chars') === '31', 'first time: a cache miss, whitespace normalised');
    const call = openaiSeen.slice(before).find((x) => x.url === '/v1/audio/speech');
    const cfg = call ? JSON.parse(call.body) : {};
    ok(call && call.auth === 'Bearer sk-test-relay-only', 'the relay calls OpenAI with its own key');
    ok(cfg.model === 'gpt-4o-mini-tts' && cfg.voice === 'marin' && cfg.response_format === 'mp3' && cfg.input === 'Task 17 is done. Anything else?', 'speech request: model, voice, mp3, the text');
    ok(/Jarvis/.test(cfg.instructions || '') && /calm/i.test(cfg.instructions || ''), 'speech request: calm, brief, Jarvis-like delivery instructions');
    const r2 = await say('Task 17 is done. Anything else?');
    ok(r2.headers.get('x-tts-cache') === 'hit' && Buffer.from(await r2.arrayBuffer()).toString() === 'ID3fake-mp3-bytes', 'the same text again comes from the cache');
    ok(openaiSeen.filter((x) => x.url === '/v1/audio/speech').length === 1, '…without a second OpenAI call');

    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const r3 = await say(long);
    await r3.arrayBuffer();
    const sent = JSON.parse(openaiSeen.filter((x) => x.url === '/v1/audio/speech').at(-1).body).input;
    ok(sent.length <= 400 && sent.startsWith('Sentence number 1 is here.') && /here\.$/.test(sent), `a long announcement is trimmed to its first whole sentences (${sent.length} chars)`);

    ok((await say('   ')).status === 400, 'empty text is a 400');
    ok((await say('FAIL please')).status === 502, 'an OpenAI refusal is a 502 (the panel falls back to the device voice)');
    const mid = await (await fetch(TTS, { headers: bearer })).json();
    ok(mid.today.requests === 2 && mid.today.chars === 31 + sent.length && mid.today.cached === 1, 'usage: requests + characters per day; cache hits and refusals are free');
    ok(Math.abs(mid.today.usd - (31 + sent.length) * (0.015 / 900)) < 0.0002, 'usage: cost estimate ≈ $0.015 per spoken minute');

    // Daily cap (1000 in this test): fill it up, then the next one is refused.
    let status = 200;
    for (let i = 0; i < 10 && status === 200; i++) {
      const rr = await say(`Cap filler ${i}. ${'x'.repeat(300)}`);
      status = rr.status;
      await rr.arrayBuffer();
    }
    ok(status === 429, 'past TTS_DAILY_CHARS the relay refuses (429 → device voice)');
    const after = await (await fetch(TTS, { headers: bearer })).json();
    ok(after.today.chars <= 1000, `the daily cap is never exceeded (${after.today.chars} chars)`);
    const r4 = await say('Task 17 is done. Anything else?');
    ok(r4.status === 200 && r4.headers.get('x-tts-cache') === 'hit', 'cached text still plays past the cap (costs nothing)');
    await r4.arrayBuffer();
    const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
    ok(health.tts && health.tts.available === true && health.tts.today.chars === after.today.chars, '/health shows today\'s announcement characters');
    await sleep(700);
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'tts-usage.json'), 'utf8'));
    ok(Object.values(saved.days)[0]?.chars === after.today.chars, 'tts usage is persisted per day');

    const { createTts, trimText } = require('../tts.js');
    const noKey = createTts({ tokenOk: (t) => t === TOKEN, env: { TTS_STORE: path.join(TMP, 'tts2.json') }, log: { log() {}, warn() {}, error() {} } });
    const fakeRes = () => { const x = { status: 0, body: '' }; x.writeHead = (st) => { x.status = st; }; x.end = (b) => { x.body = b; }; return x; };
    const fakeReq = (body) => { const { Readable } = require('node:stream'); const q = Readable.from([Buffer.from(JSON.stringify(body))]); q.method = 'POST'; q.headers = { authorization: `Bearer ${TOKEN}` }; return q; };
    const res503 = fakeRes();
    await noKey.handle(fakeReq({ text: 'Hello' }), res503, new URL('http://x/tts'));
    ok(res503.status === 503 && noKey.info().available === false, 'without OPENAI_API_KEY /tts is a 503 (the panel uses the device voice)');
    const one = trimText(`${'word '.repeat(120)}end.`, 400);
    ok(one.length <= 400 && one.endsWith('…'), 'one over-long sentence is cut at a word with "…"');

    // On Railway the tally lives on the volume; an old working-directory file is moved over once.
    const cwd = process.cwd();
    const work = fs.mkdtempSync(path.join(TMP, 'cwd-'));
    const vol = path.join(work, 'data');
    process.chdir(work);
    try {
      fs.writeFileSync('tts-usage.json', JSON.stringify({ days: { '2026-01-01': { requests: 3, chars: 42, cached: 0, usd: 0.001 } } }));
      const quiet = { log() {}, warn() {}, error() {} };
      const onVol = createTts({ tokenOk: () => true, env: { RAILWAY_VOLUME_MOUNT_PATH: vol }, log: quiet });
      ok(fs.existsSync(path.join(vol, 'tts-usage.json')) && !fs.existsSync('tts-usage.json') && onVol.info() && JSON.parse(fs.readFileSync(path.join(vol, 'tts-usage.json'), 'utf8')).days['2026-01-01'].chars === 42, 'tts tally: an existing container-disk file is migrated to the volume');
      const { createPush } = require('../push.js');
      const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
      fs.writeFileSync('push-subscriptions.json', JSON.stringify([sub]));
      const p1 = createPush({ tokenOk: () => true, env: { RAILWAY_VOLUME_MOUNT_PATH: vol, VAPID_SUBJECT: 'mailto:t@example.com' }, log: quiet });
      ok(p1.count() === 1 && fs.existsSync(path.join(vol, 'push-subscriptions.json')) && !fs.existsSync('push-subscriptions.json'), 'push subscriptions: an existing container-disk file is migrated to the volume');
      const p2 = createPush({ tokenOk: () => true, env: { RAILWAY_VOLUME_MOUNT_PATH: vol, VAPID_SUBJECT: 'mailto:t@example.com' }, log: quiet });
      ok(p2.count() === 1, 'push subscriptions survive a restart (read back from the volume)');
    } finally {
      process.chdir(cwd);
    }
  }

  console.log('wake word model');
  {
    const r = await fetch(`http://localhost:${PORT}/wake/model.tar.gz`);
    ok(r.status === 404 && /WAKE_MODEL/.test(await r.text()), 'without WAKE_MODEL the model route is a clear 404 (the panel says the wake word is unavailable)');
  }

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
  .finally(async () => {
    // The relay writes its realtime tally on SIGTERM — let it finish first.
    await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); })));
    mockOpenAI.close();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  });
