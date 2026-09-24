// Realtime talk mode, end to end in a browser — with OpenAI mocked.
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/realtime-e2e.mjs
//
// Boots the real relay (with a fake OPENAI_API_KEY pointed at a local mock of
// OpenAI's client_secrets + /realtime/calls endpoints) and the fake host, then
// drives the built panel in headless Chromium. The mic is a stub oscillator
// stream and RTCPeerConnection is a scripted fake whose "oai-events" data
// channel lets the test play the part of the realtime model: server events in,
// client events (tool outputs, Mia's injected replies) recorded.
//
// Covers: Talk tap → mint → SDP POST with the ephemeral secret; the live
// indicator; send_to_mia → the fake Mia's reply injected back as a "Result:";
// get_status; answer_question; end_session → standby + usage on the relay;
// the idle auto-end; ending on app background; fallback to Basic when the
// relay can't mint; the Settings voice section. Plus the iPad Home Screen
// bottom-gap fix in portrait and landscape.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8899;
const OPENAI_PORT = 8896;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rt-'));

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};
const procs = [];
function boot(args, name, env = {}) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}

// ---- mock OpenAI ---------------------------------------------------------------
const calls = [];
const mock = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
    if (req.url === '/v1/realtime/client_secrets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ value: `ek_mock_${calls.length}`, expires_at: 0 }));
    }
    if (req.url === '/v1/realtime/calls') {
      res.writeHead(201, { ...cors, 'content-type': 'application/sdp' });
      return res.end('v=0\r\nfake-answer\r\n');
    }
    res.writeHead(404, cors);
    res.end();
  });
});

// ---- in-page fakes ---------------------------------------------------------------
const INIT = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const d = ctx.createMediaStreamDestination();
    o.connect(d);
    o.start();
    window.__mics = (window.__mics || 0) + 1;
    return d.stream;
  };
  const rt = (window.__rt = { sent: [], dcs: 0, emit(ev) { this.dc.onmessage({ data: JSON.stringify(ev) }); } });
  class FakeDC {
    constructor() { this.readyState = 'connecting'; rt.dc = this; rt.dcs += 1; }
    send(s) { rt.sent.push(JSON.parse(s)); }
    close() { this.readyState = 'closed'; rt.closed = (rt.closed || 0) + 1; }
  }
  class FakePC {
    constructor() { this.connectionState = 'new'; this.s = []; rt.pc = this; }
    addTrack(t) { this.s.push({ track: t }); rt.tracks = (rt.tracks || 0) + 1; }
    getSenders() { return this.s; }
    removeTrack() {}
    createDataChannel(name) { rt.channel = name; return new FakeDC(); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription(d) {
      rt.answer = d.sdp;
      setTimeout(() => {
        rt.dc.readyState = 'open';
        rt.dc.onopen && rt.dc.onopen();
        this.connectionState = 'connected';
        this.onconnectionstatechange && this.onconnectionstatechange();
      }, 30);
    }
    close() { this.connectionState = 'closed'; }
  }
  window.RTCPeerConnection = FakePC;
};

async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

async function main() {
  await new Promise((r) => mock.listen(OPENAI_PORT, r));
  boot(['server.js'], 'relay', { OPENAI_API_KEY: 'sk-e2e-fake', OPENAI_BASE_URL: `http://localhost:${OPENAI_PORT}` });
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const rt = () => page.evaluate(() => ({ sent: window.__rt.sent, answer: window.__rt.answer, closed: window.__rt.closed || 0, dcs: window.__rt.dcs, channel: window.__rt.channel, tracks: window.__rt.tracks || 0 }));
  const emit = (ev) => page.evaluate((e) => window.__rt.emit(e), ev);
  const phase = () => page.getAttribute('[data-talk]', 'data-talk').catch(() => null);

  await page.goto(`${BASE}/?token=${TOKEN}`);
  await page.getByRole('button', { name: /^Mia/ }).first().click();
  await page.getByRole('button', { name: 'Talk', exact: true }).click();

  console.log('connect');
  await until(async () => (await phase()) === 'listening', 8000, 'listening');
  ok(await page.getAttribute('[data-talk]', 'data-engine') === 'realtime', 'Talk opens the realtime engine by default');
  const mint = calls.find((c) => c.url === '/v1/realtime/client_secrets');
  ok(mint && mint.auth === 'Bearer sk-e2e-fake', 'relay minted the session with its own key');
  const sdp = calls.find((c) => c.url === '/v1/realtime/calls');
  ok(sdp && /^Bearer ek_mock_/.test(sdp.auth) && sdp.type === 'application/sdp' && sdp.body.includes('fake-offer'), 'panel POSTs its SDP offer to OpenAI with the ephemeral secret');
  let s = await rt();
  ok(s.answer.includes('fake-answer') && s.channel === 'oai-events' && s.tracks === 1, 'answer applied, oai-events channel, mic track added');
  ok(await page.locator('[data-rt-live]').isVisible(), 'the "Realtime on" indicator shows while the call is live');
  ok((await page.evaluate(() => window.__mics)) === 1, 'one getUserMedia for the whole flow (primed in the tap)');

  console.log('send_to_mia → Mia replies → read back');
  await emit({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  ok((await phase()) === 'hearing', 'speech_started → hearing');
  await emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  await emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Remind me to call Sam at three.' });
  await emit({ type: 'response.created' });
  await emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'send_to_mia', call_id: 'c1', arguments: JSON.stringify({ text: 'Remind me to call Sam at 3' }) }], usage: { input_token_details: { audio_tokens: 50, text_tokens: 900, cached_tokens: 0 }, output_token_details: { audio_tokens: 0, text_tokens: 20 } } } });
  s = await rt();
  const out1 = s.sent.find((e) => e.type === 'conversation.item.create' && e.item.call_id === 'c1');
  ok(out1 && JSON.parse(out1.item.output).ok === true, 'send_to_mia returns ok to the model');
  ok(s.sent.some((e) => e.type === 'response.create'), 'and asks for the follow-up response');
  await page.getByText('Remind me to call Sam at three.').waitFor();
  ok(await page.getByText('Working on: Remind me to call Sam at 3').isVisible(), 'transcript shows what Daniel said and what went to Mia');
  // The model's short confirmation plays, then finishes.
  await emit({ type: 'response.created' });
  await emit({ type: 'output_audio_buffer.started' });
  ok((await phase()) === 'speaking', 'output audio → speaking');
  await emit({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'On it.' });
  await emit({ type: 'response.done', response: { output: [{ type: 'message' }] } });
  await emit({ type: 'output_audio_buffer.stopped' });
  // The fake host's Mia answers "(voice)" messages after ~1.2 s.
  const inj = await until(async () => (await rt()).sent.find((e) => e.type === 'conversation.item.create' && e.item.role === 'system' && /^Result: Got it\. You said: Remind me to call Sam at 3/.test(e.item.content[0].text)), 6000, 'inject');
  ok(!!inj, 'Mia\'s reply is fed into the call as a "Result:" system item');
  s = await rt();
  ok(s.sent[s.sent.length - 1].type === 'response.create', '…followed by response.create so the voice reads it out');

  const said = JSON.stringify((await rt()).sent);
  ok(!/Mia says|pass(ing)? (it|that) on|hand(ing|ed)? (it |this )?(off|over)|ask(ing)? Mia|other agent/i.test(said), 'nothing the voice is fed mentions a hand-off (one assistant)');

  console.log('get_status / answer_question');
  await emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'get_status', call_id: 'c2', arguments: '{}' }] } });
  s = await rt();
  const st = JSON.parse(s.sent.find((e) => e.item?.call_id === 'c2').item.output);
  ok(st.ok && Array.isArray(st.active) && st.openQuestions.some((q) => q.id === 'q_seed1' && q.options.includes('Whole app')), 'get_status returns tasks and open questions from the snapshot');
  await emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'answer_question', call_id: 'c3', arguments: JSON.stringify({ id: 'q_seed1', option: 'whole app' }) }] } });
  s = await rt();
  const ans = JSON.parse(s.sent.find((e) => e.item?.call_id === 'c3').item.output);
  ok(ans.ok && ans.answered === 'Whole app', 'answer_question maps "whole app" onto the option and answers it');
  await until(async () => {
    const snap = await (await fetch(`${BASE}/api/v1/mia`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    return JSON.stringify(snap).includes('(voice) Whole app');
  }, 5000, 'answer on host').then(() => ok(true, 'the answer reached Mia on the (fake) Mac')).catch(() => ok(false, 'the answer reached Mia on the (fake) Mac'));
  const bad = await (async () => {
    await emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'answer_question', call_id: 'c4', arguments: JSON.stringify({ id: 'q_nope', option: 'x' }) }] } });
    return JSON.parse((await rt()).sent.find((e) => e.item?.call_id === 'c4').item.output);
  })();
  ok(bad.ok === false, 'an unknown question id is refused, not guessed');

  console.log('end_session');
  await emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'end_session', call_id: 'c5', arguments: '{}' }] } });
  await until(async () => (await phase()) === 'standby', 4000, 'standby');
  ok(true, 'end_session → standby');
  ok(await until(async () => !(await page.locator('[data-rt-live]').count()), 2000, 'pill').catch(() => false), 'the live indicator goes away');
  ok((await rt()).closed >= 1, 'the data channel is closed');
  await sleep(800);
  const info = await (await fetch(`${BASE}/realtime`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(info.today.sessions === 1 && info.today.usd > 0, `usage reached the relay (${info.today.minutes} min, $${info.today.usd})`);

  console.log('idle auto-end + background');
  // Short limits for the test: rewrite the session's limits on the way in.
  await page.route('**/realtime/session', async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.limits = { ...j.limits, idleSeconds: 2 };
    await route.fulfill({ response: r, json: j });
  });
  await page.locator('[data-phase]').click(); // orb: tap to talk again
  await until(async () => (await phase()) === 'listening', 6000, 'relisten');
  ok((await page.evaluate(() => window.__mics)) === 2, 'restart from standby opens the mic from the tap');
  await until(async () => (await phase()) === 'standby', 6000, 'idle end');
  ok(await until(async () => /quiet/.test(await page.locator('[data-talk]').innerText()), 2000, 'quiet').catch(() => false), 'the call ends by itself after the quiet limit');
  await page.unroute('**/realtime/session');
  await page.locator('[data-phase]').click();
  await until(async () => (await phase()) === 'listening', 6000, 'relisten 2');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await until(async () => (await phase()) === 'standby', 3000, 'background end');
  ok(true, 'the call ends when the app goes to the background');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  console.log('fallback to basic');
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await page.route('**/realtime/session', (route) => route.fulfill({ status: 503, json: { ok: false, error: 'OPENAI_API_KEY is not set on the relay' } }));
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  await until(async () => ['listening', 'error'].includes(await phase()) && !(await page.getAttribute('[data-talk]', 'data-engine')), 6000, 'basic');
  ok((await phase()) === 'listening', 'no key → the basic voice takes over and listens');
  ok(/Realtime voice unavailable \(no OpenAI key on the relay\)/.test(await page.locator('[data-talk]').innerText()), 'and says why');
  ok((await page.evaluate(() => window.__mics)) === 4, 'the basic voice adopts the mic the tap opened (no second prompt)');
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await page.unroute('**/realtime/session');

  console.log('settings');
  await page.getByRole('button', { name: /settings/i }).first().click();
  await page.getByText('Talk engine').waitFor();
  const usage = await page.locator('[data-rt-usage]').innerText();
  ok(/min today/.test(usage), `Settings shows realtime usage ("${usage}")`);
  await page.screenshot({ path: path.join(process.env.E2E_SHOTS || TMP, 'settings-voice.png') });

  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await ctx.close();

  console.log('iPad Home Screen bottom edge');
  for (const [label, vp, screen] of [
    ['portrait', { width: 1024, height: 1346 }, { width: 1024, height: 1366 }],
    ['landscape', { width: 1366, height: 1004 }, { width: 1024, height: 1366 }],
    ['portrait 11"', { width: 834, height: 1174 }, { width: 834, height: 1194 }],
  ]) {
    for (const standalone of [true, false]) {
      const c = await browser.newContext({ viewport: vp, screen, isMobile: false, hasTouch: true });
      await c.addInitScript((sa) => {
        if (sa) Object.defineProperty(navigator, 'standalone', { get: () => true });
      }, standalone);
      const p = await c.newPage();
      await p.goto(`${BASE}/?token=${TOKEN}`);
      await p.waitForTimeout(800);
      const m = await p.evaluate(() => {
        const fullH = window.innerWidth > window.innerHeight ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
        const bd = document.querySelector('[aria-hidden="true"].fixed.inset-0').getBoundingClientRect();
        const nav = document.querySelector('nav').getBoundingClientRect();
        const root = document.getElementById('app').firstElementChild.getBoundingClientRect();
        return { gap: Number(document.documentElement.dataset.vgap), fullH, inner: innerHeight, bdBottom: bd.bottom, navBottom: nav.bottom, rootBottom: root.bottom };
      });
      if (standalone) {
        ok(m.gap === m.fullH - m.inner && m.bdBottom === m.fullH && m.rootBottom === m.fullH, `${label} standalone: backdrop + shell reach the screen bottom (${m.bdBottom}/${m.fullH}, gap ${m.gap})`);
        ok(m.navBottom === m.fullH - 14, `${label} standalone: dock sits 14px + safe-area above the real bottom (${m.navBottom})`);
        await p.screenshot({ path: path.join(process.env.E2E_SHOTS || TMP, `ipad-${label.replace(/\W+/g, '-')}.png`) });
      } else {
        ok(m.gap === 0 && m.bdBottom === m.inner, `${label} in a browser tab: untouched (gap 0)`);
      }
      await c.close();
    }
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    for (const p of procs) p.kill();
    mock.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });
