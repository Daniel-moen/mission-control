// Images and layout blocks in Library docs (task 0124) — in a browser.
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/docassets-panel-e2e.mjs
//
// Boots the real relay (with a temp doc-asset store) and the fake host with a
// temp library, then builds the fixture doc the way an agent would: `mc-doc
// new`, `mc-doc attach` (which pushes to this relay), `mc-doc write` with
// :::facts / :::pills / :::pair / :::gallery / :::callout and loose images.
// Opens it at phone 390×844 and desktop 1440×900:
//   - every attached image loads through /api/v1/doc-assets (the thumb), lazily;
//   - a missing asset shows a calm placeholder, no console error;
//   - pairs sit side by side on desktop and stack on a phone; the gallery grid
//     has 2 columns on a phone, ≥3 on desktop; facts, pills, callout render;
//   - no sideways page scroll;
//   - tap a photo → the lightbox, which loads the FULL image; arrows / swipe
//     step; Escape / close button closes;
//   - `mia panel show-doc` shows the same doc, images and all, in the viewer;
//   - zero console errors and page errors throughout.
// SHOTS=<dir> keeps screenshots.

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8873;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docassets-panel-'));
const LIB = path.join(TMP, 'lib');
const MIA_DIR = path.join(TMP, 'mia');
const MC_DOC = path.join(DIR, '..', '..', 'scripts', 'mc-doc');
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
};
const procs = [];
function boot(args, name, env = {}) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, PUSH_STORE: path.join(TMP, 'push.json'),
      REALTIME_STORE: path.join(TMP, 'rt.json'), THUMB_CACHE: path.join(TMP, 'thumbs'), DOC_ASSETS: path.join(TMP, 'assets'), OPENAI_API_KEY: '', ...env,
    },
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
const mcDoc = (args, input) =>
  execFileSync(MC_DOC, args, {
    env: { ...process.env, MC_LIBRARY: LIB, MC_RELAY_URL: BASE, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' },
    encoding: 'utf8',
    input,
    cwd: TMP,
  }).trim();
const mia = (...args) => execFileSync(MIA_CLI, args, { env: { ...process.env, MIA_DIR }, encoding: 'utf8' }).trim();

// A photo-ish PNG (w×h): a diagonal gradient in one hue, so each image is
// recognisably different in screenshots.
function png(w, h, [r0, g0, b0]) {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      row[1 + x * 3] = Math.round(r0 * (0.4 + 0.6 * t));
      row[2 + x * 3] = Math.round(g0 * (0.4 + 0.6 * t));
      row[3 + x * 3] = Math.round(b0 * (0.4 + 0.6 * t));
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const HUES = { drive: [210, 110, 60], sat: [90, 150, 120], palm: [200, 170, 80], street: [130, 120, 200], g1: [180, 80, 80], g2: [80, 120, 180], g3: [160, 160, 70], g4: [90, 170, 170], g5: [170, 100, 170], wide: [120, 140, 100] };

function buildDoc() {
  const IN = path.join(TMP, 'in');
  fs.mkdirSync(IN, { recursive: true });
  for (const [k, hue] of Object.entries(HUES)) fs.writeFileSync(path.join(IN, `${k}.png`), png(k === 'wide' ? 1800 : 1200, k === 'wide' ? 900 : 800, hue));
  const id = path.basename(mcDoc(['new', '--kind', 'research', '--title', 'Blocks fixture']));
  const refs = {};
  for (const k of Object.keys(HUES)) refs[k] = mcDoc(['attach', id, path.join(IN, `${k}.png`)]);
  const a = (k) => refs[k].match(/\((assets\/[^)\s]+)/)[1]; // the stored name (PNG stays PNG when small)
  const md = `# Blocks fixture

Evidence pairs, a gallery and verdicts — the Silvertree layout.

:::facts
- Scheme: SS66/1993
- Erf: 1447
- 79 m² units: 9 of 32
- Best-guess unit: Section 25
:::

:::pills
- [ok] Building: about 75% sure
- [warn] Section 25: about 40% sure
- [bad] Lift: none mentioned
- Plain pill
:::

## The drive and garages

:::pair
The listing shows a red-paved drive; Street View looks down the same drive.

![Drive with garages](${a('drive')} "Listing | Drive with garages, looking north")
![Street View down the drive](${a('street')} "Street View | 9 Platteklip Plain, Aug 2025")
:::

## The two blocks

:::compare
![Lower block](${a('palm')} "Listing | Lower block and the sea")
![Satellite](${a('sat')} "Satellite | Two flat roofs")
:::

## Gallery

:::gallery
![One](${a('g1')} "Kitchen")
![Two](${a('g2')} "Lounge")
![Three](${a('g3')})
![Four](${a('g4')} "Bedroom")
![Five](${a('g5')} "Balcony")
:::

A loose figure:

![Wide view](${a('wide')} "Satellite | Pin on Silvertree, beach to the west")

![Not attached](assets/missing.jpg "Listing | This one was never attached")

![From the web](https://photos.example.com/web.png)

:::callout warn What doesn't match yet
From the street the walls look **white** rather than cream.
:::

See also [the other doc](other-doc.md).
`;
  mcDoc(['write', id, '--stdin'], md);
  return { id, refs };
}

async function newPage(browser, viewport, docId) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.errors = [];
  page.consoleErrors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.consoleErrors.push(m.text()));
  page.assetReqs = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/doc-assets/')) page.assetReqs.push(r.url().replace(BASE, ''));
  });
  await page.route('**/api/v1/img?**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png(60, 40, [100, 100, 100]) }));
  await page.route(/^https:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto(`${BASE}/?token=${TOKEN}#doc/${encodeURIComponent(docId)}`);
  await page.waitForSelector('article.md .mdb-pair', { timeout: 20000 });
  return page;
}

async function scrollAll(page, sel = 'article.md') {
  await page.evaluate(async (sel) => {
    const s = document.querySelector(sel).closest('[data-reader]');
    for (let y = 0; y <= s.scrollHeight; y += 350) {
      s.scrollTop = y;
      await new Promise((r) => setTimeout(r, 70));
    }
  }, sel);
}

async function run(browser, label, viewport, docId) {
  console.log(label);
  const phone = viewport.width < 600;
  const page = await newPage(browser, viewport, docId);
  const tag = phone ? 'phone' : 'desktop';

  // Lazy: before scrolling, the gallery far down hasn't been asked for.
  await sleep(600);
  const early = page.assetReqs.filter((u) => /g5\.(jpg|png)/.test(u)).length;
  ok(!phone || early === 0, `lazy: off-screen images wait (${early} early asks for the last gallery photo)`);

  await scrollAll(page);
  await until(async () => (await page.locator('article.md img[data-asset]:not([data-state="ok"]):not([data-state="failed"])').count()) === 0, 10000, 'images settled');
  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll('article.md img[data-asset]')].map((i) => ({ name: i.dataset.asset, state: i.dataset.state, w: i.naturalWidth, src: i.src.slice(0, 5) }))
  );
  const good = imgs.filter((i) => i.name !== 'missing.jpg');
  ok(good.length === 10 && good.every((i) => i.state === 'ok' && i.w > 0 && i.src === 'blob:'), `all 10 attached images load as blobs (${good.filter((i) => i.state === 'ok').length}/${good.length})`);
  ok(good.every((i) => i.w <= 800), `inline images use the thumb (widest ${Math.max(...good.map((i) => i.w))} px ≤ 800)`);
  ok(page.assetReqs.filter((u) => !/size=thumb/.test(u)).length === 0, 'no full-size image requested before the lightbox');
  const miss = imgs.find((i) => i.name === 'missing.jpg');
  ok(miss && miss.state === 'failed', 'a never-attached image becomes a placeholder');
  const web = await page.evaluate(() => document.querySelector('article.md img[data-img]')?.dataset.state);
  ok(web === 'ok', 'a web image still loads through /api/v1/img');

  // ---- layout
  const L = await page.evaluate(() => {
    const rect = (e) => e.getBoundingClientRect();
    const pair = [...document.querySelectorAll('.mdb-pair')[0].querySelectorAll('.md-fig')].map(rect);
    const gal = [...document.querySelectorAll('.mdb-gallery .md-fig')].map(rect);
    const cols = new Set(gal.map((r) => Math.round(r.left))).size;
    const facts = [...document.querySelectorAll('.mdb-fact')].map((f) => [f.querySelector('span')?.textContent, f.querySelector('b')?.textContent]);
    const pills = [...document.querySelectorAll('.mdb-pill')].map((p) => [p.dataset.tone, p.textContent.trim(), getComputedStyle(p).color]);
    const callout = document.querySelector('.mdb-callout');
    const cap = document.querySelector('.mdb-pair .md-fig figcaption');
    const tags = [...document.querySelectorAll('.mdb-pair .md-tag')].map((t) => [t.textContent, t.dataset.tone, getComputedStyle(t).color]);
    const pairProse = document.querySelector('.mdb-pair > p')?.textContent || '';
    const loose = document.querySelector('.md-figs-1 .md-fig');
    return {
      pair, cols, facts, pills, tags, pairProse,
      callout: callout && { tone: callout.dataset.tone, title: callout.querySelector('.mdb-callout-title')?.textContent, bold: !!callout.querySelector('strong') },
      cap: cap && { tag: cap.querySelector('.md-tag')?.textContent, text: cap.querySelector('.md-cap')?.textContent },
      loose: loose && { w: rect(loose).width, cap: loose.querySelector('.md-cap')?.textContent },
      docW: document.documentElement.scrollWidth,
      vw: innerWidth,
      docLink: document.querySelector('article.md a.md-doclink')?.getAttribute('href'),
      leftover: [...document.querySelectorAll('article.md p')].filter((p) => /^:::/.test(p.textContent.trim())).length,
    };
  });
  if (phone) ok(L.pair[1].top >= L.pair[0].bottom - 1 && Math.abs(L.pair[0].left - L.pair[1].left) < 2, 'phone: the pair stacks');
  else ok(Math.abs(L.pair[0].top - L.pair[1].top) < 2 && L.pair[1].left > L.pair[0].right, 'desktop: the pair sits side by side');
  ok(phone ? L.cols === 2 : L.cols >= 3, `gallery columns: ${L.cols}`);
  ok(L.facts.length === 4 && L.facts[0][0] === 'Scheme' && L.facts[0][1] === 'SS66/1993' && L.facts[2][0] === '79 m² units', `facts → label/value chips (${L.facts.map((f) => f.join('=')).join(', ')})`);
  ok(L.pills.map((p) => p[0]).join() === 'ok,warn,bad,n' && L.pills[0][1] === 'Building: about 75% sure', `pills carry their tone, "[ok]" stripped (${L.pills.map((p) => p[0]).join()})`);
  ok(new Set(L.pills.slice(0, 3).map((p) => p[2])).size === 3, 'ok / warn / bad pills are three different colours');
  ok(L.tags[0][0] === 'Listing' && L.tags[0][1] === 'a' && L.tags[1][0] === 'Street View' && L.tags[1][1] === 'b' && L.tags[0][2] !== L.tags[1][2], 'pair tags: Listing warm, Street View cool, different colours');
  ok(L.cap?.tag === 'Listing' && L.cap?.text === 'Drive with garages, looking north', 'caption = "Tag | caption" from the image title');
  ok(/red-paved drive/.test(L.pairProse), 'prose inside a pair stays');
  ok(L.callout?.tone === 'warn' && L.callout.title === "What doesn't match yet" && L.callout.bold, 'callout: tone, title, markdown body');
  ok(L.loose && L.loose.cap === 'Pin on Silvertree, beach to the west', 'a loose image becomes a captioned figure');
  ok(L.leftover === 0, 'no stray ":::" lines');
  ok(L.docLink === '#doc/other-doc.md', `a link to another doc opens it in the panel (${L.docLink})`);
  ok(L.docW <= L.vw, `no sideways page scroll (${L.docW} ≤ ${L.vw})`);

  await page.locator('.mdb-facts').scrollIntoViewIfNeeded();
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, `${tag}-top.png`) });
  await page.locator('.mdb-gallery').scrollIntoViewIfNeeded();
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, `${tag}-gallery.png`) });

  // ---- lightbox
  const third = page.locator('.mdb-gallery .md-fig').nth(2);
  await third.scrollIntoViewIfNeeded();
  await third.tap();
  await page.waitForSelector('[data-lightbox] img[data-lightbox-img]', { timeout: 5000 });
  await until(() => page.evaluate(() => document.querySelector('[data-lightbox-img]')?.naturalWidth >= 1000), 6000, 'full image');
  const lb = await page.evaluate(() => {
    const d = document.querySelector('[data-lightbox]');
    const i = d.querySelector('[data-lightbox-img]');
    return { counter: d.innerText.match(/\d+ \/ \d+/)?.[0], w: i.naturalWidth, fit: i.getBoundingClientRect().width <= innerWidth };
  });
  // 10 attached + the web image; the never-attached one isn't offered.
  ok(lb.counter && Number(lb.counter.split(' / ')[1]) === 11, `lightbox opens on the tapped photo (${lb.counter})`);
  ok(lb.w >= 1000 && lb.fit, `…loads the full image (${lb.w} px wide) and fits the screen`);
  ok(page.assetReqs.some((u) => /g3\.(jpg|png)$/.test(u)), '…the full image came from the doc-asset store (no ?size)');
  await page.screenshot({ path: path.join(SHOTS, `${tag}-lightbox.png`) });
  const n0 = Number(lb.counter.split(' / ')[0]);
  if (phone) {
    const box = await page.locator('[data-lightbox-img]').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.85, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15, y, { steps: 6 });
    await page.mouse.up();
  } else {
    await page.keyboard.press('ArrowRight');
  }
  await sleep(400);
  const n1 = await page.evaluate(() => Number(document.querySelector('[data-lightbox]').innerText.match(/(\d+) \/ \d+/)?.[1]));
  ok(n1 === n0 + 1, `${phone ? 'swipe' : 'arrow key'} steps to the next photo (${n0} → ${n1})`);
  if (phone) await page.getByRole('button', { name: 'Close photo' }).tap();
  else await page.keyboard.press('Escape');
  await page.waitForSelector('[data-lightbox]', { state: 'detached', timeout: 4000 });
  const stillDoc = await page.locator('article.md .mdb-pair').count();
  ok(stillDoc > 0, `${phone ? 'close button' : 'Escape'} closes the lightbox and leaves the doc open`);

  // A pair photo opens the lightbox too.
  await page.locator('.mdb-pair .md-fig').first().scrollIntoViewIfNeeded();
  await page.locator('.mdb-pair .md-fig').first().tap();
  await page.waitForSelector('[data-lightbox]', { timeout: 4000 });
  const pairCap = await page.evaluate(() => document.querySelector('[data-lightbox]').innerText);
  ok(/listing/i.test(pairCap) && /Drive with garages/.test(pairCap), 'a pair photo opens with its tag and caption');
  await page.getByRole('button', { name: 'Close photo' }).click();
  await page.waitForSelector('[data-lightbox]', { state: 'detached', timeout: 4000 });

  ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
  ok(!page.consoleErrors.length, `zero console errors (${page.consoleErrors.join(' | ')})`);
  await page.context().close();
}

async function viewer(browser, docId) {
  console.log('mia panel show-doc (viewer)');
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.route('**/api/v1/img?**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png(60, 40, [100, 100, 100]) }));
  await page.goto(`${BASE}/?token=${TOKEN}#home`);
  await sleep(2500);
  mia('panel', 'show-doc', docId);
  await page.waitForSelector('[data-reader="viewer"] article.md .mdb-pair', { timeout: 10000 });
  await scrollAll(page, '[data-reader="viewer"] article.md');
  await until(async () => (await page.locator('[data-reader="viewer"] img[data-asset][data-state="ok"]').count()) >= 10, 10000, 'viewer images');
  const n = await page.locator('[data-reader="viewer"] img[data-asset][data-state="ok"]').count();
  ok(n === 10, `show-doc: the viewer shows the doc's images (${n})`);
  await page.locator('[data-reader="viewer"] .mdb-pair').first().scrollIntoViewIfNeeded();
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'viewer-ipad.png') });
  await page.locator('[data-reader="viewer"] .mdb-gallery .md-fig').first().click();
  await page.waitForSelector('[data-lightbox] [data-lightbox-img]', { timeout: 4000 });
  ok(true, 'the lightbox opens over the viewer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-lightbox]', { state: 'detached', timeout: 4000 });
  ok(await page.locator('[data-reader="viewer"]').count() === 1, 'Escape closes only the lightbox (viewer stays)');
  ok(!errs.length, `no console/page errors (${errs.join(' | ')})`);
  await ctx.close();
}

async function main() {
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  const { id, refs } = buildDoc();
  console.log('fixture');
  ok(id === 'blocks-fixture.md', `mc-doc new → ${id}`);
  ok(/^!\[drive\]\(assets\/drive\.(jpg|png)\)$/.test(refs.drive), `mc-doc attach prints the markdown (${refs.drive})`);
  const listed = await (await fetch(`${BASE}/api/v1/doc-assets/blocks-fixture/`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(listed.files?.length === 10, `attach pushed 10 images to the relay (${listed.files?.length})`);
  boot(['test/fake-host.mjs'], 'host', { FAKE_HOST_LIBRARY: LIB });
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  const browser = await chromium.launch();
  try {
    await run(browser, 'phone 390×844', { width: 390, height: 844 }, id);
    await run(browser, 'desktop 1440×900', { width: 1440, height: 900 }, id);
    await viewer(browser, id);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed — screenshots in ${SHOTS}`);
}

main()
  .catch((e) => {
    console.error(e);
    failed += 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    process.exit(failed ? 1 : 0);
  });
