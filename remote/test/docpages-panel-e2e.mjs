// Library pages (task 0126) — in a browser.
//
//   cd remote && npm run build && PLAYWRIGHT=<path to playwright pkg> node test/docpages-panel-e2e.mjs
//
// Boots the real relay and the fake host (playing a Mac app from BEFORE pages:
// it reports `kind: page` as note, so the panel must go by the `page` tag),
// publishes the two reference pages with `mc-doc new --kind page` (the
// Crystal Garden gallery and the Silvertree match, from PAGES_SRC, default
// ~/.mission-control/mia/briefs), plus a hostile probe page. Then, at phone
// 390×844, iPad 820×1180 and desktop 1440×900:
//   - the Library lists both pages with the page icon;
//   - opening one shows it full-bleed in a sandboxed iframe (no
//     allow-same-origin), with data-theme on its <html>, every image loaded,
//     no sideways scroll; tapping an image opens the panel's lightbox on the
//     page's own image; Back closes it;
//   - `mia panel show-doc` shows a page in the viewer the same way;
//   - zero console errors / page errors (the panel and the page frames).
// And the probe page, from inside the frame, can't read the panel's
// localStorage / token, its DOM, cookies or the referrer; its fetch to /api is
// blocked by CSP; a remote image is blocked; and the messages it forges to the
// panel (a lightbox on an outside URL, a traversal doc id) are ignored — no
// request ever goes to the outside host.
// SHOTS=<dir> keeps screenshots.

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
const PORT = 8874;
const TOKEN = 'page-e2e-token-77';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docpages-panel-'));
const LIB = path.join(TMP, 'lib');
const MIA_DIR = path.join(TMP, 'mia');
const MC_DOC = path.join(DIR, '..', '..', 'scripts', 'mc-doc');
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');
const SRC = process.env.PAGES_SRC || path.join(os.homedir(), '.mission-control', 'mia', 'briefs');
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
      REALTIME_STORE: path.join(TMP, 'rt.json'), THUMB_CACHE: path.join(TMP, 'thumbs'), DOC_ASSETS: path.join(TMP, 'assets'),
      DOC_PAGES: path.join(TMP, 'pages'), OPENAI_API_KEY: '', ...env,
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
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
const mia = (...args) => execFileSync(MIA_CLI, args, { env: { ...process.env, MIA_DIR }, encoding: 'utf8' }).trim();

// A page that attacks from inside the frame and writes what it got into #out.
const PROBE = `<title>Probe</title><style>body{background:#fff;color:#000}</style>
<h1>Probe</h1><pre id="out">running</pre>
<img id="remote" src="https://evil.example/pixel.png" alt="">
<script>
(async function () {
  var r = {};
  function t(k, f) { try { var v = f(); r[k] = v === undefined ? 'undefined' : String(v); } catch (e) { r[k] = 'blocked:' + e.name; } }
  t('ls', function () { return localStorage.getItem('mc_token'); });
  t('parentLs', function () { return parent.localStorage.getItem('mc_token'); });
  t('parentDoc', function () { return parent.document.title; });
  t('topHref', function () { return top.location.href; });
  t('cookie', function () { return document.cookie; });
  t('origin', function () { return self.origin; });
  r.referrer = document.referrer;
  r.href = location.href;
  try { var x = await fetch('/api/v1/snapshot'); r.fetch = 'status:' + x.status; } catch (e) { r.fetch = 'blocked:' + e.name; }
  try { var y = await fetch('/api/v1/snapshot', { headers: { Authorization: 'Bearer guess' } }); r.fetchAuth = 'status:' + y.status; } catch (e) { r.fetchAuth = 'blocked:' + e.name; }
  try { var ws = new WebSocket('ws://' + location.host + '/ws?role=viewer&token=guess'); r.ws = 'opened-object'; ws.close(); } catch (e) { r.ws = 'blocked:' + e.name; }
  parent.postMessage({ mc: 'lightbox', items: [{ src: 'https://evil.example/steal.jpg' }], at: 0 }, '*');
  parent.postMessage({ mc: 'lightbox', items: [{ src: '/api/v1/snapshot' }], at: 0 }, '*');
  parent.postMessage({ mc: 'open-doc', id: '../../etc/passwd.md' }, '*');
  parent.postMessage({ mc: 'open-doc', id: 'javascript:alert(1)' }, '*');
  document.getElementById('out').textContent = JSON.stringify(r);
})();
</script>`;

function publish() {
  const gal = path.join(SRC, 'designs-gallery', 'index.html');
  const sil = path.join(SRC, 'silvertree', 'index.html');
  if (!fs.existsSync(gal) || !fs.existsSync(sil)) throw new Error(`reference pages missing under ${SRC}`);
  const g = path.basename(mcDoc(['new', '--kind', 'page', '--title', 'Crystal Garden designs', '--html', gal, '--tags', 'roblox']));
  const s = path.basename(mcDoc(['new', '--kind', 'page', '--title', 'Silvertree Place match', '--html', sil, '--tags', 'property']));
  const p = path.basename(mcDoc(['new', '--kind', 'page', '--title', 'Probe page', '--stdin'], PROBE));
  const md = path.basename(mcDoc(['new', '--kind', 'note', '--title', 'Plain note'])); // a markdown doc next to them
  return { g, s, p, md };
}

async function newContext(browser, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  // Google Fonts stand-in (offline test): an empty stylesheet, so the page's
  // <link> resolves cleanly. Everything else off-box is refused and recorded.
  ctx.outside = [];
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => {
    ctx.outside.push(route.request().url());
    route.abort();
  });
  // (registered last, so it wins over the catch-all above)
  await ctx.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts */' }));
  return ctx;
}
function watch(page) {
  page.errors = [];
  page.consoleErrors = [];
  page.authToOutside = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.consoleErrors.push(`${m.text()} @ ${m.location()?.url || ''}`));
  page.on('request', (r) => {
    const auth = r.headers().authorization || '';
    if (auth && !r.url().startsWith(BASE)) page.authToOutside.push(r.url());
  });
}
const pageFrame = (page) => page.frames().find((f) => /\/p\/[0-9a-z]+-[A-Za-z0-9_-]{32}\//.test(f.url()));

async function frameImagesSettled(page) {
  const f = await until(async () => pageFrame(page), 15000, 'page frame');
  await f.waitForLoadState('load');
  // lazy images: walk the frame's own scroll
  await f.evaluate(async () => {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += 400) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    scrollTo(0, 0);
  });
  await until(async () => f.evaluate(() => [...document.images].every((i) => i.complete)), 15000, 'frame images complete');
  return f;
}

async function run(browser, label, viewport, ids) {
  console.log(label);
  const tag = label.split(' ')[0];
  const ctx = await newContext(browser, viewport);
  const page = await ctx.newPage();
  watch(page);

  // The Library: both pages listed, with the page icon.
  await page.goto(`${BASE}/?token=${TOKEN}#library`);
  await page.waitForSelector('text=Crystal Garden designs', { timeout: 20000 });
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => /Crystal Garden designs|Silvertree Place match|Plain note/.test(b.innerText))
      .map((b) => ({ t: b.innerText.split('\n')[0], icon: !!b.querySelector('svg.lucide-app-window') }))
  );
  const card = (t) => cards.find((c) => c.t.includes(t));
  ok(card('Crystal Garden')?.icon && card('Silvertree')?.icon, 'Library: both pages carry the page icon');
  ok(card('Plain note') && !card('Plain note').icon, 'a markdown doc does not');
  ok(await page.getByText('Pages', { exact: false }).count() > 0, 'a Pages filter appears');

  // Open the gallery from the list.
  await page.getByText('Crystal Garden designs').first().click();
  await page.waitForSelector('[data-page-frame] iframe', { timeout: 15000 });
  const attrs = await page.evaluate(() => {
    const f = document.querySelector('[data-page-frame] iframe');
    const r = f.getBoundingClientRect();
    return { sandbox: f.getAttribute('sandbox'), ref: f.getAttribute('referrerpolicy'), w: r.width, vw: innerWidth };
  });
  ok(attrs.sandbox === 'allow-scripts allow-popups allow-popups-to-escape-sandbox', `sandboxed without allow-same-origin (${attrs.sandbox})`);
  ok(attrs.ref === 'no-referrer', 'no referrer to the page');
  ok(attrs.w >= (viewport.width >= 1024 ? 600 : viewport.width - 40), `full-bleed: the frame is ${Math.round(attrs.w)} of ${attrs.vw} px wide`);
  const f = await frameImagesSettled(page);
  const g = await f.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    imgs: [...document.images].map((i) => ({ src: i.currentSrc, w: i.naturalWidth })),
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
    bg: getComputedStyle(document.body).backgroundColor,
    cols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length,
  }));
  ok(g.theme === 'dark' && g.bg === 'rgb(20, 17, 29)', `the page follows the panel's theme (data-theme=${g.theme}, bg ${g.bg})`);
  ok(g.imgs.length === 22 && g.imgs.every((i) => i.w > 0 && /\/assets\/[a-z0-9-]+\.jpg$/.test(i.src)), `all 22 gallery images load from the page's assets (${g.imgs.filter((i) => i.w > 0).length}/22)`);
  ok(!g.sideways, 'no sideways scroll inside the page');
  ok(viewport.width < 600 ? g.cols === 1 : g.cols >= 2, `responsive grid: ${g.cols} column(s)`);
  await page.screenshot({ path: path.join(SHOTS, `gallery-${tag}.png`) });

  // Tap an image → the panel's lightbox, on the page's own full image.
  await f.locator('figure img').nth(1).scrollIntoViewIfNeeded();
  await f.locator('figure img').nth(1).click();
  await page.waitForSelector('[data-lightbox] [data-lightbox-img]', { timeout: 5000 });
  const lb = await page.evaluate(() => {
    const i = document.querySelector('[data-lightbox] [data-lightbox-img]');
    return { src: i.getAttribute('src'), text: document.querySelector('[data-lightbox]').innerText };
  });
  ok(/\/p\/[^/]+\/crystal-garden-designs\/assets\/01-new-prism-tree\.jpg$/.test(new URL(lb.src).pathname), `tap → lightbox on the page's image (${new URL(lb.src).pathname.split('/').pop()})`);
  await until(async () => page.evaluate(() => document.querySelector('[data-lightbox] [data-lightbox-img]').naturalWidth > 0), 5000, 'lightbox image');
  ok(true, 'the lightbox image loads');
  await page.keyboard.press('ArrowRight');
  await sleep(250);
  const next = await page.evaluate(() => document.querySelector('[data-lightbox] [data-lightbox-img]').getAttribute('src'));
  ok(/02-new-hedgehog-spinel\.jpg$/.test(next), 'arrows step through the page images');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-lightbox]', { state: 'detached', timeout: 4000 });
  ok(await page.locator('[data-page-frame] iframe').count() === 1, 'Escape closes only the lightbox');

  // Back.
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.waitForSelector('[data-page-frame]', { state: 'detached', timeout: 5000 });
  ok(true, 'Back closes the page');

  // Silvertree by deep link.
  await page.goto(`${BASE}/?token=${TOKEN}#doc/${encodeURIComponent(ids.s)}`);
  await page.waitForSelector('[data-page-frame] iframe', { timeout: 15000 });
  const sf = await frameImagesSettled(page);
  const s = await sf.evaluate(() => ({
    n: [...document.images].filter((i) => i.naturalWidth > 0).length,
    all: document.images.length,
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
    gridCols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length,
    maps: document.querySelector('a[href*="google.com/maps"]')?.getAttribute('target'),
  }));
  ok(s.all === 12 && s.n === 12, `Silvertree: 12/12 images load (${s.n}/${s.all})`);
  ok(!s.sideways, 'no sideways scroll');
  ok(viewport.width <= 700 ? s.gridCols === 1 : s.gridCols === 2, `evidence pairs: ${s.gridCols} column(s)`);
  await sf.locator('a[href*="google.com/maps"]').first().evaluate((a) => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  ok((await sf.locator('a[href*="google.com/maps"]').first().getAttribute('target')) === '_blank', 'web links open in a new tab');
  await page.screenshot({ path: path.join(SHOTS, `silvertree-${tag}.png`) });

  ok(!page.errors.length, `no page errors (${page.errors.join(' | ')})`);
  ok(!page.consoleErrors.length, `zero console errors (${page.consoleErrors.join(' | ')})`);
  ok(!page.authToOutside.length, 'no request with a token ever left the relay');
  await ctx.close();
}

async function viewer(browser, ids) {
  console.log('mia panel show-doc (viewer, iPad)');
  const ctx = await newContext(browser, { width: 820, height: 1180 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/?token=${TOKEN}#home`);
  await sleep(2500);
  mia('panel', 'show-doc', ids.s);
  await page.waitForSelector('[data-reader="viewer-page"] [data-page-frame] iframe', { timeout: 10000 });
  const f = await frameImagesSettled(page);
  const n = await f.evaluate(() => [...document.images].filter((i) => i.naturalWidth > 0).length);
  ok(n === 12, `show-doc: the viewer shows the page with its images (${n}/12)`);
  await page.screenshot({ path: path.join(SHOTS, 'viewer-silvertree-ipad.png') });
  await f.locator('figure img').first().click();
  await page.waitForSelector('[data-lightbox] [data-lightbox-img]', { timeout: 5000 });
  ok(true, 'tapping an image opens the lightbox over the viewer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-lightbox]', { state: 'detached', timeout: 4000 });
  await page.getByRole('button', { name: 'Back' }).first().click();
  await page.waitForSelector('[data-reader="viewer-page"]', { state: 'detached', timeout: 5000 });
  ok(true, 'Back closes the viewer');
  ok(!page.errors.length && !page.consoleErrors.length, `zero console/page errors (${[...page.errors, ...page.consoleErrors].join(' | ')})`);
  await ctx.close();
}

async function probe(browser, ids) {
  console.log('isolation probe (a hostile page)');
  const ctx = await newContext(browser, { width: 820, height: 1180 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/?token=${TOKEN}#doc/${encodeURIComponent(ids.p)}`);
  await page.waitForSelector('[data-page-frame] iframe', { timeout: 15000 });
  const f = await until(async () => pageFrame(page), 15000, 'probe frame');
  const out = await until(async () => {
    const t = await f.evaluate(() => document.getElementById('out')?.textContent).catch(() => '');
    return t && t !== 'running' ? JSON.parse(t) : null;
  }, 10000, 'probe result');
  const stored = await page.evaluate(() => localStorage.getItem('mc_token'));
  ok(stored === TOKEN, '(the panel itself holds the token in localStorage)');
  ok(/^blocked:/.test(out.ls), `page localStorage is off-limits (${out.ls})`);
  ok(/^blocked:/.test(out.parentLs) && /^blocked:/.test(out.parentDoc), `the panel's storage and DOM are unreachable (${out.parentLs}, ${out.parentDoc})`);
  ok(/^blocked:/.test(out.topHref), `the panel URL is unreadable (${out.topHref})`);
  ok(/^blocked:/.test(out.cookie) || out.cookie === '', `cookies: ${out.cookie}`);
  ok(out.origin === 'null', `opaque origin (${out.origin})`);
  ok(out.referrer === '', 'no referrer (the panel URL never reaches the page)');
  ok(!out.href.includes(TOKEN) && !JSON.stringify(out).includes(TOKEN), 'the token appears nowhere the page can see');
  ok(/^blocked:/.test(out.fetch) && /^blocked:/.test(out.fetchAuth), `fetch to /api is blocked by CSP (${out.fetch})`);
  await sleep(800);
  ok(await page.locator('[data-lightbox]').count() === 0, 'forged lightbox messages (outside URL, /api) are ignored');
  ok(!page.url().includes('passwd') && !page.url().includes('javascript'), 'forged open-doc ids are ignored');
  ok(!ctx.outside.some((u) => u.includes('steal.jpg')), 'the panel never fetched the forged image');
  ok(!page.authToOutside.length, 'no request with a token ever left the relay');
  const remote = await f.evaluate(() => document.getElementById('remote').naturalWidth);
  ok(remote === 0 && !ctx.outside.some((u) => u.includes('pixel.png')), 'a remote image is blocked by CSP before any request');
  ok(page.consoleErrors.some((e) => /Content Security Policy/i.test(e)), '(the browser reports the CSP blocks)');
  await ctx.close();
}

async function main() {
  boot(['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok, 5000, 'relay');
  const ids = publish();
  console.log('fixtures');
  ok(ids.g === 'crystal-garden-designs.md' && ids.s === 'silvertree-place-match.md', `mc-doc new --kind page → ${ids.g}, ${ids.s}`);
  for (const id of [ids.g, ids.s, ids.p]) {
    const r = await fetch(`${BASE}/api/v1/doc-pages/${id.replace(/\.md$/, '')}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    ok(r.ok, `the relay has ${id}`);
  }
  boot(['test/fake-host.mjs'], 'host', { FAKE_HOST_LIBRARY: LIB });
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  const browser = await chromium.launch();
  try {
    await run(browser, 'phone 390×844', { width: 390, height: 844 }, ids);
    await run(browser, 'iPad 820×1180', { width: 820, height: 1180 }, ids);
    await run(browser, 'desktop 1440×900', { width: 1440, height: 900 }, ids);
    await viewer(browser, ids);
    await probe(browser, ids);
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
