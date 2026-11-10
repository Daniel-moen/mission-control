// Phone test — Mia phones Daniel (phone.js, task 0621). Boots the real relay
// against a mock Twilio + mock OpenAI (REST + the Realtime sideband socket),
// a fake Mac host (records miaSend/miaAnswer, serves a snapshot) and a fake
// panel (receives show-doc), then drives the whole call the way the providers
// would, with real signatures.
//
//   cd remote && npm run test:phone
//
// Asserts: dark without keys (503 "not configured" on every /phone route,
// /health says configured:false, / still serves); auth; number allow-list;
// the call placed at Twilio (basic auth, To/From, signed callback URLs,
// machine detection, time limit); Twilio signature checks (answer + status);
// voicemail → <Hangup/>; human → <Dial><Sip> to the OpenAI project with the
// X-MC-Call header; OpenAI webhook signature (bad, stale, good); accept with
// Mia's persona, the reason for the call and the five tools; the sideband:
// she speaks first, send_to_mia → "(phone) …" on the Mac, get_status from the
// snapshot, answer_question → miaAnswer, show_on_panel → the panel; `mia
// call-say` → "Result: …" spoken in the call; end_call → hangups at OpenAI
// and Twilio, Mia told it ended; an unknown SIP call is rejected; one live
// call at a time; the time cap (goodbye, then hangup); rate limits (hour,
// day); quiet hours (refused unless urgent); the CLI (mia call / call-say /
// call-status, phone.txt, exit codes).

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8861;
const MOCK_PORT = 8862;
const TOKEN = 'test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-phone-'));
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');
const AUTH_TOKEN = 'twilio-auth-token-test';
const WHSEC = `whsec_${crypto.randomBytes(24).toString('base64')}`;
const DANIEL = '+27835615106';
const PUBLIC = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const procs = [];
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
function runAsync(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(80);
  }
  return false;
}

// ---- mock Twilio + OpenAI -----------------------------------------------------
const mock = { twilio: [], openai: [], ws: [], sockets: [], nextSid: 1 };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/2010-04-01/')) {
      const sp = new URLSearchParams(body);
      const rec = { path: u.pathname, auth: req.headers.authorization || '', params: Object.fromEntries(sp), events: sp.getAll('StatusCallbackEvent') };
      mock.twilio.push(rec);
      if (mock.twilioFail) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 21215, message: 'Geo permission off' }));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sid: `CA${mock.nextSid++}`, status: 'queued' }));
    }
    if (u.pathname.startsWith('/v1/realtime/calls/')) {
      mock.openai.push({ path: u.pathname, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (u.pathname === '/v1/embeddings') {
      mock.probes = (mock.probes || 0) + 1;
      if (mock.noCredits) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[]}');
    }
    res.writeHead(404);
    res.end();
  });
});
const mockWss = new WebSocketServer({ server: mockServer });
mockWss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const s = { callId: u.searchParams.get('call_id'), model: u.searchParams.get('model'), auth: req.headers.authorization || '', ws, got: [] };
  mock.sockets.push(s);
  ws.on('message', (d) => s.got.push(JSON.parse(d.toString())));
});
await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

// ---- relay boot -----------------------------------------------------------------
const KEYS = {
  PHONE_VIA: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_FROM: '+15005550006',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_PROJECT_ID: 'proj_test',
  OPENAI_WEBHOOK_SECRET: WHSEC,
  PHONE_PUBLIC_URL: PUBLIC,
  TWILIO_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
};
function boot(extraEnv = {}, name = 'relay') {
  const p = spawn('node', ['server.js'], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      MC_TOKEN: TOKEN,
      PORT: String(PORT),
      PUSH_STORE: path.join(TMP, 'push.json'),
      REALTIME_STORE: path.join(TMP, 'rt.json'),
      TTS_STORE: path.join(TMP, 'tts.json'),
      PHONE_STORE: path.join(TMP, `phone-${name}.json`),
      RAILWAY_VOLUME_MOUNT_PATH: '',
      TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '', OPENAI_API_KEY: '', OPENAI_PROJECT_ID: '', OPENAI_WEBHOOK_SECRET: '',
      PHONE_QUIET: 'off',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.PHONE_TEST_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.PHONE_TEST_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
async function up() {
  return waitFor(async () => (await fetch(`${PUBLIC}/health`)).ok);
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode) return;
  await new Promise((r) => { p.once('exit', r); p.kill(); });
}

// ---- fake Mac host + panel ------------------------------------------------------
async function connectHost() {
  const host = { frames: [] };
  host.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=host&token=${TOKEN}`);
  await new Promise((r, j) => { host.ws.once('open', r); host.ws.once('error', j); });
  host.ws.on('message', (d) => host.frames.push(JSON.parse(d.toString())));
  host.ws.send(JSON.stringify({
    type: 'snapshot', caps: ['upload', 'tts'],
    mia: {
      online: true,
      tasks: [{ id: '0620', title: 'Deploy panel v6', status: 'running', updatedAt: '2026-11-09T10:00:00Z' }, { id: '0612', title: 'Panel v6', status: 'done', result: 'Shipped at /v6', updatedAt: '2026-11-08T10:00:00Z' }],
      pendingQuestions: [{ questionId: 'q_abc', taskId: '0620', text: 'Ship v6 as the default?', options: ['Yes', 'Not yet'] }],
      messages: [],
    },
  }));
  return host;
}
async function connectPanel() {
  const panel = { frames: [] };
  panel.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=viewer&token=${TOKEN}`);
  await new Promise((r, j) => { panel.ws.once('open', r); panel.ws.once('error', j); });
  panel.ws.on('message', (d) => panel.frames.push(JSON.parse(d.toString())));
  panel.ws.send(JSON.stringify({ type: 'viewerActive', visible: true }));
  return panel;
}

// ---- provider requests, signed like the real ones -------------------------------
function twilioSig(url, params, token = AUTH_TOKEN) {
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}
async function twilioHook(route, callId, params, { badSig = false } = {}) {
  const pathq = `/phone/twilio/${route}?call=${encodeURIComponent(callId)}`;
  const sig = twilioSig(PUBLIC + pathq, params, badSig ? 'wrong' : AUTH_TOKEN);
  const r = await fetch(PUBLIC + pathq, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}
function oaiSig(id, ts, body, secret = WHSEC) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}
async function openaiHook(event, { badSig = false, stale = false } = {}) {
  const body = JSON.stringify(event);
  const id = `wh_${crypto.randomBytes(6).toString('hex')}`;
  const ts = String(Math.floor(Date.now() / 1000) - (stale ? 3600 : 0));
  const sig = oaiSig(id, ts, body, badSig ? `whsec_${crypto.randomBytes(24).toString('base64')}` : WHSEC);
  const r = await fetch(`${PUBLIC}/phone/openai`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,AAAA ${sig}` }, body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const incoming = (callId, ours) => ({
  object: 'event', type: 'realtime.call.incoming',
  data: { call_id: callId, sip_headers: [{ name: 'From', value: 'sip:+15005550006@twilio' }, ...(ours ? [{ name: 'X-MC-Call', value: ours }] : [])] },
});
const api = (method, p, body, token = TOKEN) => fetch(PUBLIC + p, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const toolCall = (name, args = {}) => ({ type: 'response.done', response: { output: [{ type: 'function_call', name, call_id: `fc_${name}_${Date.now()}`, arguments: JSON.stringify(args) }], usage: { input_token_details: { audio_tokens: 300, text_tokens: 1200 }, output_token_details: { audio_tokens: 200, text_tokens: 20 } } } });
const spoke = { type: 'response.done', response: { output: [{ type: 'message' }], usage: { input_token_details: { audio_tokens: 100 }, output_token_details: { audio_tokens: 400 } } } };
const lastOutput = (s, name) => {
  const o = [...s.got].reverse().find((e) => e.type === 'conversation.item.create' && e.item?.type === 'function_call_output' && e.item.call_id.startsWith(`fc_${name}_`));
  return o ? JSON.parse(o.item.output) : null;
};

async function placeAndConnect(host, message = 'The relay is down', opts = {}) {
  const r = await api('POST', '/phone/call', { to: DANIEL, message, ...opts });
  const id = r.json.id;
  const tw = await twilioHook('answer', id, { CallSid: 'CAx', AnsweredBy: 'human', CallStatus: 'in-progress' });
  const oid = `rtc_${crypto.randomBytes(4).toString('hex')}`;
  const before = mock.sockets.length;
  const hook = await openaiHook(incoming(oid, id));
  await waitFor(() => mock.sockets.length > before && mock.sockets.at(-1).got.length > 0);
  return { r, id, tw, oid, hook, sock: mock.sockets.at(-1) };
}

try {
  // =================================================================== dark
  console.log('dark (no keys)');
  let relay = boot({}, 'dark');
  ok(await up(), 'relay boots without phone keys');
  const h = await (await fetch(`${PUBLIC}/health`)).json();
  ok(h.ok === true && h.phone && h.phone.configured === false, '/health: phone.configured is false');
  for (const [m, p] of [['GET', '/phone'], ['POST', '/phone/call'], ['POST', '/phone/say'], ['POST', '/phone/twilio/answer'], ['POST', '/phone/openai']]) {
    const r = await api(m, p, m === 'POST' ? { to: DANIEL, message: 'x' } : undefined);
    ok(r.status === 503 && r.json.configured === false && /not configured/.test(r.json.error) && r.json.missing.includes('OPENAI_API_KEY'), `${m} ${p} → 503 not configured`);
  }
  ok((await fetch(`${PUBLIC}/`)).status === 200 || (await fetch(`${PUBLIC}/`)).status === 404, '/ still answers (static panel untouched)');
  // CLI against the dark relay
  const miaDir = path.join(TMP, 'mia');
  fs.mkdirSync(miaDir, { recursive: true });
  fs.writeFileSync(path.join(miaDir, 'phone.txt'), `${DANIEL}\n`);
  const cliEnv = { ...process.env, MIA_DIR: miaDir, MC_RELAY_URL: PUBLIC, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' };
  let cli = spawnSync(MIA_CLI, ['call', 'Hello'], { env: cliEnv, encoding: 'utf8' });
  ok(cli.status === 1 && /not configured/.test(cli.stderr), 'mia call on a dark relay: clear "not configured", exit 1');
  cli = spawnSync(MIA_CLI, ['call-status'], { env: cliEnv, encoding: 'utf8' });
  ok(cli.status === 0 && /not configured/.test(cli.stdout), 'mia call-status: not configured');
  await stop(relay);

  // =================================================================== the call
  console.log('the call');
  relay = boot(KEYS, 'live');
  ok(await up(), 'relay boots with phone keys');
  ok((await (await fetch(`${PUBLIC}/health`)).json()).phone.configured === true, '/health: phone.configured is true');
  ok((await api('POST', '/phone/call', { to: DANIEL, message: 'x' }, 'nope')).status === 401, 'POST /phone/call without the token → 401');
  ok((await api('POST', '/phone/call', { to: DANIEL, message: 'x' })).status === 503, 'Mac offline → 503');
  const host = await connectHost();
  const panel = await connectPanel();
  await sleep(200);
  ok((await api('POST', '/phone/call', { to: '+15551234567', message: 'x' })).status === 400, 'a number that is not an SA mobile → 400');
  ok((await api('POST', '/phone/call', { to: DANIEL, message: '' })).status === 400, 'no message → 400');

  const call = await api('POST', '/phone/call', { to: DANIEL, message: 'The relay is down', reason: 'health check failed 3 times since 14:02', urgent: false });
  const id = call.json.id;
  ok(call.status === 200 && /^c_[0-9a-f]{10}$/.test(id || ''), `call placed → ${id}`);
  const tw = mock.twilio.at(-1);
  ok(tw && tw.path === '/2010-04-01/Accounts/ACtest/Calls.json', 'Twilio: Calls.json on the right account');
  ok(tw.auth === `Basic ${Buffer.from(`ACtest:${AUTH_TOKEN}`).toString('base64')}`, 'Twilio: basic auth with SID + auth token');
  ok(tw.params.To === DANIEL && tw.params.From === '+15005550006', 'Twilio: To = Daniel, From = TWILIO_FROM');
  ok(tw.params.Url === `${PUBLIC}/phone/twilio/answer?call=${id}` && tw.params.StatusCallback === `${PUBLIC}/phone/twilio/status?call=${id}`, 'Twilio: answer + status callbacks on the public URL');
  ok(tw.events.join(',') === 'initiated,ringing,answered,completed', 'Twilio: StatusCallbackEvent sent as repeated parameters (21626 otherwise)');
  ok(tw.params.MachineDetection === 'Enable' && Number(tw.params.TimeLimit) <= 330, 'Twilio: machine detection on, time limit ~5 min');
  ok((await api('POST', '/phone/call', { to: DANIEL, message: 'again' })).status === 409, 'a second call while one is live → 409');

  ok((await twilioHook('answer', id, { CallSid: 'CA1', AnsweredBy: 'human' }, { badSig: true })).status === 403, 'Twilio answer hook with a bad signature → 403');
  ok((await twilioHook('status', id, { CallSid: 'CA1', CallStatus: 'ringing' }, { badSig: true })).status === 403, 'Twilio status hook with a bad signature → 403');
  ok((await twilioHook('status', id, { CallSid: 'CA1', CallStatus: 'ringing' })).status === 204, 'Twilio status hook (ringing) → 204');
  const ans = await twilioHook('answer', id, { CallSid: 'CA1', AnsweredBy: 'human', CallStatus: 'in-progress' });
  ok(ans.status === 200 && ans.text.includes('<Sip>sip:proj_test@sip.api.openai.com;transport=tls?X-MC-Call=' + id + '</Sip>'), 'answered by a human → TwiML <Dial><Sip> to the OpenAI project with X-MC-Call');
  ok(/<Dial timeLimit="\d+"/.test(ans.text), 'TwiML: <Dial timeLimit> backstop');

  const oid = 'rtc_test1';
  ok((await openaiHook(incoming(oid, id), { badSig: true })).status === 403, 'OpenAI webhook with a bad signature → 403');
  ok((await openaiHook(incoming(oid, id), { stale: true })).status === 403, 'OpenAI webhook with a stale timestamp → 403');
  const hk = await openaiHook(incoming(oid, id));
  ok(hk.status === 200 && hk.json.ok === true, 'OpenAI webhook (signed) → accepted');
  const acc = mock.openai.find((r) => r.path === `/v1/realtime/calls/${oid}/accept`);
  ok(!!acc && acc.auth === 'Bearer sk-test', 'OpenAI: /accept called with the API key');
  ok(acc && acc.body.type === 'realtime' && acc.body.model === 'gpt-realtime-2.1-mini' && acc.body.audio.output.voice === 'marin', 'accept: realtime session, mini model, marin voice');
  ok(acc && /You are Mia/.test(acc.body.instructions) && acc.body.instructions.includes('The relay is down') && acc.body.instructions.includes('health check failed'), 'accept: Mia persona + the reason and background');
  ok(acc && ['send_to_mia', 'get_status', 'answer_question', 'show_on_panel', 'end_call'].every((n) => acc.body.tools.some((t) => t.name === n)), 'accept: the five tools');
  ok(await waitFor(() => mock.sockets.some((s) => s.callId === oid)), 'sideband socket opened for the call');
  const sock = mock.sockets.find((s) => s.callId === oid);
  ok(sock.auth === 'Bearer sk-test', 'sideband: API key auth');
  ok(await waitFor(() => sock.got.some((e) => e.type === 'response.create')), 'she speaks first (response.create on open)');
  sock.ws.send(JSON.stringify(spoke));
  await sleep(100);

  // 0633 guards: before Daniel says anything, and her own words, never reach Mia
  let n0 = host.frames.length;
  sock.ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: "Hi Daniel, it's Mia. The relay is down. Can you hear me?" }));
  sock.ws.send(JSON.stringify(toolCall('send_to_mia', { text: "Hi Daniel, it's Mia. The relay is down." })));
  ok(await waitFor(() => lastOutput(sock, 'send_to_mia')?.ok === false), 'send_to_mia before Daniel spoke → refused');
  sock.ws.send(JSON.stringify(spoke));
  sock.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  sock.ws.send(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'message', content: [{ type: 'output_audio', transcript: 'Daniel, if you can hear me, just say yes.' }] }] } }));
  await sleep(50);
  sock.ws.send(JSON.stringify(toolCall('send_to_mia', { text: 'Daniel, if you can hear me, just say yes.' })));
  ok(await waitFor(() => /YOU just said/.test(lastOutput(sock, 'send_to_mia')?.error || '')), "send_to_mia with Mia's own line → refused");
  sock.ws.send(JSON.stringify(spoke));
  await sleep(50);
  ok(!host.frames.slice(n0).some((f) => f.type === 'miaSend'), '… and nothing reached the Mac');
  // send_to_mia
  n0 = host.frames.length;
  sock.ws.send(JSON.stringify(toolCall('send_to_mia', { text: 'Daniel: Restart the relay and tell me when it is back' })));
  ok(await waitFor(() => host.frames.slice(n0).some((f) => f.type === 'miaSend')), 'send_to_mia → a miaSend on the Mac');
  const sent = host.frames.slice(n0).find((f) => f.type === 'miaSend');
  ok(sent.text.startsWith('(phone) Restart the relay') && sent.text.includes(`mia call-say ${id}`), 'the message starts "(phone) …" and says how to answer');
  ok(await waitFor(() => lastOutput(sock, 'send_to_mia')?.ok === true), 'send_to_mia: tool output ok');
  ok(sock.got.filter((e) => e.type === 'response.create').length >= 2, 'a response follows the tool output');
  sock.ws.send(JSON.stringify(spoke));
  n0 = host.frames.length;
  sock.ws.send(JSON.stringify(toolCall('send_to_mia', { text: 'Restart the relay and tell me when it is back' })));
  ok(await waitFor(() => /Already started/.test(lastOutput(sock, 'send_to_mia')?.status || '')), 'the same request twice → sent once');
  sock.ws.send(JSON.stringify(spoke));
  await sleep(50);
  ok(!host.frames.slice(n0).some((f) => f.type === 'miaSend'), '… no second miaSend');
  // get_status
  sock.ws.send(JSON.stringify(toolCall('get_status')));
  ok(await waitFor(() => lastOutput(sock, 'get_status')), 'get_status answered');
  const st = lastOutput(sock, 'get_status');
  ok(st.ok && st.active[0].id === '0620' && st.recentlyFinished[0].id === '0612' && st.openQuestions[0].id === 'q_abc', 'get_status: active task, finished task, open question from the snapshot');
  sock.ws.send(JSON.stringify(spoke));
  // answer_question
  n0 = host.frames.length;
  sock.ws.send(JSON.stringify(toolCall('answer_question', { id: 'q_abc', option: 'Not yet' })));
  ok(await waitFor(() => host.frames.slice(n0).some((f) => f.type === 'miaAnswer' && f.questionId === 'q_abc' && f.text === '(phone) Not yet')), 'answer_question → miaAnswer "(phone) Not yet"');
  sock.ws.send(JSON.stringify(spoke));
  // show_on_panel
  sock.ws.send(JSON.stringify(toolCall('show_on_panel', { what: 'relay-incident-report.md' })));
  ok(await waitFor(() => panel.frames.some((f) => f.type === 'panel' && f.action === 'show-doc' && f.arg === 'relay-incident-report.md')), 'show_on_panel(doc) → show-doc on the panel during the call');
  sock.ws.send(JSON.stringify(spoke));
  sock.ws.send(JSON.stringify(toolCall('show_on_panel', { what: 'https://status.example.com/' })));
  ok(await waitFor(() => panel.frames.some((f) => f.type === 'panel' && f.action === 'show-url')), 'show_on_panel(https) → show-url');
  sock.ws.send(JSON.stringify(spoke));
  await sleep(150);

  // mia call-say (CLI) → Result spoken
  cli = spawnSync(MIA_CLI, ['call-say', id, 'The relay is back up, it was the disk.'], { env: cliEnv, encoding: 'utf8' });
  ok(cli.status === 0 && cli.stdout.includes(id), 'mia call-say → ok');
  ok(await waitFor(() => sock.got.some((e) => e.type === 'conversation.item.create' && e.item?.role === 'system' && e.item.content[0].text === 'Result: The relay is back up, it was the disk.')), 'call-say → "Result: …" item in the live call');
  ok(sock.got.at(-1).type === 'response.create', '… followed by response.create (spoken now)');
  // queued while she is talking
  sock.ws.send(JSON.stringify({ type: 'response.created' }));
  await sleep(50);
  const q = await api('POST', '/phone/say', { id, text: 'Also: 0620 finished.' });
  ok(q.status === 200 && q.json.status === 'queued', 'call-say while she is speaking → queued');
  sock.ws.send(JSON.stringify(spoke));
  ok(await waitFor(() => sock.got.some((e) => e.item?.content?.[0]?.text === 'Result: Also: 0620 finished.')), '… and spoken once her reply is done');
  ok((await api('POST', '/phone/say', { id: 'c_nope', text: 'x' })).status === 404, 'call-say to an unknown call → 404');
  sock.ws.send(JSON.stringify(spoke));

  // status while live
  cli = spawnSync(MIA_CLI, ['call-status'], { env: cliEnv, encoding: 'utf8' });
  ok(cli.status === 0 && cli.stdout.includes(`live: ${id}`), 'mia call-status shows the live call');
  const health = await (await fetch(`${PUBLIC}/health`)).json();
  ok(health.phone.live.includes(id) && health.phone.log.some((c) => c.id === id && c.status === 'connected'), '/health call log: the live call');
  ok(!JSON.stringify(health.phone).includes('27835615106') && !JSON.stringify(health.phone).includes('relay is down'), '/health never shows the number or the message');

  // end_call
  n0 = host.frames.length;
  sock.ws.send(JSON.stringify(toolCall('end_call')));
  ok(await waitFor(() => mock.openai.some((r) => r.path === `/v1/realtime/calls/${oid}/hangup`), 6000), 'end_call → OpenAI hangup');
  ok(mock.twilio.some((r) => r.path === '/2010-04-01/Accounts/ACtest/Calls/CA1.json' && r.params.Status === 'completed'), 'end_call → Twilio call completed');
  ok(await waitFor(() => host.frames.slice(n0).some((f) => f.type === 'miaSend' && f.text.startsWith(`(phone) [call ${id} ended`))), 'Mia is told the call ended');
  const log1 = await api('GET', '/phone');
  const done = log1.json.calls.find((c) => c.id === id);
  ok(done && done.status === 'completed' && done.usd > 0 && log1.json.live.length === 0, 'GET /phone: completed, cost tallied, nothing live');
  ok((await api('POST', '/phone/say', { id, text: 'late' })).status === 404, 'call-say after the call ended → 404');

  // an unknown SIP call
  const rej = await openaiHook(incoming('rtc_stranger', null));
  ok(rej.status === 200 && rej.json.rejected === true && await waitFor(() => mock.openai.some((r) => r.path === '/v1/realtime/calls/rtc_stranger/reject')), 'a SIP call we did not place → rejected');

  // voicemail
  const vm = await api('POST', '/phone/call', { to: DANIEL, message: 'voicemail test' });
  const vmAns = await twilioHook('answer', vm.json.id, { CallSid: 'CA9', AnsweredBy: 'machine_start' });
  ok(vmAns.text.includes('<Hangup/>') && !vmAns.text.includes('<Sip>'), 'answered by voicemail → <Hangup/>, no OpenAI leg');
  ok((await api('GET', '/phone')).json.calls.find((c) => c.id === vm.json.id).status === 'voicemail', 'logged as voicemail');

  // no-answer via status callback
  const na = await api('POST', '/phone/call', { to: DANIEL, message: 'no answer test' });
  await twilioHook('status', na.json.id, { CallSid: 'CA10', CallStatus: 'no-answer' });
  ok((await api('GET', '/phone')).json.calls.find((c) => c.id === na.json.id).status === 'no-answer', 'Twilio no-answer → logged, call freed');

  // Twilio refuses (geo permission off) → 502, not counted
  mock.twilioFail = true;
  const tf = await api('POST', '/phone/call', { to: DANIEL, message: 'geo test' });
  mock.twilioFail = false;
  ok(tf.status === 502 && /Geo permission/.test(tf.json.error), 'Twilio refuses → 502 with its reason');

  // rate limit: 3 placed so far (the refused one doesn't count) → two more ok, the next refused
  const r4 = await api('POST', '/phone/call', { to: DANIEL, message: 'fourth' });
  await twilioHook('status', r4.json.id, { CallSid: 'CA11', CallStatus: 'busy' });
  const r5 = await api('POST', '/phone/call', { to: DANIEL, message: 'fifth' });
  await twilioHook('status', r5.json.id, { CallSid: 'CA12', CallStatus: 'busy' });
  const r6 = await api('POST', '/phone/call', { to: DANIEL, message: 'sixth' });
  ok(r4.status === 200 && r5.status === 200 && r6.status === 429 && /5 calls an hour/.test(r6.json.error), 'rate limit: 5 an hour (6th → 429; a call Twilio refused is not counted)');
  cli = spawnSync(MIA_CLI, ['call', 'seventh'], { env: cliEnv, encoding: 'utf8' });
  ok(cli.status === 3 && /an hour/.test(cli.stderr), 'mia call refused by a guard → exit 3 with the reason');
  host.ws.close();
  panel.ws.close();
  await stop(relay);

  // =================================================================== daily limit (seeded log)
  console.log('limits');
  const t = Date.now();
  const seeded = { calls: Array.from({ length: 20 }, (_, i) => ({ id: `c_old${i}`, at: t - 2 * 3600e3 - i * 60e3, to: DANIEL, message: 'old', status: 'completed', placed: true })) };
  fs.writeFileSync(path.join(TMP, 'phone-day.json'), JSON.stringify(seeded));
  relay = boot(KEYS, 'day');
  await up();
  let h2 = await connectHost();
  const d = await api('POST', '/phone/call', { to: DANIEL, message: 'x', urgent: true });
  ok(d.status === 429 && /20 calls a day/.test(d.json.error), 'rate limit: 20 a day (urgent too)');
  h2.ws.close();
  await stop(relay);

  // quiet hours: a window around now in SA time
  const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  relay = boot({ ...KEYS, PHONE_QUIET: `${hr}-${(hr + 1) % 24}` }, 'quiet');
  await up();
  h2 = await connectHost();
  const qn = await api('POST', '/phone/call', { to: DANIEL, message: 'not urgent' });
  ok(qn.status === 409 && qn.json.quiet === true && /Quiet hours/.test(qn.json.error), 'quiet hours: a normal call → 409');
  const qu = await api('POST', '/phone/call', { to: DANIEL, message: 'urgent', urgent: true });
  ok(qu.status === 200, 'quiet hours: an urgent call goes through');
  await twilioHook('status', qu.json.id, { CallSid: 'CA20', CallStatus: 'completed' });
  cli = await runAsync(MIA_CLI, ['call', 'urgent via cli', '--urgent', '--reason', 'site down'], cliEnv); // async: the mock Twilio lives in this process
  if (cli.status !== 0) console.log('cli:', cli.status, cli.stdout, cli.stderr);
  ok(cli.status === 0 && /^c_[0-9a-f]{10}$/.test(cli.stdout.trim()), 'mia call --urgent in quiet hours → call id (number from phone.txt)');
  ok(mock.twilio.at(-1).params.To === DANIEL, 'the CLI used phone.txt');
  h2.ws.close();
  await stop(relay);

  // =================================================================== Media Streams bridge (no SIP keys)
  console.log('media streams bridge');
  const { OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET, ...STREAM_KEYS } = KEYS;
  relay = boot(STREAM_KEYS, 'stream');
  await up();
  h2 = await connectHost();
  ok((await (await fetch(`${PUBLIC}/health`)).json()).phone.limits.bridge === 'stream', 'without the SIP keys the bridge is Media Streams');
  ok((await openaiHook(incoming('rtc_x', 'c_x'))).status === 503, 'the OpenAI SIP webhook is off in stream mode');
  const sc = await api('POST', '/phone/call', { to: DANIEL, message: 'Stream test call' });
  const sa = await twilioHook('answer', sc.json.id, { CallSid: 'CA30', AnsweredBy: 'human' });
  const wsUrl = `ws://127.0.0.1:${PORT}/phone/stream`;
  ok(sa.text.includes(`<Connect><Stream url="${wsUrl}">`) && sa.text.includes(`<Parameter name="call" value="${sc.json.id}"/>`), 'answer → <Connect><Stream> to /phone/stream with the call id');
  const key = /name="key" value="([0-9a-f]+)"/.exec(sa.text)?.[1];
  ok(!!key, '… and a per-call key');
  const twStart = (k) => ({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA30', customParameters: { call: sc.json.id, key: k } } });
  // a wrong key is dropped
  const bad = new WebSocket(wsUrl);
  await new Promise((r) => bad.once('open', r));
  const sockets0 = mock.sockets.length;
  bad.send(JSON.stringify({ event: 'connected' }));
  bad.send(JSON.stringify(twStart('0'.repeat(32))));
  ok(await waitFor(() => bad.readyState === WebSocket.CLOSED), 'a media stream with the wrong key is closed');
  ok(mock.sockets.length === sockets0, '… and no voice session is opened for it');
  // the real one
  const twl = { got: [] };
  twl.ws = new WebSocket(wsUrl);
  await new Promise((r) => twl.ws.once('open', r));
  twl.ws.on('message', (d) => twl.got.push(JSON.parse(d.toString())));
  twl.ws.send(JSON.stringify({ event: 'connected' }));
  twl.ws.send(JSON.stringify(twStart(key)));
  ok(await waitFor(() => mock.sockets.length > sockets0 && mock.sockets.at(-1).got.length >= 2), 'media stream accepted → a Realtime session at OpenAI');
  const rs = mock.sockets.at(-1);
  ok(rs.model === 'gpt-realtime-2.1-mini' && rs.auth === 'Bearer sk-test', 'Realtime WS: mini model, API key');
  const su = rs.got.find((e) => e.type === 'session.update');
  ok(su && su.session.audio.input.format.type === 'audio/pcmu' && su.session.audio.output.format.type === 'audio/pcmu', 'session.update: μ-law in and out (phone audio, no transcoding)');
  ok(su && su.session.instructions.includes('Stream test call') && su.session.tools.length === 5, 'session.update: persona, reason, tools');
  ok(rs.got.some((e) => e.type === 'response.create'), 'she speaks first');
  twl.ws.send(JSON.stringify({ event: 'media', media: { payload: 'f/9/fw==' } }));
  ok(await waitFor(() => rs.got.some((e) => e.type === 'input_audio_buffer.append' && e.audio === 'f/9/fw==')), "Daniel's audio → input_audio_buffer.append");
  rs.ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAEC' }));
  ok(await waitFor(() => twl.got.some((m) => m.event === 'media' && m.streamSid === 'MZ1' && m.media.payload === 'AAEC')), "Mia's audio → Twilio media");
  rs.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  ok(await waitFor(() => twl.got.some((m) => m.event === 'clear')), 'he talks over her → clear (barge-in)');
  rs.ws.send(JSON.stringify(spoke));
  rs.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  const n1 = h2.frames.length;
  rs.ws.send(JSON.stringify(toolCall('send_to_mia', { text: 'Check the logs' })));
  ok(await waitFor(() => h2.frames.slice(n1).some((f) => f.type === 'miaSend' && f.text.startsWith('(phone) Check the logs'))), 'tools work on the stream bridge too');
  rs.ws.send(JSON.stringify(spoke));
  const say2 = await api('POST', '/phone/say', { id: sc.json.id, text: 'Logs are clean.' });
  ok(say2.status === 200 && await waitFor(() => rs.got.some((e) => e.item?.content?.[0]?.text === 'Result: Logs are clean.')), 'call-say on the stream bridge');
  twl.ws.send(JSON.stringify({ event: 'stop' }));
  ok(await waitFor(async () => (await api('GET', '/phone')).json.calls.find((c) => c.id === sc.json.id)?.status === 'completed'), 'Twilio stops the stream → call completed');
  ok(await waitFor(() => rs.ws.readyState === WebSocket.CLOSED), '… and the Realtime session is closed');
  h2.ws.close();
  await stop(relay);

  // =================================================================== FaceTime (the Mac streams the call; no Twilio keys)
  console.log('facetime');
  relay = boot({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` }, 'facetime');
  await up();
  h2 = await connectHost();
  const fh = (await (await fetch(`${PUBLIC}/health`)).json()).phone;
  ok(fh.configured === true && fh.limits.via === 'facetime' && fh.limits.twilio === false, 'OpenAI key only: configured, FaceTime by default, Twilio off');
  ok((await twilioHook('answer', 'c_x', { CallSid: 'CA1' })).status === 503, 'Twilio hooks answer 503 while Twilio is off');
  ok((await api('POST', '/phone/call', { to: DANIEL, message: 'x', via: 'twilio' })).status === 503, 'via twilio without its keys → 503 not configured');
  const twBefore = mock.twilio.length;
  const fc = await api('POST', '/phone/call', { to: DANIEL, message: 'FaceTime test call' });
  ok(fc.status === 200 && fc.json.via === 'facetime' && /^[0-9a-f]{32}$/.test(fc.json.key || '') && fc.json.stream === '/phone/stream', 'POST /phone/call → id + stream key for the Mac');
  ok(mock.twilio.length === twBefore, 'no Twilio request for a FaceTime call');
  const ft = { got: [] };
  ft.ws = new WebSocket(`ws://127.0.0.1:${PORT}/phone/stream`);
  await new Promise((r) => ft.ws.once('open', r));
  ft.ws.on('message', (d) => ft.got.push(JSON.parse(d.toString())));
  const s0 = mock.sockets.length;
  ft.ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'ft1', customParameters: { call: fc.json.id, key: fc.json.key, format: 'pcm16', wait: '1' } } }));
  ok(await waitFor(async () => (await api('GET', '/phone')).json.calls.find((c) => c.id === fc.json.id)?.status === 'ringing'), 'stream start (wait) → ringing');
  await sleep(300);
  ok(mock.sockets.length === s0, 'no voice session while it rings (nothing billed)');
  ft.ws.send(JSON.stringify({ event: 'answered' }));
  ok(await waitFor(() => mock.sockets.length > s0 && mock.sockets.at(-1).got.some((e) => e.type === 'session.update')), 'answered → Realtime session');
  const fs1 = mock.sockets.at(-1);
  const fsu = fs1.got.find((e) => e.type === 'session.update');
  ok(fsu.session.audio.input.format.type === 'audio/pcm' && fsu.session.audio.input.format.rate === 24000 && fsu.session.audio.output.format.rate === 24000, 'FaceTime audio: 24 kHz PCM16 both ways');
  ok(fsu.session.instructions.includes('FaceTime test call'), '… with the reason for the call');
  ft.ws.send(JSON.stringify({ event: 'media', media: { payload: 'AAAAAA==' } }));
  ok(await waitFor(() => fs1.got.some((e) => e.type === 'input_audio_buffer.append' && e.audio === 'AAAAAA==')), 'Mac audio → Realtime');
  fs1.ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: 'AQID' }));
  ok(await waitFor(() => ft.got.some((m) => m.event === 'media' && m.media.payload === 'AQID')), 'Realtime audio → the Mac');
  fs1.ws.send(JSON.stringify(spoke));
  fs1.ws.send(JSON.stringify(toolCall('end_call')));
  ok(await waitFor(() => ft.got.some((m) => m.event === 'hangup'), 6000), 'end_call → the Mac is told to hang up FaceTime');
  ok(await waitFor(async () => (await api('GET', '/phone')).json.calls.find((c) => c.id === fc.json.id)?.status === 'completed'), 'logged completed');
  // no answer
  const fn = await api('POST', '/phone/call', { to: DANIEL, message: 'nobody home' });
  const ft2 = new WebSocket(`ws://127.0.0.1:${PORT}/phone/stream`);
  await new Promise((r) => ft2.once('open', r));
  ft2.send(JSON.stringify({ event: 'start', start: { streamSid: 'ft2', customParameters: { call: fn.json.id, key: fn.json.key, format: 'pcm16', wait: '1' } } }));
  await sleep(200);
  ft2.send(JSON.stringify({ event: 'stop', stop: { reason: 'no-answer', detail: 'rang 45 s' } }));
  ok(await waitFor(async () => (await api('GET', '/phone')).json.calls.find((c) => c.id === fn.json.id)?.status === 'no-answer'), 'the Mac reports no-answer → logged no-answer');
  // task 0629: the OpenAI org has no credits → the Realtime socket errors right after the answer
  const fq = await api('POST', '/phone/call', { to: DANIEL, message: 'quota call' });
  ok(fq.status === 200, 'voice probe passes → call placed');
  const ft3 = { got: [] };
  ft3.ws = new WebSocket(`ws://127.0.0.1:${PORT}/phone/stream`);
  await new Promise((r) => ft3.ws.once('open', r));
  ft3.ws.on('message', (d) => ft3.got.push(JSON.parse(d.toString())));
  const s3 = mock.sockets.length;
  ft3.ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'ft3', customParameters: { call: fq.json.id, key: fq.json.key, format: 'pcm16', wait: '1' } } }));
  await sleep(200);
  const nq = h2.frames.length;
  ft3.ws.send(JSON.stringify({ event: 'answered' }));
  ok(await waitFor(() => mock.sockets.length > s3 && mock.sockets.at(-1).got.some((e) => e.type === 'session.update')), 'answered → Realtime session');
  mock.sockets.at(-1).ws.send(JSON.stringify({ type: 'error', error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You have no credits remaining. Add credits to continue using the API' } }));
  ok(await waitFor(() => ft3.got.some((m) => m.event === 'hangup' && /credits/.test(m.reason))), 'quota error → the Mac is told to hang up (voice out of credits)');
  const fql = await waitFor(async () => { const c = (await api('GET', '/phone')).json.calls.find((x) => x.id === fq.json.id); return c?.status === 'failed' && /credits/.test(c.why); });
  ok(fql, 'logged failed (voice provider out of credits)');
  ok(await waitFor(() => h2.frames.slice(nq).some((f) => f.type === 'miaSend' && /could not talk.*no credits/.test(f.text))), 'Mia is told the voice has no credits');
  const fq2 = await api('POST', '/phone/call', { to: DANIEL, message: 'again' });
  ok(fq2.status === 503 && fq2.json.voice === false && /credits/.test(fq2.json.error), 'next call refused before dialling (voice out of credits)');
  ok((await (await fetch(`${PUBLIC}/health`)).json()).phone.voice?.ok === false, '/health shows voice ok:false');
  h2.ws.close();
  await stop(relay);

  // =================================================================== voice probe (task 0629)
  console.log('voice probe');
  mock.noCredits = true;
  const p0 = mock.probes || 0;
  relay = boot({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` }, 'probe');
  await up();
  h2 = await connectHost();
  const pr = await api('POST', '/phone/call', { to: DANIEL, message: 'probe' });
  ok(pr.status === 503 && pr.json.voice === false && /credit_balance_exhausted/.test(pr.json.error), 'no credits → POST /phone/call 503 before dialling');
  ok((mock.probes || 0) > p0, 'probed with a near-free embedding');
  ok(!(await api('GET', '/phone')).json.calls.some((c) => c.message === 'probe'), 'no call logged (nothing rang)');
  mock.noCredits = false;
  h2.ws.close();
  await stop(relay);

  // =================================================================== the time cap
  console.log('time cap');
  relay = boot({ ...KEYS, PHONE_MAX_SECONDS: '6' }, 'cap');
  await up();
  h2 = await connectHost();
  const cap = await placeAndConnect(h2, 'cap test');
  ok(cap.hook.json.ok === true, 'call connected');
  cap.sock.ws.send(JSON.stringify(spoke));
  ok(await waitFor(() => cap.sock.got.some((e) => e.item?.content?.[0]?.text?.includes('time limit')), 6000), 'near the cap: told to say goodbye');
  ok(await waitFor(() => mock.openai.some((r) => r.path === `/v1/realtime/calls/${cap.oid}/hangup`), 6000), 'at the cap: hung up');
  const capLog = (await api('GET', '/phone')).json.calls.find((c) => c.id === cap.id);
  ok(capLog.status === 'completed' && capLog.why === 'time limit', 'logged: completed (time limit)');
  h2.ws.close();
  await stop(relay);
} catch (e) {
  failed += 1;
  console.error('test crashed:', e);
} finally {
  for (const p of procs) await stop(p);
  mockWss.close();
  mockServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
