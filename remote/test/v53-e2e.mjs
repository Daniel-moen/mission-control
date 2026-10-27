// Panel v5.3 end to end (task 0502): chat first, Liquid Glass, a bottom tab
// bar, at /v53 beside v5 and v5.2. The real relay, the fake host as the Mac
// and the built panel in headless Chromium (Metal GPU) at iPhone, iPad
// portrait and iPad landscape, dark and light. Grown out of v5.2's suite
// (test/v52-e2e.mjs).
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/v53-e2e.mjs
//   SHOTS=<dir>   screenshots (default: a temp dir)      VIDEO=1  short recordings too
//   ONLY=a,b      only these viewports (phone,ipad-port,ipad-land)
//   KEEP=1        leave the rig up and print the URL
//   PART=frames   only serving + frame timing + lite (a quick re-check)
//
//   • serving: /v53 beside /v52, /v5 and / (v1), ?ui=v53 and the mc_ui cookie
//   • the chat is the home screen; the composer is its own row of glass over
//     the photo, the tab bar under it — nothing overlaps, all of it shader glass
//   • the tab bar: five tabs + search, a floating capsule; every tab lands
//     where it should; the lens lifts under a press, follows a drag, settles
//     where it's let go; scrolling minimises the bar and the composer slides
//     down beside it; scrolling back (or a tap) restores it
//   • the pane: X / Esc / drag-down close it; right-edge swipe reopens
//   • every `mia panel` target (open-doc --at, highlight, scroll-to, scroll,
//     close, open-task, open-agent, view *, show-doc, show-url, search)
//   • the moving light lives in the shader's scene (the glass bends it) and
//     paces itself with the agents; highlights answer scroll
//   • restraint: type scale, radii, no emoji, no candy pills, no bounce
//   • frame timing (rAF p95 ≤ 20 ms) during chat scroll, the bar minimising,
//     the lens, pane open/close; the glass never lags
//   • reduced motion → lite glass, still usable
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
const REPO = path.join(DIR, '..', '..');
const PORT = Number(process.env.RIG_PORT || 8877);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v53-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(MIA_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const fails = [];
const ok = (c, label) => {
  if (c) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    fails.push(label);
    console.error(`  ✗ ${label}`);
  }
};

const ENV = {
  MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, FAKE_HOST_LIBRARY: LIB, FAKE_HOST_PAGE_KIND: '1',
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
const run = (args) =>
  new Promise((resolve) => {
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), ...args], { env: { ...process.env, ...ENV } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (status) => resolve({ status, out }));
  });
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(120);
  }
}
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const thread = async () => (await api('GET', '/api/v1/mia')).j.mia?.messages || [];
const isoAgo = (min) => new Date(Date.now() - min * 60e3).toISOString();

function writeLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  const doc = (name, front, body) => fs.writeFileSync(path.join(LIB, `${name}.md`), `---\n${front}\n---\n${body}\n`);
  const para =
    'The short version: the opening seconds decide everything. Viewers who stay past the first tense moment watch to the end, and the ones who leave do so before any narration starts. That argues for letting the footage breathe and explaining afterwards.';
  doc(
    'raw-incident-hooks',
    'kind: research\nstatus: done\nsubject: Bodycam channel\ntags: youtube, research\ncompany: video\ncreated: 2026-10-10T10:00:00Z',
    `# Raw Incident: what makes bodycam videos work\n\n**Answer:** Let the footage breathe, explain after, and open on the most tense second.\n\n## What the numbers say\n\n${para}\n\n${para}\n\n| Video | 24h views | Retention |\n|---|---|---|\n| Phoenix stop | 18,400 | 61% |\n| Kern pursuit | 9,100 | 48% |\n| LAPD standoff | 6,800 | 44% |\n\n## What to change\n\n- Cut the intro card entirely.\n- Open on the moment the officer reaches the window.\n- Narration only between beats, never over them.\n\n${para}\n\n## Sources\n\n${para}\n\n${para}\n\n## Appendix: the long tail\n\n${para}\n\n${para}`,
  );
  doc('crystal-retention', 'kind: plan\nstatus: active\nsubject: Crystal Garden\ntags: roblox\ncreated: 2026-10-11T10:00:00Z', '# Crystal Garden: come back tomorrow\n\nA plan to lift day-1 retention from 18% to 25% with a daily harvest and a streak.\n\n## Steps\n\n1. Daily harvest\n2. Streak\n3. Measure');
  doc('mandates-fresnaye', 'kind: research\nstatus: done\nsubject: Oblivion\ntags: mandate\ncreated: 2026-10-09T10:00:00Z', '# Mandate targets in Fresnaye\n\n**In one line:** Nine homes over R10m look ready to sell; three have owners who bought before 2010.');
  doc('lunch-ideas', 'kind: note\nstatus: draft\ncreated: 2026-10-08T10:00:00Z', '# Lunch ideas\n\nSomething unrelated to any company at all, just a note.');
  for (let i = 1; i <= 60; i++) doc(`bulk-note-${String(i).padStart(2, '0')}`, `kind: note\nstatus: draft\ntags: bulk\ncreated: 2026-09-${String((i % 27) + 1).padStart(2, '0')}T10:00:00Z`, `# Field note ${i}\n\nA short note to make the Library long enough to need virtualising.`);
}

function miaLines() {
  return [
    { id: 'r_1', at: isoAgo(2 * 24 * 60), from: 'mia', kind: 'question', text: 'Keep the old Kern thumbnail or test the new one?', options: ['Keep', 'Test new'], questionId: 'q_old2d' },
    { id: 'r_2', at: isoAgo(180), from: 'mia', kind: 'question', text: 'Should the Fresnaye dossier include the 2009 sales?', options: ['Yes', 'No'], questionId: 'q_old3h' },
    { id: 'r_3', at: isoAgo(25), from: 'mia', kind: 'chat', text: 'Tempe long-form is live. 1,240 views in the first hour, retention 58% at 30s — best opening of the week.' },
    { id: 'r_3b', at: isoAgo(20), from: 'mia', kind: 'notify', text: 'Crystal Garden build passed review — ready to publish when you are.' },
    { id: 'r_4', at: isoAgo(12), from: 'mia', kind: 'question', text: 'Publish the Phoenix Short now or hold it for the 18:00 slot?', options: ['Now', '18:00'], questionId: 'q_new12' },
  ];
}

async function seedJarvis() {
  fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [], reminders: [] }));
  const r = await run(['jarvis', 'seed']);
  if (r.status !== 0) return console.error('jarvis seed failed (HQ shots will be empty):', r.out.slice(0, 300));
  const REG = path.join(MIA_DIR, 'jarvis', 'registry.json');
  try {
    const R = JSON.parse(fs.readFileSync(REG, 'utf8'));
    for (const p of R.projects) {
      p.probes = [];
      if (p.healthcheck) p.healthcheck = null;
    }
    fs.writeFileSync(REG, JSON.stringify(R, null, 2));
  } catch {}
  await run(['jarvis', 'upgrade']);
  await run(['jarvis', 'sync']);
}

async function seedUsage() {
  await api('PUT', '/api/v1/usage', {
    source: 'rig',
    at: new Date().toISOString(),
    windows: [
      { key: 'session', label: 'Session (5h)', pct: 83, resetsAt: new Date(Date.now() + 96 * 60e3).toISOString() },
      { key: 'weekly', label: 'Week', pct: 41, active: true, resetsAt: new Date(Date.now() + 3.2 * 24 * 3600e3).toISOString() },
    ],
  });
}

let panelSeq = 0;
function panel(action, arg, heading) {
  const line = { id: `t_${Date.now()}_${++panelSeq}`, action };
  if (arg != null) line.arg = arg;
  if (heading != null) line.heading = heading;
  fs.appendFileSync(path.join(MIA_DIR, 'panel.jsonl'), JSON.stringify(line) + '\n');
  return line.id;
}
const panelResults = () => {
  try {
    return fs.readFileSync(path.join(MIA_DIR, 'panel-results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const resultFor = (id, ms = 12000) => until(() => Promise.resolve(panelResults().find((r) => r.id === id)), ms, `panelResult ${id}`).catch(() => null);

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
  'ipad-port': { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 },
  'ipad-land': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 },
  stage: { viewport: { width: 700, height: 860 }, deviceScaleFactor: 1 },
};

const allErrors = [];
async function newPage(browser, tag, { theme = 'dark', hash = '', reduced = false, video = null } = {}) {
  const vp = VIEWPORTS[tag];
  const ctx = await browser.newContext({
    ...vp,
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    permissions: ['microphone'],
    ...(video ? { recordVideo: { dir: video, size: vp.viewport } } : {}),
  });
  // A charged device: the panel drops to lite glass on a low, discharging battery (prefs.js), and the
  // headless browser reports the Mac's real battery — the run must not depend on it.
  await ctx.addInitScript(() => { navigator.getBattery = () => Promise.resolve({ charging: true, level: 1, addEventListener() {}, removeEventListener() {} }); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (202|404)/.test(m.text())) page.errors.push(`console: ${m.text()}`);
  });
  await page.route('**/tts', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, voice: 'Kokoro (Heart)', today: { requests: 3, chars: 412 }, limits: { maxChars: 600, dailyChars: 20000 } }) }) : r.fulfill({ status: 204, body: '' })));
  // a fixed photo, so the Lens screenshots are comparable run to run
  await page.goto(`${BASE}/v53?token=${TOKEN}&bg=${process.env.BG || '01'}${hash}`);
  await page.waitForSelector('[data-v5-shell]', { timeout: 15000 });
  await until(() => page.evaluate(() => !document.querySelector('[data-conn]')), 15000, 'linked').catch(() => {});
  await sleep(700);
  return page;
}
const flush = (page, tag) => {
  allErrors.push(...page.errors.map((e) => `${tag}: ${e}`));
  page.errors = [];
};
const waitImages = (page) => page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 2500); }))));
const shot = async (page, name) => {
  await waitImages(page);
  await sleep(450);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const go = async (page, hash, wait = 900) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await sleep(wait);
};
const top = (page) => page.evaluate(() => [...document.querySelectorAll('[data-page][data-top="true"]')].filter((e) => e.offsetParent !== null).map((e) => e.dataset.page).pop() || '');
const noSideScroll = (page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > w + 1) return 'document scrolls sideways';
    const bad = [...document.querySelectorAll('[data-page][data-top="true"] *')].find((el) => {
      if (el.closest('.v-scroll-x, .term, pre, .md-table, [data-chart], svg, table, [data-dock]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed';
    });
    return bad ? `${bad.tagName.toLowerCase()}.${String(bad.className).slice(0, 60)}` : '';
  });
// The Library is newest-first and virtualised: find a doc by searching.
const libSearch = async (page, q) => {
  await page.locator('[data-page="library"][data-top="true"] input[placeholder^="Search"]').first().fill(q);
  await sleep(700);
};
// One Escape per sheet, then wait for it to leave (v5's Esc on a bare page
// goes Back / Home, as in v1, so a spare Escape would navigate).
const closeSheets = async (page) => {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) return;
    await page.keyboard.press('Escape');
    for (let k = 0; k < 12 && (await page.locator('[role="dialog"]').count()); k++) await sleep(100);
  }
};



// Every surface on screen is glass: the window (if any) is drawn by the shader
// or is translucent CSS glass, and nothing big on screen is an opaque plane
// (v1/v2's solid cards, a black room).
const glassAudit = (page) =>
  page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const out = { problems: [] };
    const alpha = (c) => {
      c = c || '';
      if (c === 'transparent') return 0;
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
      if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
      const m = /^rgba\(([^)]+)\)$/.exec(c);
      if (m) return parseFloat(m[1].split(',')[3]);
      return 1;
    };
    const gl = document.documentElement.dataset.lensmode === 'gl';
    const lite = document.documentElement.dataset.glass === 'lite';
    for (const w of document.querySelectorAll('.v5-win')) {
      const r = w.getBoundingClientRect();
      if (r.width < 50 || r.bottom < 0 || r.top > H || !w.offsetParent) continue;
      const cs = getComputedStyle(w);
      const isGlass = (gl && w.classList.contains('lens-live')) || (alpha(cs.backgroundColor) > 0 && alpha(cs.backgroundColor) < 0.95 && (lite || /blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || '')));
      if (!isGlass) out.problems.push(`window not glass (${cs.backgroundColor} ${cs.backdropFilter})`);
      out.windows = (out.windows || 0) + 1;
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg, canvas, img, video, iframe, .lens-scene, .term, pre, [data-viewer-frame], [data-tv], [data-car]')) continue;
      const r = el.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      if (vis < W * H * 0.12) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
      if (alpha(cs.backgroundColor) >= 0.97) out.problems.push(`opaque ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} ${cs.backgroundColor}`);
    }
    out.bodyBg = getComputedStyle(document.body).backgroundImage;
    return out;
  });

const loadedScripts = new Set();
async function track(page) {
  const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)));
  urls.forEach((u) => loadedScripts.add(u));
}


// ---- v5.3 probes ------------------------------------------------------------------
const st = (page) =>
  page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const pane = document.querySelector('[data-v53-pane]');
    const tops = [...document.querySelectorAll('[data-v53-pane="open"] [data-page][data-top="true"]')].filter((e) => e.getClientRects().length);
    return {
      hash: location.hash,
      pane: pane?.dataset.v53Pane,
      paneTab: pane?.dataset.paneTab,
      top: tops.pop()?.dataset.page || '',
      mini: document.querySelector('[data-v53-bar]')?.dataset.mini,
      active: document.querySelector('[data-tab][aria-current="page"]')?.dataset.tab || '',
      stage: r('[data-v53-stage]'),
      full: document.querySelector('[data-v53-stage]')?.dataset.full === '1',
      foot: r('[data-stage-foot]'),
      head: r('[data-stage-head]'),
      paneR: r('[data-v53-pane]'),
      bar: r('[data-v53-bar]'),
      search: r('[data-bar-search]'),
      acc: r('[data-v53-acc]'),
      composer: r('[data-composer]'),
      talk: r('[data-talk]'),
      W: innerWidth,
      H: innerHeight,
    };
  });
const settle = (ms = 900) => sleep(ms);
const shotV = async (page, name) => {
  await waitImages(page);
  await sleep(350);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const onScreen = (b, s) => b && b.w > 0 && b.h > 0 && b.r > 0 && b.l < s.W && b.b > 0 && b.t < s.H;

async function servingChecks() {
  console.log('Serving');
  const get = async (p, cookie) => {
    const r = await fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    return { status: r.status, body: await r.text(), cookie: r.headers.get('set-cookie') || '' };
  };
  const isV53 = (b) => /<html[^>]*class="v5 v53"/.test(b);
  const isV52 = (b) => /<html[^>]*class="v5 v52"/.test(b);
  const isV5 = (b) => /<html[^>]*class="v5"/.test(b);
  let r = await get('/v53');
  ok(r.status === 200 && isV53(r.body), '/v53 serves v5.3');
  r = await get('/v52');
  ok(isV52(r.body), '/v52 still serves v5.2 (side by side)');
  r = await get('/v5');
  ok(isV5(r.body) && !isV53(r.body), '/v5 still serves v5');
  r = await get('/');
  ok(!isV53(r.body) && !isV52(r.body) && !isV5(r.body), 'no cookie → v1 stays the default at /');
  r = await get('/?ui=v53');
  ok(isV53(r.body) && /mc_ui=v53/.test(r.cookie), '?ui=v53 → v5.3 and the mc_ui=v53 cookie');
  r = await get('/', 'mc_ui=v53');
  ok(isV53(r.body), 'cookie mc_ui=v53 → v5.3 at / (deep links and pushes land in v5.3)');
  r = await get('/', 'mc_ui=v52');
  ok(isV52(r.body), 'cookie mc_ui=v52 → still v5.2');
  const css = [...new Set((await get('/v53')).body.match(/\/v2\/_next\/static\/css\/[^"\\]+\.css/g) || [])];
  let t = '';
  for (const c of css) t += (await get(c)).body;
  ok(t.includes('.v53-bar') && t.includes('.v5-win') && !t.includes('.v52-stage'), `v5.3's stylesheet carries v5's glass and its own, not v5.2's (${css.length} file)`);
  ok(!t.includes('1b1b21') && !/--blur:\s*28px/.test(t), "no v1 stylesheet inside v5.3's");
}

// The chat is the home screen: the chat, the composer and the tab bar stack
// from the top to the foot, each its own glass over the photo.
async function chatFirst(browser, tag, theme) {
  const T = `${tag} ${theme}`;
  const page = await newPage(browser, tag, { theme });
  await settle(1500);
  const s = await st(page);
  ok(s.hash === '' && s.pane === 'closed' && s.active === 'chat', `${T}: opens on the chat (no hash, no pane, Chat lit) (${s.hash} ${s.pane} ${s.active})`);
  if (s.full) {
    // task 0503 (Daniel: "maximise space"): on iPhone and iPad portrait the
    // chat's glass is the whole screen; the chrome floats over it
    ok(s.stage.l <= 0 && s.stage.t <= 0 && s.stage.r >= s.W && s.stage.b >= s.H, `${T}: the chat's glass fills the screen edge to edge, top to bottom (${s.stage.l},${s.stage.t} → ${s.stage.r},${s.stage.b} of ${s.W}×${s.H})`);
    ok(s.acc && s.acc.t > s.stage.t && s.acc.b < s.stage.b && s.foot && s.foot.b <= s.acc.t && s.acc.t - s.foot.b <= 16, `${T}: the composer and the suggestions float over the chat, the suggestions just above the composer (${s.foot?.b} → ${s.acc?.t})`);
    await floatingChrome(page, T);
  } else {
    ok(s.stage && s.stage.w >= s.W * 0.95 && s.stage.t <= 16 && s.stage.h >= s.H * 0.72, `${T}: the chat fills the view down to the composer (${s.stage?.w}×${s.stage?.h} of ${s.W}×${s.H})`);
    ok(s.acc && s.stage.b <= s.acc.t && s.acc.t - s.stage.b <= 16, `${T}: the composer sits just under the chat, not over it (${s.stage.b} → ${s.acc?.t})`);
  }
  ok(s.bar && s.acc.b <= s.bar.t && s.bar.t - s.acc.b <= 16, `${T}: the tab bar sits under the composer (${s.acc.b} → ${s.bar?.t})`);
  ok(s.bar && s.H - s.bar.b <= 30 && s.bar.h >= 50 && s.bar.h <= 64, `${T}: the bar floats at the foot (${s.H - s.bar?.b}px up, ${s.bar?.h}px tall)`);
  const mid = (s.bar.l + s.search.r) / 2;
  ok(Math.abs(mid - s.W / 2) <= 3, `${T}: the bar and its search circle are centred (${Math.round(mid)} of ${s.W / 2})`);
  ok(s.search && s.search.w === s.search.h && Math.abs(s.search.t - s.bar.t) <= 2, `${T}: search is its own circle beside the bar (${s.search?.w}×${s.search?.h})`);
  ok(onScreen(s.composer, s) && s.composer.b >= s.H - 150, `${T}: the composer is in thumb reach (${s.composer?.b} of ${s.H})`);
  ok(onScreen(s.talk, s), `${T}: talk (Mia's mark) is beside the composer`);
  const n = await page.evaluate(() => ({
    msgs: document.querySelectorAll('[data-v53-stage] [data-msg]').length,
    qcards: document.querySelectorAll('[data-v53-stage] [data-question-card]').length,
    opts: document.querySelectorAll('[data-v53-stage] [data-question-card] button').length,
    task: document.querySelectorAll('[data-v53-stage] [data-task-card]').length,
    live: document.querySelectorAll('[data-live-card]').length,
    chips: document.querySelectorAll('[data-chip]').length,
    tabs: [...document.querySelectorAll('[data-v53-bar] [data-tab]')].map((e) => e.dataset.tab).join(','),
    orb: document.querySelectorAll('[data-head-orb]').length,
    rings: document.querySelectorAll('[data-ring]').length,
    mode: document.documentElement.dataset.lensmode,
    live2: ['[data-v53-stage]', '[data-v53-bar]', '[data-bar-search]', '[data-v53-acc] .v53-field', '[data-talk]'].map((q) => !!document.querySelector(q)?.classList.contains('lens-live')),
    radius: getComputedStyle(document.querySelector('[data-v53-bar]')).borderTopLeftRadius,
  }));
  ok(n.msgs >= 5, `${T}: Mia's thread is the page (${n.msgs} messages)`);
  ok(n.qcards >= 1 && n.opts >= 2, `${T}: questions are glass cards with tap answers (${n.qcards} cards, ${n.opts} buttons)`);
  ok(n.task >= 1, `${T}: a task Mia talks about is a card in the chat (${n.task})`);
  ok(n.live === 1, `${T}: the live card shows what's running`);
  ok(n.chips >= 2 && n.chips <= 4, `${T}: a few quiet suggestions at the chat's foot (${n.chips})`);
  ok(n.tabs === 'chat,home,tasks,fleet,library', `${T}: the bar holds Chat, Home, Tasks, Fleet, Library (${n.tabs})`);
  ok(n.orb === 1 && n.rings >= 1, `${T}: Mia's mark and the agents' progress rings are in the header (${n.rings} rings)`);
  ok(n.mode === 'gl' && n.live2.every(Boolean), `${T}: the chat, the bar, search, the field and talk are all shader glass (${n.mode} ${n.live2.join(',')})`);
  ok(parseFloat(n.radius) >= 25, `${T}: the bar is a capsule (${n.radius})`);
  const g = await glassAudit(page);
  ok(!g.problems.length, `${T}: everything on screen is glass ${g.problems.slice(0, 2).join(' | ')}`);
  ok((await noSideScroll(page)) === '', `${T}: nothing scrolls sideways`);
  await shotV(page, `${tag}-${theme}-chat`);

  // a task card opens in place, then grows into the pane
  await page.locator('[data-v53-stage] [data-task-card] > button').first().click();
  await settle(700);
  ok((await page.locator('[data-task-card][class*="open"] [data-card-open]').count()) === 1, `${T}: a task card opens in place (its actions inside the card)`);
  await shotV(page, `${tag}-${theme}-card-open`);
  await page.locator('[data-task-card] [data-card-open]').first().click();
  await settle(1100);
  const s2 = await st(page);
  ok(s2.pane === 'open' && s2.top === 'task' && /^#task\//.test(s2.hash) && s2.active === 'tasks', `${T}: Open grows the card into the pane; Tasks lights (${s2.top} ${s2.hash} ${s2.active})`);
  if (s2.W >= 1000) ok(s2.stage.r <= s2.paneR.l && s2.stage.w >= 300 && s2.bar.r <= s2.paneR.l, `${T}: the chat, its composer and the bar stay beside the pane (${s2.stage.w}px)`);
  else ok(s2.paneR.b <= s2.bar.t && s2.bar.t - s2.paneR.b <= 16, `${T}: the pane covers the chat down to the bar (${s2.paneR.b} → ${s2.bar.t})`);
  await shotV(page, `${tag}-${theme}-task-pane`);
  await page.locator('[data-v53-pane="open"] [data-close-window]:visible').first().click();
  await settle(1000);
  const s3 = await st(page);
  ok(s3.pane === 'closed' && s3.hash === '' && s3.active === 'chat', `${T}: X closes the pane back to the chat`);
  flush(page, T);
  await track(page);
  await page.context().close();
}

// Grown up: calm type, small radii inside the glass, no emoji, no candy.
async function restraint(browser, tag) {
  const T = `${tag} restraint`;
  const page = await newPage(browser, tag);
  await settle(1300);
  const r = await page.evaluate(() => {
    const px = (sel, prop = 'fontSize') => parseFloat(getComputedStyle(document.querySelector(sel))[prop]);
    const shell = document.querySelector('[data-v53-shell]');
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(shell.innerText);
    return {
      prose: px('[data-v53-stage] [data-prose]'),
      bubble: document.querySelector('[data-bubble]') ? px('[data-bubble]') : 15,
      card: px('[data-v53-stage] [data-question-card]', 'borderTopLeftRadius'),
      sugg: px('[data-chip]', 'borderTopLeftRadius'),
      answer: px('[data-v53-stage] [data-question-card] button', 'borderTopLeftRadius'),
      head: getComputedStyle(document.querySelector('[data-stage-head] .text-ink')).fontWeight,
      emoji,
      dots: document.querySelectorAll('.v52-dots, .v53-dots, .v52-orb-mini, .v53-orb-mini, .v52-swell').length,
      glow: getComputedStyle(document.querySelector('[data-head-orb] .v53-orb-core')).boxShadow,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--t-accent').trim(),
    };
  });
  ok(r.prose >= 14 && r.prose <= 16 && r.bubble <= 16, `${T}: reading type is calm, 14–16 px (prose ${r.prose}, bubbles ${r.bubble})`);
  ok(r.card <= 16 && r.sugg <= 12 && r.answer <= 12, `${T}: small radii inside the glass (cards ${r.card}, suggestions ${r.sugg}, answers ${r.answer})`);
  ok(Number(r.head) >= 590 && Number(r.head) <= 650, `${T}: names are semibold, not heavy (${r.head})`);
  ok(!r.emoji && r.dots === 0, `${T}: no emoji, no bouncing dots, no mini orbs, no swell`);
  ok(!/rgba?\([^)]*\) 0px 0px [1-9]/.test(r.glow), `${T}: Mia's mark doesn't glow (${r.glow.slice(0, 60)})`);
  ok(r.accent.toLowerCase() !== '#3ecf8e', `${T}: the accent is muted (${r.accent})`);
  flush(page, T);
  await page.context().close();
}

const ITEMS = [
  ['home', 'home', '#home'],
  ['tasks', 'tasks', '#tasks'],
  ['fleet', 'agents', '#fleet'],
  ['library', 'library', '#library'],
];
const MORE = [
  ['hq', 'hq', '#hq'],
  ['insights', 'insights', '#insights'],
  ['settings', 'settings', '#settings'],
];

// scroll an element in small steps, each its own frame (real scroll events)
const scrollBy = (page, sel, dy, steps = 10) =>
  page.evaluate(
    async ({ sel, dy, steps }) => {
      const el = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && e.scrollHeight > e.clientHeight).pop();
      if (!el) return null;
      for (let i = 0; i < steps; i++) {
        el.scrollTop += dy / steps;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return el.scrollTop;
    },
    { sel, dy, steps },
  );
const THREAD = '[data-v53-stage] [data-reader="thread"]';

// The tab bar: every tab, the ··· places, the lens, minimise on scroll.
async function tabBar(browser, tag) {
  const T = `${tag} tab bar`;
  const page = await newPage(browser, tag);
  await settle(1200);
  const wide = (await st(page)).W >= 1000;
  let s;
  for (const [key, want, hash] of ITEMS) {
    await page.locator(`[data-v53-bar] [data-tab="${key}"]`).click();
    await settle(1100);
    s = await st(page);
    ok(s.pane === 'open' && s.top === want && s.hash === hash && s.active === key, `${T}: ${key} opens in the pane and lights (${s.top} ${s.hash} ${s.active})`);
    const pill = await page.evaluate((k) => {
      const p = document.querySelector('[data-tab-pill]').getBoundingClientRect();
      const t = document.querySelector(`[data-tab="${k}"]`).getBoundingClientRect();
      return Math.abs(p.left + p.width / 2 - (t.left + t.width / 2));
    }, key);
    ok(pill <= 2, `${T}: …the pill sits under ${key} (${pill.toFixed(1)}px off)`);
    ok(s.stage && s.stage.w > 0 && s.bar && s.bar.b <= s.H, `${T}: …the chat stays alive and the bar stays (${s.stage?.w}px)`);
    if (key === 'library' || key === 'home') await shotV(page, `${tag}-pane-${key}`);
  }
  const g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the pane and the bar are glass ${g.problems.slice(0, 2).join(' | ')}`);
  await page.locator('[data-v53-bar] [data-tab="chat"]').click();
  await settle(1000);
  s = await st(page);
  ok(s.pane === 'closed' && s.hash === '' && s.active === 'chat', `${T}: Chat closes the pane`);

  // HQ, Insights and Settings live in the chat's ··· menu
  for (const [key, want, hash] of MORE) {
    if ((await st(page)).pane === 'open') {
      await page.locator('[data-v53-bar] [data-tab="chat"]').click();
      await settle(900);
    }
    await page.locator('[data-mia-more]').click();
    await settle(400);
    await page.locator(`[data-more-item="${key}"]`).click();
    await settle(1100);
    s = await st(page);
    ok(s.pane === 'open' && s.top === want && s.hash === hash && s.active === '', `${T}: ··· → ${key} opens in the pane, no tab lit (${s.top} ${s.hash})`);
  }
  await page.keyboard.press('Escape');
  await settle(900);
  ok((await st(page)).pane === 'closed', `${T}: Esc closes it`);

  // the lens: press lifts it (shader glass), a drag carries it, letting go picks
  const b = (await st(page)).bar;
  const cx = (k) => page.evaluate((k) => { const r = document.querySelector(`[data-tab="${k}"]`).getBoundingClientRect(); return r.left + r.width / 2; }, k);
  const y = b.t + b.h / 2;
  const x0 = await cx('home');
  const x1 = await cx('library');
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await sleep(260);
  const lifted = await page.evaluate(() => {
    const l = document.querySelector('[data-tab-lens]');
    return l ? { o: parseFloat(getComputedStyle(l).opacity), live: l.classList.contains('lens-live'), w: l.getBoundingClientRect().width, h: l.getBoundingClientRect().height } : null;
  });
  const barH = b.h;
  ok(lifted && lifted.o > 0.5 && lifted.h > barH, `${T}: a press lifts the lens out of the bar (${JSON.stringify(lifted)})`);
  ok(lifted && lifted.live, `${T}: …and the lens is real refracting glass (the shader draws it)`);
  await shotV(page, `${tag}-lens`);
  const xs = [];
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y, { steps: 1 });
    await sleep(30);
    xs.push(await page.evaluate(() => Math.round(document.querySelector('[data-tab-lens]')?.getBoundingClientRect().left ?? -1)));
  }
  ok(xs.every((v, i) => i === 0 || v >= xs[i - 1]) && xs[xs.length - 1] > xs[0] + (x1 - x0) * 0.5, `${T}: the lens follows the finger across the tabs (${xs[0]}…${xs[xs.length - 1]})`);
  await page.mouse.up();
  await settle(1100);
  s = await st(page);
  ok(s.active === 'library' && s.hash === '#library', `${T}: letting go over Library opens it (${s.active} ${s.hash})`);
  ok((await page.locator('[data-tab-lens]').count()) === 0, `${T}: …and the lens settles back into the bar`);
  await page.locator('[data-v53-bar] [data-tab="chat"]').click();
  await settle(1000);

  // minimise: scrolling up into the chat's history shrinks the bar; the composer slides down beside it
  const before = await st(page);
  before.fade = await fadeOf(page);
  await scrollBy(page, THREAD, -500, 14);
  await settle(700);
  s = await st(page);
  ok(s.mini === '1' && s.bar.w <= 50, `${T}: scrolling into the history minimises the bar (${s.mini}, ${s.bar.w}px)`);
  ok(Math.abs(s.acc.b - s.bar.b) <= 3 && s.acc.l >= s.bar.r, `${T}: …the composer slides down beside it (bar ${s.bar.l}–${s.bar.r}, composer ${s.acc.l}–${s.acc.r})`);
  if (s.full) ok(s.foot.b > before.foot.b + 40 && (await fadeOf(page)) < (before.fade ?? 1e9) - 40, `${T}: …and the chat gets the room: the suggestions and the fade follow the composer down (${before.foot.b} → ${s.foot.b})`);
  else ok(s.stage.b > before.stage.b + 40, `${T}: …and the chat gets the room (${before.stage.b} → ${s.stage.b})`);
  ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-bar-search]')).opacity) < 0.1), `${T}: …search steps aside for the composer`);
  await shotV(page, `${tag}-bar-mini`);
  await scrollBy(page, THREAD, 20000, 6);
  await settle(800);
  s = await st(page);
  ok(s.mini === '0' && s.bar.w > 200, `${T}: back at the newest message the bar grows back (${s.bar.w}px)`);
  await scrollBy(page, THREAD, -500, 14);
  await settle(700);
  ok((await st(page)).mini === '1', `${T}: (minimised again)`);
  await page.locator('[data-v53-bar]').click();
  await settle(700);
  ok((await st(page)).mini === '0', `${T}: tapping the small bar grows it back`);
  await page.keyboard.press('Meta+Backslash');
  await settle(600);
  ok((await st(page)).mini === '1', `${T}: ⌘\\ minimises it`);
  await page.keyboard.press('Meta+Backslash');
  await settle(600);
  ok((await st(page)).mini === '0', `${T}: ⌘\\ restores it`);
  await scrollBy(page, THREAD, 20000, 4);

  // in a page over the chat (narrow), scrolling down minimises; back at the top
  // it returns. Beside the chat (wide) the page runs full height: the bar stays.
  await page.locator('[data-v53-bar] [data-tab="library"]').click();
  await settle(1200);
  const LIST = '[data-v53-pane="open"] [data-page="library"][data-top="true"] .v-scroll';
  await scrollBy(page, LIST, 600, 12);
  await settle(700);
  s = await st(page);
  if (!wide) {
    ok(s.mini === '1', `${T}: scrolling down a page minimises the bar (${s.mini})`);
    ok(s.paneR.b <= s.bar.t, `${T}: …the page keeps its frame above the bar (${s.paneR.b} ≤ ${s.bar.t})`);
    await scrollBy(page, LIST, -5000, 6);
    await settle(700);
    ok((await st(page)).mini === '0', `${T}: back at the top it grows back`);
  } else ok(s.mini === '0' && s.paneR.b >= s.H - 16, `${T}: a page beside the chat runs full height; scrolling it leaves the bar alone`);


  // the right-edge swipe brings back the pane you just closed
  await page.locator('[data-v53-pane="open"] [data-close-window]:visible').first().click().catch(() => page.keyboard.press('Escape'));
  await settle(900);
  ok((await st(page)).pane === 'closed', `${T}: X closes the pane`);
  await page.evaluate(async () => {
    const stage = document.querySelector('[data-v53-stage]');
    const y = innerHeight / 2;
    const ev = (type, x, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 8 }));
    ev('pointerdown', innerWidth - 6, stage.querySelector('[data-thread]') || stage);
    for (let x = innerWidth - 6; x >= innerWidth - 200; x -= 24) {
      ev('pointermove', x);
      await new Promise((r) => requestAnimationFrame(r));
    }
    ev('pointerup', innerWidth - 200);
  });
  await settle(1100);
  s = await st(page);
  ok(s.pane === 'open' && s.top === 'library', `${T}: a right-edge swipe brings the last pane back (${s.top})`);

  // on a phone, drag the pane down by its top to dismiss
  if (!wide) {
    const pr = s.paneR;
    await page.mouse.move(pr.l + pr.w / 2, pr.t + 14);
    await page.mouse.down();
    const ys = [];
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(pr.l + pr.w / 2, pr.t + 14 + i * 30, { steps: 1 });
      ys.push(Math.round((await st(page)).paneR.t));
    }
    await page.mouse.up();
    await settle(1000);
    ok(ys[ys.length - 1] > pr.t + 150, `${T}: the pane follows the finger down (${pr.t} → ${ys[ys.length - 1]})`);
    ok((await st(page)).pane === 'closed', `${T}: …and a long enough pull dismisses it`);
  } else {
    await page.keyboard.press('Escape');
    await settle(900);
    ok((await st(page)).pane === 'closed', `${T}: Esc closes the pane`);
  }
  flush(page, T);
  await page.context().close();
}

// Every `mia panel` target lands sensibly: places and pages in the pane,
// the viewer over everything, search in its sheet, scroll / scroll-to /
// highlight in what's in front.
async function panelTargets(browser, tag) {
  const T = `${tag} mia panel`;
  const page = await newPage(browser, tag);
  await settle(1200);
  const res = async (id, label) => {
    const r = await resultFor(id);
    ok(r && r.ok, `${T}: ${label} → ok (${r ? r.detail || '' : 'no result'})`);
    return r;
  };
  let id = panel('open-doc', 'raw-incident-hooks.md', 'What to change');
  await res(id, 'open-doc --at');
  await settle(800);
  let s = await st(page);
  ok(s.pane === 'open' && s.top === 'doc' && s.hash === '#doc/raw-incident-hooks.md', `${T}: open-doc lands in the pane (${s.top} ${s.hash})`);
  ok(await page.evaluate(() => [...document.querySelectorAll('[data-v53-pane="open"] h2')].some((h) => /What to change/.test(h.textContent) && h.getBoundingClientRect().top < innerHeight * 0.6 && h.getBoundingClientRect().top > 0)), `${T}: …scrolled to the heading`);
  await shotV(page, `${tag}-panel-open-doc`);
  id = panel('highlight', 'Cut the intro card entirely');
  await res(id, 'highlight');
  ok((await page.locator('[data-v53-pane="open"] .mia-mark').count()) >= 1, `${T}: highlight marks the text in the open doc`);
  id = panel('scroll-to', 'Sources');
  await res(id, 'scroll-to');
  id = panel('scroll', 'top');
  await res(id, 'scroll top');
  await settle(1000);
  ok(await page.evaluate(() => (document.querySelector('[data-v53-pane="open"] [data-reader="doc"]')?.scrollTop ?? 1) < 40), `${T}: scroll moves the doc in the pane, not the chat`);
  id = panel('close');
  await res(id, 'close');
  await settle(900);
  s = await st(page);
  ok(s.pane === 'closed' && s.hash === '', `${T}: close shuts the doc and the pane — back to the chat`);

  id = panel('open-task', '1');
  await res(id, 'open-task');
  await settle(700);
  s = await st(page);
  ok(s.pane === 'open' && s.top === 'task' && s.hash === '#task/0001', `${T}: open-task lands in the pane (${s.top})`);
  const ag = await page.evaluate(() => fetch('/api/v1/agents', { headers: { Authorization: 'Bearer test' } }).then((r) => r.json()).then((j) => (j.agents || [])[0]?.id).catch(() => null));
  if (ag) {
    id = panel('open-agent', ag);
    await res(id, 'open-agent');
    await settle(800);
    s = await st(page);
    ok(s.pane === 'open' && s.top === 'agent', `${T}: open-agent lands in the pane (${s.top})`);
  }
  for (const [v, want] of [['home', 'home'], ['fleet', 'agents'], ['library', 'library'], ['insights', 'insights'], ['hq', 'hq'], ['settings', 'settings']]) {
    id = panel('view', v);
    await res(id, `view ${v}`);
    await settle(900);
    s = await st(page);
    ok(s.pane === 'open' && s.top === want, `${T}: view ${v} → ${want} in the pane (${s.top})`);
  }
  id = panel('view', 'mia');
  await res(id, 'view mia');
  await settle(900);
  s = await st(page);
  ok(s.pane === 'closed' && s.hash === '', `${T}: view mia → the chat (pane closed)`);
  id = panel('scroll', 'top');
  await res(id, 'scroll (chat)');
  await settle(1200);
  ok(await page.evaluate(() => document.querySelector('[data-v53-stage] [data-reader="thread"]').scrollTop < 40), `${T}: with no pane, scroll moves the chat`);
  id = panel('scroll', 'bottom');
  await res(id, 'scroll bottom (chat)');

  id = panel('show-doc', 'crystal-retention.md');
  await res(id, 'show-doc');
  await settle(900);
  ok((await page.locator('[role="dialog"] [data-reader="viewer"]').count()) === 1, `${T}: show-doc opens the viewer over everything`);
  let g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the viewer is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await shotV(page, `${tag}-panel-show-doc`);
  id = panel('close');
  await res(id, 'close viewer');
  await settle(800);
  ok((await page.locator('[data-reader="viewer"]').count()) === 0, `${T}: close shuts the viewer`);
  id = panel('show-url', 'https://example.com/listing');
  await res(id, 'show-url');
  await settle(1200);
  ok((await page.locator('[role="dialog"]').count()) >= 1, `${T}: show-url opens the viewer`);
  id = panel('close');
  await res(id, 'close url');
  await settle(800);
  id = panel('search', 'crystal');
  await res(id, 'search');
  await settle(1000);
  ok((await page.locator('[role="dialog"] input').first().inputValue().catch(() => '')) === 'crystal', `${T}: search opens Search with the words`);
  await shotV(page, `${tag}-panel-search`);
  await closeSheets(page);
  id = panel('open-doc', 'no-such-doc-anywhere');
  const bad = await resultFor(id);
  ok(bad && !bad.ok, `${T}: an unknown doc is reported back, not opened (${bad?.detail})`);
  flush(page, T);
  await page.context().close();
}

// The cool things, working.
async function extras(browser, tag) {
  const T = `${tag} extras`;
  const page = await newPage(browser, tag);
  await settle(1200);
  // ⌘K palette: fuzzy, keyboard, lands in the pane
  await page.keyboard.press('Meta+k');
  await settle(500);
  ok((await page.locator('[data-palette] [role="dialog"]').count()) === 1, `${T}: ⌘K opens the command palette`);
  await page.keyboard.type('crys ret');
  await settle(400);
  const first = await page.locator('[data-pal-i="0"]').getAttribute('data-pal-key');
  ok(first === 'd:crystal-retention.md', `${T}: fuzzy finds “Crystal Garden: come back tomorrow” first (${first})`);
  await shotV(page, `${tag}-palette`);
  await page.keyboard.press('Enter');
  await settle(1200);
  let s = await st(page);
  ok(s.pane === 'open' && s.hash === '#doc/crystal-retention.md', `${T}: Return opens it in the pane`);
  await page.keyboard.press('Meta+k');
  await settle(400);
  await page.keyboard.type('fl');
  await settle(300);
  ok((await page.locator('[data-pal-i="0"]').getAttribute('data-pal-key')) === 'p:fleet', `${T}: “fl” → Fleet`);
  await page.keyboard.press('Escape');
  await settle(500);
  ok((await page.locator('[data-palette]').count()) === 0, `${T}: Esc closes the palette`);
  await page.keyboard.press('Escape');
  await settle(800);

  // a chip fills the composer; an answer chip answers
  const chip = page.locator('[data-chip^="x:"], [data-chip^="t:"]').first();
  if (await chip.count()) {
    await chip.click();
    await settle(400);
    ok((await page.locator('[data-composer]').inputValue()).length > 3, `${T}: a chip writes into the composer`);
    await page.locator('[data-composer]').fill('');
    await page.locator('[data-composer]').blur();
    await settle(400);
  }

  // long-press a message → make it a task / remind me
  const prose = page.locator('[data-v53-stage] [data-prose]').first();
  const pb = await prose.boundingBox();
  await page.mouse.move(pb.x + 20, pb.y + 10);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await settle(500);
  ok((await page.locator('[data-msg-menu] [data-msg-action]').count()) === 6, `${T}: long-press a message → its menu (task, reminders, reply, copy)`);
  await shotV(page, `${tag}-message-menu`);
  const before = (await api('GET', '/api/v1/mia')).j.mia?.tasks?.length || 0;
  await page.locator('[data-msg-action="task"]').click();
  const after = await until(async () => {
    const n = (await api('GET', '/api/v1/mia')).j.mia?.tasks?.length || 0;
    return n > before ? n : null;
  }, 8000, 'task added').catch(() => before);
  ok(after > before, `${T}: “Make it a task” adds it to Mia's board (${before} → ${after})`);
  await prose.click({ button: 'right' });
  await settle(500);
  await page.locator('[data-msg-action="hour"]').click();
  await settle(900);
  const rem = await until(async () => (await api('GET', '/api/v1/mia')).j.mia?.schedule?.reminders?.length || null, 6000, 'reminder').catch(() => 0);
  ok(rem >= 1, `${T}: “Remind me in an hour” sets a reminder (${rem})`);

  // the orb, the rings, the ambient light
  // the moving light lives in the shader's scene now (the glass bends it), and keeps time with the agents
  const amb = await page.evaluate(async () => {
    const a = document.querySelector('[data-ambient]');
    const p0 = window.__ambient?.phase;
    await new Promise((r) => setTimeout(r, 1000));
    return { level: Number(a.dataset.level), warm: a.dataset.warm, inScene: a.dataset.inScene, blobs: a.querySelectorAll('.v53-blob').length, moved: (window.__ambient?.phase ?? 0) - (p0 ?? 0), still: window.__ambient?.still };
  });
  ok(amb.inScene === '1' && amb.blobs === 0, `${T}: the moving light is drawn inside the shader's scene, under the glass (${JSON.stringify(amb)})`);
  ok(amb.level >= 1 && amb.moved > 1.2, `${T}: executors running → the light drifts faster (level ${amb.level}, ${amb.moved.toFixed(2)} per second)`);
  ok(amb.warm === '1', `${T}: an agent waiting on Daniel warms one light`);
  const orb = await page.evaluate(() => document.querySelector('[data-head-orb]').dataset.orb);
  ok(['idle', 'thinking'].includes(orb), `${T}: Mia's mark shows her state (${orb})`);
  // highlights answer scroll: the shader's light leans while the chat moves
  const flow = await page.evaluate(async () => {
    const el = document.querySelector('[data-v53-stage] [data-reader="thread"]');
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      el.scrollTop -= 40;
      await new Promise((r) => requestAnimationFrame(r));
      peak = Math.max(peak, Math.abs(window.__flow || 0));
    }
    el.scrollTop = el.scrollHeight;
    return peak;
  });
  ok(flow > 5, `${T}: scrolling moves the glass's highlight (flow ${flow.toFixed(1)} px/frame)`);
  await settle(700);

  await page.locator('[data-ring]').first().click();
  await settle(1100);
  s = await st(page);
  ok(s.pane === 'open' && s.top === 'agent', `${T}: a progress ring opens its agent`);
  await page.keyboard.press('Escape');
  await settle(900);

  // send: the message arrives with a spring
  await page.locator('[data-composer]').fill('Ping from the v5.3 rig');
  await page.locator('[data-send]').click();
  await sleep(120);
  const arriving = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-arrived]')].pop();
    return el ? getComputedStyle(el).transform : '';
  });
  ok(arriving && arriving !== 'none', `${T}: a new message arrives on a spring (${arriving.slice(0, 30)})`);
  await settle(1500);
  flush(page, T);
  await page.context().close();
}

// Frame timing (the brief: rAF p95 ≤ 20 ms): the chat scrolling (the bar
// minimising and restoring with it), the lens, the pane opening, scrolling and
// closing. The glass must never lag: while the chat scrolls the chat pane
// itself stays shader glass and nothing inside the scroller is; a pane in
// flight is CSS glass (it moves in the compositor's frame) and the shader
// takes it once it's still (beside the chat).
const P95 = 20;
async function frames(browser, tag) {
  console.log(`Frame timing and glass sync: ${tag}`);
  const T = `${tag} frames`;
  const page = await newPage(browser, tag);
  await settle(1800);
  const wide = (await st(page)).W >= 1000;
  const sample = (fnSrc, n = 60) =>
    page.evaluate(
      async ({ fnSrc, n }) => {
        const step = new Function('i', fnSrc);
        const dts = [];
        const glass = [];
        let t0 = performance.now();
        for (let i = 0; i < n; i++) {
          step(i);
          await new Promise((r) => requestAnimationFrame(r));
          const t = performance.now();
          dts.push(t - t0);
          t0 = t;
          const pane = document.querySelector('[data-v53-pane]');
          glass.push({
            stage: document.querySelector('[data-v53-stage]')?.classList.contains('lens-live'),
            bar: document.querySelector('[data-v53-bar]')?.classList.contains('lens-live'),
            inner: document.querySelectorAll('[data-v53-stage] .lens-live').length,
            paneLive: !!document.querySelector('[data-v53-pane] .v5-win.lens-live'),
            mini: document.querySelector('[data-v53-bar]')?.dataset.mini,
            x: Math.round(pane?.getBoundingClientRect().left || 0),
            y: Math.round(pane?.getBoundingClientRect().top || 0),
          });
        }
        const s = [...dts].sort((a, b) => a - b);
        return { p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], long: dts.filter((d) => d > 50).length, glass };
      },
      { fnSrc, n },
    );
  const fmt = (r) => `p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, ${r.long} long frames`;
  const scroll = await sample(`const el = document.querySelector('[data-v53-stage] [data-reader="thread"]'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true })); el.scrollTop += i < 30 ? -24 : 24;`, 70);
  ok(scroll.p95 <= P95 && scroll.long <= 1, `${T}: chat scroll with the bar minimising and restoring: ${fmt(scroll)}`);
  ok(scroll.glass.some((g) => g.mini === '1'), `${T}: (the bar did minimise during the scroll)`);
  ok(scroll.glass.every((g) => g.stage && g.bar && g.inner === 0), `${T}: the chat and the bar stay shader glass while it scrolls; nothing inside the scroller is (never lags)`);
  await page.evaluate(() => { const el = document.querySelector('[data-v53-stage] [data-reader="thread"]'); el.scrollTop = el.scrollHeight; });
  await settle(800);
  // the lens: lift, carry across, let go (pointer events, as a finger)
  const lens = await sample(
    `const bar = document.querySelector('[data-v53-bar]'); const r = bar.getBoundingClientRect(); const y = r.top + r.height / 2;
     const ev = (t, x) => bar.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 11 }));
     if (i === 2) ev('pointerdown', r.left + 40); else if (i > 2 && i < 34) ev('pointermove', r.left + 40 + (i - 2) * 6); else if (i === 34) ev('pointerup', r.left + 40 + 32 * 6);`,
    60,
  );
  ok(lens.p95 <= P95 && lens.long <= 1, `${T}: the lens lifting, following and settling: ${fmt(lens)}`);
  await settle(900);
  if ((await st(page)).pane === 'open') {
    await page.locator('[data-v53-bar] [data-tab="chat"]').click();
    await settle(1000);
  }
  // the pane coming in and out
  const open = await sample(`if (i === 2) location.hash = 'library';`, 50);
  ok(open.p95 <= P95 && open.long <= 1, `${T}: pane open: ${fmt(open)}`);
  const moving = open.glass.filter((g, i) => i > 3 && i < 45 && open.glass[i - 1] && (g.x !== open.glass[i - 1].x || g.y !== open.glass[i - 1].y));
  ok(moving.length > 3 && moving.every((g) => !g.paneLive), `${T}: while it moves the pane is CSS glass, never a trailing shader pane (${moving.length} moving frames)`);
  await sleep(800);
  if (wide) ok(await page.evaluate(() => !!document.querySelector('[data-v53-pane] .v5-win.lens-live')), `${T}: the pane at rest beside the chat: the shader draws it`);
  const lib = await sample(`const s = document.querySelector('[data-page="library"][data-top="true"] .v-scroll'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true })); s.scrollTop += i < 25 ? 30 : -30;`, 50);
  // The Library list's own cost (a virtualised page shared with v5 / v5.2)
  // sits right at 20 ms on this Mac in v5.2 too: hold v5.3 to 20 ms or to
  // v5.2's figure measured now on the same rig, whichever is higher.
  const base = await libBaseline(browser, tag);
  const cap = Math.max(P95, base + 1);
  ok(lib.p95 <= cap && lib.long <= 1 && (!wide || lib.glass.slice(2).every((g) => g.paneLive)), `${T}: Library list scroll${wide ? '' : ' (the bar minimising with it)'}: ${fmt(lib)} (v5.2 on this rig: p95 ${base.toFixed(1)} ms)${wide ? ', the pane stays refracting glass' : ''}`);

  const close = await sample(`if (i === 2) document.querySelector('[data-v53-pane="open"] [data-close-window]').click();`, 50);
  ok(close.p95 <= P95 && close.long <= 1, `${T}: pane close: ${fmt(close)}`);
  console.log(`    (rAF p50/p95 ms — scroll ${scroll.p50.toFixed(1)}/${scroll.p95.toFixed(1)}, lens ${lens.p50.toFixed(1)}/${lens.p95.toFixed(1)}, open ${open.p50.toFixed(1)}/${open.p95.toFixed(1)}, pane scroll ${lib.p50.toFixed(1)}/${lib.p95.toFixed(1)}, close ${close.p50.toFixed(1)}/${close.p95.toFixed(1)})`);
  FRAMES[tag] = { scroll, lens, open, lib, close };
  flush(page, T);
  await page.context().close();
}

// Task 0503 (Daniel on an iPhone: "the liquid glass ... seems a bit like low
// res and it keeps like popping in"). The shader's canvas renders at the
// screen's density (≤ 2 device px per CSS px) with the photo at that
// resolution, and the first pane switch looks like the second: the window is
// there at once, and the shader takes it from the CSS glass in a cross-fade —
// never a frame without glass, never a one-frame swap.
async function sharpAndSteady(browser, tag) {
  console.log(`Full-DPR glass and no late glass: ${tag}`);
  const T = `${tag} 0503`;
  const vp = VIEWPORTS[tag];
  const ctx = await browser.newContext({ ...vp, ...(tag === 'phone' ? { deviceScaleFactor: 3 } : {}), hasTouch: true, colorScheme: 'dark' });
  await ctx.addInitScript(() => { navigator.getBattery = () => Promise.resolve({ charging: true, level: 1, addEventListener() {}, removeEventListener() {} }); });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/v53?token=${TOKEN}&bg=01`);
  await page.waitForSelector('[data-v5-shell]', { timeout: 15000 });
  await until(() => page.evaluate(() => !!window.__lensTex), 15000, 'photo on the GPU').catch(() => {});
  await settle(1200);
  const d = await page.evaluate(() => {
    const c = document.querySelector('.lens-canvas');
    return { dpr: devicePixelRatio, cw: c.clientWidth, ch: c.clientHeight, w: c.width, h: c.height, scale: window.__lens?.scale, tex: window.__lensTex };
  });
  const want = Math.min(d.dpr, 2);
  ok(d.scale === 1 && Math.abs(d.w - Math.round(d.cw * want)) <= 1 && Math.abs(d.h - Math.round(d.ch * want)) <= 1, `${T}: the shader canvas renders at ${want}× (DPR ${d.dpr}, capped at 2): ${d.w}×${d.h} for ${d.cw}×${d.ch} CSS px`);
  ok(d.tex && d.tex[0] >= Math.min(2048, d.cw * want) / 1.01 && d.tex[1] >= Math.min(2048, d.ch * want) / 1.01, `${T}: the photo texture covers the canvas's device pixels: ${d.tex?.join('×')}`);
  await page.screenshot({ path: path.join(SHOTS, `0503-${tag}-dpr${d.dpr}-chat.png`) });

  // the first visit to a tab, then the second: every frame from the tap
  const watch = (hash) =>
    page.evaluate(async (hash) => {
      const out = [];
      location.hash = hash;
      const t0 = performance.now();
      const alpha = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c || '');
        if (!m) return 0;
        const v = m[1].split(',');
        return v.length > 3 ? parseFloat(v[3]) : 1;
      };
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const w = [...document.querySelectorAll('[data-v53-pane="open"] .v5-win')].find((e) => e.getClientRects().length);
        const vis = w && getComputedStyle(w).visibility !== 'hidden';
        const cs = vis && getComputedStyle(w);
        const blur = cs ? parseFloat(/blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || '')?.[1] || 0) : 0;
        const k = w?.__lensIn ?? 0;
        out.push({ t: performance.now() - t0, win: !!vis, css: cs ? alpha(cs.backgroundColor) : 0, blur, live: !!w?.classList.contains('lens-live'), shader: w?.classList.contains('lens-live') ? k * k * (3 - 2 * k) : 0 });
      }
      return out;
    }, hash);
  const judge = (tl, label) => {
    const at = tl.findIndex((f) => f.win);
    const css0 = Math.max(...tl.map((f) => f.css));
    // glass on the window, every frame after it shows: CSS share + shader share
    const cover = tl.slice(at).map((f) => f.css / css0 + f.shader);
    const jumps = tl.slice(at + 1).map((f, i) => Math.abs(f.css - tl[at + i].css) / css0);
    const hand = tl.findIndex((f) => f.live);
    const fade = hand < 0 ? 0 : tl.slice(hand).findIndex((f) => f.shader >= 0.99);
    ok(at >= 0 && at <= 3, `${T} ${label}: the window is on screen within ${at + 1} frames of the tap`);
    ok(Math.min(...cover) >= 0.8, `${T} ${label}: the window always has glass (min CSS + shader share ${Math.min(...cover).toFixed(2)})`);
    ok(hand > 0 && fade >= 8 && Math.max(...jumps) < 0.3, `${T} ${label}: the shader takes over in a cross-fade (${fade} frames; biggest one-frame drop of the CSS glass ${(Math.max(...jumps) * 100).toFixed(0)}%), not a pop`);
    return { at, hand: hand < 0 ? -1 : tl[hand].t, fade };
  };
  const first = judge(await watch('library'), 'first visit');
  await page.evaluate(() => (location.hash = 'mia'));
  await settle(1000);
  const second = judge(await watch('library'), 'second visit');
  ok(Math.abs(first.at - second.at) <= 2 && Math.abs(first.hand - second.hand) <= 120, `${T}: the first visit looks like the second (window at frame ${first.at} vs ${second.at}, hand-over at ${Math.round(first.hand)} vs ${Math.round(second.hand)} ms)`);
  await page.screenshot({ path: path.join(SHOTS, `0503-${tag}-dpr${d.dpr}-library.png`) });
  flush(page, T);
  await ctx.close();
}

// Full-bleed (task 0503): the text scrolls under the floating header,
// suggestions, composer and bar, and fades out before it reaches any of them —
// iOS 26's scroll-edge effect — so it never sits behind a control unreadably.
const fadeOf = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-v53-stage]')).getPropertyValue('--stage-fade')) || 0);
async function floatingChrome(page, T) {
  const m = await page.evaluate(() => {
    const th = document.querySelector('[data-v53-stage] [data-reader="thread"]');
    const cs = getComputedStyle(th);
    const mask = cs.maskImage || cs.webkitMaskImage || '';
    const tb = th.getBoundingClientRect();
    // resolve a length (the vars are calc()s) with a probe inside the thread
    const v = (expr) => {
      const p = document.createElement('div');
      p.style.cssText = `position:absolute;visibility:hidden;height:${expr}`;
      th.appendChild(p);
      const h = p.getBoundingClientRect().height;
      p.remove();
      return h;
    };
    const head = document.querySelector('[data-stage-head]').getBoundingClientRect();
    const foot = document.querySelector('[data-stage-foot]').getBoundingClientRect();
    const acc = document.querySelector('[data-v53-acc]').getBoundingClientRect();
    const bar = document.querySelector('[data-v53-bar]').getBoundingClientRect();
    // where the thread's mask is fully clear (text gone), top and bottom, in px
    const topClear = tb.top + v('calc(var(--stage-head) - 4px)');
    const botClear = tb.bottom - v('calc(var(--stage-foot, 56px) + var(--stage-fade, 0px) - 18px)');
    const inner = th.firstElementChild;
    const padB = parseFloat(getComputedStyle(inner).paddingBottom);
    return { dbg: [v('var(--stage-foot)'), v('var(--stage-chrome)'), v('var(--stage-fade)'), v('var(--stage-head)')], mask: !!mask && mask !== 'none', topClear, botClear, head: head.bottom, foot: foot.top, acc: acc.top, bar: bar.top, padB, stageH: tb.height, H: innerHeight, scrolls: th.scrollHeight > th.clientHeight };
  });
  ok(m.mask && m.topClear >= m.head - 1, `${T}: the text fades out before it reaches the floating header (clear from ${Math.round(m.topClear)} px, header ends ${Math.round(m.head)})`);
  ok(m.mask && m.botClear <= m.foot + 24 && m.botClear < m.acc && m.botClear < m.bar, `${T}: …and before the suggestions, composer and bar (clear from ${Math.round(m.botClear)} px; chips ${Math.round(m.foot)}, composer ${Math.round(m.acc)}, bar ${Math.round(m.bar)})`);
  // the newest message, scrolled to the end, ends just above the suggestions: clear of the chrome, no wasted room
  const end = m.stageH - m.padB;
  ok(end <= m.foot && end >= m.foot - 40, `${T}: the newest message scrolls clear of the chrome and no further (ends ${Math.round(end)} px, suggestions at ${Math.round(m.foot)}; foot/chrome/fade/head ${m.dbg.map(Math.round).join('/')})`);
}

// Task 0503 (Daniel: the 'Now · N agents working' card named alovewebsite,
// task 0154, which wasn't running): the card lists only tasks that really
// run — a running status AND an executor that hasn't finished.
async function nowCard(browser) {
  console.log('Now card: only tasks that really run');
  const add = (title, fx) => api('POST', '/api/v1/mia/tasks', { title, detail: `fixture:${JSON.stringify(fx)}` });
  await add('alovewebsite: make it 10x better', { status: 'checking', executor: { dispatchedAt: isoAgo(60 * 24 * 19), finishedAt: isoAgo(60 * 24 * 19), sessionId: 'stale' } });
  await add('stale-running: no executor', { status: 'running', executor: null });
  await add('live-task: really running', { status: 'running', executor: { dispatchedAt: isoAgo(3), finishedAt: null, sessionId: 'live' } });
  const page = await newPage(browser, 'phone', { theme: 'dark' });
  await settle(1500);
  const c = await until(
    () => page.evaluate(() => {
      const el = document.querySelector('[data-live-card]');
      return el && /live-task/.test(el.textContent) ? el.textContent : null;
    }),
    8000,
    'the Now card',
  ).catch(() => '');
  ok(/live-task: really running/.test(c), 'now card: a task with a live executor is listed');
  ok(!/alovewebsite/.test(c), 'now card: a "checking" task whose executor finished is not (task 0154)');
  ok(!/stale-running/.test(c), 'now card: a "running" task with no executor is not');
  await page.locator('[data-live-card] [data-grow="live"], [data-live-card] button').first().click().catch(() => {});
  await settle(600);
  const open = await page.evaluate(() => document.querySelector('[data-live-card]')?.textContent || '');
  ok(!/alovewebsite|stale-running/.test(open), 'now card: …nor when it is opened');
  await shotV(page, 'phone-now-card');
  flush(page, 'now card');
  await page.context().close();
}

// v5.2's Library list scroll, the same sample on the same rig (a baseline).
async function libBaseline(browser, tag) {
  const vp = VIEWPORTS[tag];
  const ctx = await browser.newContext({ ...vp, hasTouch: true, colorScheme: 'dark' });
  await ctx.addInitScript(() => { navigator.getBattery = () => Promise.resolve({ charging: true, level: 1, addEventListener() {}, removeEventListener() {} }); });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/v52?token=${TOKEN}&bg=01#library`);
  await sleep(4000);
  const r = await p.evaluate(async () => {
    const s = [...document.querySelectorAll('[data-page="library"][data-top="true"] .v-scroll')].pop();
    const dts = [];
    let t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      s.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true }));
      s.scrollTop += i < 25 ? 30 : -30;
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      dts.push(t - t0);
      t0 = t;
    }
    dts.sort((a, b) => a - b);
    return dts[Math.floor(dts.length * 0.95)];
  });
  await ctx.close();
  return r;
}
const FRAMES = {};

async function videos(browser) {
  const vdir = path.join(SHOTS, 'video');
  for (const tag of ['ipad-land', 'phone']) {
    const p = await newPage(browser, tag, { video: vdir });
    await settle(1500);
    const b = (await st(p)).bar;
    const cx = (k) => p.evaluate((k) => { const r = document.querySelector(`[data-tab="${k}"]`).getBoundingClientRect(); return r.left + r.width / 2; }, k);
    const y = b.t + b.h / 2;
    const a = await cx('chat');
    const z = await cx('library');
    await p.mouse.move(a, y);
    await p.mouse.down();
    for (let i = 1; i <= 20; i++) await p.mouse.move(a + ((z - a) * i) / 20, y, { steps: 1 }), await sleep(25);
    await p.mouse.up();
    await settle(1400);
    await p.locator('[data-v53-bar] [data-tab="chat"]').click();
    await settle(1000);
    await scrollBy(p, THREAD, -600, 30);
    await settle(1000);
    await scrollBy(p, THREAD, 20000, 20);
    await settle(1000);
    await p.locator('[data-v53-stage] [data-task-card] > button').first().click();
    await settle(800);
    await p.locator('[data-task-card] [data-card-open]').first().click();
    await settle(1400);
    await p.keyboard.press('Escape');
    await settle(1200);
    await p.context().close();
  }
}

// Reduced motion and lite glass: no shader, nothing slides, still works.
async function liteChecks(browser) {
  console.log('Reduced motion → lite glass');
  const page = await newPage(browser, 'phone', { reduced: true });
  await settle(1200);
  const m = await page.evaluate(() => ({ glass: document.documentElement.dataset.glass, lens: document.documentElement.dataset.lensmode, orb: document.querySelector('[data-head-orb]')?.className, amb: document.querySelector('[data-ambient]')?.className, blobs: document.querySelectorAll('[data-ambient] .v53-blob').length }));
  ok(m.glass === 'lite' && m.lens !== 'gl', `lite: CSS glass, no shader (${m.glass} ${m.lens})`);
  ok(/still/.test(m.orb || '') && /still/.test(m.amb || ''), 'lite: the orb and the ambient light hold still');
  ok(m.blobs === 3, `lite: the moving light falls back to CSS over the photo (${m.blobs} lights)`);
  const b = (await st(page)).bar;
  await page.mouse.move(b.l + 40, b.t + b.h / 2);
  await page.mouse.down();
  await sleep(200);
  ok((await page.locator('[data-tab-lens]').count()) === 0, 'lite: no lens lifts (reduced motion)');
  await page.mouse.up();
  await page.locator('[data-v53-bar] [data-tab="library"]').click();
  await settle(900);
  const s = await st(page);
  ok(s.pane === 'open' && s.top === 'library', 'lite: the tab bar and the pane still work');
  const g = await glassAudit(page);
  ok(!g.problems.length, `lite: everything is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await shotV(page, 'phone-lite-library');
  flush(page, 'lite');
  await page.context().close();
}

async function componentChecks() {
  const mine = [...loadedScripts].filter((u) => u.startsWith(BASE));
  ok(mine.length > 0 && mine.every((u) => !u.includes('/assets/')), `v5.3 never loads v1's bundle (${mine.length} scripts)`);
}

async function main() {
  writeLibrary();
  fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), '');
  boot('node', ['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay');
  boot('node', ['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  await sleep(500);
  fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), miaLines().map((l) => JSON.stringify(l)).join('\n') + '\n');
  await seedJarvis();
  await seedUsage();
  await sleep(1200);
  if (process.env.KEEP) {
    console.log(`Rig up: ${BASE}/v53?token=${TOKEN}  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }
  await servingChecks();
  const PART = process.env.PART || '';
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : ['phone', 'ipad-port', 'ipad-land'];
  for (const tag of PART === 'frames' ? [] : only) {
    for (const theme of ['dark', 'light']) {
      console.log(`Chat first: ${tag} ${theme}`);
      await chatFirst(browser, tag, theme);
    }
  }
  for (const tag of PART === 'frames' ? [] : only) {
    console.log(`Restraint: ${tag}`);
    await restraint(browser, tag);
  }
  for (const tag of PART === 'frames' ? [] : only) {
    console.log(`Tab bar: ${tag}`);
    await tabBar(browser, tag);
  }
  for (const tag of PART === 'frames' ? [] : only) {
    console.log(`mia panel targets: ${tag}`);
    await panelTargets(browser, tag);
  }
  for (const tag of PART === 'frames' ? [] : only.filter((t) => t !== 'ipad-port')) {
    console.log(`Extras: ${tag}`);
    await extras(browser, tag);
  }
  for (const tag of only.filter((t) => t !== 'ipad-port')) await frames(browser, tag);
  for (const tag of only.filter((t) => t !== 'ipad-port')) await sharpAndSteady(browser, tag);
  if (process.env.VIDEO) await videos(browser);
  if (PART !== 'frames') await nowCard(browser);
  await liteChecks(browser);

  await browser.close();
  if (!PART) await componentChecks();
  const errs = [...new Set(allErrors)];
  ok(errs.length === 0, `zero console errors${errs.length ? `:\n    ${errs.slice(0, 20).join('\n    ')}` : ''}`);
  console.log(`\n${passed} passed, ${failed} failed${failed ? `:\n  - ${fails.join('\n  - ')}` : ''}`);
  console.log(`Screenshots: ${SHOTS}`);
  return failed;
}

const cleanup = () => {
  for (const p of procs) try { p.kill(); } catch {}
  if (!process.env.KEEP_TMP) setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 300);
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
main().then(
  (f) => {
    cleanup();
    setTimeout(() => process.exit(f ? 1 : 0), 500);
  },
  (e) => {
    console.error(e);
    cleanup();
    setTimeout(() => process.exit(1), 500);
  },
);
