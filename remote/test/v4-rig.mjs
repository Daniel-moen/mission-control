// Task 0446 — the three v4 STRUCTURAL directions — A Stage (Mia-first
// canvas), B Atlas (zoomable map of rooms), C Now (a stack of moments) — on
// the real relay + the fake host (seeded with test/v3/cast.json + mia.json):
// screenshots (iPad landscape, iPad portrait, iPhone; dark, plus light), one
// screen recording of each direction's key gesture, and frame timings of
// those gestures in WebKit (Safari's engine) at iPhone size.
//
//   cd remote && node build.mjs && PLAYWRIGHT=<playwright pkg> node test/v4-rig.mjs
//   OUT=<dir>   default ~/.mission-control/mia/briefs/0446-shots
//   ONLY=v4a,v4c   SKIP_SHOTS=1 SKIP_VIDEO=1 SKIP_PERF=1   KEEP=1 (print URLs, stay up)
//   PROBE='/v4b#agents' DEV=phone THEME=dark,light   one screenshot per hash, to /tmp
//   LENS_SHOTS=1   (0448) entry + one inner screen, iPad + iPhone, dark + light, + lite

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
const PORT = Number(process.env.RIG_PORT || 8876);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v4-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const OUT = process.env.OUT || path.join(os.homedir(), '.mission-control/mia/briefs/0446-shots');
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
  doc('mandates-fresnaye', 'kind: research\nstatus: done\nsubject: Oblivion\ntags: mandate', '# Mandate targets in Fresnaye\n\n**Answer:** nine homes over R10m look ready to sell; three owners bought before 2010 and sit on large unrealised gains.\n\n## The shortlist\n\n| Street | Est. value | Owned since | Signal |\n|---|---|---|---|\n| Avenue Fresnaye | R28m | 2006 | Children left home |\n| De Wet Road | R19m | 2009 | Listed a rental nearby |\n| Kloof Road | R34m | 2004 | Owner relocated to London |\n| Avenue Disandt | R14m | 2015 | Planning application lapsed |\n\n## Why now\n\nStock above R10m on the Atlantic Seaboard is down 18% on last year while enquiries are up. Owners who bought before 2010 can sell at roughly three times their price.\n\n## Approach\n\n1. Handwritten letter with a recent comparable sale.\n2. Follow-up call after ten days.\n3. Offer a private valuation, no listing commitment.');
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
  ipad: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: false },
  ipadp: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: false },
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true },
};
const DIRS = (process.env.ONLY || 'v4a,v4b,v4c').split(',');
const NAMES = { v4a: 'stage', v4b: 'atlas', v4c: 'now' };
const errors = [];

async function open(browser, ui, dev, { video = null, theme = 'dark', hash = '', scale, q = '' } = {}) {
  const d = DEVICES[dev];
  const engine = browser.browserType().name();
  const ctx = await browser.newContext({
    viewport: d.viewport,
    deviceScaleFactor: scale ?? (video ? 1 : d.deviceScaleFactor),
    ...(engine === 'firefox' ? {} : { isMobile: d.isMobile }),
    hasTouch: true,
    colorScheme: theme,
    ...(video ? { recordVideo: { dir: video, size: d.viewport } } : {}),
  });
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${ui}/${dev}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (202|404)|Failed to load resource/.test(m.text()) && errors.push(`${ui}/${dev}: ${m.text()}`));
  await page.goto(`${BASE}/${ui}?token=${TOKEN}&bg=01&theme=${theme}${q ? `&q=${q}` : ''}${hash}`);
  await page.waitForSelector('[data-screen]', { timeout: 20000 });
  await until(() => page.evaluate(() => !/Reconnecting/.test(document.body.innerText) && document.querySelectorAll('[data-card],[data-room],[data-moment]').length > 2), 15000, 'linked').catch(() => {});
  await sleep(2200);
  return { page, ctx };
}
// A real click when Playwright can make one (it waits for the camera to stop
// moving); else dispatch it, so one hesitant element can't stall the rig.
const tap = (page, sel) => page.locator(sel).first().click({ timeout: 4000 }).catch(() => page.locator(sel).first().dispatchEvent('click'));
const hash = (page, h) => page.evaluate((h) => (location.hash = h), h);
const unhash = (page) => tap(page, '[data-back]');
async function drag(page, x0, y0, x1, y1, steps = 14, ms = 16) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await sleep(ms);
  }
  await page.mouse.up();
}
const center = async (loc) => {
  if (!(await loc.count())) return null;
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await sleep(250);
  const b = await loc.boundingBox({ timeout: 3000 }).catch(() => null);
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, b } : null;
};

// The screens Daniel judges by: entry, Mia, one agent, one doc, what's waiting.
const AGENT = 'cg-retention';
const DOC = 'mandates-fresnaye.md';
async function shots(browser, ui, dev, theme = 'dark') {
  const { page, ctx } = await open(browser, ui, dev, { theme });
  const n = (s) => path.join(OUT, `${NAMES[ui]}-${dev}${theme === 'dark' ? '' : '-' + theme}-${s}.png`);
  const settle = (ms = 1500) => (process.env.STEPS && console.log('  settle', ui, dev, new Error().stack.split('\n')[2].trim()), sleep(ms));
  await page.screenshot({ path: n('1-entry') });
  if (theme !== 'dark' || dev === 'ipadp') return ctx.close();
  if (ui === 'v4b') {
    // Atlas: fly into the Needs room, then Agents, then a window
    await tap(page, '[data-room="needs"]');
    await settle(1800);
    await page.screenshot({ path: n('2-needs') });
    await tap(page, '[data-mini="mia"]');
    await settle(1800);
    await page.screenshot({ path: n('3-mia') });
    await tap(page, '[data-mini="agents"]');
    await settle(1800);
    await page.screenshot({ path: n('4-agents-room') });
    await tap(page, `[data-agent-tile="${AGENT}"]`);
    await settle(1800);
    await page.screenshot({ path: n('5-agent') });
    await unhash(page);
    await settle(1200);
    await tap(page, '[data-mini="library"]');
    await settle(1600);
    await tap(page, `[data-doc-tile="${DOC}"]`);
    await settle(1800);
    await page.screenshot({ path: n('6-doc') });
  } else {
    await hash(page, 'mia');
    await settle();
    await page.screenshot({ path: n('3-mia') });
    await unhash(page);
    await settle(1000);
    if (ui === 'v4a') {
      // Stage: ask for the agents → cards fly in
      await page.locator('[data-composer] input').fill('show agents');
      await page.keyboard.press('Enter');
      await settle(1800);
      await page.screenshot({ path: n('2-asked-agents') });
    } else {
      await page.locator('[data-feed]').evaluate((el) => el.scrollBy({ top: 700 }));
      await settle(900);
      await page.screenshot({ path: n('2-stack-scrolled') });
      await page.locator('[data-feed]').evaluate((el) => el.scrollTo({ top: 0 }));
    }
    await hash(page, `agent/${AGENT}`);
    await settle();
    await page.screenshot({ path: n('5-agent') });
    await unhash(page);
    await settle(1000);
    await hash(page, `doc/${DOC}`);
    await settle(1800);
    await page.screenshot({ path: n('6-doc') });
    await unhash(page);
    await settle(1000);
    await hash(page, 'need/q_phx');
    await settle();
    await page.screenshot({ path: n('4-need') });
  }
  await ctx.close();
}

// The key gesture of each direction, recorded at 1× (Chromium's recorder).
async function gesture(page, ui, dev, step = () => {}) {
  const { width: W, height: H } = DEVICES[dev].viewport;
  if (ui === 'v4a') {
    // a card flicked up opens full-screen; pulled down it goes back; a card
    // flicked down leaves; asking brings new ones in
    let c = await center(page.locator('[data-card^="agent:"]').first());
    if (c) await drag(page, c.x, c.y, c.x, c.y - 260, 10, 18);
    step('opened');
    await sleep(1600);
    const head = await center(page.locator('.st-open-head').first());
    if (head) await drag(page, head.x, head.y, head.x, head.y + 420, 14, 18);
    step('closed');
    await sleep(1300);
    c = await center(page.locator('[data-card^="agent:"]').last());
    if (c) await drag(page, c.x, c.y, c.x + (dev === 'phone' ? 0 : 60), c.y + 320, 10, 16);
    step('flicked');
    await sleep(1100);
    await tap(page, '[data-say="Show the library"]');
    step('library');
    await sleep(1800);
    await tap(page, '[data-open-mia]');
    await sleep(1600);
    const th = await center(page.locator('.st-thread .st-open-head').first());
    if (th) await drag(page, th.x, th.y, th.x, th.y + 450, 14, 18);
    await sleep(1200);
  } else if (ui === 'v4b') {
    // the map → into a room → slide sideways to the next → dive into a tile →
    // back out → pinch back up to the map
    await sleep(600);
    await tap(page, '[data-room="agents"]');
    step('agents');
    await sleep(1500);
    await drag(page, W * 0.8, H * 0.5, W * 0.2, H * 0.52, 12, 18);
    step('swiped');
    await sleep(1400);
    await drag(page, W * 0.2, H * 0.5, W * 0.8, H * 0.48, 12, 18);
    await sleep(1400);
    await tap(page, `[data-agent-tile="${AGENT}"]`);
    step('window');
    await sleep(1700);
    const head = await center(page.locator('.at-window .st-open-head').first());
    if (head) await drag(page, head.x, head.y, head.x, head.y + 420, 14, 18);
    await sleep(1300);
    if (browserName(page) === 'chromium') {
      // a trackpad/two-finger pinch out (ctrl+wheel) back to the map
      await page.mouse.move(W / 2, H / 2);
      await page.keyboard.down('Control');
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 14);
        await sleep(16);
      }
      await page.keyboard.up('Control');
    } else await tap(page, '[data-to-map]');
    step('map');
    await sleep(1800);
    await tap(page, '[data-room="needs"]');
    await sleep(1600);
    await tap(page, '[data-to-map]');
    await sleep(1500);
  } else {
    // swipe a card left (later), one right (do it), tap one into a sheet and
    // throw the sheet away, pull the stack to talk
    let c = await center(page.locator('[data-moment^="doc:"] .nw-card').first());
    if (c) await drag(page, c.x - 40, c.y, c.x - 320, c.y + 6, 12, 18);
    step('later');
    await sleep(1200);
    c = await center(page.locator('[data-moment^="need:q_"] .nw-card').first());
    if (c) await drag(page, c.b.x + 40, c.b.y + 30, c.b.x + 360, c.b.y + 36, 12, 18);
    step('answered');
    await sleep(1500);
    c = await center(page.locator('[data-moment^="agent:"] .nw-card').first());
    if (c) await page.mouse.click(c.x, c.y);
    step('sheet');
    await sleep(1600);
    const head = await center(page.locator('.nw-sheet .st-open-head').first());
    if (head) await drag(page, head.x, head.y, head.x, head.y + 480, 12, 16);
    await sleep(1300);
    await drag(page, W / 2, 110, W / 2, 420, 18, 20);
    step('pull');
    await sleep(1400);
  }
}
const browserName = (page) => page.context().browser().browserType().name();

async function record(browser, ui, dev) {
  const vdir = fs.mkdtempSync(path.join(TMP, 'vid-'));
  const { page, ctx } = await open(browser, ui, dev, { video: vdir });
  await gesture(page, ui, dev);
  await ctx.close();
  const f = fs.readdirSync(vdir).find((x) => x.endsWith('.webm'));
  if (!f) return;
  const base = path.join(OUT, `${NAMES[ui]}-${dev}-gesture`);
  fs.copyFileSync(path.join(vdir, f), `${base}.webm`);
  // mp4 (H.264) so it plays in Messages/QuickLook; skip the first second of load
  await new Promise((res) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.2', '-i', `${base}.webm`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', `${base}.mp4`]);
    p.on('close', res);
    p.on('error', res);
  });
  if (fs.existsSync(`${base}.mp4`)) fs.rmSync(`${base}.webm`);
}

// Frame timings in WebKit at iPhone size: idle, and the key gesture.
async function perf(browser, ui, dev) {
  const { page, ctx } = await open(browser, ui, dev, { scale: 3 });
  const measure = async (fn) => {
    await page.evaluate(() => window.__v3perf.start());
    await fn();
    return page.evaluate(() => window.__v3perf.stop());
  };
  const out = {};
  out.idle = await measure(() => sleep(3000));
  const marks = [];
  await page.evaluate(() => {
    window.__long = [];
    let last = 0;
    const f = (t) => {
      if (last && t - last > 50) window.__long.push([Math.round(last), Math.round(t - last)]);
      last = t;
      window.__lr = requestAnimationFrame(f);
    };
    window.__lr = requestAnimationFrame(f);
  });
  out.gesture = await measure(() => gesture(page, ui, dev, async (m) => marks.push([m, Math.round(await page.evaluate(() => performance.now()))])));
  if (process.env.LONG) console.log(ui, 'long frames', JSON.stringify(await page.evaluate(() => window.__long)), 'marks', JSON.stringify(marks));
  out.scroll = await measure(async () => {
    const sel = ui === 'v4c' ? '[data-feed]' : '[data-thread]';
    if (ui !== 'v4c') await hash(page, 'mia');
    await sleep(900);
    for (let i = 0; i < 6; i++) {
      await page.locator(sel).first().evaluate((el, d) => el.scrollBy({ top: d, behavior: 'smooth' }), i % 2 ? -600 : 600).catch(() => {});
      await sleep(450);
    }
  });
  await ctx.close();
  return out;
}

// Task 0458 — the glass bends the photo. REFRACT=1 TAG=before|after:
//   • edge crops: a pane's corner over the photo, per direction, iPad +
//     iPhone, dark + light → <dir>-<dev>-<theme>-edge-<tag>.png (+ full screen)
//   • COMPARE=1: before | after side by side for every crop that has both
//   • TAG=after also records a pane gliding over the photo (CSS `translate`,
//     so the shader sees it move) while the pointer sweeps (tilt + light)
//     → <dir>-<dev>-glass-move.mp4, and WebKit frame timings at iPhone size
//     with a pane moving → refract-perf-webkit-iphone.json
// The pane: the first shader-drawn one fully on screen.
const pickPane = (page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('.lens-live')) {
      const r = el.getBoundingClientRect();
      if (r.left >= 8 && r.top >= 8 && r.right <= innerWidth - 8 && r.bottom <= innerHeight - 8 && r.width > 120) {
        document.querySelectorAll('[data-refract-pick]').forEach((x) => x.removeAttribute('data-refract-pick'));
        el.setAttribute('data-refract-pick', '');
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return null;
  });
// Glide the picked pane along a loop for `ms`, sweeping the pointer too.
async function glide(page, ms = 4200) {
  const { width: W, height: H } = page.viewportSize();
  const t0 = Date.now();
  page.evaluate((ms) => {
    const el = document.querySelector('[data-refract-pick]');
    if (!el) return;
    const t0 = performance.now();
    const f = (t) => {
      const k = (t - t0) / ms;
      if (k >= 1) {
        el.style.translate = '';
        return;
      }
      const a = k * Math.PI * 2;
      const amp = Math.min(innerWidth, innerHeight) * 0.16;
      el.style.translate = `${(Math.sin(a) * amp * 1.4).toFixed(1)}px ${(Math.sin(a * 2) * amp * 0.6).toFixed(1)}px`;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }, ms);
  while (Date.now() - t0 < ms) {
    const k = (Date.now() - t0) / ms;
    await page.mouse.move(W * (0.5 + 0.42 * Math.cos(k * Math.PI * 2)), H * (0.5 + 0.38 * Math.sin(k * Math.PI * 4)));
    await sleep(30);
  }
  await sleep(200);
}
async function refract(chromium) {
  const tag = process.env.TAG || 'after';
  const devs = (process.env.DEVS || 'ipad,phone').split(',');
  if (process.env.COMPARE) return compareEdges(chromium);
  for (const ui of DIRS) {
    for (const dev of devs) {
      for (const theme of (process.env.THEME || 'dark,light').split(',')) {
        const { page, ctx } = await open(chromium, ui, dev, { theme });
        await page.mouse.move(-5, -5).catch(() => {});
        const r = await pickPane(page);
        const base = `${NAMES[ui]}-${dev}-${theme}`;
        await page.screenshot({ path: path.join(OUT, `${base}-full-${tag}.png`) });
        if (r) {
          // the pane's bottom-left corner (the photos' detail — trees, rock,
          // water — sits low), photo on both sides of the edge
          const cw = dev === 'phone' ? 200 : 300;
          const ch = dev === 'phone' ? 150 : 210;
          const { width: VW, height: VH } = DEVICES[dev].viewport;
          const clip = { x: Math.max(0, r.x - cw * 0.3), y: Math.min(VH - ch, Math.max(0, r.y + r.h - ch * 0.7)), width: Math.min(cw, VW), height: ch };
          await page.screenshot({ path: path.join(OUT, `${base}-edge-${tag}.png`), clip });
        }
        await ctx.close();
      }
      if (tag === 'after' && !process.env.SKIP_VIDEO) {
        const vdir = fs.mkdtempSync(path.join(TMP, 'vid-'));
        const { page, ctx } = await open(chromium, ui, dev, { video: vdir });
        await pickPane(page);
        await glide(page, 5000);
        await ctx.close();
        const f = fs.readdirSync(vdir).find((x) => x.endsWith('.webm'));
        const out = path.join(OUT, `${NAMES[ui]}-${dev}-glass-move.mp4`);
        if (f)
          await new Promise((res) => {
            const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2.4', '-i', path.join(vdir, f), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out]);
            p.on('close', res);
            p.on('error', res);
          });
      }
      console.log(`refract ${ui} ${dev} ${tag} done`);
    }
  }
  if (tag === 'after' && !process.env.SKIP_PERF) {
    const webkit = await pw.webkit.launch();
    const res = {};
    for (const ui of DIRS) {
      const { page, ctx } = await open(webkit, ui, 'phone', { scale: 3 });
      await pickPane(page);
      const m = async (fn) => {
        await page.evaluate(() => window.__v3perf.start());
        await fn();
        return page.evaluate(() => window.__v3perf.stop());
      };
      res[ui] = {
        idle: await m(() => sleep(3000)),
        paneMoving: await m(() => glide(page, 4000)),
        gpu: await page.evaluate(() => window.__lens?.bench?.(40)).catch(() => null),
        mode: await page.evaluate(() => document.documentElement.dataset.lensmode),
      };
      console.log(ui, JSON.stringify({ idle: res[ui].idle.fps, moving: res[ui].paneMoving.fps, p95: res[ui].paneMoving.p95Ms, gpu: res[ui].gpu, mode: res[ui].mode }));
      await ctx.close();
    }
    fs.writeFileSync(path.join(OUT, 'refract-perf-webkit-iphone.json'), JSON.stringify(res, null, 2));
    await webkit.close();
  }
  console.log('errors:', errors.length ? errors : 'none');
}
// before | after, each crop shown at 2× so the bend reads at a glance
async function compareEdges(chromium) {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('-edge-before.png'));
  const ctx = await chromium.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const f of files) {
    const a = path.join(OUT, f.replace('-before', '-after'));
    if (!fs.existsSync(a)) continue;
    const uri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
    const label = f.replace('-edge-before.png', '');
    await page.setContent(`<body style="margin:0;background:#111;font:600 22px -apple-system,system-ui;color:#eee;display:inline-flex;gap:18px;padding:18px">
      <figure style="margin:0"><figcaption style="margin-bottom:8px">${label} — before (0448)</figcaption><img id=a src="${uri(path.join(OUT, f))}"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:8px">after (0458)</figcaption><img id=b src="${uri(a)}"></figure></body>`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await page.evaluate(() => document.querySelectorAll('img').forEach((i) => (i.style.width = `${Math.min(i.naturalWidth, 900)}px`)));
    const box = await page.locator('body').boundingBox();
    await page.screenshot({ path: path.join(OUT, `${label}-edge-compare.png`), clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) } });
  }
  await ctx.close();
  console.log('compare done', files.length);
}

async function main() {
  writeLibrary();
  fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), '');
  boot('node', ['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay');
  boot('node', ['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  await seedUsage();
  await sleep(2500);
  if (process.env.KEEP) {
    for (const ui of DIRS) console.log(`${ui}: ${BASE}/${ui}?token=${TOKEN}`);
    await new Promise(() => {});
  }
  const chromium = await pw.chromium.launch({ args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  if (process.env.PROBE) {
    const dev = process.env.DEV || 'ipad';
    const browser = process.env.ENGINE === 'webkit' ? await pw.webkit.launch() : chromium;
    for (const theme of (process.env.THEME || 'dark').split(',')) {
      const [first, ...rest] = process.env.PROBE.split(' ');
      const [p, h0] = first.split('#');
      const { page, ctx } = await open(browser, p.replace(/^\//, ''), dev, { theme, scale: 1, hash: h0 ? `#${h0}` : '' });
      for (const [i, u] of [first, ...rest].entries()) {
        if (i) {
          if (u.startsWith('js:')) await page.evaluate(u.slice(3)).catch((e) => console.log('js', e.message));
          else await hash(page, u.replace(/^#/, ''));
          await sleep(+(process.env.PROBE_WAIT || 1800));
        }
        const out = path.join('/tmp', `probe-${dev}-${theme}-${i}.png`);
        await page.screenshot({ path: out });
        if (process.env.PROBE_JS) console.log(i, await page.evaluate(process.env.PROBE_JS).catch((e) => e.message));
        console.log('shot', out);
      }
      await ctx.close();
    }
    console.log('errors:', errors.length ? errors : 'none');
    await chromium.close();
    return;
  }
  if (process.env.REFRACT) {
    await refract(chromium);
    await chromium.close();
    return;
  }
  // Task 0448 — the Lens skin: entry + one inner screen per direction, iPad
  // landscape + iPhone, dark + light, then the lite (low power) fallback.
  if (process.env.LENS_SHOTS) {
    const INNER = { v4a: `#agent/${AGENT}`, v4b: 'room:agents', v4c: '#need/q_phx' };
    for (const ui of DIRS) {
      for (const dev of ['ipad', 'phone']) {
        for (const theme of ['dark', 'light']) {
          const { page, ctx } = await open(chromium, ui, dev, { theme });
          const n = (s) => path.join(OUT, `${NAMES[ui]}-${dev}-${theme}-${s}.png`);
          await page.screenshot({ path: n('1-entry') });
          const inner = INNER[ui];
          if (inner.startsWith('room:')) await tap(page, `[data-room="${inner.slice(5)}"]`);
          else await hash(page, inner.slice(1));
          await sleep(2000);
          await page.screenshot({ path: n('2-inner') });
          await ctx.close();
        }
      }
      for (const theme of ['dark', 'light']) {
        const { page, ctx } = await open(chromium, ui, 'ipad', { theme, q: 'low' });
        await page.screenshot({ path: path.join(OUT, `${NAMES[ui]}-ipad-${theme}-3-lite.png`) });
        await ctx.close();
      }
      console.log(`lens shots ${ui} done`);
    }
    console.log('errors:', errors.length ? errors : 'none');
    await chromium.close();
    return;
  }
  if (!process.env.SKIP_SHOTS) {
    for (const ui of DIRS) {
      for (const dev of ['ipad', 'phone', 'ipadp']) await shots(chromium, ui, dev);
      for (const dev of ['ipad', 'phone']) await shots(chromium, ui, dev, 'light');
      console.log(`shots ${ui} done`);
    }
  }
  if (!process.env.SKIP_VIDEO) {
    for (const ui of DIRS) {
      for (const dev of ui === 'v4b' ? ['ipad', 'phone'] : ['phone', 'ipad']) await record(chromium, ui, dev);
      console.log(`video ${ui} done`);
    }
  }
  if (!process.env.SKIP_PERF) {
    const webkit = await pw.webkit.launch();
    const res = {};
    for (const ui of DIRS) {
      res[ui] = await perf(webkit, ui, 'phone');
      console.log(ui, JSON.stringify(Object.fromEntries(Object.entries(res[ui]).map(([k, v]) => [k, { fps: v.fps, dropped: v.dropped, p95: v.p95Ms, worst: v.worstMs, frames: v.frames }]))));
    }
    fs.writeFileSync(path.join(OUT, 'perf-webkit-iphone.json'), JSON.stringify(res, null, 2));
    await webkit.close();
  }
  await chromium.close();
  console.log('errors:', errors.length ? errors : 'none');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    procs.forEach((p) => p.kill());
    setTimeout(() => process.exit(), 300); // an open browser must not keep a failed run alive
  });
