// Jarvis HQ end to end (task 0199): the real relay, the fake host as the Mac
// (MiaManager), the real `mia jarvis` CLI as the registry, and the built
// panel in headless Chromium at phone and iPad sizes.
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/hq-panel-e2e.mjs
//
//   • `mia jarvis seed` + `sync` push the registry; HQ draws all 8 companies
//     with health, numbers, levels, running tasks, findings and questions
//   • a level tap: Mia gets "HQ: set … autonomy …" in her thread (the chat
//     path), the relay queues it, the card shows it at once; Undo sends it back
//   • pause, quieter, Scout this now: same two paths
//   • `mia jarvis sync` applies the queue to registry.json; HQ shows it applied
//   • drill-in: photo, per-project panels, links, tasks, docs, permissions,
//     the company feed; #hq/<company> deep link; back arrow
//   • phone 390×844, iPad portrait 820×1180, iPad landscape 1180×820: no
//     sideways scroll, the dock fits, zero console errors
// Own ports (8871/8872). SHOTS=<dir> keeps screenshots.

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
const REPO = path.join(DIR, '..', '..');
const PORT = 8871;
const HPORT = 8872;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hq-'));
const MIA_DIR = path.join(TMP, 'mia');
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, JARVIS_STORE: path.join(TMP, 'jarvis.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
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
const ENV = { ...process.env, MIA_DIR, MC_RELAY_URL: BASE, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' };
const mia = (...args) =>
  new Promise((resolve) => {
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), 'jarvis', ...args], { env: ENV });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (status) => resolve({ status, out }));
  });
const REG = () => path.join(MIA_DIR, 'jarvis', 'registry.json');
const reg = () => JSON.parse(fs.readFileSync(REG(), 'utf8'));
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
// What Daniel said to Mia: the fake host keeps the thread in its snapshot.
const chats = async () => {
  const j = await (await fetch(`${BASE}/api/v1/mia`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  return (j.mia?.messages || []).filter((m) => m.from === 'daniel').map((m) => m.text);
};
const relayJarvis = async () => (await fetch(`${BASE}/api/v1/jarvis`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();

// Health targets for the test registry: /ok 200, /bad 503 (no internet needed).
const hs = http.createServer((q, s) => { s.writeHead(q.url === '/bad' ? 503 : 200); s.end('x'); }).listen(HPORT);

async function seedRegistry() {
  fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [{ id: 'hb_scout', label: 'Scout', enabled: true, prompt: 'x' }], reminders: [] }));
  let r = await mia('seed');
  ok(r.status === 0, 'mia jarvis seed');
  const R = reg();
  for (const p of R.projects) {
    p.probes = [];
    if (p.healthcheck) p.healthcheck = { type: 'http', target: `http://localhost:${HPORT}/ok` };
    // Two weeks of history so trends and sparklines have something to say.
    const hist = (vals) => vals.map((v, i) => ({ t: iso((vals.length - 1 - i) * 24), v }));
    const metric = (name, label, vals, better = 'up', unit = '') => ({ name, label, unit, better, value: vals[vals.length - 1], at: iso(0), source: 'mia', history: hist(vals) });
    if (p.id === 'dryager-panel') p.metrics = [metric('leads', 'Leads', [40, 42, 44, 47, 47, 51, 55, 58, 60, 61, 64, 66, 70, 73]), metric('stale', 'Stale leads', [20, 19, 19, 18, 17, 15, 15, 14, 14, 12, 12, 11, 10, 9], 'down')];
    if (p.id === 'crystal-garden') p.metrics = [metric('visits', 'Visits', [120, 131, 140, 152, 170, 188, 201, 214, 230, 241, 256, 266, 274, 281]), metric('favorites', 'Favourites', [1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3])];
    if (p.id === 'prospect-engine') p.metrics = [metric('owners', 'Owners found', [310, 340, 352, 380, 401, 433, 470, 498, 512, 530, 561, 590, 615, 640]), metric('mandates', 'Mandates', [2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4])];
    if (p.id === 'houston') p.metrics = [metric('theses', 'Theses', [3, 3, 4, 4, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9])];
  }
  R.projects.find((p) => p.id === 'penny').healthcheck.target = `http://localhost:${HPORT}/bad`;
  R.projects.find((p) => p.id === 'dryager-panel').permissions = ['Restart the service when it is down', 'Refresh the lead data nightly'];
  fs.writeFileSync(REG(), JSON.stringify(R, null, 2));
  await mia('finding', 'dryager-panel', '12 leads untouched for 7 days; 3 are Cape Winelands farms');
  await mia('finding', 'crystal-garden', 'Day-1 retention 18%: the tutorial loses players at the shop', '--kind', 'found');
  await mia('finding', 'oblivion-site', 'Fixed a broken listing photo on /bantry-bay', '--kind', 'fixed');
  await mia('finding', '-', 'Weekly report sent', '--kind', 'shipped');
  const now = iso(0);
  const task = (id, title, status, dir, h = 0) => fs.writeFileSync(path.join(MIA_DIR, 'tasks', `${id}.json`), JSON.stringify({ id, title, status, dir, createdAt: iso(h + 1), updatedAt: iso(h) }));
  task('0601', 'Dry-ager: chase the stale leads', 'running', path.join(os.homedir(), 'dryager-panel'));
  task('0602', 'Crystal Garden shop tutorial', 'done', path.join(os.homedir(), 'CrystalGarden'), 20);
  task('0603', 'Prospect engine: Bantry Bay owner pull', 'done', path.join(os.homedir(), 'prospecting-auto'), 50);
  void now;
  r = await mia('sync', '--health');
  ok(r.status === 0 && /pushed/.test(r.out), `mia jarvis sync pushed (${r.out.trim().split('\n').pop()})`);
}

async function newPage(browser, viewport, hash = '') {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(`console: ${m.text()}`); });
  await page.route('**/tts', (r) => r.fulfill({ status: 204, body: '' }));
  await page.goto(`${BASE}/?token=${TOKEN}${hash}`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await sleep(800);
  return page;
}
const noSideScroll = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll('[data-hq] *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > w + 1 || r.left < -1) && !el.closest('.overflow-x-auto');
  });
  return { ok: document.documentElement.scrollWidth <= w && bad.length === 0, bad: bad.slice(0, 3).map((e) => e.outerHTML.slice(0, 120)) };
});
async function openHQ(page) {
  await page.locator('nav button[aria-label="HQ"]').click();
  await page.waitForSelector('[data-company]', { timeout: 8000 });
  await sleep(900); // cards settle
}
// Mini Mia peeks open when a question lands; fold her away before a shot.
async function calm(page) {
  const b = page.getByRole('button', { name: 'Minimise Mia' });
  if (await b.count()) await b.first().click().catch(() => {});
  await sleep(400);
}
const waitImages = (page) => page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))));

async function main() {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');

  console.log('Registry on the Mac → relay');
  await seedRegistry();
  // A question from Mia that belongs to the dry-ager (by keyword).
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), JSON.stringify({ id: 'm_9001', at: iso(0.01), from: 'mia', kind: 'question', text: 'Should the dry-ager panel email Terje the three farm leads?', options: ['Yes', 'Not yet'], questionId: 'q_dry1' }) + '\n');
  const st = await relayJarvis();
  ok(st.state?.registry?.companies?.length === 8, 'relay holds the pushed registry (8 companies)');

  const browser = await chromium.launch();
  const pages = [];

  console.log('Phone 390×844 — board');
  const phone = await newPage(browser, { width: 390, height: 844 });
  pages.push(phone);
  const dock = await phone.locator('nav').first().boundingBox();
  ok(dock && dock.x >= 0 && dock.x + dock.width <= 390, `the dock (with HQ) fits the phone (${Math.round(dock?.width)}px)`);
  await openHQ(phone);
  ok((await phone.locator('[data-company]').count()) === 8, '8 company cards');
  const names = await phone.locator('[data-company] [aria-label^="Open "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').slice(5)));
  ok(['Oblivion Estates', 'Klear', 'Dry-ager', 'Games', 'YouTube & video', 'PropIQ', 'CivEntropy', 'Mission Control'].every((n) => names.includes(n)), `every company: ${names.join(', ')}`);
  // Compact tiles (task 0204): three project lines, then "+N more".
  ok((await phone.locator('[data-company="games"] [data-project]').count()) === 3 && /\+1 more/.test(await phone.locator('[data-company="games"]').innerText()), 'Games shows 3 games + 1 more');
  ok((await phone.locator('[data-company="klear"] [data-health="down"]').count()) === 1, 'Klear shows down (Penny 503)');
  ok((await phone.locator('[data-company="dryager"] [data-health="up"]').count()) === 1, 'Dry-ager shows up');
  const dryCard = await phone.locator('[data-company="dryager"]').innerText();
  ok((await phone.locator('[data-company="dryager"] [data-num="leads"]').innerText()).includes('73'), 'key number on the card (Leads 73)');
  ok(/Now: Dry-ager: chase the stale leads/.test(dryCard), 'what Mia is doing now');
  ok(/1\?/.test(dryCard), 'open question for Daniel');
  ok((await phone.locator('[data-company="dryager"] [data-num="leads"] .text-accent').count()) === 1, 'leads going up shows as good (green)');
  const tileH = await phone.locator('[data-company="dryager"]').evaluate((e) => e.getBoundingClientRect().height);
  ok(tileH < 260, `the tile is compact (${Math.round(tileH)}px)`);
  const ss = await noSideScroll(phone);
  ok(ss.ok, `no sideways scroll on the phone ${ss.bad.join(' ')}`);
  await waitImages(phone);
  await calm(phone);
  await phone.screenshot({ path: path.join(SHOTS, 'phone-board.png') });
  await phone.locator('[data-company]').nth(3).scrollIntoViewIfNeeded();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-board-scrolled.png') });
  await phone.locator('[data-feed]').first().scrollIntoViewIfNeeded();
  await sleep(300);
  const feedText = await phone.locator('[data-feed]').first().innerText();
  ok(/Weekly report sent/.test(feedText) && /Fixed a broken listing photo/.test(feedText) && /Crystal Garden shop tutorial/.test(feedText), 'activity feed: findings + shipped tasks');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-activity.png') });

  console.log('Phone — controls reach Mia and the relay');
  const before = (await chats()).length;
  await phone.locator('[data-jarvis] [data-pause]').click();
  await until(async () => (await chats()).length > before, 4000, 'pause chat').catch(() => {});
  ok((await chats()).some((t) => t.startsWith('HQ: pause.')), 'Pause → Mia gets "HQ: pause." through the chat path');
  ok((await relayJarvis()).pending.some((c) => c.action === 'pause' && c.told === true), 'Pause → queued on the relay for the Mac (told=true)');
  await until(async () => (await phone.locator('[data-jarvis="paused"]').count()) === 1, 3000, 'paused shown').catch(() => {});
  ok((await phone.locator('[data-jarvis="paused"]').count()) === 1, 'the strip shows Jarvis paused at once');
  await phone.getByRole('button', { name: 'Quieter: pitch less often' }).click();
  await until(async () => (await chats()).some((t) => t.startsWith('HQ: quieter.')), 4000, 'quieter').catch(() => {});
  ok((await chats()).some((t) => t.startsWith('HQ: quieter. Pitch every other day')), 'Quieter → "HQ: quieter. Pitch every other day…"');
  ok((await phone.locator('[data-pitch]').innerText()).includes('Every other day'), 'pitch label updates at once');

  console.log('Phone — drill-in');
  await phone.locator('[data-company="dryager"] [aria-label="Open Dry-ager"]').click();
  await phone.waitForSelector('[data-company-page="dryager"]');
  await sleep(700);
  ok((await phone.evaluate(() => location.hash)) === '#hq/dryager', 'hash follows the company (#hq/dryager)');
  const panel = phone.locator('[data-project-panel="dryager-panel"]');
  ok((await panel.locator('a[data-link="live"]').getAttribute('href')) === 'https://dryager-panel.up.railway.app', 'live link');
  ok((await panel.innerText()).includes('Restart the service when it is down'), 'standing permissions');
  ok((await panel.innerText()).includes('12 leads untouched'), 'last scout finding (company page)');
  ok((await panel.locator('[data-task="0601"]').count()) === 1, 'the project’s tasks');
  ok((await panel.locator('[data-num="leads"] svg path').count()) >= 1, 'number history sparkline');
  ok((await panel.locator('[data-question="q_dry1"]').count()) === 1, 'the question shows on the project');
  await waitImages(phone);
  await calm(phone);
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company.png') });
  const before2 = (await chats()).length;
  await panel.locator('[data-levels="dryager-panel"] button', { hasText: 'Fix' }).click();
  await until(async () => (await chats()).length > before2, 4000, 'level chat').catch(() => {});
  ok((await chats()).some((t) => t === 'HQ: set Dry-ager panel (dryager-panel) autonomy to Fix with undo (level 3, was Suggest). Saved to the HQ registry.'), 'level → Mia told with old and new level');
  ok((await relayJarvis()).pending.some((c) => c.action === 'level' && c.project === 'dryager-panel' && c.level === 3), 'level → relay queue');
  ok((await panel.locator('[data-undo="dryager-panel"]').count()) === 1, 'Undo offered');
  await panel.locator('[data-levels]').scrollIntoViewIfNeeded();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-level-fix-undo.png') });
  await panel.locator('[data-undo="dryager-panel"]').click();
  await until(async () => (await chats()).some((t) => t.includes('autonomy to Suggest (level 2, was Fix with undo)')), 4000, 'undo chat').catch(() => {});
  ok((await chats()).some((t) => t.includes('autonomy to Suggest (level 2, was Fix with undo)')), 'Undo → Mia told it went back');
  // Leave it on Watch for the sync check below.
  await panel.locator('[data-levels="dryager-panel"] button', { hasText: 'Watch' }).click();
  await sleep(500);
  await panel.locator('[data-scout="dryager-panel"]').click();
  await until(async () => (await chats()).some((t) => t.startsWith('HQ: scout Dry-ager panel')), 4000, 'scout').catch(() => {});
  ok((await chats()).some((t) => t.startsWith('HQ: scout Dry-ager panel (dryager-panel) now.')), 'Scout this now → Mia');
  ok((await panel.locator('[data-scout="dryager-panel"]').innerText()).includes('Scout asked'), 'the button says it was asked');
  const ss2 = await noSideScroll(phone);
  ok(ss2.ok, `no sideways scroll on the company page ${ss2.bad.join(' ')}`);

  console.log('The Mac applies it — mia jarvis sync');
  const r = await mia('sync');
  ok(r.status === 0, 'sync ran');
  const R = reg();
  ok(R.projects.find((p) => p.id === 'dryager-panel').autonomy === 1, 'registry.json: dry-ager on Watch (last tap wins)');
  ok(R.jarvis.paused === true && R.jarvis.pitchesPerDay === 0.5 && R.projects.find((p) => p.id === 'dryager-panel').scoutRequestedAt, 'registry.json: paused, quieter, scout stamped');
  ok(JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'schedule.json'), 'utf8')).heartbeats[0].enabled === false, 'pause switched hb_scout off');
  ok((await relayJarvis()).pending.length === 0, 'relay queue empty');
  await phone.locator('[data-sync]').click();
  await until(async () => /Mac just now/.test(await phone.locator('[data-sync]').innerText()), 5000, 'synced chip').catch(() => {});
  ok(/Mac just now/.test(await phone.locator('[data-sync]').innerText()), 'HQ shows it synced');
  ok((await phone.locator('[data-company-page] [data-levels="dryager-panel"] button[aria-pressed="true"]').innerText()).includes('Watch'), 'HQ shows the applied level');
  await phone.locator('[data-back]').click();
  await phone.waitForSelector('[data-company="dryager"]');
  ok((await phone.evaluate(() => location.hash)) === '#hq', 'back arrow returns to the board');

  console.log('iPad portrait 820×1180');
  const ipadP = await newPage(browser, { width: 820, height: 1180 });
  pages.push(ipadP);
  await openHQ(ipadP);
  await waitImages(ipadP);
  const cols = await ipadP.locator('[data-company]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
  ok(cols === 3, `three columns of tiles (${cols})`);
  ok((await noSideScroll(ipadP)).ok, 'no sideways scroll');
  await ipadP.screenshot({ path: path.join(SHOTS, 'ipad-portrait-board.png') });
  await ipadP.locator('[aria-label="Open Games"]').click();
  await ipadP.waitForSelector('[data-company-page="games"]');
  await sleep(800);
  await waitImages(ipadP);
  await calm(ipadP);
  await ipadP.screenshot({ path: path.join(SHOTS, 'ipad-portrait-games.png') });

  console.log('iPad landscape 1180×820 — deep link');
  const ipadL = await newPage(browser, { width: 1180, height: 820 }, '#hq/oblivion');
  pages.push(ipadL);
  await ipadL.waitForSelector('[data-company-page="oblivion"]', { timeout: 8000 });
  await sleep(900);
  await waitImages(ipadL);
  ok(true, '#hq/oblivion opens the company page directly');
  ok((await noSideScroll(ipadL)).ok, 'no sideways scroll');
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-oblivion.png') });
  await ipadL.locator('[data-back]').click();
  await ipadL.waitForSelector('[data-company="klear"]');
  await sleep(900);
  await waitImages(ipadL);
  await calm(ipadL);
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-board.png') });
  // Resume from the iPad; the Mac applies it.
  await ipadL.locator('[data-jarvis] [data-pause]').click();
  await until(async () => (await chats()).some((t) => t.startsWith('HQ: resume.')), 4000, 'resume').catch(() => {});
  ok((await chats()).some((t) => t.startsWith('HQ: resume.')), 'Resume → Mia');
  await mia('sync');
  ok(reg().jarvis.paused === false && JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'schedule.json'), 'utf8')).heartbeats[0].enabled === true, 'resume applied; hb_scout back on');

  console.log('Console');
  const errs = pages.flatMap((p) => p.errors);
  ok(errs.length === 0, `zero console errors${errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''}`);

  await browser.close();
}

main()
  .catch((e) => {
    failed += 1;
    console.error(e);
  })
  .finally(() => {
    for (const p of procs) p.kill();
    hs.close();
    console.log(`\n${passed} passed, ${failed} failed${process.env.SHOTS ? '' : ` — shots in ${SHOTS}`}`);
    process.exit(failed ? 1 : 0);
  });
