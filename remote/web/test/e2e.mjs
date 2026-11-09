// End-to-end for panel v6 (task 0612): its own relay + rich fake host on a
// free port, then WebKit at iPhone and iPad sizes. Needs dist/v6 built.
// PLAYWRIGHT=<path to playwright> (default ~/PropIQ-design-0225/node_modules/playwright)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { webkit } = require(process.env.PLAYWRIGHT || `${os.homedir()}/PropIQ-design-0225/node_modules/playwright`);
const REMOTE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = String(18000 + Math.floor(Math.random() * 1000));
const TOKEN = 'e2e-' + Math.random().toString(36).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6e2e-'));
const env = { ...process.env, PORT, MC_TOKEN: TOKEN, FAKE_HOST_RICH: '1', USAGE_STORE: `${tmp}/u.json`, PUSH_STORE: `${tmp}/p.json`, TTS_STORE: `${tmp}/t.json`, CHANNELS_STORE: `${tmp}/c.json`, JARVIS_STORE: `${tmp}/j.json`, REALTIME_STORE: `${tmp}/r.json`, THUMB_CACHE: `${tmp}/th`, DOC_ASSETS: `${tmp}/da`, DOC_PAGES: `${tmp}/dp` };
const procs = [];
const run = (args) => { const p = spawn('node', args, { cwd: REMOTE, env, stdio: 'ignore' }); procs.push(p); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { for (const p of procs) try { p.kill('SIGTERM'); } catch {} };
process.on('exit', cleanup);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
}

run(['server.js']);
await sleep(700);
run(['test/fake-host.mjs']);
await sleep(1200);
const base = `http://localhost:${PORT}`;

await check('relay serves v6 at / and /v6, the classic panel at /classic (task 0622)', async () => {
  const isV6 = async (url, init) => { const r = await fetch(url, init); assert.equal(r.status, 200, url); return /\/v6\/_next\//.test(await r.text()); };
  assert.ok(await isV6(`${base}/v6`), '/v6 is v6');
  assert.ok(await isV6(`${base}/`), '/ is v6');
  assert.ok(await isV6(`${base}/some/deep/route`), 'SPA routes are v6');
  assert.ok(!(await isV6(`${base}/classic`)), '/classic is the classic panel');
  assert.ok(!(await isV6(`${base}/?ui=classic`)), '?ui=classic pins the classic panel');
  assert.ok(await isV6(`${base}/`, { headers: { cookie: 'mc_ui=v53' } }), 'a stale v5.3 A/B cookie no longer overrides v6');
  assert.ok(!(await isV6(`${base}/`, { headers: { cookie: 'mc_ui2=classic' } })), 'mc_ui2=classic keeps a device on classic');
  const man = await (await fetch(`${base}/v6/manifest.json`)).json();
  assert.equal(man.start_url, '/', 'home-screen icon opens /');
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(await sw.text(), /SW_VERSION = 'v6-default-1'/);
});

const browser = await webkit.launch();
for (const dev of [{ name: 'iphone', viewport: { width: 393, height: 852 } }, { name: 'ipad', viewport: { width: 1180, height: 820 } }]) {
  const ctx = await browser.newContext({ viewport: dev.viewport, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await check(`${dev.name}: gate asks for a token, a bad one is refused`, async () => {
    await page.goto(`${base}/v6`);
    await page.fill('input[type=password]', 'nope');
    await page.press('input[type=password]', 'Enter');
    await page.waitForSelector('text=rejected', { timeout: 8000 });
  });
  errors.length = 0; // the refused token logs a 401 on purpose
  await check(`${dev.name}: Now shows Mia, needs-you, flow and the crew`, async () => {
    await page.goto(`${base}/v6?token=${TOKEN}#now`);
    await page.waitForSelector('[data-hero]', { timeout: 10000 });
    await page.waitForSelector('[data-pane="now"] [data-question="q_r2"]', { timeout: 10000 });
    await page.waitForSelector('[data-crew="job:501"]');
    assert.equal(await page.locator('[data-link="linked"]').count(), 1);
    await page.waitForFunction(() => /3/.test(document.querySelector('[data-pane="now"] [data-stage="running"]')?.textContent || ''), null, { timeout: 5000 });
  });
  await check(`${dev.name}: one tap answers a question and the card leaves`, async () => {
    const id = dev.name === 'iphone' ? 'q_r1' : 'q_r2';
    const card = page.locator(`[data-pane="now"] [data-question="${id}"]`);
    await card.locator('button.pill').first().click();
    await page.waitForSelector(`[data-pane="now"] [data-question="${id}"]`, { state: 'detached', timeout: 8000 });
  });
  await check(`${dev.name}: tasks board has every lane and opens a task sheet`, async () => {
    await page.click('[data-tab="tasks"]');
    if (dev.name === 'iphone') await page.locator('[data-pane="tasks"] .seg button', { hasText: 'Done' }).click();
    await page.waitForSelector('[data-pane="tasks"] [data-lane="done"] [data-task="0107"]');
    if (dev.name === 'ipad') for (const l of ['queued', 'running', 'checking', 'done']) assert.equal(await page.locator(`[data-pane="tasks"] [data-lane="${l}"]`).count(), 1);
    if (dev.name === 'iphone') await page.locator('[data-pane="tasks"] .seg button', { hasText: 'Active' }).click();
    await page.locator('[data-pane="tasks"] [data-task="0101"]').click();
    await page.waitForSelector('[data-sheet="task"] >> text=Live · executor 501');
    assert.match(page.url(), /#task\/0101$/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-sheet]', { state: 'detached' });
  });
  await check(`${dev.name}: chat with Mia round-trips`, async () => {
    await page.click('[data-tab="mia"]');
    const msg = `hello from ${dev.name} ${Date.now()}`;
    const box = page.locator('[data-pane="mia"] textarea');
    await box.fill(msg);
    await box.press('Enter');
    await page.waitForSelector(`[data-pane="mia"] >> text=${msg}`);
    // fake Mia answers after a moment
    await page.waitForFunction((m) => [...document.querySelectorAll('[data-pane="mia"] .msg.mia')].length > 0 && document.body.innerText.includes(m), msg, { timeout: 10000 });
  });
  await check(`${dev.name}: library opens a document`, async () => {
    await page.click('[data-tab="library"]');
    await page.locator('[data-pane="library"] [data-doc]').first().click();
    await page.waitForSelector('[data-sheet="doc"] .md', { timeout: 8000 });
    await page.keyboard.press('Escape');
  });
  await check(`${dev.name}: fleet shows limits and sessions`, async () => {
    await page.click('[data-tab="fleet"]');
    await page.waitForSelector('[data-pane="fleet"] [data-agent]');
  });
  await check(`${dev.name}: a push tap's URL (/#task/0101) opens v6 at the task`, async () => {
    await page.goto(`${base}/#task/0101`);
    await page.waitForSelector('[data-sheet="task"] >> text=Live · executor 501', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-sheet]', { state: 'detached' });
  });
  await check(`${dev.name}: Mia can drive the panel (#hash deep link)`, async () => {
    await page.evaluate(() => { location.hash = '#mia'; });
    await page.waitForFunction(() => document.querySelector('[data-pane="mia"]')?.getAttribute('aria-hidden') === 'false');
  });
  await check(`${dev.name}: Liquid Glass lens layer runs, dock pill slides, calm turns it off`, async () => {
    await page.waitForFunction(() => document.documentElement.classList.contains('gl-lens') && !!document.querySelector('canvas.glass-layer'));
    assert.ok((await page.locator('.glass.lens').count()) >= 3, 'controls are lenses');
    const pillX = () => page.evaluate(() => document.querySelector('.dock .sel').getBoundingClientRect().left);
    await page.click('[data-tab="now"]');
    await sleep(900);
    const a = await pillX();
    await page.click('[data-tab="fleet"]');
    await sleep(900);
    assert.ok((await pillX()) > a + 100, 'pill moved to Fleet');
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.click('[data-calm="on"]');
    await page.waitForFunction(() => document.documentElement.classList.contains('calm') && !document.querySelector('canvas.glass-layer'));
    await page.click('[data-calm="off"]');
    await page.waitForFunction(() => document.documentElement.classList.contains('gl-lens'));
    await page.keyboard.press('Escape');
  });
  await check(`${dev.name}: while the pane scrolls the glass frosts (no trailing content, in-pane rims fade), and comes back sharp once it settles (task 0623)`, async () => {
    await page.click('[data-tab="now"]');
    await sleep(1500);
    const st = () => page.evaluate(() => window.__mcGlassStats());
    let s0 = await st();
    assert.equal(s0.sp, 0, 'in-pane rims shown at rest');
    assert.equal(s0.sf, 0, 'sharp content at rest');
    const mid = await page.evaluate(() => new Promise((res) => {
      const pane = document.querySelector('.pane[aria-hidden="false"]');
      pane.scrollTop = 0;
      const t0 = performance.now(); let mid = null, dir = 1;
      const step = () => {
        const t = performance.now() - t0;
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) dir = -1; else if (pane.scrollTop <= 0) dir = 1;
        pane.scrollTop += 9 * dir; // a fling, driven per frame
        if (t > 350 && !mid) mid = window.__mcGlassStats();
        if (t < 600) requestAnimationFrame(step); else res(mid);
      };
      requestAnimationFrame(step);
    }));
    assert.ok(mid.sf > 0.95 && mid.sp > 0.95, `frosted mid-scroll (sf ${mid.sf}, sp ${mid.sp}) ${JSON.stringify(mid)}`);
    await sleep(500);
    s0 = await st();
    assert.equal(s0.sf, 0, `content refraction back after settling ${JSON.stringify(s0)}`);
    assert.equal(s0.sp, 0, 'in-pane rims back after settling');
  });
  await check(`${dev.name}: no console errors`, async () => assert.deepEqual(errors, []));
  await ctx.close();
}
await check('standalone PWA with a short layout viewport: the app, backdrop, glass and dock reach the real screen bottom (task 0623)', async () => {
  // iPhone 16 Pro: screen 402×874; iOS reports innerHeight 874-62 in the bad case
  const ctx = await browser.newContext({ viewport: { width: 402, height: 812 }, deviceScaleFactor: 3, hasTouch: true });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    Object.defineProperty(screen, 'width', { get: () => 402 });
    Object.defineProperty(screen, 'height', { get: () => 874 });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/?token=${TOKEN}#now`);
  await page.waitForFunction(() => document.documentElement.classList.contains('gl-lens'), null, { timeout: 15000 });
  await sleep(600);
  const m = await page.evaluate(() => ({
    gap: document.documentElement.dataset.vgap,
    app: document.querySelector('.app').getBoundingClientRect().bottom,
    scene: document.querySelector('.scene').getBoundingClientRect().bottom,
    glass: document.querySelector('canvas.glass-layer').getBoundingClientRect().bottom,
    dock: document.querySelector('.dock-wrap').getBoundingClientRect().bottom,
    H: window.__mcGlassStats().H,
    scroll: document.scrollingElement.scrollHeight - innerHeight,
  }));
  assert.equal(m.gap, '62');
  for (const k of ["app", "scene", "glass"]) assert.equal(Math.round(m[k]), 874, `${k} reaches the screen bottom ${JSON.stringify(m)}`);
  assert.equal(Math.round(m.dock), 874 - 12, 'dock sits 12px above the screen bottom (no safe-area emulation here)');
  assert.equal(Math.round(m.H), 874, 'glass layer draws the full height');
  assert.ok(m.scroll <= 0, 'document itself does not scroll');
  await ctx.close();
});
await browser.close();
cleanup();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
