// Channels end to end (task 0260): the real relay, the fake host as the Mac's link (Mia's thread), the real
// Channels HQ sync from ~/channels-hq (reads the channel repos read-only; its action log goes to a temp file and
// it never reminds the real Mia), and the built panel in headless Chromium.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/yt-channels-panel-e2e.mjs
//   SHOTS=<dir> keeps screenshots (iPad landscape + phone) and a webm of the animations.
//
//   • overview: active channel cards (ring, streak, counters, checkpoint bar), parked collapsed, double-down
//   • checkpoints: done dots fill, the current one pulses, a tap shows when + which file
//   • channel page → video sheet: player poster from the relay's media cache, controls
//   • Approve → Mia's thread gets the "Channels:" line, the relay queue → the Mac's actions.jsonl;
//     `hq.actions done` → the panel shows Done
//   • Publish now needs the confirmation sheet; Reject needs a note
//   • analytics tab; no sideways scroll, zero console errors

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
const HQ = process.env.CHANNELS_HQ || path.join(os.homedir(), 'channels-hq');
const PORT = 8875;
const HQPORT = 8876;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-channels-e2e-'));
const MIA_DIR = path.join(TMP, 'mia');
const ACTIONS = path.join(TMP, 'actions.jsonl');
const HQDATA = path.join(TMP, 'hqdata');
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(HQDATA, { recursive: true });
if (fs.existsSync(path.join(HQ, 'data', 'stats.jsonl'))) fs.copyFileSync(path.join(HQ, 'data', 'stats.jsonl'), path.join(HQDATA, 'stats.jsonl'));

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const procs = [];
function boot(cmd, args, name, env, cwd = path.join(DIR, '..')) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await sleep(150);
  }
}
const RELAY_ENV = { MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, JARVIS_STORE: path.join(TMP, 'j.json'), PUSH_STORE: path.join(TMP, 'push.json'),
  REALTIME_STORE: path.join(TMP, 'rt.json'), CHANNELS_STORE: path.join(TMP, 'channels.json'), CHANNELS_MEDIA: path.join(TMP, 'media'),
  DOC_ASSETS: path.join(TMP, 'da'), DOC_PAGES: path.join(TMP, 'dp'), OPENAI_API_KEY: '', RAILWAY_VOLUME_MOUNT_PATH: '' };
const HQ_ENV = { HQ_PORT: String(HQPORT), HQ_NO_STATS: '1', HQ_RELAY_SYNC: '1', MC_RELAY_URL: BASE, MC_TOKEN: TOKEN,
  HQ_ACTIONS: ACTIONS, HQ_NO_MIA: '1', HQ_DATA: HQDATA };
const chats = async () => {
  const j = await (await fetch(`${BASE}/api/v1/mia`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  return (j.mia?.messages || []).filter((m) => m.from === 'daniel').map((m) => m.text);
};
const actionLog = () => (fs.existsSync(ACTIONS) ? fs.readFileSync(ACTIONS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function newPage(browser, viewport, { video } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 2, ...(video ? { recordVideo: { dir: SHOTS, size: viewport } } : {}) });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 202/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  await page.route('**/tts', (r) => r.fulfill({ status: 204, body: '' }));
  await page.goto(`${BASE}/?token=${TOKEN}#channels`);
  await page.waitForSelector('[data-view="channels"]', { timeout: 15000 });
  await page.waitForSelector('[data-channel]', { timeout: 20000 });
  await sleep(1400); // cards, rings and checkpoint fills settle
  return page;
}
const noSideScroll = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll('[data-view="channels"] *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > w + 1 || r.left < -1) && !el.closest('.overflow-x-auto') && !el.closest('[data-tip]');
  });
  return { ok: document.documentElement.scrollWidth <= w && bad.length === 0, bad: bad.slice(0, 3).map((e) => e.outerHTML.slice(0, 140)) };
});
const waitImages = (page) => page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); }))));
async function calm(page) {
  const b = page.getByRole('button', { name: 'Minimise Mia' });
  if (await b.count()) await b.first().click().catch(() => {});
  await sleep(300);
}
const shot = async (page, name) => { await waitImages(page); await sleep(500); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

let browser;
try {
  boot('node', ['server.js'], 'relay', RELAY_ENV);
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay up');
  boot('node', ['test/fake-host.mjs'], 'host', RELAY_ENV);
  boot(path.join(HQ, '.venv', 'bin', 'python'), ['-m', 'hq.server'], 'channels-hq', HQ_ENV, HQ);
  await until(async () => {
    const j = await (await fetch(`${BASE}/api/v1/channels`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    return j.state?.channels?.length;
  }, 60000, 'Channels HQ pushed its state');
  ok(true, 'Channels HQ on the Mac side pushed its state to the relay');
  await sleep(4000); // first media prepush

  browser = await chromium.launch();
  const land = { width: 1180, height: 820 };
  const phone = { width: 390, height: 844 };

  console.log('iPad landscape');
  const page = await newPage(browser, land, { video: true });
  await calm(page);
  ok(await page.locator('[data-channel="raw-incident"]').count() === 1, 'Raw Incident card on the overview');
  ok(await page.locator('[data-parked]').count() === 1, 'parked channels are collapsed under "Parked"');
  ok(await page.locator('[data-cp][data-state="current"]').count() > 0, 'a current checkpoint is marked');
  ok(await page.locator('.ch-pulse').count() > 0, 'the current checkpoint pulses');
  ok(await page.locator('[data-across]').count() === 1, 'all-channel totals strip');
  await shot(page, '01-channels-overview-ipad-landscape');
  await page.locator('[data-parked] button').first().click();
  await sleep(700);
  await shot(page, '02-channels-overview-parked-open-ipad-landscape');

  // a channel page with its videos
  await page.locator('[data-channel="raw-incident"]').click();
  await page.waitForSelector('[data-channel-page="raw-incident"]');
  await sleep(1400);
  ok(await page.locator('[data-video]').count() > 3, 'channel page lists its videos with checkpoints');
  ok(/#channels\/raw-incident$/.test(page.url()), 'the URL carries the open channel');
  await shot(page, '03-channel-page-ipad-landscape');

  // checkpoint tooltip
  const cp = page.locator('[data-video] [data-cp="render"]').first();
  await cp.hover();
  await sleep(350);
  ok(await page.locator('[data-tip]').count() === 1, 'hovering a checkpoint shows when and which file');

  // a video sheet: player + controls
  const shortRow = page.locator('[data-video*=":short"]').first();
  const vid = await shortRow.getAttribute('data-video');
  await shortRow.click();
  await page.waitForSelector('[data-video-sheet]');
  await sleep(1500);
  ok(await page.locator('[data-video-sheet] [data-checkpoints]').count() === 1, 'video sheet has the full checkpoint bar');
  ok(await page.locator('[data-controls] [data-action]').count() >= 6, 'six controls in the sheet');
  await shot(page, '04-video-checkpoints-controls-ipad-landscape');

  // Approve: tells Mia and queues it; the Mac files it
  await page.locator('[data-controls] [data-action="approve"]').click();
  const line = await until(async () => (await chats()).find((t) => t.startsWith('Channels: Approve')), 8000, 'Mia heard the approve');
  ok(!!line && line.includes(vid), 'Mia gets a "Channels: Approve …" line naming the video');
  const logged = await until(async () => actionLog().find((a) => a.action === 'approve' && a.video === vid), 40000, 'the Mac filed it');
  ok(logged && logged.status === 'queued' && logged.told === true, 'the Mac filed it in actions.jsonl (told, so no extra reminder)');
  execFileSync(path.join(HQ, '.venv', 'bin', 'python'), ['-m', 'hq.actions', 'done', logged.id, 'approved'], { cwd: HQ, env: { ...process.env, HQ_ACTIONS: ACTIONS } });
  await until(async () => (await page.locator('[data-video-sheet] [data-status="done"]').count()) > 0, 60000, 'panel shows done');
  ok(true, 'Mia marks it done → the panel shows Done');

  // Reject needs a note
  await page.locator('[data-controls] [data-action="reject"]').click();
  await sleep(400);
  ok(await page.locator('[data-send-reject]').isDisabled(), 'Reject stays disabled without a note');
  await page.fill('[data-reject-note]', 'Hook is too slow; open on the shove.');
  await page.locator('[data-send-reject]').click();
  await until(async () => (await chats()).some((t) => t.startsWith('Channels: Reject') && t.includes('open on the shove')), 8000, 'reject line');
  ok(true, 'Reject with a note reaches Mia');

  // Publish now: confirmation sheet first
  await page.locator('[data-controls] [data-action="publish_now"]').click();
  await page.waitForSelector('[data-confirm]');
  await sleep(500);
  await shot(page, '05-publish-confirm-sheet-ipad-landscape');
  const before = (await chats()).filter((t) => t.startsWith('Channels: Publish now')).length;
  ok(before === 0, 'nothing is sent before confirming');
  await page.locator('[data-confirm]').click();
  await until(async () => (await chats()).some((t) => t.startsWith('Channels: Publish now')), 8000, 'publish line');
  ok(true, 'Publish now goes to Mia only after the confirmation');
  await page.keyboard.press('Escape');
  await sleep(600);

  // analytics
  await page.goto(`${BASE}/?token=${TOKEN}#channels`);
  await page.waitForSelector('[data-channel]');
  await calm(page);
  await page.getByRole('button', { name: /Analytics/ }).click();
  await page.waitForSelector('[data-analytics]');
  await sleep(1600);
  ok(await page.locator('[data-top]').count() > 0, 'analytics: top Shorts');
  await shot(page, '06-analytics-ipad-landscape');
  await page.evaluate(() => document.querySelector('[data-view="channels"] .overflow-y-auto')?.scrollBy(0, 700));
  await sleep(700);
  await shot(page, '07-analytics-raw-incident-ipad-landscape');
  await page.getByRole('button', { name: /Pipeline/ }).click();
  await sleep(1500);
  await shot(page, '08-pipeline-ipad-landscape');
  const s1 = await noSideScroll(page);
  ok(s1.ok, `iPad: no sideways scroll ${s1.bad.join(' ')}`);
  ok(page.errors.length === 0, `iPad: no console errors ${page.errors.join(' | ')}`);
  const vpath = await page.video().path();
  await page.context().close();
  fs.renameSync(vpath, path.join(SHOTS, 'channels-animations.webm'));

  console.log('phone');
  const p2 = await newPage(browser, phone);
  await calm(p2);
  await shot(p2, '11-channels-overview-phone');
  await p2.locator('[data-channel="raw-incident"]').click();
  await p2.waitForSelector('[data-channel-page]');
  await sleep(1400);
  await shot(p2, '12-channel-page-phone');
  // The thumbnail: mid-row on a phone is a checkpoint dot (its own tooltip button).
  await p2.locator('[data-video]').first().click({ position: { x: 40, y: 40 } });
  await p2.waitForSelector('[data-video-sheet]');
  await sleep(1500);
  await shot(p2, '13-video-sheet-phone');
  await p2.evaluate(() => document.querySelector('[role="dialog"] .overflow-y-auto')?.scrollBy(0, 600));
  await sleep(500);
  await shot(p2, '14-video-controls-phone');
  await p2.keyboard.press('Escape');
  await sleep(500);
  await p2.goto(`${BASE}/?token=${TOKEN}#channels`);
  await p2.waitForSelector('[data-channel]');
  await calm(p2);
  await p2.getByRole('button', { name: /Analytics/ }).click();
  await sleep(1600);
  await shot(p2, '15-analytics-phone');
  const s2 = await noSideScroll(p2);
  ok(s2.ok, `phone: no sideways scroll ${s2.bad.join(' ')}`);
  ok(p2.errors.length === 0, `phone: no console errors ${p2.errors.join(' | ')}`);
} catch (e) {
  failed += 1;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) p.kill();
  // The killed processes may still be writing for a moment.
  if (!process.env.SHOTS) { await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}
console.log(`\n${passed} passed, ${failed} failed${process.env.SHOTS ? ` · shots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);
