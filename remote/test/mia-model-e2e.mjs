// Mia's model picker and spoken updates, end to end in a browser (docs/mia.md
// §8.3, §8.5).
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/mia-model-e2e.mjs
//
// Boots the real relay + the fake host (acting as MiaManager) and drives the
// built panel in headless Chromium. Own ports (8869/8868).
//
// Covers: the picker sits in the Mia header's top-right corner (iPad landscape,
// iPad portrait, phone — no horizontal scroll, nothing overlapped), shows the
// HOST's model, offers the four models; a pick → miaSetModel → host → snapshot
// → picker; "Mia is still running on …" + "Restart Mia now" → miaRestart → the
// offer clears once she's back on the new model; an older Mac app (no
// runningModel, no miaRestart cap) gets stop + start instead. Settings ›
// "Speak Mia's updates": Off / Important only / Everything — Everything reads a
// plain `mia say`, a long report is read as its first sentence + "More on the
// panel.", Important only keeps chat silent, quiet hours silence Everything.

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
const TOKEN = 'test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-miamodel-'));
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};
const procs = [];
function boot(args, name, port, miaDir, env = {}) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(port), MIA_DIR: miaDir, PUSH_STORE: path.join(TMP, `push-${port}.json`), REALTIME_STORE: path.join(TMP, `rt-${port}.json`), OPENAI_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) console.log(`[${name}]`, d.toString().trim()); });
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

// A stack: relay + fake host on `port`, with its own MIA_DIR.
async function stack(port, hostEnv = {}) {
  const miaDir = path.join(TMP, `mia-${port}`);
  fs.mkdirSync(miaDir, { recursive: true });
  const base = `http://localhost:${port}`;
  boot(['server.js'], `relay${port}`, port, miaDir);
  await until(async () => (await fetch(`${base}/health`).catch(() => null))?.ok, 5000, 'relay');
  const host = boot(['test/fake-host.mjs'], `host${port}`, port, miaDir, hostEnv);
  await until(async () => (await (await fetch(`${base}/health`)).json()).host, 8000, 'host');
  const miaApi = async () => (await (await fetch(`${base}/api/v1/mia`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).mia;
  const cli = (...args) => execFileSync(MIA_CLI, args, { env: { ...process.env, MIA_DIR: miaDir }, encoding: 'utf8' }).trim();
  return { base, host, miaApi, cli, cmds: () => [...host.out.matchAll(/mia cmd (\w+)/g)].map((m) => m[1]) };
}

const INIT = () => {
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
};

async function newPage(browser, base, { viewport, hash = 'mia' }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  await ctx.addInitScript(INIT);
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${base}/?token=${TOKEN}#${hash}`);
  // Linked: "Live" in the top bar, or (full-screen Mia at narrow widths, no
  // top bar) the picker filled from the host's snapshot.
  await page.waitForSelector('[aria-label="Live"], [data-mia-model^="claude"]', { timeout: 15000, state: 'attached' });
  await sleep(1200);
  return page;
}

// The picker's box vs the Mia header row and the close button.
async function cornerCheck(page) {
  return page.evaluate(() => {
    const pick = document.querySelector('[data-mia-model]');
    if (!pick) return { found: false };
    const p = pick.getBoundingClientRect();
    const header = pick.closest('header').getBoundingClientRect();
    const close = [...document.querySelectorAll('button[aria-label="Close"]')].map((b) => b.getBoundingClientRect()).find((r) => r.width);
    const title = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Mia')?.getBoundingClientRect();
    return {
      found: true,
      right: header.right - p.right,
      top: p.top - header.top,
      sameRowAsTitle: title ? Math.abs((p.top + p.bottom) / 2 - (title.top + title.bottom) / 2) < 12 : false,
      overlapsClose: close ? p.right > close.left && p.left < close.right && p.bottom > close.top && p.top < close.bottom : false,
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      inView: p.left >= 0 && p.right <= window.innerWidth,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- 1. the picker + miaSetModel + restart (current host) ---------------------------
  const S = await stack(8869);
  console.log('model picker — iPad landscape 1180×820');
  {
    const page = await newPage(browser, S.base, { viewport: { width: 1180, height: 820 } });
    const pick = page.locator('[data-mia-model]');
    await pick.waitFor({ timeout: 6000 });
    const c = await cornerCheck(page);
    ok(c.found && c.sameRowAsTitle && c.right < 90 && !c.overlapsClose && c.inView, `the picker sits in the header's top-right corner (${c.right}px from the edge)`);
    ok((await pick.getAttribute('data-mia-model')) === 'claude-opus-5-5' && (await pick.innerText()).includes('Opus 5.5'), 'it shows the model the host reports (Opus 5.5), not a panel default');
    const opts = await page.locator('select[aria-label="Mia\'s model"] option').evaluateAll((os) => os.map((o) => `${o.value}=${o.textContent}`));
    ok(JSON.stringify(opts) === JSON.stringify(['claude-fable-5-1=Fable 5.1', 'claude-opus-5-5=Opus 5.5', 'claude-sonnet-5=Sonnet 5', 'claude-haiku-4-5-20251001=Haiku 4.5']), `it offers the four models (${opts.join(', ')})`);
    ok(!(await page.locator('[data-mia-restart]').count()), 'no restart offer while she runs on the saved model');

    await page.selectOption('select[aria-label="Mia\'s model"]', 'claude-fable-5-1');
    await until(async () => (await S.miaApi()).model === 'claude-fable-5-1', 5000, 'host model');
    ok(S.cmds().includes('miaSetModel'), 'a pick sends miaSetModel to the Mac');
    await until(async () => (await pick.getAttribute('data-mia-model')) === 'claude-fable-5-1', 5000, 'picker follows');
    ok((await pick.innerText()).includes('Fable 5.1'), 'the picker shows Fable 5.1 once the host\'s snapshot says so');
    ok(await page.getByText(/Model saved/).isVisible().catch(() => false), 'a toast confirms the save');
    const offer = page.locator('[data-mia-restart="offer"]');
    await offer.waitFor({ timeout: 4000 });
    ok((await offer.innerText()).includes('still running on Opus 5.5') && (await offer.innerText()).includes('Fable 5.1 applies from her next start'), 'the offer says she is still on Opus 5.5 until she restarts');
    const nRestarts = (await S.miaApi()).restarts;
    await page.getByRole('button', { name: 'Restart Mia now' }).click();
    await until(async () => (await S.miaApi()).runningModel === 'claude-fable-5-1', 5000, 'restarted');
    ok(S.cmds().filter((x) => x === 'miaRestart').length === 1 && !S.cmds().includes('miaStop'), 'Restart Mia now sends ONE miaRestart (no stop/start dance)');
    const after = await S.miaApi();
    ok(after.restarts === nRestarts + 1 && after.online && after.enabled, 'the host restarted her: online, on Fable 5.1');
    await until(async () => !(await page.locator('[data-mia-restart]').count()), 5000, 'offer clears');
    ok(true, 'the offer clears once she is back on the new model');
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  for (const [label, viewport] of [['iPad portrait 820×1180', { width: 820, height: 1180 }], ['phone 390×844', { width: 390, height: 844 }]]) {
    console.log(`model picker — ${label}`);
    const page = await newPage(browser, S.base, { viewport });
    await page.locator('[data-mia-model]').waitFor({ timeout: 6000 });
    const c = await cornerCheck(page);
    ok(c.found && c.sameRowAsTitle && c.right < 90 && c.inView, `${label}: top-right corner, on the title row (${c.right}px from the edge)`);
    ok(!c.overlapsClose && !c.hscroll, `${label}: overlaps nothing, no horizontal scroll`);
    ok((await page.locator('[data-mia-model]').innerText()).includes('Fable 5.1'), `${label}: shows the host's model`);
    ok(!page.errors.length, `${label}: no page errors`);
    await page.context().close();
  }

  // ---- 2. spoken updates ---------------------------------------------------------------
  console.log('Settings › Speak Mia\'s updates');
  {
    const page = await newPage(browser, S.base, { viewport: { width: 1180, height: 820 }, hash: 'settings' });
    await page.evaluate(() => localStorage.setItem('mc.talk.engine', JSON.stringify('basic')));
    await page.evaluate(() => localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: false, from: '22:00', to: '07:00' })));
    await page.getByText('Speak Mia\'s updates').waitFor({ timeout: 5000 });
    const seg = page.locator('button', { hasText: /^(Off|Important only|Everything)$/ });
    ok(JSON.stringify((await seg.allInnerTexts()).slice(0, 3)) === JSON.stringify(['Off', 'Important only', 'Everything']), 'Settings shows Off / Important only / Everything');
    ok((await page.getByRole('button', { name: 'Important only' }).getAttribute('aria-pressed')) === 'true', 'Important only (today\'s behaviour) is the default');
    await page.getByRole('button', { name: 'Everything' }).click(); // also the audio-unlocking tap
    ok((await page.evaluate(() => localStorage.getItem('mc.announce.mode'))) === '"all"', 'the choice is saved on this device');
    ok(await page.getByText('Everything she writes to you').isVisible(), 'the hint says what Everything means');
    await page.reload();
    await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
    ok((await page.getByRole('button', { name: 'Everything' }).getAttribute('aria-pressed')) === 'true', '…and survives a reload');
    await page.getByText('Speak Mia\'s updates').click(); // a tap after the reload (audio unlock), inside the sheet
    await sleep(1200);
    const said = () => page.evaluate(() => window.__said.join(' '));

    S.cli('say', 'Plain chat probe, for Everything.');
    await until(async () => (await said()).includes('Plain chat probe'), 8000, 'plain say spoken');
    ok(true, 'Everything: a plain `mia say` is read aloud');

    const report = 'Morning brief: three meetings today, the first at 9:30 with **Acme** about the Q3 renewal. ' +
      'Mail: two need you — the invoice from Northwind and a contract question from legal. ' +
      'Executors finished tasks 24 and 25 overnight. I suggest you start with the invoice. See https://example.com/brief for more.';
    S.cli('notify', report);
    await until(async () => /morning brief/i.test(await said()), 8000, 'report spoken');
    await sleep(600);
    const heard = await said();
    ok(heard.includes('Hey Daniel, morning brief: three meetings today, the first at 9:30 with Acme about the Q3 renewal.') && heard.includes('More on the panel.'), 'a long report is read as its first sentence + "More on the panel."');
    ok(!heard.includes('Northwind') && !heard.includes('**') && !heard.includes('https'), '…not the whole report, no markdown, no URL');

    // Important only: plain chat stays silent, a notify still speaks.
    await page.getByRole('button', { name: 'Important only' }).click();
    S.cli('say', 'Chat probe in Important only.');
    S.cli('notify', 'Notify probe in Important only.');
    await until(async () => /notify probe/i.test(await said()), 8000, 'notify spoken');
    ok(!(await said()).includes('Chat probe in Important'), 'Important only: a plain say stays silent, a notify is spoken');

    // Quiet hours covering now: Everything stays silent.
    await page.getByRole('button', { name: 'Everything' }).click();
    await page.evaluate(() => {
      const d = new Date();
      const hh = (x) => String(x).padStart(2, '0');
      localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: true, from: `${hh(d.getHours())}:00`, to: `${hh((d.getHours() + 1) % 24)}:59` }));
    });
    S.cli('notify', 'Quiet probe for Everything.');
    await sleep(2000);
    ok(!/quiet probe/i.test(await said()), 'quiet hours: nothing is said, even on Everything');

    // Off.
    await page.evaluate(() => localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: false, from: '22:00', to: '07:00' })));
    await page.getByRole('button', { name: 'Off', exact: true }).first().click();
    S.cli('ask', '--speak', 'Off probe?');
    await sleep(2000);
    ok(!(await said()).includes('Off probe'), 'Off: silent, even for a --speak question');
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }

  // ---- 3. an older Mac app: no runningModel, no miaRestart cap -----------------------
  console.log('older Mac app — stop + start fallback');
  {
    const L = await stack(8867, { FAKE_HOST_CAPS: 'upload', FAKE_HOST_LEGACY_MIA: '1' });
    const page = await newPage(browser, L.base, { viewport: { width: 1180, height: 820 } });
    await page.locator('[data-mia-model]').waitFor({ timeout: 6000 });
    ok(!(await page.locator('[data-mia-restart]').count()), 'no offer before a switch (nothing to compare)');
    await page.selectOption('select[aria-label="Mia\'s model"]', 'claude-sonnet-5');
    const offer = page.locator('[data-mia-restart="offer"]');
    await offer.waitFor({ timeout: 5000 });
    ok((await offer.innerText()).includes('Sonnet 5 applies from Mia\'s next start'), 'after a switch on this panel: the offer still shows');
    await page.getByRole('button', { name: 'Restart Mia now' }).click();
    await until(() => L.cmds().includes('miaStart'), 6000, 'start');
    const seq = L.cmds().filter((x) => x === 'miaStop' || x === 'miaStart' || x === 'miaRestart');
    ok(JSON.stringify(seq) === '["miaStop","miaStart"]', `it restarts her with stop, then start (${seq.join(' → ')})`);
    await until(async () => !(await page.locator('[data-mia-restart]').count()), 6000, 'offer clears');
    ok((await L.miaApi()).online, 'she is back online, and the offer clears');
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
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
