// Listing photos in the Library reader (task 0070) — in a browser.
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/thumbs-panel-e2e.mjs
//
// Boots the real relay and the fake host with a fixture doc (a listings
// table, a prose link, a non-listing link, a home-page link, ![](…)), then
// opens it at phone 390 and iPad 820. The relay's /thumb, /img and /preview
// are stubbed in the browser (page.route), so nothing touches the internet:
//   - a listing link in a table cell gets a compact photo (≤ 64 px), loaded;
//   - a listing whose page has no photo (204) keeps the plain link, no box;
//   - a non-listing / bare home-page link gets no photo at all;
//   - the table still scrolls sideways inside its wrapper, rows stay short;
//   - at most 4 photo requests in flight; each photo requested once;
//   - tap a photo → the viewer's card with the gallery; long press → the
//     page opens outside; the link text is target=_blank;
//   - ![](https://…) loads through /api/v1/img, never straight from the host.
//
// REAL=1 instead loads the real library (FAKE_HOST_LIBRARY=~/.mission-control/
// library), lets the relay fetch the real listing photos, and saves
// screenshots of the dossier at 390 and 820 into SHOTS (no stubs).

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
const PORT = 8871;
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-thumbs-panel-'));
const REAL = !!process.env.REAL;
const LIB = REAL ? process.env.FAKE_HOST_LIBRARY || path.join(os.homedir(), '.mission-control', 'library') : path.join(TMP, 'lib');
const DOC = REAL ? process.env.DOC || 'oblivion-property-dossiers-chosen-mandat.md' : 'listing-fixture.md';
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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
    env: {
      ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR: path.join(TMP, 'mia'), PUSH_STORE: path.join(TMP, 'push.json'),
      REALTIME_STORE: path.join(TMP, 'rt.json'), THUMB_CACHE: process.env.THUMB_CACHE || path.join(TMP, 'thumbs'), OPENAI_API_KEY: '', ...env,
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

// ---- fixture ------------------------------------------------------------------
const ROWS = Array.from({ length: 14 }, (_, i) => {
  const n = 14 - i;
  const link =
    n === 13 ? 'https://www.privateproperty.co.za/for-sale/western-cape/cape-town/none/T0' // no photo → 204
      : n === 12 ? 'https://www.chaseveritt.co.za/' // a bare home page: no photo box
        : `https://www.remax.co.za/property-for-sale-south-africa/western-cape/cape-town/house-${n}`;
  return `| ${n} | ${n} Some Long Road Name, Fresnaye (cliffside house with a view) | **${1000 + n}** | R${n}.9m | [open](${link}) |`;
});
const FIXTURE = `# Listing fixture

A table of listings, like the dossier.

| # | Address | Erf | Asking | Listing |
|---|---|---|---|---|
${ROWS.join('\n')}

A prose link to a listing: [see the Seeff page](https://www.seeff.com/results/residential/for-sale/cape-town/fresnaye/house/3150302/).

Not a listing: [Northflank docs](https://northflank.com/docs/v1/application/overview).

An embedded photo:

![street view](https://photos.example.com/street.png)
`;

// A small solid PNG (4×3), built here so the fixture needs no binary file.
const PNG = (() => {
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
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 3 }, () => Buffer.from([0, ...[120, 150, 170, 120, 150, 170, 120, 150, 170, 120, 150, 170]])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', require('node:zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: REAL ? 2 : 1 });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(url);
      return {};
    };
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.stats = { thumb: [], img: [], direct: [], live: 0, peak: 0, preview: 0 };
  if (!REAL) {
    await page.route('**/api/v1/thumb?**', async (route) => {
      const u = new URL(route.request().url()).searchParams.get('url');
      page.stats.thumb.push(u);
      page.stats.live += 1;
      page.stats.peak = Math.max(page.stats.peak, page.stats.live);
      await sleep(250);
      page.stats.live -= 1;
      if (/none/.test(u)) return route.fulfill({ status: 204 });
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await page.route('**/api/v1/img?**', async (route) => {
      page.stats.img.push(new URL(route.request().url()).searchParams.get('url'));
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await page.route('**/api/v1/preview?**', async (route) => {
      page.stats.preview += 1;
      const u = new URL(route.request().url()).searchParams.get('url');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, url: u, finalUrl: u, status: 200, frameable: false, why: 'the site forbids framing (X-Frame-Options: deny)',
          title: '4 Bedroom House for Sale in Fresnaye', site: 'RE/MAX', description: 'A cliffside house.',
          image: 'https://cdn.remax.co.za/a.jpg', images: ['https://cdn.remax.co.za/a.jpg', 'https://cdn.remax.co.za/b.jpg', 'https://cdn.remax.co.za/c.jpg'],
        }),
      });
    });
    // Nothing may load straight from a listing/photo host.
    await page.route(/^https:\/\/(?!localhost)/, (route) => {
      page.stats.direct.push(route.request().url());
      return route.abort();
    });
  }
  await page.goto(`${BASE}/?token=${TOKEN}#doc/${encodeURIComponent(DOC)}`);
  await page.waitForSelector('article.md table', { timeout: 20000 });
  return page;
}

async function fixture(browser, label, viewport) {
  console.log(label);
  const page = await newPage(browser, viewport);
  const phone = viewport.width < 500;
  await until(async () => (await page.locator('.md-thumb[data-state="ok"]').count()) >= 1, 8000, 'first photos');
  const cell = await page.evaluate(() => {
    const b = document.querySelector('td .md-thumb[data-state="ok"]');
    const r = b.getBoundingClientRect();
    const img = b.querySelector('img');
    const a = b.parentElement.querySelector('a');
    const row = b.closest('tr').getBoundingClientRect();
    return { w: r.width, h: r.height, src: img.src, natural: img.naturalWidth, radius: getComputedStyle(b).borderRadius, link: a?.textContent, target: a?.target, rowH: row.height };
  });
  ok(cell.w <= 66 && cell.w >= 60 && cell.h <= 50, `a table cell's photo is compact (${cell.w}×${cell.h})`);
  ok(cell.src.startsWith('blob:') && cell.natural > 0, 'it loaded (through the relay, as a blob)');
  ok(parseFloat(cell.radius) >= 6, `rounded (${cell.radius})`);
  ok(cell.link === 'open' && cell.target === '_blank', 'the link text is still there, opening a new page');

  // Scroll through the whole table so every photo is asked for.
  await page.evaluate(async () => {
    const s = document.querySelector('article.md').closest('.overflow-y-auto') || document.scrollingElement;
    for (let y = 0; y < s.scrollHeight; y += 300) {
      s.scrollTop = y;
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await until(async () => (await page.locator('.md-thumb[data-state="loading"]').count()) === 0, 10000, 'all photos settled');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('article.md tbody tr')].map((tr) => ({
      n: tr.cells[0].textContent.trim(),
      thumb: !!tr.querySelector('.md-thumb'),
      link: tr.querySelector('a')?.textContent,
    }))
  );
  const heights = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('article.md tbody tr')].map((tr) => [tr.cells[0].textContent.trim(), tr.getBoundingClientRect().height])));
  // In a cell the link sits under the photo (keeps the column narrow), so a
  // row is at most photo + link tall — 2-line addresses already are.
  ok(heights['14'] <= Math.max(heights['13'] + (phone ? 24 : 0), 84), `a photo keeps its row compact (${heights['14']} vs ${heights['13']} without)`);
  const r13 = rows.find((r) => r.n === '13');
  const r12 = rows.find((r) => r.n === '12');
  ok(r13 && !r13.thumb && r13.link === 'open', 'no photo on the page → the plain link, no box');
  ok(r12 && !r12.thumb && r12.link === 'open', 'a bare home-page link gets no photo');
  ok(rows.filter((r) => r.thumb).length === 12, `the other 12 rows have photos (${rows.filter((r) => r.thumb).length})`);
  ok(page.stats.peak <= 4, `at most 4 photo requests at once (peak ${page.stats.peak})`);
  ok(new Set(page.stats.thumb).size === page.stats.thumb.length, `each photo requested once (${page.stats.thumb.length} requests)`);
  ok(!page.stats.thumb.some((u) => /northflank|chaseveritt\.co\.za\/$/.test(u)), 'non-listing links are never asked for');
  const prose = await page.evaluate(() => {
    const b = document.querySelector('p .md-thumb');
    return b ? { w: b.getBoundingClientRect().width, state: b.dataset.state } : null;
  });
  ok(prose && prose.w >= 90 && prose.state === 'ok', `a listing link in prose gets a bigger photo (${prose?.w}px)`);
  const table = await page.evaluate(() => {
    const w = document.querySelector('.md-table');
    const art = document.querySelector('article.md');
    return { wrapW: w.getBoundingClientRect().width, artW: art.getBoundingClientRect().width, scrollW: w.scrollWidth, docW: document.documentElement.scrollWidth, vw: innerWidth };
  });
  ok(table.wrapW <= table.artW + 1 && table.docW <= table.vw, `the table stays inside the page (wrap ${Math.round(table.wrapW)} ≤ ${Math.round(table.artW)}, page ${table.docW} ≤ ${table.vw})`);
  if (phone) ok(table.scrollW > table.wrapW, 'on a phone the table scrolls sideways inside its wrapper');
  const md = await page.evaluate(() => {
    const i = document.querySelector('img.md-img');
    return { src: i?.src || '', state: i?.dataset.state };
  });
  ok(md.src.startsWith('blob:') && md.state === 'ok' && page.stats.img.includes('https://photos.example.com/street.png'), '![](…) loads through /api/v1/img');
  ok(page.stats.direct.length === 0, `nothing loads straight from an outside host (${page.stats.direct.slice(0, 3).join(', ')})`);
  await page.screenshot({ path: path.join(SHOTS, `fixture-${phone ? 'phone' : 'ipad'}.png`) });

  // Tap → the card with the gallery.
  const first = page.locator('td .md-thumb[data-state="ok"]').first();
  await first.scrollIntoViewIfNeeded();
  await first.tap();
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await sleep(600);
  const card = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return { text: d.innerText, imgs: [...d.querySelectorAll('img')].filter((i) => i.naturalWidth > 0).length, opened: window.__opened.length };
  });
  ok(/4 Bedroom House for Sale/.test(card.text) && /listing/.test(card.text), 'tap opens the viewer on the listing card');
  ok(card.imgs >= 3, `…with its photo gallery (${card.imgs} photos, via the relay)`);
  ok(card.opened === 0, '…and does not leave for the site');
  await page.screenshot({ path: path.join(SHOTS, `fixture-${phone ? 'phone' : 'ipad'}-card.png`) });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });

  // Long press → the page itself.
  const box = await first.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pt = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const after = await page.evaluate(() => ({ opened: window.__opened.slice(), dialog: !!document.querySelector('[role="dialog"]') }));
  ok(after.opened.length === 1 && /remax\.co\.za/.test(after.opened[0]), `long press opens the listing page (${after.opened[0]})`);
  ok(!after.dialog, '…without also opening the viewer');
  ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
  await page.context().close();
}

async function real(browser) {
  for (const [tag, viewport] of [['phone-390', { width: 390, height: 844 }], ['ipad-820', { width: 820, height: 1180 }]]) {
    console.log(`real library — ${DOC} at ${tag}`);
    const page = await newPage(browser, viewport);
    const t0 = Date.now();
    await until(async () => (await page.locator('td .md-thumb[data-state="ok"]').count()) >= 3, 60000, 'real photos').catch(() => {});
    await sleep(1500);
    const n = await page.evaluate(() => ({
      ok: document.querySelectorAll('.md-thumb[data-state="ok"]').length,
      loading: document.querySelectorAll('.md-thumb[data-state="loading"]').length,
      all: document.querySelectorAll('.md-thumb').length,
    }));
    console.log(`    ${n.ok} photos shown, ${n.loading} loading, ${n.all} boxes (${Date.now() - t0} ms)`);
    ok(n.ok >= 3, `real listing photos render (${n.ok})`);
    await page.screenshot({ path: path.join(SHOTS, `dossier-${tag}.png`) });
    // The index table, scrolled into view and sideways to the photo column
    // (a wide table overflows its wrapper at both widths), then one row's card.
    await page.evaluate(() => {
      const w = document.querySelector('.md-table');
      w.scrollIntoView({ block: 'start' });
      w.closest('[data-reader]').scrollTop -= 60;
      w.scrollLeft = w.scrollWidth;
    });
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, `dossier-${tag}-table.png`) });
    const first = page.locator('td .md-thumb[data-state="ok"]').first();
    await first.tap();
    await page.waitForSelector('[role="dialog"] img', { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, `dossier-${tag}-card.png`) });
    ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
    await page.context().close();
  }
}

async function main() {
  if (!REAL) {
    fs.mkdirSync(LIB, { recursive: true });
    fs.writeFileSync(path.join(LIB, DOC), FIXTURE);
  }
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  boot(['test/fake-host.mjs'], 'host', { FAKE_HOST_LIBRARY: LIB });
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  const browser = await chromium.launch();
  try {
    if (REAL) await real(browser);
    else {
      await fixture(browser, 'phone 390×844', { width: 390, height: 844 });
      await fixture(browser, 'iPad portrait 820×1180', { width: 820, height: 1180 });
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed${process.env.SHOTS ? ` — screenshots in ${SHOTS}` : ''}`);
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
