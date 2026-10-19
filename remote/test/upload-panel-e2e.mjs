// Files for Mia, end to end in a browser (docs/mia.md §8.4).
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/upload-panel-e2e.mjs
//
// Boots the real relay and the fake host (MIA_DIR in a temp dir), opens the
// built panel in headless Chromium as the iPad Home Screen app and as a phone,
// and uses the Mia thread's upload button like Daniel would: pick two files,
// add a note, send, watch the progress (on a throttled uplink), see the cards
// land in the thread, and find the files on disk with Mia's [MC] events.
// Also: unsupported type and Mac-offline refusals, the phone layout, and the
// ⌘K "Send a file to Mia" entry. Own port (8876). SHOTS=<dir> saves screenshots.

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
const PORT = 8876;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upload-e2e-'));
const MIA_DIR = path.join(TMP, 'mia');
const SHOTS = process.env.SHOTS || '';

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
    env: { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), TTS_STORE: path.join(TMP, 'tts.json'), OPENAI_API_KEY: '', UPLOAD_TMP: path.join(TMP, 'relay-tmp') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}
const events = () => {
  try {
    return fs.readFileSync(path.join(MIA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// Test files on disk for the picker.
const F = path.join(TMP, 'files');
fs.mkdirSync(F, { recursive: true });
const pdfPath = path.join(F, 'Oblivion brief.pdf');
fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(900 * 1024, 32), Buffer.from('\n%%EOF\n')]));
const csvPath = path.join(F, 'budget.csv');
fs.writeFileSync(csvPath, 'item,cost\nhosting,12\n');
const exePath = path.join(F, 'setup.exe');
fs.writeFileSync(exePath, 'MZ');

async function newPage(browser, { viewport, standalone = true }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  if (standalone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/?token=${TOKEN}`);
  // Linked (the pill is only visible from sm: up, so attached is enough).
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await page.evaluate(() => { location.hash = '#mia'; });
  await clip(page).waitFor({ timeout: 5000 });
  await sleep(800);
  return page;
}

// The chat's paperclip (task 0290) opens the Attach sheet; "Photo or file"
// there is the file picker.
const clip = (page) => page.locator('[data-attach-button]').first();
async function chooseFiles(page) {
  await clip(page).click();
  await page.locator('[data-attach-files]').waitFor({ timeout: 4000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-attach-files]').click()]);
  return chooser;
}

async function pick(page, files) {
  const chooser = await chooseFiles(page);
  ok(chooser.isMultiple(), 'the picker allows several files');
  await chooser.setFiles(files);
}

let browser = null;
async function main() {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  let host = boot(['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  browser = await chromium.launch();

  console.log('iPad portrait, Home Screen app — pick, note, send');
  {
    const page = await newPage(browser, { viewport: { width: 820, height: 1180 } });
    await pick(page, [pdfPath, csvPath]);
    const accepts = await page.evaluate(() => document.querySelector('input[type=file]')?.accept || '');
    ok(/image\/\*/.test(accepts) && /audio\/\*/.test(accepts) && /\.pdf/.test(accepts) && /\.docx/.test(accepts), 'the picker offers photos, audio, PDF and Office files');
    ok(await page.getByLabel('Files to send').getByText('Oblivion brief.pdf').isVisible(), 'picked files wait in the tray');
    ok(await page.getByLabel('Files to send').getByText('budget.csv').isVisible(), 'both of them');
    const field = page.locator('textarea').last();
    ok(/Add a note/.test(await field.getAttribute('placeholder')), 'the composer asks for an optional note');
    await field.fill('Summarise this and file it for Oblivion');
    await shot(page, 'ipad-tray');

    // A slow uplink so the progress is visible.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 5e6, uploadThroughput: 300 * 1024 });
    await page.getByLabel('Send', { exact: true }).click();
    const pct = await until(() => page.getByText(/Uploading \d+%/).first().textContent().catch(() => null), 6000, 'progress');
    ok(!!pct, `progress shows while it uploads ("${pct.trim()}")`);
    await shot(page, 'ipad-progress');
    ok(!(await page.getByLabel('Files to send').isVisible().catch(() => false)), 'the tray empties once sending starts');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    const day = new Date().toISOString().slice(0, 10);
    const saved = path.join(MIA_DIR, 'uploads', day, 'Oblivion brief.pdf');
    await until(() => fs.existsSync(path.join(MIA_DIR, 'uploads', day, 'budget.csv')), 20000, 'both files on disk');
    ok(fs.readFileSync(saved).equals(fs.readFileSync(pdfPath)), 'the PDF is on the Mac byte-for-byte');
    const ev = events().filter((e) => e.kind === 'upload').map((e) => e.text);
    ok(ev.length === 2 && ev[0] === `[MC] Daniel uploaded a file (1 of 2): ${saved} (application/pdf, 900 KB) — note: Summarise this and file it for Oblivion`, `Mia's event: ${ev[0]}`);
    ok(/\(2 of 2\): .*budget\.csv \(text\/csv, 21 B\) — note: Summarise this/.test(ev[1] || ''), 'second file numbered 2 of 2 with the same note');
    const toast = await until(() => page.getByText('2 files sent to Mia').isVisible().catch(() => false), 5000, 'toast').catch(() => false);
    ok(toast, 'a toast confirms "2 files sent to Mia"');
    await until(async () => (await page.getByText('Saved on the Mac').count()) >= 2, 6000, 'cards').catch(() => {});
    ok((await page.getByText('Oblivion brief.pdf').count()) >= 1 && (await page.getByText(/PDF · 900 KB/).count()) >= 1, 'the thread shows the PDF card (type · size)');
    ok((await page.getByText('Summarise this and file it for Oblivion', { exact: true }).count()) === 1, 'the note shows once, under the batch');
    await shot(page, 'ipad-thread');

    console.log('refusals');
    const chooser = await chooseFiles(page);
    await chooser.setFiles([exePath]);
    ok(await page.getByText(/\.exe files aren't supported/).isVisible(), 'an unsupported type is refused on the device with the reason');
    ok(!(await page.getByLabel('Files to send').isVisible().catch(() => false)), '…and never reaches the tray');

    host.kill();
    await until(async () => !(await (await fetch(`${BASE}/health`)).json()).host, 5000, 'host gone');
    await sleep(1500);
    await pick(page, [csvPath]);
    await page.getByLabel('Send', { exact: true }).click();
    ok(await until(() => page.getByText(/Mac is offline/).first().isVisible().catch(() => false), 4000, 'offline toast').catch(() => false), 'Mac offline: a clear message, nothing sent');
    ok(await page.getByLabel('Files to send').getByText('budget.csv').isVisible(), '…and the file stays in the tray to send later');
    host = boot(['test/fake-host.mjs'], 'host2');
    await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host back');
    await sleep(2500);
    await page.getByLabel('Send', { exact: true }).click();
    ok(await until(() => page.getByText('Sent to Mia').isVisible().catch(() => false), 8000, 'sent').catch(() => false), 'once the Mac is back the same tray sends');
    ok(events().filter((e) => e.kind === 'upload').at(-1)?.text.includes('budget-2.csv'), 'saved under a unique name (budget-2.csv)');
    ok(page.errors.length === 0, `no page errors${page.errors.length ? `: ${page.errors.join(' | ')}` : ''}`);
    await page.context().close();
  }

  console.log('phone 390×844 — layout, ⌘K entry');
  {
    const page = await newPage(browser, { viewport: { width: 390, height: 844 } });
    const box = await clip(page).boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= 390 && box.width >= 44, 'the upload button is on screen and a full 44pt+ target');
    const send = await page.getByLabel('Send', { exact: true }).boundingBox();
    ok(send && send.x + send.width <= 390, 'send still fits beside it');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    ok(!wide, 'no horizontal scroll');
    await pick(page, [pdfPath]);
    const wide2 = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    ok(!wide2, 'the tray fits the phone width');
    await shot(page, 'phone-tray');
    await page.getByLabel('Remove Oblivion brief.pdf').click();
    ok(!(await page.getByLabel('Files to send').isVisible().catch(() => false)), 'a staged file can be removed');
    ok(page.errors.length === 0, 'no page errors');
    await page.context().close();
  }

  console.log('desktop — ⌘K "Send a file to Mia"');
  {
    const page = await newPage(browser, { viewport: { width: 1280, height: 860 }, standalone: false });
    await page.evaluate(() => { location.hash = '#fleet'; });
    await sleep(500);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const q = page.getByPlaceholder(/Jump to an agent/);
    await q.waitFor({ timeout: 5000 });
    await q.fill('send a file');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('Send a file to Mia').click()]);
    await chooser.setFiles([csvPath]);
    await sleep(300);
    ok((await page.evaluate(() => location.hash)) === '#mia', 'it opens Mia');
    ok(await page.getByLabel('Files to send').getByText('budget.csv').isVisible(), 'with the picked file in the tray');
    await page.context().close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    await browser?.close().catch(() => {});
    await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); })));
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  });
