// Dismissing Mia's questions and hiding old ones — end to end in a browser
// (task 0103, docs/mia.md §8.4).
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/questions-panel-e2e.mjs
//
// Boots the real relay and the fake host (as MiaManager) with MIA_DIR pointed
// at a temp dir, feeds Mia's questions in through messages.jsonl — some fresh,
// some days old — and drives the built panel in headless Chromium:
//   • old questions are hidden: no home card, not in the Mia badge, the home
//     sentence or anything read aloud; the "N old questions hidden" bar shows
//   • the X on a home card dismisses it, on this panel and on a second one,
//     and Mia gets "[MC] Daniel dismissed q_…" (events.jsonl)
//   • a sideways swipe dismisses a card; a short drag springs back
//   • (0290) Home shows only the last hour; Mia's chat holds the old ones and
//     "Dismiss all old" closes every one with one
//     [MC] line; the thread then labels them Dismissed
//   • the Settings age (24 h) re-sorts what counts as old
//   • phone width: card, X and bar fit; zero console errors throughout
// Own ports (8869) so it can run beside the other E2Es. SHOTS=<dir> keeps screenshots.

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
const PORT = 8869;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-questions-'));
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
function boot(args, name, extra = {}) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, ...extra, PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
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

const iso = (hAgo) => new Date(Date.now() - hAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
let seq = 0;
function ask(id, hAgo, text, options = []) {
  seq += 1;
  const m = { id: `m_9${String(seq).padStart(3, '0')}`, at: iso(hAgo), from: 'mia', kind: 'question', text, options, questionId: id };
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), JSON.stringify(m) + '\n');
}
const events = () => {
  try {
    return fs.readFileSync(path.join(MIA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
  } catch {
    return [];
  }
};
const snap = async () => (await (await fetch(`${BASE}/api/v1/mia`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).mia;

const INIT = () => {
  window.__said = [];
  const synth = {
    paused: false, speaking: false,
    speak(u) { if (String(u.text).trim()) window.__said.push(u.text); setTimeout(() => u.onend && u.onend(), 30); },
    cancel() {}, resume() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
};

async function newPage(browser, viewport, base = BASE) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(`console: ${m.text()}`); });
  await page.route('**/tts', (r) => r.fulfill({ status: 204, body: '' })); // no audio → device voice → __said
  await page.goto(`${base}/?token=${TOKEN}`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await sleep(1200);
  return page;
}
const card = (page, id) => page.locator(`[data-question="${id}"]`);
const visible = async (page, id) => (await card(page, id).count()) > 0 && card(page, id).first().isVisible();
const miaBadge = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('nav button[aria-label^="Mia"]')].map((x) => x.getAttribute('aria-label'));
  const m = /Mia, (\d+) new/.exec(b[0] || '');
  return m ? Number(m[1]) : 0;
});

async function main() {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  const browser = await chromium.launch();

  console.log('Old questions hidden — iPad landscape 1180×820');
  const page = await newPage(browser, { width: 1180, height: 820 });
  await page.evaluate(() => localStorage.setItem('mc.announce.quiet', JSON.stringify({ on: false, from: '22:00', to: '07:00' })));
  await page.mouse.click(600, 120); // a tap: unlocks read-aloud, like Daniel touching the iPad
  const baseBadge = await miaBadge(page);

  ask('q_old1', 24 * 10, 'Old one: which agent for the deck? (ten days ago)', ['A', 'B']);
  ask('q_old2', 24 * 5, 'Old two: Fetzer viewing on Friday?', ['Yes', 'No']);
  ask('q_old3', 72, 'Old three: renew the domain?', ['Renew', 'Let it lapse']);
  ask('q_day', 30, 'A day-old one: keep the Sunset Hill alert?', ['Keep', 'Drop']);
  ask('q_new1', 0.005, 'Fresh one: ship the Diplomat mode?', ['Deploy', 'Not yet']);
  ask('q_new2', 0.002, 'Fresh two: switch the Fetzer links to Dylan?', ['Switch', 'Keep']);
  await until(() => visible(page, 'q_new1'), 8000, 'fresh cards on home').catch(() => {});
  const more = page.getByRole('button', { name: /^\+\d+ more$/ });
  if (await more.count()) await more.click(); // past the first three cards
  await sleep(2500); // announcements run

  const s0 = await snap();
  ok(s0.questionMaxAgeHours === 48, 'the snapshot carries the 48 h default');
  ok(['q_old1', 'q_old2', 'q_old3'].every((id) => s0.oldQuestions.some((q) => q.questionId === id))
    && !s0.pendingQuestions.some((q) => /^q_old/.test(q.questionId)), 'questions over 48 h ride as oldQuestions, not pendingQuestions');
  ok(await visible(page, 'q_new1') && await visible(page, 'q_new2'), 'fresh questions get home cards');
  ok(!(await card(page, 'q_old1').count()) && !(await card(page, 'q_old3').count()), 'old questions get no home card');
  // Since task 0290 Home shows only the last hour's questions; older open ones
  // (the 30 h one here) sit behind one small link, the hidden old ones in Mia's chat.
  ok(!(await card(page, 'q_day').count()) && (await page.locator('[data-older-questions="1"]').count()) === 1
    && (await page.locator('[data-older-questions]').innerText()).includes('1 older question'), 'home: the 30 h question is one link away, not a card');
  ok(!(await page.locator('[data-old-questions]').count()), 'home: no old-questions bar any more');
  const badge = await miaBadge(page);
  ok(badge - baseBadge === 3, `the Mia badge counts the 3 new fresh questions only (+${badge - baseBadge})`);
  const said = await page.evaluate(() => window.__said.join(' | '));
  ok(!/Old one|Old two|Old three/.test(said), 'old questions are never read aloud');
  ok(/Fresh (one|two)/.test(said), `a fresh question is read aloud (${said.slice(0, 200)})`);
  await page.screenshot({ path: path.join(SHOTS, 'home-ipad.png') });

  console.log('Dismiss one — the X');
  const other = await newPage(browser, { width: 820, height: 1180 }); // a second device
  ok(await visible(other, 'q_new1'), 'the second panel shows q_new1 too');
  await card(page, 'q_new1').locator('[aria-label="Dismiss question"]').click();
  await until(async () => !(await card(page, 'q_new1').count()), 4000, 'card leaves').catch(() => {});
  ok(!(await card(page, 'q_new1').count()), 'the card leaves at once');
  await until(() => events().some((e) => e.includes('q_new1')), 4000, 'event').catch(() => {});
  const e1 = events().find((e) => e.includes('q_new1')) || '';
  ok(e1.startsWith('[MC] Daniel dismissed q_new1') && e1.includes("don't wait on it") && e1.includes('Diplomat'), 'Mia gets "[MC] Daniel dismissed q_new1 …"');
  const s1 = await until(async () => { const s = await snap(); return s.closedQuestions?.q_new1 ? s : null; }, 4000, 'snap 1').catch(snap);
  ok(s1.closedQuestions.q_new1 === 'dismissed' && !s1.pendingQuestions.some((q) => q.questionId === 'q_new1'), 'dismissed on the host — closedQuestions has it');
  await until(async () => !(await card(other, 'q_new1').count()), 4000, 'other device').catch(() => {});
  ok(!(await card(other, 'q_new1').count()), 'gone on the second panel too');

  console.log('Dismiss one — swipe');
  const box = await card(page, 'q_new2').boundingBox();
  const y = box.y + 22;
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(box.x + 60 + i * 5, y); await sleep(40); }
  await sleep(150);
  await page.mouse.up();
  await sleep(700);
  ok(await visible(page, 'q_new2'), 'a short, slow drag springs back and keeps the card');
  ok((await page.evaluate(() => location.hash)) !== '#mia', 'letting go of a drag does not also open Mia');
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, y, { steps: 10 });
  await page.mouse.up();
  await until(async () => !(await card(page, 'q_new2').count()), 4000, 'swiped away').catch(() => {});
  ok(!(await card(page, 'q_new2').count()), 'a long swipe dismisses the card');
  await until(() => events().some((e) => e.includes('q_new2')), 4000, 'event 2').catch(() => {});
  ok(events().some((e) => e.startsWith('[MC] Daniel dismissed q_new2')), 'Mia is told about the swiped one');
  ok((await page.evaluate(() => location.hash)) !== '#mia', 'the swipe stayed on home');

  console.log('Mia\'s chat: the old questions, then Dismiss all old');
  await page.locator('[data-older-questions]').click();
  await page.waitForSelector('[data-mia-view]', { timeout: 5000 });
  await sleep(900);
  const bar = page.locator('[data-old-questions]').first();
  ok((await bar.innerText()).includes('3 old questions hidden'), 'the chat says "3 old questions hidden"');
  ok(/Old one: which agent/.test(await page.evaluate(() => document.body.innerText)), 'the old questions stay readable in the thread');
  await page.screenshot({ path: path.join(SHOTS, 'mia-old.png') });
  await bar.getByRole('button', { name: 'Dismiss all old' }).click();
  await until(async () => !(await page.locator('[data-old-questions]').count()), 4000, 'bar leaves').catch(() => {});
  ok(!(await page.locator('[data-old-questions]').count()), 'the bar leaves once they are dismissed');
  await until(() => events().some((e) => e.includes('3 old questions')), 4000, 'event all').catch(() => {});
  const e3 = events().find((e) => e.includes('3 old questions')) || '';
  ok(e3.startsWith('[MC] Daniel dismissed 3 old questions') && ['q_old1', 'q_old2', 'q_old3'].every((id) => e3.includes(id)), 'Mia gets one line naming all three');
  const s3 = await until(async () => { const s = await snap(); return s.oldQuestions.length ? null : s; }, 4000, 'snap 3').catch(snap);
  ok(!s3.oldQuestions.length && ['q_old1', 'q_old2', 'q_old3'].every((id) => s3.closedQuestions[id] === 'dismissed'), 'all three closed on the host, none deleted');
  ok(s3.messages.filter((m) => /^q_old/.test(m.questionId || '')).length === 3, 'the questions stay in the thread history');
  ok(s3.pendingQuestions.some((q) => q.questionId === 'q_day') && s3.pendingQuestions.some((q) => q.questionId === 'q_seed1'), 'the day-old and task questions are untouched');

  console.log('Thread labels');
  await page.goto(`${BASE}/?token=${TOKEN}#mia`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000 });
  await sleep(1500);
  const thread = await page.evaluate(() => document.body.innerText);
  ok((thread.match(/Dismissed/g) || []).length >= 5, 'the thread marks dismissed questions "Dismissed"');
  ok((await page.locator('[aria-label="Dismiss question"]').count()) >= 2, 'open questions in the thread have an X');

  console.log('Settings: hide after 24 h');
  await page.goto(`${BASE}/?token=${TOKEN}#settings`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000 });
  await sleep(1200);
  const sec = page.locator('section', { hasText: "Mia's questions" });
  ok(await sec.isVisible(), 'Settings has a "Mia\'s questions" section');
  ok((await sec.locator('button[aria-pressed="true"]').innerText()).trim() === '48 h', '48 h is selected');
  await sec.getByRole('button', { name: '24 h' }).click();
  await until(async () => (await snap()).questionMaxAgeHours === 24, 4000, 'age saved').catch(() => {});
  const s4 = await snap();
  ok(s4.questionMaxAgeHours === 24, 'the age is saved on the host');
  ok(s4.oldQuestions.some((q) => q.questionId === 'q_day') && !s4.pendingQuestions.some((q) => q.questionId === 'q_day'), 'the 30 h question is now old');
  await page.goto(`${BASE}/?token=${TOKEN}#home`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000 });
  await sleep(1500);
  ok(!(await card(page, 'q_day').count()) && !(await page.locator('[data-older-questions]').count()), 'home: once old it leaves the "older" link too');

  console.log('Phone 390×844');
  const phone = await newPage(browser, { width: 390, height: 844 });
  await until(() => visible(phone, 'q_seed1'), 6000, 'phone card').catch(() => {});
  const c = await card(phone, 'q_seed1').boundingBox();
  const x = await card(phone, 'q_seed1').locator('[aria-label="Dismiss question"]').boundingBox();
  ok(c && x && x.x + x.width <= c.x + c.width + 1 && x.width >= 32, 'the X sits inside the card, a thumb-sized target');
  ok(c && c.x >= 0 && c.x + c.width <= 390, 'the card fits the phone width');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
  await phone.screenshot({ path: path.join(SHOTS, 'home-phone.png') });

  console.log('A Mac app from before 0103');
  const LPORT = PORT - 1;
  const LBASE = `http://localhost:${LPORT}`;
  boot(['server.js'], 'relay-legacy', { PORT: String(LPORT), MIA_DIR: path.join(TMP, 'mia-legacy') });
  await until(async () => (await fetch(`${LBASE}/health`).catch(() => null))?.ok, 5000, 'legacy relay');
  boot(['test/fake-host.mjs'], 'host-legacy', { PORT: String(LPORT), MIA_DIR: path.join(TMP, 'mia-legacy'), FAKE_HOST_LEGACY_MIA: '1' });
  await until(async () => (await (await fetch(`${LBASE}/health`)).json()).host, 8000, 'legacy host');
  const legacy = await newPage(browser, { width: 1180, height: 820 }, LBASE);
  await until(() => visible(legacy, 'q_seed1'), 6000, 'legacy card').catch(() => {});
  ok(await visible(legacy, 'q_seed1'), 'questions still show as cards');
  ok(!(await legacy.locator('[aria-label="Dismiss question"]').count()) && !(await legacy.locator('[data-old-questions]').count()),
    'no X, swipe or old-questions bar the Mac could not honour');

  const errs = [...page.errors, ...other.errors, ...phone.errors, ...legacy.errors];
  ok(errs.length === 0, `zero console errors${errs.length ? `: ${errs.join(' / ')}` : ''}`);
  await browser.close();
}

main()
  .catch((e) => { failed += 1; console.error('  ✗', e.message); })
  .finally(() => {
    for (const p of procs) p.kill();
    console.log(`\n${passed} passed, ${failed} failed${process.env.SHOTS ? '' : ` (screenshots: ${SHOTS})`}`);
    process.exit(failed ? 1 : 0);
  });
