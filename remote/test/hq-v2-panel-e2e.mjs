// HQ v2 end to end (task 0204): company-centric data and the company page.
// The real relay, the fake host as the Mac (with a temp Library), the real
// `mia jarvis` CLI (upgrade + sync), the built panel in headless Chromium.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/hq-v2-panel-e2e.mjs
//
//   • board: compact tiles (2 / 3 / 4 columns at phone / iPad portrait /
//     landscape), tile → company page (shared photo), back
//   • company page tabs: Overview (history chart with readout), Knowledge
//     (facts with file+line or doc source, redacted, searchable), Library
//     (docs filed by frontmatter company / rules, opens the doc), Tasks
//     (explicit --company filing), Actions (sheet with input + preview →
//     Mia's thread gets the [MC] job, relay queue, sync logs an action finding)
//   • Library view: the company filter row
//   • no sideways scroll, zero console errors. SHOTS=<dir> keeps screenshots.

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
const PORT = 8873;
const HPORT = 8874;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hq2-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
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
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, FAKE_HOST_LIBRARY: LIB, FAKE_HOST_PAGE_KIND: '1', JARVIS_STORE: path.join(TMP, 'jarvis.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
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
const ENV = { ...process.env, MIA_DIR, MC_LIBRARY: LIB, MC_RELAY_URL: BASE, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' };
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


function writeLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  const doc = (name, front, body) => fs.writeFileSync(path.join(LIB, `${name}.md`), `---\n${front}\n---\n${body}\n`);
  doc('raw-incident-hooks', 'kind: research\nstatus: done\nsubject: Bodycam channel\ntags: youtube, research\ncompany: video\ncreated: 2026-10-10T10:00:00Z', '# Raw Incident: what makes bodycam videos work\n\n**Answer:** Let the footage breathe, explain after, and open on the most tense second.\n\nMore text here.');
  doc('crystal-retention', 'kind: plan\nstatus: active\nsubject: Crystal Garden\ntags: roblox\ncreated: 2026-10-11T10:00:00Z', '# Crystal Garden: come back tomorrow\n\nA plan to lift day-1 retention from 18% to 25% with a daily harvest and a streak.');
  doc('mandates-fresnaye', 'kind: research\nstatus: done\nsubject: Oblivion\ntags: mandate\ncreated: 2026-10-09T10:00:00Z', '# Mandate targets in Fresnaye\n\n**In one line:** Nine homes over R10m look ready to sell; three have owners who bought before 2010.');
  doc('lunch-ideas', 'kind: note\nstatus: draft\ncreated: 2026-10-08T10:00:00Z', '# Lunch ideas\n\nSomething unrelated to any company at all, just a note.');
}
function writeMemory() {
  fs.mkdirSync(path.join(MIA_DIR, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'memory', 'video.md'), '# Video pipelines\n\n## Bodycam\n- Bodycam style: narration must NOT talk over footage; let moments play.\n- Channel contact is producer@example.com for brand deals.\n- Keep generated videos on the Mac only, never on the VPS.\n');
  fs.writeFileSync(path.join(MIA_DIR, 'memory', 'oblivion.md'), '# Oblivion\n\n## Engine\n- Prod is the VPS root@203.0.113.9, password: hunter2, call +27 82 555 1234.\n- Daniel wants ADDRESS + ERF only in dossiers.\n');
}

async function seed() {
  fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [{ id: 'hb_scout', label: 'Scout', enabled: true, prompt: 'x' }], reminders: [] }));
  writeLibrary();
  writeMemory();
  let r = await mia('seed');
  ok(r.status === 0, 'mia jarvis seed');
  const R = reg();
  const hist = (vals) => vals.map((v, i) => ({ t: iso((vals.length - 1 - i) * 24), v }));
  for (const p of R.projects) {
    p.probes = [];
    if (p.healthcheck) p.healthcheck = { type: 'http', target: `http://localhost:${HPORT}/ok` };
    if (p.id === 'dryager-panel') p.metrics = [{ name: 'leads', label: 'Leads', unit: '', better: 'up', value: 73, at: iso(0), source: 'mia', history: hist([40, 44, 47, 51, 58, 61, 66, 73]) }];
    if (p.id === 'bodycam') p.metrics = [{ name: 'views', label: 'Views', unit: '', better: 'up', value: 1840, at: iso(0), source: 'mia', history: hist([120, 300, 650, 900, 1300, 1840]) }];
  }
  fs.writeFileSync(REG(), JSON.stringify(R, null, 2));
  const task = (id, title, status, extra = {}, h = 0) => fs.writeFileSync(path.join(MIA_DIR, 'tasks', `${id}.json`), JSON.stringify({ id, title, status, dir: '', createdAt: iso(h + 1), updatedAt: iso(h), ...extra }));
  task('0701', 'Cut the Phoenix stop intro', 'running', { company: 'video', project: 'bodycam', routing: { tier: 'mid', model: 'claude-sonnet-5-5' } });
  task('0702', 'Thumbnail tests', 'done', { company: 'video' }, 5);
  task('0703', 'Crystal Garden streak reward', 'done', {}, 30);
  r = await mia('upgrade');
  ok(r.status === 0 && /companies with actions/.test(r.out), `mia jarvis upgrade (${r.out.trim()})`);
  r = await mia('sync', '--health');
  ok(r.status === 0 && /pushed/.test(r.out), 'mia jarvis sync pushed');
  const st = (await relayJarvis()).state;
  ok(st?.schema === 2 && Array.isArray(st.docs) && st.knowledge?.video?.length > 0, 'relay holds schema 2: docs index + knowledge');
  const filed = Object.fromEntries(st.docs.map((d) => [d.id, d.company]));
  ok(filed['raw-incident-hooks'] === 'video' && filed['crystal-retention'] === 'games' && filed['mandates-fresnaye'] === 'oblivion' && filed['lunch-ideas'] === '', `docs filed by company (${JSON.stringify(filed)})`);
  ok(st.tasks.find((t) => t.id === '0702')?.company === 'video', 'a task filed with --company keeps it');
  const k = JSON.stringify(st.knowledge);
  ok(!/hunter2|203\.0\.113\.9|producer@example|555 1234/.test(k), 'knowledge leaves secrets and contact details on the Mac');
}

const cols = (page) => page.locator('[data-company]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
async function openCompany(page, name, id) {
  await page.locator(`[aria-label="Open ${name}"]`).click();
  await page.waitForSelector(`[data-company-page="${id}"]`);
  await sleep(900);
}
async function tab(page, t) {
  await page.locator(`[data-tab="${t}"]`).click();
  await page.waitForSelector(`[data-section="${t}"]`);
  await sleep(500);
}

async function main() {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  writeLibrary();
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  console.log('Registry v2 on the Mac → relay');
  await seed();

  const browser = await chromium.launch();
  const pages = [];

  console.log('Phone 390×844');
  const phone = await newPage(browser, { width: 390, height: 844 });
  pages.push(phone);
  await openHQ(phone);
  ok((await cols(phone)) === 2, 'two columns of compact tiles');
  const h = await phone.locator('[data-company="video"]').evaluate((e) => e.getBoundingClientRect().height);
  ok(h < 240, `tiles are compact (${Math.round(h)}px)`);
  ok((await noSideScroll(phone)).ok, 'no sideways scroll (board)');
  await waitImages(phone);
  await calm(phone);
  await phone.screenshot({ path: path.join(SHOTS, 'phone-board.png') });

  await openCompany(phone, 'YouTube & video', 'video');
  ok((await phone.locator('[data-tab]').count()) === 5, 'five tabs');
  const tabsBox = await phone.locator('[data-tabs] [role="tablist"]').boundingBox();
  ok(tabsBox && tabsBox.x >= 0 && tabsBox.x + tabsBox.width <= 391, 'the tab bar fits the phone');
  ok((await phone.locator('[data-quick-actions] [data-action]').count()) >= 3, 'quick actions under the photo');
  ok((await phone.locator('[data-chart="views"] svg path').count()) >= 2, 'history chart for Views');
  const chart = phone.locator('[data-chart="views"] [role="img"]');
  const cb = await chart.boundingBox();
  await phone.mouse.move(cb.x + 4, cb.y + cb.height / 2);
  await sleep(200);
  ok(/\b120\b/.test(await phone.locator('[data-chart="views"]').innerText()), 'chart readout follows the pointer (first value 120)');
  ok((await noSideScroll(phone)).ok, 'no sideways scroll (company)');
  await calm(phone);
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company-overview.png') });

  await tab(phone, 'knowledge');
  const kt = await phone.locator('[data-section="knowledge"]').innerText();
  ok(/let moments play/.test(kt) && /video\.md · line 4/.test(kt), 'a memory fact with file + line');
  ok(/Let the footage breathe/.test(kt) && (await phone.locator('[data-source-doc="raw-incident-hooks"]').count()) === 1, 'a doc fact with a tappable source');
  ok(!/producer@example/.test(kt), 'the email is redacted');
  await phone.locator('[data-knowledge-search]').fill('vps');
  await sleep(300);
  ok((await phone.locator('[data-section="knowledge"] [data-fact]').count()) === 1, 'knowledge search narrows to one fact');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company-knowledge.png') });
  await phone.locator('[data-knowledge-search]').fill('');

  await tab(phone, 'library');
  ok((await phone.locator('[data-section="library"] [data-doc]').count()) === 1, 'Library tab: the doc filed under video');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company-library.png') });

  await tab(phone, 'tasks');
  const tt = await phone.locator('[data-section="tasks"]').innerText();
  ok(/Cut the Phoenix stop intro/.test(tt) && /Sonnet/.test(tt), 'running task with its tier');
  await phone.locator('[data-section="tasks"] button', { hasText: 'All' }).click();
  await sleep(300);
  ok(/Thumbnail tests/.test(await phone.locator('[data-section="tasks"]').innerText()), 'a task filed by --company shows under All');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company-tasks.png') });

  await tab(phone, 'actions');
  ok((await phone.locator('[data-section="actions"] [data-action]').count()) === 3, 'three video actions (new video, upload, scout)');
  await phone.locator('[data-section="actions"] [data-action="new-video"]').click();
  await phone.waitForSelector('[data-action-sheet="new-video"]');
  await sleep(500);
  ok(await phone.locator('[data-action-send]').isDisabled(), 'Send waits for the topic');
  await phone.locator('[data-action-input="topic"]').fill('the 2019 Phoenix traffic stop');
  ok(/on the 2019 Phoenix traffic stop\./.test(await phone.locator('[data-action-preview]').innerText()), 'the preview shows what Mia gets');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-action-sheet.png') });
  await phone.locator('[data-action-send]').click();
  await until(async () => (await chats()).some((t) => t.startsWith('HQ action · YouTube & video · Bodycam channel · Make a new video: Make a new bodycam video on the 2019 Phoenix traffic stop.')), 4000, 'action chat').catch(() => {});
  ok((await chats()).some((t) => t.startsWith('HQ action · YouTube & video · Bodycam channel · Make a new video: Make a new bodycam video on the 2019 Phoenix traffic stop.') && /Suggested tier: smart \(Opus\)/.test(t)), 'Mia gets the job through the chat path, with its tier');
  const pend = (await relayJarvis()).pending || [];
  ok(pend.some((c) => c.action === 'action' && c.company === 'video' && c.actionId === 'new-video' && c.inputs.topic === 'the 2019 Phoenix traffic stop' && c.told === true), 'the relay queued it for the Mac');
  await sleep(600);
  ok(/sending/.test(await phone.locator('[data-section="actions"] [data-action="new-video"]').innerText()), 'the button shows it is on its way');
  const r = await mia('sync');
  ok(r.status === 0, 'mia jarvis sync applies it');
  const fl = fs.readFileSync(path.join(MIA_DIR, 'jarvis', 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(fl.some((f) => f.kind === 'action' && f.company === 'video' && f.action === 'new-video' && f.project === 'bodycam' && /Phoenix/.test(f.text)), 'logged as an action finding under video/bodycam');
  await phone.locator('[data-sync]').click();
  await until(async () => /sent/.test(await phone.locator('[data-section="actions"] [data-action="new-video"]').innerText()), 5000, 'sent').catch(() => {});
  ok(/sent just now/.test(await phone.locator('[data-section="actions"] [data-action="new-video"]').innerText()), 'the button says when it was sent');
  await calm(phone);
  await phone.screenshot({ path: path.join(SHOTS, 'phone-company-actions.png') });
  ok((await noSideScroll(phone)).ok, 'no sideways scroll (tabs)');

  // A doc from the Library tab opens the doc itself.
  await tab(phone, 'library');
  await phone.locator('[data-section="library"] [data-doc^="raw-incident-hooks"]').click();
  await until(async () => /#doc\//.test(await phone.evaluate(() => location.hash)), 4000, 'doc open').catch(() => {});
  ok(/#doc\/raw-incident-hooks/.test(await phone.evaluate(() => location.hash)), 'tapping a filed doc opens it');

  console.log('iPad portrait 820×1180');
  const ipadP = await newPage(browser, { width: 820, height: 1180 });
  pages.push(ipadP);
  await openHQ(ipadP);
  await waitImages(ipadP);
  ok((await cols(ipadP)) === 3, 'three columns of tiles');
  ok((await noSideScroll(ipadP)).ok, 'no sideways scroll');
  await calm(ipadP);
  await ipadP.screenshot({ path: path.join(SHOTS, 'ipad-portrait-board.png') });
  await openCompany(ipadP, 'Dry-ager', 'dryager');
  ok((await ipadP.locator('[data-chart="leads"]').innerText()).includes('73'), 'Dry-ager leads chart');
  ok((await noSideScroll(ipadP)).ok, 'no sideways scroll (company)');
  await calm(ipadP);
  await ipadP.screenshot({ path: path.join(SHOTS, 'ipad-portrait-dryager.png') });
  await ipadP.locator('[data-back]').click();
  await ipadP.waitForSelector('[data-company="games"]');
  await sleep(700);
  ok((await ipadP.locator('[data-company]').count()) === 8, 'back to the board');

  console.log('iPad landscape 1180×820');
  const ipadL = await newPage(browser, { width: 1180, height: 820 });
  pages.push(ipadL);
  await openHQ(ipadL);
  await waitImages(ipadL);
  ok((await cols(ipadL)) === 4, 'four columns of tiles');
  ok((await noSideScroll(ipadL)).ok, 'no sideways scroll');
  await calm(ipadL);
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-board.png') });
  await openCompany(ipadL, 'Oblivion Estates', 'oblivion');
  await tab(ipadL, 'knowledge');
  const ok2 = await ipadL.locator('[data-section="knowledge"]').innerText();
  ok(/ADDRESS \+ ERF/.test(ok2) && !/hunter2|203\.0\.113\.9/.test(ok2) && /‹hidden›/.test(ok2), 'Oblivion knowledge: redacted password and host');
  ok(/Nine homes over R10m/.test(ok2), 'the mandate doc (company keyword) is known');
  await calm(ipadL);
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-oblivion-knowledge.png') });
  await tab(ipadL, 'actions');
  ok((await ipadL.locator('[data-section="actions"] [data-action="mandate-targets"]').count()) === 1, 'Oblivion: Find mandate targets');
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-oblivion-actions.png') });

  console.log('Library filed by company');
  await ipadL.locator('nav button[aria-label="Library"]').click();
  await ipadL.waitForSelector('[data-company-filter]', { timeout: 8000 });
  await sleep(600);
  await ipadL.locator('[data-company-filter] [data-co="games"]').click();
  await sleep(700);
  const titles = await ipadL.locator('main, body').first().innerText();
  ok(/Crystal Garden: come back tomorrow/.test(titles) && !/Lunch ideas/.test(titles), 'the Games chip shows only Games docs');
  ok((await ipadL.locator('[data-company-filter] [data-co="unfiled"]').count()) === 1, 'a Not filed chip for the rest');
  await ipadL.screenshot({ path: path.join(SHOTS, 'ipad-landscape-library-by-company.png') });

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
