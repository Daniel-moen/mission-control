// Panel upgrade end to end (task 0290): the real relay, the fake host as the
// Mac (temp Library, Mia questions old and new), and the built panel in
// headless Chromium at phone 390×844, iPad portrait 820×1180 and landscape
// 1180×820.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/panel-0290-e2e.mjs
//
//   • relay: PUT/GET /api/v1/usage — validation, only known fields kept
//   • Home: only questions from the last hour; older ones behind one link
//   • Mia chat: no dock, no model picker / notifications in the header (they
//     are in Settings › Mia), one slim header row
//   • HQ: no "Jarvis" anywhere; Channels is a section of HQ (no dock button),
//     #channels still deep-links there
//   • Fleet: the usage meter; the top-bar pill at ≥80% (amber) and ≥95% (red)
//   • report: compact dock, no metadata form until "Details", "Ask Mia" clips
//     the doc into the chat; the message Mia gets carries id, title and path
//   • chat clip → Reports → pick → chip → send
//   • no sideways scroll, zero console errors
//   • talk mode never uses OpenAI: Basic even with an old 'realtime' choice
//     saved, Mia's reply spoken through /tts (the Mac's Kokoro voice) first
//     sentence first, the device voice only when /tts fails; Settings › Voice
//     has no Realtime engine

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8885;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-0290-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
fs.mkdirSync(MIA_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const ENV = {
  MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, FAKE_HOST_LIBRARY: LIB, FAKE_HOST_PAGE_KIND: '1',
  JARVIS_STORE: path.join(TMP, 'j.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'),
  CHANNELS_STORE: path.join(TMP, 'ch.json'), CHANNELS_MEDIA: path.join(TMP, 'media'), USAGE_STORE: path.join(TMP, 'usage.json'),
  DOC_ASSETS: path.join(TMP, 'da'), DOC_PAGES: path.join(TMP, 'dp'), OPENAI_API_KEY: '', RAILWAY_VOLUME_MOUNT_PATH: '',
};
const procs = [];
function boot(args, name) {
  const p = spawn('node', args, { cwd: path.join(DIR, '..'), env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(120);
  }
}
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const chats = async () => ((await api('GET', '/api/v1/mia')).j.mia?.messages || []).filter((m) => m.from === 'daniel').map((m) => m.text);
const isoAgo = (min) => new Date(Date.now() - min * 60e3).toISOString();
const usageBody = (session, week) => ({
  source: 'test', at: new Date().toISOString(), plan: 'max_5x', stale: false, error: '',
  accessToken: 'sk-ant-oat-SECRET', // must never be kept
  windows: [
    { key: 'session', label: 'Session (5h)', pct: session, resetsAt: new Date(Date.now() + 90 * 60e3).toISOString(), extra: 'x' },
    { key: 'weekly', label: 'Week', pct: week, resetsAt: new Date(Date.now() + 3 * 864e5).toISOString(), active: true },
  ],
});

function writeLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(path.join(LIB, 'raw-incident-hooks.md'), '---\nkind: research\nstatus: done\nsubject: Bodycam\ntags: youtube\n---\n# Raw Incident: what works\n\n**Answer:** Let the footage breathe.\n\n## Numbers\n\nSome text.\n');
  fs.writeFileSync(path.join(LIB, 'crystal-retention.md'), '---\nkind: plan\nstatus: active\n---\n# Crystal Garden: come back tomorrow\n\nA plan.\n');
}

async function newPage(browser, viewport, hash = '') {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 202/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  await page.route('**/tts', (r) => r.fulfill({ status: 204, body: '' }));
  await page.goto(`${BASE}/?token=${TOKEN}${hash}`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await sleep(900);
  return page;
}
async function calm(page) {
  const b = page.getByRole('button', { name: 'Minimise Mia' });
  if (await b.count()) await b.first().click().catch(() => {});
  await sleep(250);
}
const go = async (page, hash, wait = 900) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(wait); await calm(page); };
const noSideScroll = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll('main *, [data-mia-view] *, [data-hq] *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > w + 1 || r.left < -1) && !el.closest('.overflow-x-auto') && !el.closest('.noscroll') && !el.closest('[data-tip]');
  });
  return document.documentElement.scrollWidth <= w && bad.length === 0;
});
const text = (page) => page.evaluate(() => document.body.innerText);

async function main() {
  writeLibrary();
  fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), '');
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  await sleep(400);
  // Mia's questions: 2 days, 3 hours and 10 minutes old (the fake host's seed is ~10 min).
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), [
    { id: 'r_1', at: isoAgo(2 * 1440), from: 'mia', kind: 'question', text: 'OLD-2D question?', options: ['A', 'B'], questionId: 'q_2d' },
    { id: 'r_2', at: isoAgo(180), from: 'mia', kind: 'question', text: 'OLDER-3H question?', options: ['Yes', 'No'], questionId: 'q_3h' },
    { id: 'r_3', at: isoAgo(8), from: 'mia', kind: 'question', text: 'FRESH-8M question?', options: ['Now', 'Later'], questionId: 'q_8m' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await sleep(1200);

  console.log('Relay: /api/v1/usage');
  let r = await api('GET', '/api/v1/usage');
  ok(r.status === 200 && r.j.usage === null, 'GET before any push: usage null');
  r = await api('PUT', '/api/v1/usage', { windows: 'nope' });
  ok(r.status === 400, 'bad body → 400');
  r = await api('PUT', '/api/v1/usage', usageBody(83, 41));
  ok(r.status === 200, 'PUT accepted');
  r = await api('GET', '/api/v1/usage');
  const u = r.j.usage || {};
  ok(u.windows?.length === 2 && u.windows[0].pct === 83 && u.windows[1].active === true, 'GET returns the windows');
  ok(!JSON.stringify(r.j).includes('SECRET') && !('extra' in (u.windows?.[0] || {})), 'unknown fields (a token) are dropped');
  ok(fs.existsSync(ENV.USAGE_STORE) && !fs.readFileSync(ENV.USAGE_STORE, 'utf8').includes('SECRET'), 'stored on disk, without the token');
  r = await api('PUT', '/api/v1/usage', { windows: [{ key: 'session', pct: 140 }, { key: 'BAD KEY', pct: 5 }] });
  ok((await api('GET', '/api/v1/usage')).j.usage.windows.length === 1 && (await api('GET', '/api/v1/usage')).j.usage.windows[0].pct === 100, 'pct clamped, bad keys dropped');
  await api('PUT', '/api/v1/usage', usageBody(83, 41));

  const browser = await chromium.launch();
  const sizes = [['phone', { width: 390, height: 844 }], ['iPad portrait', { width: 820, height: 1180 }], ['iPad landscape', { width: 1180, height: 820 }]];
  for (const [tag, vp] of sizes) {
    console.log(tag);
    const page = await newPage(browser, vp);
    await calm(page);

    // Home
    const home = await text(page);
    ok(home.includes('FRESH-8M') && !home.includes('OLDER-3H') && !home.includes('OLD-2D'), 'Home: only the last hour’s questions');
    ok((await page.locator('[data-older-questions]').count()) === 1, 'Home: one small link to the older ones');
    ok((await page.locator('[data-old-questions]').count()) === 0, 'Home: no old-questions bar');
    ok((await page.locator('nav button[aria-label^="Channels"]').count()) === 0, 'dock: no Channels button');
    ok((await page.locator('[data-usage-pill="warn"]').count()) === 1, 'top bar: amber usage pill at 83%');
    ok(await noSideScroll(page), 'Home: no sideways scroll');
    await page.locator('[data-older-questions]').click();
    await sleep(900);
    ok((await page.locator('[data-mia-view]').count()) === 1, 'the older link opens Mia');

    // Mia chat
    await calm(page);
    ok((await page.locator('[data-dock]').count()) === 0, 'Mia chat: no dock');
    ok((await page.locator('[data-mia-view] [data-mia-model]').count()) === 0, 'Mia chat: no model picker');
    const chatText = await page.locator('[data-mia-view] header').innerText();
    ok(!/Notif|Notify/.test(chatText), 'Mia chat: no notifications control in the header');
    const hh = await page.locator('[data-mia-view] header').evaluate((e) => e.getBoundingClientRect().height);
    ok(hh < 60, `Mia chat: one slim header row (${Math.round(hh)}px)`);
    ok(await noSideScroll(page), 'Mia chat: no sideways scroll');

    // Settings › Mia
    await go(page, 'settings');
    ok((await page.locator('[data-settings-mia] [data-mia-model]').count()) === 1, 'Settings › Mia has the model picker');
    await page.keyboard.press('Escape');
    await sleep(400);

    // HQ
    await go(page, 'hq', 1200);
    const hq = await text(page);
    ok(!/Jarvis/.test(hq), 'HQ: never says Jarvis');
    await page.locator('[data-hq] header button', { hasText: 'Channels' }).click();
    await sleep(800);
    ok((await page.locator('[data-hq] [data-view="channels"]').count()) === 1, 'HQ › Channels shows the Channels view inside HQ');
    ok(await page.evaluate(() => location.hash === '#channels'), 'HQ › Channels keeps the #channels address');
    await go(page, '', 600);
    await go(page, 'channels', 900);
    ok((await page.locator('[data-hq-section="channels"] [data-view="channels"]').count()) === 1, '#channels deep-links into HQ');

    // Fleet
    await go(page, 'fleet');
    ok((await page.locator('[data-usage="warn"] [data-usage-window="session"][data-level="warn"]').count()) === 1, 'Fleet: usage meter, session amber at 83%');
    ok((await page.locator('[data-usage-window="weekly"][data-level="ok"]').count()) === 1, 'Fleet: weekly calm at 41%');

    // Report
    await go(page, 'doc/raw-incident-hooks.md', 1500);
    ok((await page.locator('[data-dock="compact"]').count()) === 1, 'report: compact dock');
    ok((await page.getByLabel('Kind').count()) === 0, 'report: metadata form folded away');
    await page.locator('[data-doc-details]').click();
    await sleep(300);
    ok((await page.getByLabel('Kind').count()) === 1, 'report: "Details" shows it');
    ok(await noSideScroll(page), 'report: no sideways scroll');
    await page.locator('[data-doc-to-mia]').click();
    await sleep(900);
    await calm(page);
    ok((await page.locator('[data-composer-refs] [data-ref="doc:raw-incident-hooks.md"]').count()) === 1, 'Ask Mia → the chat with the doc as a chip');
    const before = (await chats()).length;
    await page.locator('[data-mia-view] textarea, [data-mia-view] input[placeholder]').last().fill(`What next? (${tag})`);
    await page.keyboard.press('Enter');
    const sent = await until(async () => { const c = await chats(); return c.length > before ? c[c.length - 1] : null; }, 5000, 'sent').catch(() => '');
    ok(sent.startsWith(`What next? (${tag})`) && sent.includes('📎 Report "Raw Incident: what works" (doc raw-incident-hooks.md · ~/.mission-control/library/raw-incident-hooks.md · read: mc-doc get raw-incident-hooks.md)'),
      'Mia receives the doc id, title and path');
    await sleep(900);
    ok((await page.locator('[data-composer-refs]').count()) === 0, 'the chip leaves the composer once sent');
    ok((await page.locator('[data-mia-view] [data-ref="doc:raw-incident-hooks.md"]').count()) >= 1, 'the thread shows the reference as a chip');

    // The clip → Reports → pick
    await page.locator('[data-attach-button]').click();
    await sleep(500);
    ok((await page.locator('[data-attach-sheet]').count()) === 1, 'clip opens the attach sheet');
    await page.locator('[data-attach-pick="crystal-retention.md"]').click();
    await sleep(400);
    ok((await page.locator('[data-composer-refs] [data-ref="doc:crystal-retention.md"]').count()) === 1, 'picked report becomes a chip');
    await page.locator('[data-composer-refs] button[aria-label^="Remove"]').click();
    await sleep(300);
    ok((await page.locator('[data-composer-refs]').count()) === 0, 'the chip can be removed');

    ok(page.errors.length === 0, `zero console errors${page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''}`);
    await page.context().close();
  }

  console.log('Usage at 96%');
  await api('PUT', '/api/v1/usage', usageBody(96, 50));
  const p = await newPage(browser, { width: 1180, height: 820 });
  await until(async () => (await p.locator('[data-usage-pill="crit"]').count()) === 1, 4000, 'crit pill').catch(() => {});
  ok((await p.locator('[data-usage-pill="crit"]').count()) === 1, 'top bar: red usage pill at 96%');
  await p.locator('[data-usage-pill]').click();
  await sleep(800);
  ok((await p.locator('[data-usage="crit"]').count()) === 1, 'the pill opens Fleet’s meter, red');
  await api('PUT', '/api/v1/usage', usageBody(40, 50));
  await p.context().close();

  await talkNoOpenAI(browser);
  await browser.close();
}

// ---- talk mode: never OpenAI, Mia's own voice first ----------------------------------
const TALK_INIT = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const d = ctx.createMediaStreamDestination();
    const o = ctx.createOscillator();
    o.connect(d);
    o.start();
    return d.stream;
  };
  window.__said = [];
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      paused: false, speaking: false, cancel() {}, resume() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {},
      speak(u) { if (String(u.text).trim()) window.__said.push(u.text); setTimeout(() => u.onend && u.onend(), 30); },
    },
  });
  // The /tts audio "plays" for 120 ms (headless Chromium can't decode the fake bytes).
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!String(this.src).startsWith('blob:')) return play.call(this);
    window.__played.push({ src: this.src, at: performance.now() });
    setTimeout(() => this.dispatchEvent(new Event('ended')), 120);
    return Promise.resolve();
  };
};

async function talkNoOpenAI(browser) {
  console.log('Talk mode: never OpenAI, Mia’s own voice');
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  await ctx.addInitScript(TALK_INIT);
  // A device that chose Realtime before 0290.
  await ctx.addInitScript(() => { try { localStorage.setItem('mc.talk.engine', JSON.stringify('realtime')); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  const openai = [];
  page.on('request', (r) => { if (/\/realtime|openai\.com/.test(r.url())) openai.push(`${r.method()} ${r.url()}`); });
  const tts = [];
  let ttsFails = false;
  await page.route('**/tts', async (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, engine: 'mac', voice: 'Kokoro (Heart)', limits: { maxChars: 400, dailyChars: 50000 }, today: { requests: 0, chars: 0 } }) });
    const text = JSON.parse(r.request().postData() || '{}').text || '';
    tts.push({ text, at: Date.now() });
    if (ttsFails) return r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
    await sleep(tts.length === 1 ? 150 : 400);
    return r.fulfill({ status: 200, contentType: 'audio/mp4', body: Buffer.from(`fake-m4a:${text}`) });
  });
  await page.goto(`${BASE}/?token=${TOKEN}#mia`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await sleep(1200);
  await page.mouse.click(5, 300); // a tap: unlocks audio like Daniel's first touch
  await page.getByRole('button', { name: 'Talk', exact: true }).first().click();
  const phase = () => page.getAttribute('[data-talk]', 'data-talk').catch(() => null);
  ok(await until(async () => ['listening', 'thinking'].includes(await phase()), 8000, 'talk').then(() => true, () => false), `talk opens in Basic with a saved 'realtime' choice (phase ${await phase()})`);
  ok(!(await page.locator('[data-talk] button', { hasText: /^Realtime$/ }).count()), 'no Realtime switch in the talk controls');

  const long = 'Your build finished and every check passed on the first run. ' +
    'I also tidied the three reports you asked about, filed them in the Library, and flagged the one that still needs a decision from you. ' +
    'Nothing else is waiting; the fleet is quiet and the usage meter is well under the limit for this session and the week. ' +
    'If you want, I can start on the Phoenix intro next, or hold until you have looked at the flagged report.';
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), JSON.stringify({ id: 't_1', at: new Date().toISOString(), from: 'mia', kind: 'chat', text: long }) + '\n');
  await until(async () => (await page.evaluate(() => window.__played.length)) >= 2 && (await phase()) !== 'speaking', 15000, 'spoken').catch(() => {});
  const played = await page.evaluate(() => window.__played.length);
  const said = await page.evaluate(() => window.__said.slice());
  ok(tts.length >= 2 && tts[0].text === 'Your build finished and every check passed on the first run.', `Mia’s reply goes to /tts, the first sentence on its own first (${tts.length} pieces: ${JSON.stringify(tts[0]?.text)})`);
  ok(tts.every((t) => t.text.length <= 400) && tts.map((t) => t.text).join(' ').includes('flagged report'), 'the rest follows in /tts-sized pieces, nothing dropped');
  ok(played === tts.length, `every piece is played in Mia’s own voice (${played}/${tts.length})`);
  ok(!said.some((t) => /build finished|Phoenix/.test(t)), `the device voice stays quiet while /tts works (${JSON.stringify(said)})`);

  ttsFails = true;
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), JSON.stringify({ id: 't_2', at: new Date().toISOString(), from: 'mia', kind: 'chat', text: 'Mac voice is down, so this comes from the device.' }) + '\n');
  await until(async () => (await page.evaluate(() => window.__said.slice())).some((t) => /Mac voice is down/.test(t)), 8000, 'fallback').catch(() => {});
  ok((await page.evaluate(() => window.__said.slice())).some((t) => /Mac voice is down/.test(t)), 'when /tts fails, the device voice reads it (last resort)');

  await page.getByRole('button', { name: 'End', exact: true }).click().catch(() => {});
  await sleep(400);
  await page.evaluate(() => { location.hash = 'settings'; });
  await sleep(1200);
  const body = await page.evaluate(() => document.body.innerText);
  ok((await page.locator('[data-talk-engine="basic"]').count()) === 1 && /OpenAI Realtime is off/.test(body), 'Settings › Voice: talk mode is Basic, OpenAI Realtime off');
  ok(!(await page.getByRole('button', { name: 'Realtime', exact: true }).count()) && /Kokoro \(Heart\)/.test(body), 'no Realtime engine to pick; Mia’s voice reads Kokoro (Heart)');
  ok(openai.length === 0, `no request to /realtime or OpenAI at all (${openai.join(', ')})`);
  ok(!page.errors.length, `talk: no page errors (${page.errors.join(' | ')})`);
  await ctx.close();
}

const cleanup = () => {
  for (const pr of procs) try { pr.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 300);
};
main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
}, (e) => {
  console.error(e);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  cleanup();
  setTimeout(() => process.exit(1), 500);
});
