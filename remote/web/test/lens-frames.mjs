// Proof frames for the lens layer (v6.4): a line of pane text scrolled under
// the dock at iPhone 3x, in Chromium and WebKit, plus the top pills / sticky
// lenses with content under them. Starts its own relay + fake host like e2e.
// node test/lens-frames.mjs <outDir> [engines=chromium,webkit]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT || `${os.homedir()}/PropIQ-design-0225/node_modules/playwright`);
const REMOTE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out = '/tmp/v64', engines = 'chromium,webkit'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const PORT = String(19000 + Math.floor(Math.random() * 900));
const TOKEN = 'lf-' + Math.random().toString(36).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6lf-'));
const env = { ...process.env, PORT, MC_TOKEN: TOKEN, FAKE_HOST_RICH: '1', USAGE_STORE: `${tmp}/u.json`, PUSH_STORE: `${tmp}/p.json`, TTS_STORE: `${tmp}/t.json`, CHANNELS_STORE: `${tmp}/c.json`, JARVIS_STORE: `${tmp}/j.json`, REALTIME_STORE: `${tmp}/r.json`, THUMB_CACHE: `${tmp}/th`, DOC_ASSETS: `${tmp}/da`, DOC_PAGES: `${tmp}/dp` };
const procs = [];
const run = (args) => { const p = spawn('node', args, { cwd: REMOTE, env, stdio: 'ignore' }); procs.push(p); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => { for (const p of procs) try { p.kill('SIGTERM'); } catch {} });
run(['server.js']);
await sleep(700);
run(['test/fake-host.mjs']);
await sleep(1200);
const base = `http://localhost:${PORT}`;

for (const eng of engines.split(',')) {
  const browser = await pw[eng].launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: eng === 'chromium' ? true : undefined });
  const page = await ctx.newPage();
  if (process.env.SHOTS_BG) await page.addInitScript((bg) => localStorage.setItem('mc6_bg', bg), process.env.SHOTS_BG);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/v6?token=${TOKEN}#now`);
  await page.waitForSelector('[data-hero]', { timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.classList.contains('gl-lens'));
  await sleep(2500);
  // a line of body text in the Now pane, placed on the dock's centre line, then nudged through the rim
  const dock = await page.evaluate(() => { const r = document.querySelector('.dock').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const clip = { x: 0, y: dock.y - 40, width: 393, height: dock.h + 80 };
  const steps = [0, -10, -20, -27, 10, 20, 27];
  for (const [i, off] of steps.entries()) {
    await page.evaluate(({ dock, off }) => {
      const pane = document.querySelector('.pane[aria-hidden="false"]');
      const cands = [...pane.querySelectorAll('p, .small, .title, h2, h3, div')].filter((e) => e.children.length === 0 && (e.textContent || '').trim().length > 24);
      window.__lfEl = window.__lfEl || cands.find((e) => e.getBoundingClientRect().top > dock.y + dock.h + 40) || cands[cands.length - 1];
      const el = window.__lfEl;
      const r = el.getBoundingClientRect();
      pane.scrollTop += r.top + r.height / 2 - (dock.y + dock.h / 2) + off;
      return `${(el.textContent || '').slice(0, 30)} → scrollTop ${pane.scrollTop} / ${pane.scrollHeight - pane.clientHeight}`;
    }, { dock, off }).then((m) => console.log(eng, 'step', off, m));
    await sleep(700); // settle → repaint
    await page.screenshot({ path: `${out}/${eng}-dock-${i}.png`, clip });
  }
  await page.screenshot({ path: `${out}/${eng}-iphone-now-scrolled.png` });
  // the texture the shader samples, over a dark ground so white text shows
  const tex = await page.evaluate(() => { const t = window.__mcContent && window.__mcContent(); if (!t) return null; return new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.fillStyle = '#2a2530'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0); res({ data: c.toDataURL('image/png') }); }; im.src = t.data; }); });
  if (tex) fs.writeFileSync(`${out}/${eng}-content-texture.png`, Buffer.from(tex.data.split(',')[1], 'base64'));
  console.log(eng, 'stats', JSON.stringify(await page.evaluate(() => window.__mcGlassStats && window.__mcGlassStats())));
  // top: every lens that content can pass under (sticky chat head, top pills)
  for (const tab of ['now', 'mia', 'library']) {
    await page.evaluate((t) => { location.hash = '#' + t; }, tab);
    await sleep(1200);
    for (const [i, y] of [0, 120, 260].entries()) {
      await page.evaluate((y) => { const p = document.querySelector('.pane[aria-hidden="false"]'); p.scrollTop = y; }, y);
      await sleep(600);
      await page.screenshot({ path: `${out}/${eng}-top-${tab}-${i}.png`, clip: { x: 0, y: 0, width: 393, height: 200 } });
    }
  }
  console.log(eng, errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
  await browser.close();
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
