// Task 0445 — the three v3 design directions on the real relay + the fake
// host (seeded with a realistic cast: test/v3/cast.json, test/v3/mia.json),
// captured on iPad landscape and iPhone: screenshots, a screen recording per
// direction and device, and frame-time numbers from scripted interactions.
//
//   cd remote && node build.mjs && PLAYWRIGHT=<playwright pkg> node test/v3-rig.mjs
//   OUT=<dir>       where shots/videos/perf.json go (default ~/.mission-control/mia/briefs/0445-shots)
//   ONLY=v3a,v3b    only these directions;  DEV=ipad,phone  only these devices
//   SKIP_VIDEO=1 SKIP_PERF=1 SKIP_SHOTS=1
//   ENGINE=webkit   measure in WebKit (Safari's engine) instead of Chromium
//   KEEP=1          leave the rig up and print the URLs

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT || 'playwright');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RIG_PORT || 8875);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v3-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const OUT = process.env.OUT || path.join(os.homedir(), '.mission-control/mia/briefs/0445-shots');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(MIA_DIR, { recursive: true });

const ENV = {
  MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, FAKE_HOST_LIBRARY: LIB,
  FAKE_HOST_AGENTS: path.join(DIR, 'v3', 'cast.json'), FAKE_HOST_MIA: path.join(DIR, 'v3', 'mia.json'),
  JARVIS_STORE: path.join(TMP, 'j.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'),
  CHANNELS_STORE: path.join(TMP, 'ch.json'), CHANNELS_MEDIA: path.join(TMP, 'media'), USAGE_STORE: path.join(TMP, 'usage.json'),
  DOC_ASSETS: path.join(TMP, 'da'), DOC_PAGES: path.join(TMP, 'dp'), OPENAI_API_KEY: '', RAILWAY_VOLUME_MOUNT_PATH: '',
  MC_LIBRARY: LIB, MC_RELAY_URL: BASE, MC_DOC_NO_DEFAULTS: '1',
};
const procs = [];
function boot(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: path.join(DIR, '..'), env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(120);
  }
}

function writeLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  const doc = (name, front, body) => fs.writeFileSync(path.join(LIB, `${name}.md`), `---\n${front}\n---\n${body}\n`);
  doc('raw-incident-hooks', 'kind: research\nstatus: done\nsubject: Raw Incident\ntags: youtube', '# What makes bodycam videos work\n\n**Answer:** Let the footage breathe, explain after, open on the most tense second.');
  doc('crystal-retention', 'kind: plan\nstatus: active\nsubject: Crystal Garden\ntags: roblox', '# Crystal Garden: come back tomorrow\n\nLift day-1 retention from 18% to 25% with a daily harvest and a streak.');
  doc('mandates-fresnaye', 'kind: research\nstatus: done\nsubject: Oblivion\ntags: mandate', '# Mandate targets in Fresnaye\n\nNine homes over R10m look ready to sell; three owners bought before 2010.');
  doc('kalshi-october', 'kind: research\nstatus: active\nsubject: Kalshi lab\ntags: trading', '# NYC highs: October judge review\n\n6 of 7 calls right; the miss was a front arriving early.');
  doc('ec-balance', 'kind: plan\nstatus: active\nsubject: Empire Clash\ntags: roblox', '# Siege balance pass\n\nTrebuchet wins 71% of sieges at 140 range. Test 120 + slower reload.');
}

async function seedUsage() {
  await fetch(`${BASE}/api/v1/usage`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'rig', at: new Date().toISOString(),
      windows: [
        { key: 'session', label: 'Session (5h)', pct: 62, resetsAt: new Date(Date.now() + 96 * 60e3).toISOString() },
        { key: 'weekly', label: 'Week', pct: 41, active: true, resetsAt: new Date(Date.now() + 3.2 * 24 * 3600e3).toISOString() },
      ],
    }),
  });
}

const DEVICES = {
  ipad: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: false, label: 'iPad landscape' },
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, label: 'iPhone' },
};
const DIRS = ['v3a', 'v3b', 'v3c'];
const NAMES = { v3a: 'lens', v3b: 'presence', v3c: 'press' };
const errors = [];

async function open(browser, ui, dev, { video = null, reduced = false, query = '' } = {}) {
  const d = DEVICES[dev];
  const engine = browser.browserType().name();
  const ctx = await browser.newContext({
    viewport: d.viewport,
    deviceScaleFactor: video ? 1 : d.deviceScaleFactor,
    ...(engine === 'firefox' ? {} : { isMobile: d.isMobile }),
    hasTouch: true,
    colorScheme: 'dark',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    ...(video ? { recordVideo: { dir: video, size: d.viewport } } : {}),
  });
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${ui}/${dev}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (202|404)|Failed to load resource/.test(m.text()) && errors.push(`${ui}/${dev}: ${m.text()}`));
  await page.goto(`${BASE}/${ui}?token=${TOKEN}${query}`);
  await page.waitForSelector('[data-screen]', { timeout: 20000 });
  await until(() => page.evaluate(() => !!document.querySelector('[data-screen="home"]') && !/Reconnecting/.test(document.body.innerText)), 15000, 'linked').catch(() => {});
  await sleep(1800);
  return { page, ctx };
}

// Scripted interactions per direction: open Mia, scroll, come back — each
// with a real touch gesture where the direction has one.
async function toMia(page) {
  await page.locator('[data-open-mia]').first().click();
  await page.waitForSelector('[data-screen="mia"]', { timeout: 5000 });
  await sleep(1300);
}
async function toHome(page) {
  await page.locator('[data-back]').first().click();
  await page.waitForSelector('[data-screen="home"]', { timeout: 5000 }).catch(async (e) => {
    console.log('toHome failed at', await page.evaluate(() => JSON.stringify({ href: location.href, state: history.state, screens: [...document.querySelectorAll('[data-screen]')].map((x) => x.dataset.screen + ':' + getComputedStyle(x).visibility + ':' + x.getBoundingClientRect().width) })));
    throw e;
  });
  await sleep(1300);
}
async function swipe(page, x0, y0, x1, y1, steps = 14) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await sleep(16);
  }
  await page.mouse.up();
}

async function shots(browser, ui, dev) {
  const { page, ctx } = await open(browser, ui, dev, { query: '&bg=01' });
  const n = (s) => path.join(OUT, `${NAMES[ui]}-${dev}-${s}.png`);
  await page.screenshot({ path: n('1-home') });
  await toMia(page);
  await page.screenshot({ path: n('2-mia') });
  await ctx.close();
  // Reduced motion / low power: the fallback has to look designed too.
  const low = await open(browser, ui, dev, { query: '&bg=01&q=low', reduced: true });
  await low.page.screenshot({ path: n('3-home-lowpower') });
  await low.ctx.close();
}

const step = (m) => process.env.STEPS && console.log(`  · ${m}`);
async function record(browser, ui, dev) {
  const vdir = fs.mkdtempSync(path.join(TMP, 'vid-'));
  const { page, ctx } = await open(browser, ui, dev, { video: vdir, query: '&bg=01' });
  const W = DEVICES[dev].viewport.width;
  const H = DEVICES[dev].viewport.height;
  // a finger wandering over the glass / the orb / the type
  await page.mouse.move(W * 0.7, H * 0.3);
  step('rec 1');
  // mostly vertical, so it never reads as Press's page-turn swipe
  await swipe(page, W * 0.72, H * 0.22, W * 0.58, H * 0.62, 40);
  step('rec 2');
  await sleep(1500);
  step('rec 3');
  await page.evaluate(() => window.__v3demo?.());
  step('rec 4');
  await sleep(2000);
  step('rec 5');
  // read down Home and back up (Press's sections, the phone's column)
  const homeScroll = (d) => page.evaluate((d) => {
    const el = [...document.querySelectorAll('[data-screen="home"], [data-screen="home"] *')].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    el?.scrollBy({ top: d, behavior: 'smooth' });
  }, d);
  await homeScroll(H * 1.4);
  step('rec 6');
  await sleep(2200);
  step('rec 7');
  await homeScroll(-H * 3);
  step('rec 8');
  await sleep(1500);
  step('rec 9');
  await toMia(page);
  step('rec 10');
  await sleep(1200);
  step('rec 11');
  await page.locator('[data-thread]').first().evaluate((el) => el.scrollBy({ top: -500, behavior: 'smooth' })).catch(() => {});
  step('rec 12');
  await sleep(1400);
  step('rec 13');
  await page.locator('[data-thread]').first().evaluate((el) => el.scrollBy({ top: 800, behavior: 'smooth' })).catch(() => {});
  step('rec 14');
  await sleep(1200);
  step('rec 15');
  await page.locator('[data-composer]').first().click().catch(() => {});
  step('rec 16');
  await page.keyboard.type('Ship the trebuchet change if 120 holds', { delay: 45 });
  step('rec 17');
  await sleep(900);
  step('rec 18');
  await toHome(page);
  step('rec 19');
  await sleep(1500);
  step('rec 20');
  await ctx.close();
  step('rec 21');
  const f = fs.readdirSync(vdir).find((x) => x.endsWith('.webm'));
  if (f) fs.copyFileSync(path.join(vdir, f), path.join(OUT, `${NAMES[ui]}-${dev}.webm`));
}

// Frame timings: idle (ambient animation only), Home → Mia → Home, and a
// thread scroll — rAF intervals as the page saw them.
async function perf(browser, ui, dev, { cpu = 1 } = {}) {
  const { page, ctx } = await open(browser, ui, dev, { query: '&bg=01' });
  if (cpu > 1 && browser.browserType().name() === 'chromium') {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  const measure = async (fn) => {
    await page.evaluate(() => window.__v3perf.start());
    await fn();
    return page.evaluate(() => window.__v3perf.stop());
  };
  const out = {};
  out.idle = await measure(() => sleep(3000));
  out.transition = await measure(async () => {
    await toMia(page);
    await toHome(page);
  });
  await toMia(page);
  out.scroll = await measure(async () => {
    for (let i = 0; i < 6; i++) {
      await page.locator('[data-thread]').first().evaluate((el, d) => el.scrollBy({ top: d, behavior: 'smooth' }), i % 2 ? 600 : -600).catch(() => {});
      await sleep(450);
    }
  });
  out.glScale = await page.evaluate(() => window.__v3gl?.scale ?? null);
  // main-thread JS per frame (rAF callbacks incl. the shader's uniforms), and
  // the shader alone forced through the GPU at full resolution
  out.bench = await page.evaluate(() => window.__v3gl?.bench?.(60) ?? null);
  await toHome(page);
  out.benchHome = await page.evaluate(() => window.__v3gl?.bench?.(60) ?? null);
  await ctx.close();
  return out;
}

async function main() {
  writeLibrary();
  fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), '');
  boot('node', ['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay');
  boot('node', ['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  await seedUsage();
  await sleep(2500); // a few snapshots, so the tokens/sec history has a shape
  if (process.env.KEEP) {
    for (const ui of DIRS) console.log(`${ui}: ${BASE}/${ui}?token=${TOKEN}`);
    await new Promise(() => {});
  }
  const engineName = process.env.ENGINE || 'chromium';
  const browser = await pw[engineName].launch(engineName === 'chromium' ? { args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--use-angle=metal'] } : {});
  // PROBE='/?ui=v2#fleet' — open one page (DEV: ipad|phone, THEME), screenshot
  // it to PROBE_OUT, print PROBE_JS's result. For iterating on the design.
  if (process.env.PROBE) {
    const dev = process.env.DEV || 'ipad';
    const d = DEVICES[dev];
    for (const theme of (process.env.THEME || 'dark').split(',')) {
      const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: 1, isMobile: d.isMobile, hasTouch: true, colorScheme: theme });
      ctx.setDefaultTimeout(15000);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('pageerror', e.message));
      page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
      for (const [i, u] of process.env.PROBE.split(' ').entries()) {
        const url = `${BASE}${u.replace('?', `?token=${TOKEN}&bg=01&`)}`;
        if (i === 0) await page.goto(url);
        else await page.evaluate((h) => (location.hash = h), u.split('#')[1] || '');
        await sleep(+(process.env.PROBE_WAIT || 2500));
        const out = path.join(process.env.PROBE_OUT || '/tmp', `probe-${dev}-${theme}-${i}.png`);
        await page.screenshot({ path: out });
        if (process.env.PROBE_JS) console.log(i, await page.evaluate(process.env.PROBE_JS).catch((e) => e.message));
        console.log('shot', out);
      }
      await ctx.close();
    }
    await browser.close();
    return;
  }
  // LENS_PERF=1 — task 0445's full Lens build (/?ui=v2): frame timing for the
  // everyday motions, full vs lite glass, iPad + iPhone (+4× CPU), and the
  // shader's GPU cost; → OUT/perf-lens-<engine>.json
  if (process.env.LENS_PERF) {
    const res = {};
    const measure = async (page, fn) => {
      await page.evaluate(() => {
        window.__f = [];
        let last = 0;
        const t = (n) => {
          if (last) window.__f.push(n - last);
          last = n;
          window.__fr = requestAnimationFrame(t);
        };
        window.__fr = requestAnimationFrame(t);
      });
      await fn();
      return page.evaluate(() => {
        cancelAnimationFrame(window.__fr);
        const f = window.__f;
        const s = [...f].sort((a, b) => a - b);
        const base = s[Math.floor(s.length / 2)] || 16.7;
        return { frames: f.length, fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / (f.length || 1))), p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(1), worst: +(s[s.length - 1] || 0).toFixed(1), dropped: f.filter((d) => d > base * 1.5).length };
      });
    };
    for (const dev of (process.env.DEV || 'ipad,phone').split(',')) {
      for (const glass of ['full', 'lite']) {
        for (const cpu of dev === 'phone' && engineName === 'chromium' ? [1, 4] : [1]) {
          const d = DEVICES[dev];
          const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, ...(engineName === 'firefox' ? {} : { isMobile: d.isMobile }), hasTouch: true, colorScheme: 'dark' });
          await ctx.addInitScript((g) => localStorage.setItem('mc.v2.glass', g), glass);
          ctx.setDefaultTimeout(15000);
          const page = await ctx.newPage();
          page.on('pageerror', (e) => errors.push(`lens-perf: ${e.message}`));
          if (cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
          await page.goto(`${BASE}/?token=${TOKEN}&ui=v2&bg=01`);
          await page.waitForSelector('[data-tabbar]');
          await sleep(2500);
          const k = `${dev}/${glass}${cpu > 1 ? `@${cpu}xCPU` : ''}`;
          const r = (res[k] = {});
          r.idleHome = await measure(page, () => sleep(2500));
          const scroller = '[data-page="home"][data-top="true"] .v-scroll';
          r.scrollHome = await measure(page, async () => {
            for (const dy of [500, -500, 500, -500]) {
              await page.locator(scroller).first().evaluate((el, dy) => el.scrollBy({ top: dy, behavior: 'smooth' }), dy).catch(() => {});
              await sleep(500);
            }
          });
          r.tabSwitch = await measure(page, async () => {
            for (const t of ['agents', 'library', 'mia', 'home']) {
              await page.locator(`[data-tab="${t}"]`).click();
              await sleep(550);
            }
          });
          r.zoomInsights = await measure(page, async () => {
            await page.locator('[data-tile="tile-insights"]').click();
            await sleep(900);
            await page.locator('[data-page="insights"][data-top="true"] [data-back]').first().click();
            await sleep(900);
          });
          await page.locator('[data-tab="library"]').click();
          await sleep(700);
          r.scrollLibrary = await measure(page, async () => {
            for (const dy of [700, -700, 700]) {
              await page.locator('[data-page="library"][data-top="true"] .v-scroll').first().evaluate((el, dy) => el.scrollBy({ top: dy, behavior: 'smooth' }), dy).catch(() => {});
              await sleep(500);
            }
          });
          r.pushPop = await measure(page, async () => {
            await page.locator('[data-doc]').first().click();
            await sleep(800);
            await page.locator('[data-page="doc"][data-top="true"] [data-back]').first().click();
            await sleep(800);
          });
          if (glass === 'full') {
            await page.locator('[data-tab="home"]').click();
            await sleep(900);
            r.gpuHome = await page.evaluate(() => window.__v3gl?.bench?.(60) ?? null);
          }
          r.backdropBlurElements = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => { const b = getComputedStyle(e).backdropFilter; return b && b !== 'none'; }).length);
          console.log(k, JSON.stringify(r));
          await ctx.close();
        }
      }
    }
    fs.writeFileSync(path.join(OUT, `perf-lens-${engineName}.json`), JSON.stringify({ at: new Date().toISOString(), engine: engineName, ...res }, null, 2));
    await browser.close();
    return;
  }
  const only = process.env.ONLY ? process.env.ONLY.split(',') : DIRS;
  const devs = process.env.DEV ? process.env.DEV.split(',') : Object.keys(DEVICES);
  const perfOut = {};
  for (const ui of only) {
    for (const dev of devs) {
      console.log(`${ui} · ${dev}`);
      if (!process.env.SKIP_SHOTS) await shots(browser, ui, dev);
      if (!process.env.SKIP_VIDEO) await record(browser, ui, dev);
      if (!process.env.SKIP_PERF) {
        perfOut[`${ui}/${dev}`] = await perf(browser, ui, dev);
        if (dev === 'phone' && engineName === 'chromium') perfOut[`${ui}/${dev}@4xCPU`] = await perf(browser, ui, dev, { cpu: 4 });
        console.log(JSON.stringify(perfOut[`${ui}/${dev}`]));
      }
    }
  }
  await browser.close();
  if (!process.env.SKIP_PERF) {
    const file = path.join(OUT, `perf-${engineName}.json`);
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(file, JSON.stringify({ ...prev, ...perfOut, at: new Date().toISOString(), engine: engineName }, null, 2));
  }
  const errs = [...new Set(errors)];
  console.log(errs.length ? `console errors:\n  ${errs.join('\n  ')}` : 'zero console errors');
  console.log(`Output: ${OUT}`);
}

const cleanup = () => {
  for (const p of procs) try { p.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 300);
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
main().then(() => cleanup(), (e) => {
  console.error(e);
  cleanup();
  setTimeout(() => process.exit(1), 800); // an open browser would keep us alive
});
