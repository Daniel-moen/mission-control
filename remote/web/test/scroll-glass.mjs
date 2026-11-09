// Task 0623: glass while scrolling, on iPhone-class budgets. iPhone 16 Pro
// (402×874 @3x) with its safe areas emulated (--safe-t 62, --safe-b 34), in
// Chromium with the CPU throttled 6x and in WebKit. Flings the Library and Now
// panes, records rAF frame intervals, the lens layer's own frame cost and the
// frost state, and saves frames (settled, mid-scroll, top bar) for comparison
// with Daniel's device screenshot. Starts its own relay + fake host like e2e.
// node test/scroll-glass.mjs <outDir> [engines=chromium,webkit]
// env: GPU=1 (Chromium on the real GPU via Metal, not SwiftShader), CALM=1 (no-GL baseline), THROTTLE=6
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT || `${os.homedir()}/PropIQ-design-0225/node_modules/playwright`);
const REMOTE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out = '/tmp/v65', engines = 'chromium,webkit'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const PORT = String(19000 + Math.floor(Math.random() * 900));
const TOKEN = 'sg-' + Math.random().toString(36).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6sg-'));
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
const SAFE = ':root{--safe-t:62px !important;--safe-b:34px !important}';
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

for (const eng of engines.split(',')) {
  const browser = await pw[eng].launch(eng === 'chromium' && process.env.GPU ? { args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] } : {});
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, hasTouch: true, isMobile: eng === 'chromium' ? true : undefined });
  const page = await ctx.newPage();
  if (process.env.CALM) await page.addInitScript(() => localStorage.setItem('mc6_calm', '1'));
  if (process.env.SHOTS_BG) await page.addInitScript((bg) => localStorage.setItem('mc6_bg', bg), process.env.SHOTS_BG);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?token=${TOKEN}#library`);
  await page.waitForFunction((calm) => document.documentElement.classList.contains(calm ? 'calm' : 'gl-lens'), !!process.env.CALM, { timeout: 15000 });
  await page.addStyleTag({ content: SAFE });
  await sleep(2500);
  let cdp = null;
  if (eng === 'chromium') { cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +(process.env.THROTTLE || 6) }); }
  for (const tab of ['library', 'now']) {
    await page.evaluate((t) => { location.hash = '#' + t; }, tab);
    await sleep(1800);
    await page.screenshot({ path: `${out}/${eng}${process.env.CALM ? '-calm' : ''}-${tab}-settled.png` });
    await page.screenshot({ path: `${out}/${eng}${process.env.CALM ? '-calm' : ''}-${tab}-top.png`, clip: { x: 0, y: 0, width: 402, height: 200 } });
    await page.evaluate(() => { window.__fr = []; let l = performance.now(); const f = (t) => { window.__fr.push(t - l); l = t; if (window.__fr.length < 2000) window.__frRaf = requestAnimationFrame(f); }; requestAnimationFrame(f); });
    const s0 = await page.evaluate(() => (window.__mcGlassStats ? window.__mcGlassStats() : { sf: 0, sp: 0, frames: 0, fms: 0, fmax: 0, paints: 0, last: 0 }));
    // a fling: wheel steps (compositor scroll in Chromium), a frame in the middle
    let mid = null;
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(200, 450);
      await page.mouse.wheel(0, i < 25 ? 40 : -40);
      await sleep(16);
      if (i === 20) { mid = await page.evaluate(() => (window.__mcGlassStats ? window.__mcGlassStats() : { sf: 0, sp: 0, frames: 0, fms: 0, fmax: 0, paints: 0, last: 0 })); await page.screenshot({ path: `${out}/${eng}${process.env.CALM ? '-calm' : ''}-${tab}-midscroll.png` }); }
    }
    await sleep(700);
    const s1 = await page.evaluate(() => (window.__mcGlassStats ? window.__mcGlassStats() : { sf: 0, sp: 0, frames: 0, fms: 0, fmax: 0, paints: 0, last: 0 }));
    const fr = (await page.evaluate(() => { cancelAnimationFrame(window.__frRaf); return window.__fr; })).slice(2);
    await page.screenshot({ path: `${out}/${eng}${process.env.CALM ? '-calm' : ''}-${tab}-after.png` });
    const frames = s1.frames - s0.frames;
    console.log(JSON.stringify({ eng, tab, throttle: cdp ? `${process.env.THROTTLE || 6}x` : 'none', gpu: !!process.env.GPU, calm: !!process.env.CALM, midFrost: { sf: +mid.sf.toFixed(2), sp: +mid.sp.toFixed(2) }, settled: { sf: s1.sf, sp: s1.sp },
      raf: { n: fr.length, p50: +pct(fr, 0.5).toFixed(1), p95: +pct(fr, 0.95).toFixed(1), max: +Math.max(...fr).toFixed(1), over20ms: fr.filter((x) => x > 20).length },
      lens: { frames, avgMs: +((s1.fms - s0.fms) / Math.max(1, frames)).toFixed(2), maxMs: +s1.fmax.toFixed(1), paints: s1.paints - s0.paints, paintMs: s1.last } }));
  }
  if (errors.length) console.log(eng, 'errors', errors);
  await browser.close();
}
process.exit(0);
