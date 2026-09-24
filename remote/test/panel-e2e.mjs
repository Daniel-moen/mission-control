// Mia drives the panel, the voice pill, and spoken announcements — end to end
// in a browser (docs/mia.md §8.2–8.3).
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/panel-e2e.mjs
//
// Boots the real relay and the fake host with MIA_DIR pointed at a temp dir,
// then runs the REAL `mia` CLI (scripts/mia): `mia panel …` lines travel
// panel.jsonl → fake host (as MiaManager) → relay → the built panel in
// headless Chromium, and the panel's panelDone comes back to the host
// (panel-results.jsonl). The mic is a stub oscillator and speechSynthesis a
// recorder. Own ports (8879/8878) so it can run beside the other E2Es.
//
// Covers: open-doc (by id, with --at heading, and by title words), view,
// open-task, open-agent, search, open-url, scroll-to, a miss reported back;
// talk mode persisting as the top-bar pill across views at iPad portrait and
// landscape (one mic for the whole session, never over the dock or a control,
// expand back, stop); announcements (chime + speech after a tap, the locked
// "tap to hear" banner, answer via the pill's mic, quiet hours, background,
// Off); announcements in Mia's realtime voice via a mocked /tts (played on the
// blessed <audio>, device voice on failure, never while a talk call is live).

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8879;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panel-'));
const MIA_DIR = path.join(TMP, 'mia');
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');
const RESEARCH = 'acme-corp-pricing-teardown--7b2e9f14.md';

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};
const procs = [];
function boot(args, name) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
const mia = (...args) => execFileSync(MIA_CLI, args, { env: { ...process.env, MIA_DIR }, encoding: 'utf8' }).trim();
const results = () => {
  try {
    return fs.readFileSync(path.join(MIA_DIR, 'panel-results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
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
const resultFor = (id, ms = 12000) => until(() => results().find((r) => r.id === id), ms, `panelResult ${id}`);

// ---- in-page fakes ---------------------------------------------------------------
const INIT = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const d = ctx.createMediaStreamDestination();
    o.connect(d);
    o.start();
    window.__mics = (window.__mics || 0) + 1;
    window.__tracks = (window.__tracks || []).concat(d.stream.getAudioTracks());
    return d.stream;
  };
  window.__said = [];
  const synth = {
    paused: false,
    speaking: false,
    speak(u) {
      if (String(u.text).trim()) window.__said.push(u.text);
      setTimeout(() => u.onend && u.onend(), 30);
    },
    cancel() {},
    resume() {},
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  // Which blob: audio the page played (the /tts mp3), and whether it finished.
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (String(this.src).startsWith('blob:')) {
      const rec = { src: this.src, ended: false };
      window.__played.push(rec);
      this.addEventListener('ended', () => (rec.ended = true), { once: true });
    }
    return play.call(this);
  };
  window.__opened = [];
  window.open = (url) => {
    window.__opened.push(url);
    return {};
  };
  // Background, on demand: the page reads visibilityState.
  window.__setHidden = (h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
};

// 0.3 s of silence, served as the mocked /tts audio.
const WAV = (() => {
  const n = 4800;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
})();

const rect = (page, sel) => page.locator(sel).first().boundingBox();
const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Every visible button that isn't part of the pill — the pill may cover none.
async function pillCovers(page) {
  return page.evaluate(() => {
    const pill = document.querySelector('[data-talk-pill]');
    if (!pill) return ['no pill'];
    const p = pill.getBoundingClientRect();
    const hits = [];
    for (const el of document.querySelectorAll('button, a[href], nav')) {
      if (pill.contains(el) || el.closest('[data-talk-host]') || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (r.x < p.right && p.x < r.right && r.y < p.bottom && p.y < r.bottom) hits.push(el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName);
    }
    return hits;
  });
}

async function newPage(browser, { viewport, standalone = true }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  await ctx.addInitScript(INIT);
  if (standalone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/?token=${TOKEN}`);
  // Linked: the top bar's link pill reads "Live" once snapshots flow.
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000 }).catch(async (e) => {
    console.error('page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 400));
    throw e;
  });
  await sleep(1200); // first snapshots, presence
  return page;
}
const hash = (page) => page.evaluate(() => decodeURIComponent(location.hash.replace(/^#/, '')));

async function main() {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- 1. mia panel commands, iPad landscape --------------------------------------
  console.log('mia panel — iPad landscape 1180×820');
  {
    const page = await newPage(browser, { viewport: { width: 1180, height: 820 } });
    await page.mouse.click(600, 400); // a tap: presence + audio unlock

    let id = mia('panel', 'open-doc', RESEARCH, '--at', 'Competitive position');
    let r = await resultFor(id);
    ok(r.ok === true, `open-doc by id: the panel reports success back to the Mac (${r.detail})`);
    ok((await hash(page)) === `doc/${RESEARCH}`, 'open-doc opens the document window');
    ok(await page.getByText(/Mia opened “/).isVisible(), 'a toast says "Mia opened …"');
    const top = await page.evaluate(() => {
      const h = [...document.querySelectorAll('article.md h2')].find((x) => x.textContent.trim() === 'Competitive position');
      if (!h) return null;
      const box = h.getBoundingClientRect();
      return { top: box.top, flash: h.classList.contains('mia-flash'), inView: box.top >= 0 && box.top < innerHeight };
    });
    ok(top && top.inView && top.flash, '--at scrolls the doc to that heading and marks it');

    id = mia('panel', 'view', 'fleet');
    r = await resultFor(id);
    ok(r.ok && (await hash(page)) === 'fleet', 'view fleet');

    id = mia('panel', 'open-doc', 'acme pricing');
    r = await resultFor(id);
    ok(r.ok && r.detail === RESEARCH && (await hash(page)) === `doc/${RESEARCH}`, 'open-doc by title words finds the doc');

    id = mia('panel', 'scroll-to', 'Sources');
    r = await resultFor(id);
    ok(r.ok, 'scroll-to a heading in the open doc');

    id = mia('panel', 'open-task', '1');
    r = await resultFor(id);
    ok(r.ok && (await hash(page)) === 'mia', 'open-task opens Mia');
    await sleep(600);
    ok(await page.getByText('Add dark mode to settings').first().isVisible(), '…with the task on her board');

    const agents = (await (await fetch(`${BASE}/api/v1/agents`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).agents;
    const ag = agents.find((a) => a.name) || agents[0];
    id = mia('panel', 'open-agent', ag.name || ag.folder);
    r = await resultFor(id);
    ok(r.ok && (await hash(page)).startsWith('agent/'), `open-agent "${ag.name || ag.folder}" opens its window`);

    id = mia('panel', 'search', 'checkout');
    r = await resultFor(id);
    await sleep(300);
    const q = await page.locator('input').evaluateAll((els) => els.map((e) => e.value));
    ok(r.ok && q.includes('checkout'), 'search opens the palette pre-filled');
    await page.keyboard.press('Escape');

    id = mia('panel', 'open-url', 'https://zoom.us/j/123456?pwd=abc');
    r = await resultFor(id);
    ok(r.ok && (await page.evaluate(() => window.__opened)).includes('https://zoom.us/j/123456?pwd=abc'), 'open-url hands the https link to the device');

    id = mia('panel', 'open-doc', 'no-such-doc-anywhere');
    r = await resultFor(id);
    ok(r.ok === false && /no Library doc matches/.test(r.detail), 'a miss comes back to the Mac as a failure with the reason');

    id = mia('panel', 'view', 'settings');
    r = await resultFor(id);
    await sleep(400);
    ok(r.ok && (await page.getByText('Announcements').isVisible()), 'view settings opens Settings (with the Announcements section)');
    ok(await page.getByText('Quiet hours').isVisible(), 'quiet hours are configurable');
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  // ---- 2. the voice pill at iPad sizes --------------------------------------------
  for (const [label, viewport] of [
    ['iPad portrait 820×1180', { width: 820, height: 1180 }],
    ['iPad landscape 1180×820', { width: 1180, height: 820 }],
  ]) {
    console.log(`voice pill — ${label}`);
    const page = await newPage(browser, { viewport });
    await page.evaluate(() => localStorage.setItem('mc.talk.engine', JSON.stringify('basic')));
    await page.reload();
    await sleep(1500);
    await page.getByRole('button', { name: /^Mia/ }).first().click();
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    await until(async () => (await page.getAttribute('[data-talk]', 'data-talk').catch(() => null)) === 'listening', 8000, 'listening');
    ok(await page.locator('[data-talk-slot] [data-talk]').count() === 1, `${label}: the talk view sits in the Mia window`);
    ok(await page.locator('[data-talk-pill]').count() === 0, `${label}: no pill while Mia is on screen`);

    // Mia opens something mid-conversation.
    const id = mia('panel', 'open-doc', RESEARCH);
    await resultFor(id);
    await page.locator('[data-talk-pill]').waitFor({ timeout: 4000 });
    await sleep(700); // let the pill's entrance settle before measuring
    ok((await hash(page)) === `doc/${RESEARCH}`, `${label}: Mia's open-doc lands while talking`);
    ok(await page.getAttribute('[data-pill-phase]', 'data-pill-phase') === 'listening', `${label}: the pill shows the live phase`);
    ok(await page.locator('[data-talk]').count() === 1, `${label}: the session is still mounted (parked)`);
    ok((await pillCovers(page)).length === 0, `${label}: the pill covers no control (${(await pillCovers(page)).join(', ')})`);
    const pill = await rect(page, '[data-talk-pill]');
    const dock = await page.getByRole('button', { name: 'Voice command' }).locator('xpath=ancestor::nav').boundingBox();
    ok(dock && !overlap(pill, dock) && pill.y >= 0, `${label}: clear of the dock and inside the safe top (pill ${JSON.stringify(pill)}, dock ${JSON.stringify(dock)})`);

    // Navigate around with the dock.
    for (const name of ['Fleet', 'Library', 'Home']) {
      await page.getByRole('button', { name, exact: true }).click();
      await sleep(350);
      ok(await page.locator('[data-talk-pill]').isVisible(), `${label}: pill persists on ${name}`);
    }
    ok((await pillCovers(page)).length === 0, `${label}: on Home too the pill covers no top-bar control`);
    const tracksLive = await page.evaluate(() => window.__tracks.filter((t) => t.readyState === 'live').length);
    ok((await page.evaluate(() => window.__mics)) === 1 && tracksLive === 1, `${label}: one mic for the whole session, still live`);

    // Expand back to Mia.
    await page.locator('[data-pill-expand]').click();
    await sleep(500);
    ok((await hash(page)) === 'mia' && (await page.locator('[data-talk-slot] [data-talk]').count()) === 1, `${label}: tapping the pill expands back to Mia`);
    ok(await page.locator('[data-talk-pill]').count() === 0, `${label}: …and the pill steps aside`);

    // Leave again and stop from the pill.
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('[data-pill-stop]').click();
    await sleep(500);
    const after = await page.evaluate(() => ({ talk: !!document.querySelector('[data-talk]'), live: window.__tracks.filter((t) => t.readyState === 'live').length }));
    ok(!after.talk && after.live === 0 && (await page.locator('[data-talk-pill]').count()) === 0, `${label}: stop ends the session and releases the mic`);
    ok(!page.errors.length, `${label}: no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  // ---- 3. announcements ----------------------------------------------------------------
  console.log('announcements');
  {
    const page = await newPage(browser, { viewport: { width: 1180, height: 820 } });
    await page.evaluate(() => localStorage.setItem('mc.talk.engine', JSON.stringify('basic')));
    await page.mouse.click(600, 400); // unlock
    await sleep(300);
    const said = () => page.evaluate(() => window.__said.slice());

    mia('say', '--speak', 'Hey Daniel, task 14 is done. Anything else?');
    await until(async () => (await said()).some((t) => t.includes('task 14 is done')), 6000, 'spoken');
    ok(true, 'a --speak message is read aloud after the chime');
    await page.locator('[data-announce-mic]').waitFor({ timeout: 4000 });
    ok(await page.locator('[data-talk-pill]').isVisible(), 'the pill offers a mic to answer');

    mia('say', 'A plain chat reply, not for reading out.');
    await sleep(1500);
    ok(!(await said()).some((t) => t.includes('plain chat reply')), 'an unflagged chat message stays silent (default mode)');

    await page.locator('[data-announce-mic]').click();
    await until(async () => (await page.getAttribute('[data-talk]', 'data-talk').catch(() => null)) === 'listening', 8000, 'answer session');
    ok(await page.locator('[data-pill-phase]').isVisible(), 'the mic opens a talk session, shown in the pill');
    await page.locator('[data-pill-stop]').click();
    await sleep(400);

    // Quiet hours covering now → silent.
    const n0 = (await said()).length;
    await page.evaluate(() => {
      const d = new Date();
      const hh = (x) => String(x).padStart(2, '0');
      const from = `${hh(d.getHours())}:00`;
      const to = `${hh((d.getHours() + 1) % 24)}:59`;
      localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: true, from, to }));
    });
    mia('notify', '--speak', 'Quiet-hours probe');
    await sleep(1500);
    ok((await said()).length === n0 && !(await page.locator('[data-announce]').count()), 'quiet hours: nothing is said or shown');
    await page.evaluate(() => localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: false, from: '22:00', to: '07:00' })));

    // In the background → silent.
    await page.evaluate(() => window.__setHidden(true));
    mia('notify', '--speak', 'Background probe');
    await sleep(1500);
    await page.evaluate(() => window.__setHidden(false));
    ok(!(await said()).some((t) => t.includes('Background probe')), 'in the background: not announced (push covers it)');

    // Off → silent.
    await page.evaluate(() => localStorage.setItem('mc.announce.mode', JSON.stringify('off')));
    mia('ask', '--speak', 'Off-mode probe?');
    await sleep(1500);
    ok(!(await said()).some((t) => t.includes('Off-mode probe')), 'Announcements: Off silences her');
    await page.evaluate(() => localStorage.removeItem('mc.announce.mode'));
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  // Locked audio: no tap in this page session yet.
  {
    const page = await newPage(browser, { viewport: { width: 820, height: 1180 } });
    mia('ask', '--speak', 'Shall I deploy now?', '--options', 'Yes|No');
    await page.locator('[data-announce="locked"]').waitFor({ timeout: 5000 });
    ok(await page.getByText('Mia wants to talk — tap to hear').isVisible(), 'before any tap: the "Mia wants to talk — tap to hear" banner');
    ok(!(await page.evaluate(() => window.__said.length)), '…and no sound is attempted');
    ok((await pillCovers(page)).length === 0, 'the banner covers no control (portrait)');
    await page.locator('[data-announce="locked"]').click();
    // speak() reads sentence by sentence, so join what was said.
    await until(async () => /Shall I deploy now\?.*Yes, or No/.test((await page.evaluate(() => window.__said)).join(' ')), 5000, 'heard');
    ok(true, 'the tap plays it, options included');
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  // ---- 4. announcements in Mia's voice (/tts mocked) -------------------------------------
  console.log('announcements — Mia\'s voice');
  {
    const page = await newPage(browser, { viewport: { width: 1180, height: 820 } });
    await page.evaluate(() => localStorage.setItem('mc.talk.engine', JSON.stringify('basic')));
    const asked = [];
    let mode = 'ok';
    await page.route('**/tts', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      asked.push({ text: JSON.parse(req.postData() || '{}').text, auth: req.headers().authorization });
      if (mode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'no key' }) });
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV });
    });
    await page.mouse.click(600, 400); // unlock (blesses the <audio>)
    await sleep(300);
    const said = () => page.evaluate(() => window.__said.slice());
    const played = () => page.evaluate(() => window.__played.slice());

    mia('say', '--speak', 'Task 17 is done. Want the report?');
    await until(() => asked.some((a) => a.text.includes('Task 17 is done')), 6000, '/tts asked');
    ok(asked[0].auth === `Bearer ${TOKEN}`, 'the announcement is fetched from /tts with the token');
    await until(async () => (await played()).some((p) => p.ended), 6000, 'played');
    ok(true, 'the /tts audio plays to the end on the page\'s <audio>');
    ok(!(await said()).some((t) => t.includes('Task 17')), '…and the device voice stays quiet');
    await page.locator('[data-announce-mic]').waitFor({ timeout: 4000 });
    ok(true, 'the pill still offers the mic afterwards');

    mode = 'fail';
    mia('notify', '--speak', 'Fallback probe. The relay has no key.');
    await until(async () => (await said()).some((t) => t.includes('Fallback probe')), 6000, 'fallback spoken');
    ok(asked.some((a) => a.text.includes('Fallback probe')), '/tts failing (503) → the device voice reads it instead');
    mode = 'ok';

    // Off / quiet hours: /tts is never even asked.
    const nAsked = asked.length;
    await page.evaluate(() => localStorage.setItem('mc.announce.mode', JSON.stringify('off')));
    mia('notify', '--speak', 'Off probe two');
    await sleep(1500);
    await page.evaluate(() => {
      localStorage.removeItem('mc.announce.mode');
      const d = new Date();
      const hh = (x) => String(x).padStart(2, '0');
      localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: true, from: `${hh(d.getHours())}:00`, to: `${hh((d.getHours() + 1) % 24)}:59` }));
    });
    mia('notify', '--speak', 'Quiet probe two');
    await sleep(1500);
    await page.evaluate(() => localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: false, from: '22:00', to: '07:00' })));
    await page.evaluate(() => window.__setHidden(true));
    mia('notify', '--speak', 'Hidden probe two');
    await sleep(1500);
    await page.evaluate(() => window.__setHidden(false));
    ok(asked.length === nAsked, 'Off, quiet hours and background: no /tts request at all');

    // A live talk call: the message goes into the call, not through /tts.
    await page.locator('[data-announce-mic]').click().catch(async () => {
      mia('say', '--speak', 'Open the mic probe.');
      await page.locator('[data-announce-mic]').click({ timeout: 6000 });
    });
    await until(async () => (await page.getAttribute('[data-talk]', 'data-talk').catch(() => null)) === 'listening', 8000, 'talk on');
    const nCall = asked.length;
    mia('say', '--speak', 'In-call probe, done.');
    await until(async () => (await said()).some((t) => t.includes('In-call probe')), 8000, 'said in call');
    ok(asked.length === nCall, 'with a talk call live, the message is read in the call — no /tts');
    await page.locator('[data-pill-stop]').click().catch(() => {});
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  await browser.close();
}

main()
  .catch((e) => {
    failed += 1;
    console.error('✗ harness:', e.stack || e.message);
  })
  .finally(() => {
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
