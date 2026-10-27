// Panel v5 end to end (task 0483): v1's structure in v4's Lens glass, at
// /v5. The real relay, the fake host as the Mac (temp Library, Mia's
// questions and tasks, usage, the HQ registry) and the built panel in
// headless Chromium (Metal GPU) at iPhone, iPad portrait and iPad landscape,
// dark and light.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/v5-e2e.mjs
//   SHOTS=<dir>   screenshots of every page (default: a temp dir)
//   ONLY=a,b      only these viewports (phone,ipad-port,ipad-land)
//   KEEP=1        leave the rig up and print the URL
//
//   • serving: /v5, ?ui=v5 and the mc_ui cookie; only v5's stylesheet
//   • every page — Home, Mia, a task, Fleet, an agent, Library, a doc,
//     Insights, HQ, Channels, Settings, search, launch, the viewer, the
//     voice room, the console — opens in v1's place (dock/top bar/window)
//     and every surface on screen is glass: no opaque planes, no v1 backdrop
//   • every `mia panel` door (open-doc, show-doc, open-task, open-agent,
//     view …, show-url) lands inside v5 glass
//   • Library is a vertical page with its own reader page; Back returns
//   • lite (reduced motion) = CSS glass, no shader; the shader draws windows
//   • none of v1's shell/page components are in the JS v5 loads
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
const PORT = Number(process.env.RIG_PORT || 8875);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v5-'));
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
}

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
  await page.goto(`${BASE}/v5?token=${TOKEN}&bg=${process.env.BG || '01'}${hash}`);
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


// ---- what "no v1" means, checked two ways --------------------------------------
// 1. Stylesheets: only v5's own. v1's app.css is recognisable by its body
//    backdrop (a radial graphite gradient) and its --blur token; v2's v2.css
//    by its Quiet page colour. Neither may be on a v5 page.
// 2. Components: the JS a v5 session loads may not contain any of v1's shell
//    or page components (its windows, top bar, dock, Mini-Mia, backdrop, doc
//    reader, library, home, fleet, agent view, Mia, tasks, settings, palette,
//    viewer …). Each is fingerprinted by a class string found only in that
//    file; the same fingerprints must be found in v1's own bundle, so the
//    detector is known to work. (v5 still hosts v1's HQ/Channels, console,
//    TV/car, lightbox and terminal — re-skinned entirely by v5.css.)
const V1_FINGERPRINTS = {"Window.jsx": "flex h-full cursor-pointer flex-col items-center gap-3 pb-3 pt-3", "TopBar.jsx": "text-[19px] font-light leading-none tracking-tight text-ink tnum", "Dock.jsx": "mx-1 h-6 w-px flex-none bg-white/15", "MiniMia.jsx": "glass-strong fixed z-[89] flex flex-col overflow-hidden rounded-xl3 shadow-2", "Backdrop.jsx": "absolute inset-x-0 top-0 h-[32%] bg-gradient-to-b from-black/55 to-transparent", "TarsCard.jsx": "glass pill pointer-events-auto h-9 px-4 text-[13px] font-medium text-ink2 hover:text-ink", "CommandPalette.jsx": "h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink3", "Viewer.jsx": "flex flex-none items-center gap-3 border-b border-glass-line px-3 py-2.5 sm:px-4", "DocView.jsx": "flex-none px-3 pb-2 pt-2.5 sm:px-4", "Library.jsx": "block truncate text-[14.5px] font-semibold leading-tight tracking-tight text-ink", "Home.jsx": "relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center", "AttentionCards.jsx": "flex min-w-0 flex-1 items-start gap-2.5 text-left", "AgentView.jsx": "mt-1.5 text-[19px] font-semibold tracking-tight tabular-nums text-ink", "Fleet.jsx": "flex-none text-[9.5px] font-semibold tracking-wide text-mgr/80", "Insights.jsx": "pointer-events-none absolute right-3 bottom-3 hidden opacity-80 sm:block", "Mia.jsx": "flex flex-none items-center gap-1.5 pl-1 text-[16px] font-semibold tracking-tight text-ink", "Thread.jsx": "grid h-9 w-9 flex-none place-items-center rounded-xl bg-white/[0.06] text-ink2", "Tasks.jsx": "h-2 w-2 flex-none rounded-full border border-ink3", "Settings.jsx": "rounded-[18px] border border-glass-line bg-white/[0.04] p-4 sm:p-5"};

async function servingChecks() {
  console.log('Serving');
  const get = async (p, cookie) => {
    const r = await fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    return { body: await r.text(), cookie: r.headers.get('set-cookie') || '' };
  };
  const isV5 = (b) => /<html[^>]*class="v5"/.test(b);
  let r = await get('/v5');
  ok(isV5(r.body), '/v5 serves v5');
  r = await get('/');
  ok(!isV5(r.body), 'no cookie → v1 stays the default at /');
  r = await get('/?ui=v5');
  ok(isV5(r.body) && /mc_ui=v5/.test(r.cookie), '?ui=v5 → v5 and the mc_ui=v5 cookie');
  r = await get('/', 'mc_ui=v5');
  ok(isV5(r.body), 'cookie mc_ui=v5 → v5 at / (deep links and pushes land in v5)');
  const v5 = (await get('/v5')).body;
  const css = [...new Set(v5.match(/\/v2\/_next\/static\/css\/[^"\\]+\.css/g) || [])];
  ok(css.length >= 1, `v5's HTML links its stylesheet (${css.join(', ')})`);
  const v2css = [...new Set(((await get('/v2.html')).body.match(/\/v2\/_next\/static\/css\/[^"\\]+\.css/g) || []))];
  ok(!css.some((c) => v2css.includes(c)), "v5 doesn't link v2's stylesheet (which carries v1's)");
  for (const c of css) {
    const t = (await get(c)).body;
    ok(!t.includes('1b1b21') && !/--blur:\s*28px/.test(t) && !/--v-page:\s*#0b0b0d/.test(t), `${c.split('/').pop()}: no v1 (or v2) stylesheet inside`);
    ok(t.includes('.v5-win'), `${c.split('/').pop()}: is v5's own (Lens windows)`);
  }
}

// What the page is showing: the top page of the current place.
const pageInfo = (page) =>
  page.evaluate(() => {
    const tops = [...document.querySelectorAll('[data-page][data-top="true"]')].filter((e) => e.getClientRects().length > 0);
    const el = tops.pop();
    return { name: el?.dataset.page || '', win: !!el?.querySelector('.v5-win') };
  });

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

async function check(page, tag, label, { want, win = true } = {}) {
  // let a transition finish (a page leaving is still the top layer until it's gone)
  if (want) await until(async () => (await pageInfo(page)).name === want, 3000, label).catch(() => {});
  const info = await pageInfo(page);
  let why = '';
  if (want && info.name !== want) {
    const res = (() => { try { return fs.readFileSync(path.join(MIA_DIR, 'panel-results.jsonl'), 'utf8').trim().split('\n').slice(-2).join(' / '); } catch { return ''; } })();
    why = ` (hash ${await page.evaluate(() => location.hash)}; last panel results: ${res})`;
  }
  if (want) ok(info.name === want, `${tag}: ${label} → page "${info.name}"${why}`);
  if (win) ok(info.win, `${tag}: ${label} opens as a glass window`);
  const g = await glassAudit(page);
  ok(!g.problems.length, `${tag}: ${label} — every surface is glass${g.problems.length ? ': ' + g.problems.slice(0, 3).join(' | ') : ''}`);
  ok(!/radial-gradient/.test(g.bodyBg), `${tag}: ${label} — no v1 backdrop`);
  const side = await noSideScroll(page);
  ok(!side, `${tag}: ${label} — no sideways scroll ${side}`);
  await track(page);
}

const VIEWS = { phone: ['dark', 'light'], 'ipad-port': ['dark'], 'ipad-land': ['dark', 'light'] };

async function tour(browser, tag, theme) {
  const page = await newPage(browser, tag, { theme });
  const T = `${tag}/${theme}`;
  const n = (v) => `${tag}-${theme}-${v}`;
  let i = 0;
  const snap = async (name) => shot(page, n(`${String(++i).padStart(2, '0')}-${name}`));

  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `${T}: theme ${theme}`);
  await check(page, T, 'Home', { want: 'home', win: false });
  ok((await page.locator('[data-topbar]').count()) === 1 && (await page.locator('[data-dock="full"]').count()) === 1, `${T}: Home has v1's top bar and dock`);
  ok((await page.locator('[data-tab]').count()) === 5, `${T}: the tab bar has five tabs (Apple's iPhone limit; v5.1)`);
  ok((await page.locator('[data-tab-talk]').count()) === 1 && !(await page.locator('nav[aria-label="Main"] [data-tab-talk]').count()), `${T}: the mic is its own glass circle beside the tab bar`);
  ok((await page.locator('[data-home] [data-hero]').count()) === 1, `${T}: Home is v1's scene (greeting, sentence, button, figures)`);
  await snap('home');

  // the dock's places, each its own window
  for (const [key, want, name] of [['mia', 'mia', 'mia'], ['fleet', 'agents', 'fleet'], ['library', 'library', 'library'], ['insights', 'insights', 'insights'], ['hq', 'hq', 'hq']]) {
    if (key === 'insights') {
      // Insights is Home's page now: its figures open it
      await page.locator('[data-tab="home"]').first().click().catch(() => {});
      await sleep(600);
      await page.locator('[data-figure="burn"]').first().click().catch(() => {});
    } else await page.locator(`[data-tab="${key}"]`).first().click().catch(() => {});
    if (key === 'mia') {
      await sleep(1200);
      // Mia's chat has no dock (v1, task 0290) — close goes Home
      ok((await page.locator('[data-dock]').count()) === 0, `${T}: Mia's chat has no dock under it`);
    } else await sleep(1000);
    await check(page, T, name, { want });
    if (key === 'hq') ok(!(await page.locator('[data-page="hq"][data-top="true"] [data-back]').count()), `${T}: HQ is a tab — no Back on its first page`);
    if (key === 'fleet') ok((await page.locator('[data-page="agents"][data-top="true"] h1').first().textContent()) === 'Fleet', `${T}: the Fleet tab's page is called Fleet`);
    await snap(name);
    if (key === 'mia') {
      const tasksTab = page.locator('[role="tab"]', { hasText: 'Tasks' });
      if (await tasksTab.count()) {
        await tasksTab.first().click();
        await sleep(600);
        await snap('mia-tasks');
      }
      // a task opens its own page
      await page.locator('[data-task="0001"] [role="button"]').first().click();
      await sleep(1000);
      await check(page, T, 'task page (from the board)', { want: 'task' });
      ok((await page.locator('[data-task-page="0001"]').count()) === 1 && (await page.evaluate(() => location.hash)) === '#task/0001', `${T}: task page #task/0001`);
      await snap('task');
      await page.locator('[data-page="task"][data-top="true"] [data-back]').first().click();
      await sleep(800);
      if (await tasksTab.count()) await page.locator('[role="tab"]', { hasText: 'Chat' }).first().click().catch(() => {});
      await page.locator('[data-page="mia"][data-top="true"] [data-close-window]').first().click();
      await until(async () => (await pageInfo(page)).name === 'home', 3000).catch(() => {});
      ok((await pageInfo(page)).name === 'home', `${T}: Mia's close button returns Home`);
    }
    if (key === 'fleet') {
      const a = page.locator('[data-agent]').first();
      if (await a.count()) {
        await a.click();
        await sleep(1100);
        await check(page, T, 'agent window', { want: 'agent' });
        await snap('agent');
        await page.locator('[data-page="agent"][data-top="true"] [data-agent-more]').first().click();
        await sleep(500);
        const its = await page.locator('[data-context-menu] [data-menu-item]').evaluateAll((els) => els.map((e) => e.dataset.menuItem));
        ok(its.includes('Stop agent') && !its.includes('Open'), `${T}: the agent's ⋯ menu holds Stop (no red Kill in the title bar) — ${its.join(', ')}`);
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    }
    if (key === 'library') {
      const vert = await page.evaluate(() => {
        const root = document.querySelector('[data-page="library"][data-top="true"]');
        const s = root?.querySelector('.v-scroll');
        if (!s || s.scrollWidth > s.clientWidth + 1) return 'the page scrolls sideways';
        const side = [...root.querySelectorAll('*')].find((e) => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX));
        return side ? `${side.tagName.toLowerCase()}.${String(side.className).slice(0, 40)} scrolls sideways` : '';
      });
      ok(!vert, `${T}: Library is a vertical list — nothing scrolls sideways ${vert}`);
      await libSearch(page, 'Raw incident');
      await page.locator('[data-doc="raw-incident-hooks.md"]').first().click();
      await sleep(1400);
      await check(page, T, 'doc reader (from the Library)', { want: 'doc' });
      ok((await page.locator('[data-page="doc"][data-top="true"] .v5-win article.md').count()) === 1, `${T}: the report renders inside the v5 window`);
      ok((await page.locator('[data-dock="compact"]').count()) === 1, `${T}: a report keeps a compact dock (v1)`);
      await snap('doc');
      await page.locator('[data-doc-details]').first().click();
      await sleep(700);
      const g = await glassAudit(page);
      ok(!g.problems.length, `${T}: doc details sheet is glass ${g.problems.slice(0, 2).join(' | ')}`);
      await snap('doc-details');
      await closeSheets(page);
      await page.locator('[data-page="doc"][data-top="true"] [data-back]').first().click();
      await sleep(900);
      ok((await pageInfo(page)).name === 'library', `${T}: Back from the doc returns to the Library`);
      await page.locator('[data-page="library"][data-top="true"] input[placeholder^="Search"]').first().fill('');
      await sleep(400);
    }
  }

  // Settings from the top bar
  await page.locator('[data-tab="home"]').first().click();
  await sleep(600);
  await page.locator('[data-open-settings]').first().click();
  await sleep(1000);
  await check(page, T, 'settings', { want: 'settings' });
  await snap('settings');
  await go(page, 'channels', 1500);
  await check(page, T, 'channels', { want: 'hq' });
  await snap('channels');

  // sheets: search, launch
  await go(page, '', 700);
  await page.locator('[data-top-search]').first().click();
  await sleep(500);
  await page.keyboard.type('raw');
  await sleep(900);
  let g = await glassAudit(page);
  ok(!g.problems.length, `${T}: search sheet is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('search');
  await closeSheets(page);
  await page.locator('[data-top-launch]').first().click();
  await sleep(700);
  g = await glassAudit(page);
  ok(!g.problems.length, `${T}: launch sheet is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('launch');
  await closeSheets(page);

  // every `mia panel` door lands in v5 glass
  panel('open-doc', 'crystal-retention.md');
  await sleep(1500);
  await check(page, T, 'mia panel open-doc', { want: 'doc' });
  panel('open-task', '1');
  await sleep(1200);
  await check(page, T, 'mia panel open-task', { want: 'task' });
  const ag = await page.evaluate(() => fetch('/api/v1/agents', { headers: { Authorization: 'Bearer test' } }).then((r) => r.json()).then((j) => (j.agents || [])[0]?.id).catch(() => null));
  if (ag) {
    panel('open-agent', ag);
    await sleep(1300);
    await check(page, T, 'mia panel open-agent', { want: 'agent' });
  }
  for (const [v, want] of [['mia', 'mia'], ['fleet', 'agents'], ['library', 'library'], ['insights', 'insights'], ['hq', 'hq'], ['settings', 'settings']]) {
    panel('view', v);
    await sleep(1000);
    await check(page, T, `mia panel view ${v}`, { want });
  }
  panel('view', 'home');
  await sleep(900);
  await check(page, T, 'mia panel view home', { want: 'home', win: false });
  panel('show-doc', 'raw-incident-hooks.md');
  await sleep(1500);
  ok((await page.locator('[role="dialog"] [data-reader="viewer"]').count()) === 1, `${T}: mia panel show-doc opens the viewer`);
  g = await glassAudit(page);
  ok(!g.problems.length, `${T}: show-doc viewer is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('viewer-doc');
  panel('close');
  await sleep(700);
  panel('show-url', 'https://example.com/listing');
  await sleep(2200);
  ok((await page.locator('[role="dialog"]').count()) >= 1, `${T}: mia panel show-url opens the viewer`);
  g = await glassAudit(page);
  ok(!g.problems.length, `${T}: show-url viewer is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('viewer-url');
  panel('close');
  await sleep(700);

  // takeovers: the voice room and the console are glass over the scene
  await page.locator('[data-tab-talk]').first().click();
  await sleep(1300);
  g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the voice room is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('voice');
  await page.locator('[data-voice-min]').first().click().catch(() => {});
  await sleep(500);
  await page.locator('[data-pill-stop]').first().click().catch(() => {});
  await sleep(400);
  await go(page, 'console', 1300);
  g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the console is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await snap('console');
  await go(page, '', 700);

  await track(page);
  flush(page, T);
  await page.context().close();
}

async function liteChecks(browser) {
  console.log('Lite (reduced motion → CSS glass)');
  const page = await newPage(browser, 'phone', { reduced: true });
  await sleep(1200);
  const st = await page.evaluate(() => ({ glass: document.documentElement.dataset.glass, canvas: !!document.querySelector('.lens-canvas'), photo: !!document.querySelector('.lens-lite-photo') }));
  ok(st.glass === 'lite' && !st.canvas && st.photo, `lite: no shader, the photo + CSS glass (${JSON.stringify(st)})`);
  await go(page, 'library', 1000);
  await check(page, 'lite', 'library', { want: 'library' });
  await shot(page, 'phone-dark-lite-library');
  await page.context().close();
}

async function glChecks(browser) {
  console.log('Lens shader');
  const page = await newPage(browser, 'ipad-land');
  await sleep(1500);
  const st = await page.evaluate(() => ({ mode: document.documentElement.dataset.lensmode, panes: window.__lensLive ? window.__lensLive() : -1 }));
  ok(st.mode === 'gl' && st.panes >= 1, `gl: the shader draws Home's panes (${JSON.stringify(st)})`);
  await go(page, 'library', 1200);
  const live = await page.evaluate(() => !!document.querySelector('[data-page="library"][data-top="true"] .v5-win.lens-live'));
  ok(live, 'gl: the Library window is shader glass (refracting rim)');
  await page.context().close();
}

// ---- v5.1 (task 0486): the Library's one search field + Filter menu, and the
// things an Apple app does without being asked ---------------------------------------
async function uxChecks(browser, tag) {
  console.log(`v5.1 UX: ${tag}`);
  const T = `ux ${tag}`;
  const page = await newPage(browser, tag);
  const lib = '[data-page="library"][data-top="true"]';
  await page.locator('[data-tab="library"]').first().click();
  await sleep(1100);

  // the toolbar is one search field — no tag, company or status chips on show
  const bar = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const text = root?.querySelector('header')?.innerText || '';
    return { tags: /#bulk|#roblox|#mandate/.test(text), cos: root?.querySelectorAll('[data-co]').length || 0, selects: root?.querySelectorAll('header select').length || 0, search: root?.querySelectorAll('[data-library-search]').length || 0, menu: root?.querySelectorAll('[data-filter-menu]').length || 0 };
  }, lib);
  ok(bar.search === 1 && !bar.tags && !bar.cos && !bar.selects, `${T}: the Library leads with one search field — no tag/company/status chips (${JSON.stringify(bar)})`);
  ok(!bar.menu && !(await page.locator('[data-filter-menu]').count()), `${T}: the Filter menu is hidden by default`);
  const row = await page.locator(`${lib} [data-doc]`).first().innerText();
  ok(!/words|by you|by an agent|#bulk/.test(row), `${T}: a row shows only useful info (${JSON.stringify(row.replace(/\n/g, ' | '))})`);
  ok((await page.locator(`${lib} [data-library-section]`).count()) >= 1, `${T}: newest first, in date sections`);

  // Filter: a glass pull-down (iPad) / a sheet (phone), with every tag inside
  await page.locator(`${lib} [data-filter-button]`).click();
  await sleep(700);
  ok((await page.locator('[data-filter-menu]').count()) === 1, `${T}: Filter opens the menu`);
  const isSheet = (await page.locator('[role="dialog"] [data-filter-menu]').count()) === 1;
  ok(tag === 'phone' ? isSheet : !isSheet, `${T}: the menu is ${tag === 'phone' ? 'a sheet on a phone' : 'a pull-down on an iPad'}`);
  const g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the Filter menu is glass ${g.problems.slice(0, 2).join(' | ')}`);
  ok((await page.locator('[data-filter="tag"]').count()) >= 2, `${T}: tags live in the menu`);
  ok((await page.locator('[data-filter="co"]').count()) >= 2, `${T}: companies live in the menu`);
  ok((await page.locator('[data-filter="status"][data-value="done"]').count()) === 1, `${T}: status lives in the menu`);
  await shot(page, `${tag}-ux-01-filter-menu`);
  ok((await page.locator('[data-filter="tag"]').count()) <= 7, `${T}: only the most used tags show until you ask for all of them`);
  await page.locator('[data-all-tags]').click().catch(() => {});
  await sleep(300);
  await page.locator('[data-filter="tag"][data-value="roblox"]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-filter="tag"][data-value="roblox"]').click();
  await sleep(400);
  await page.locator('[data-filter-done]').click();
  await sleep(700);
  ok((await page.locator('[data-filter-menu]').count()) === 0, `${T}: Done closes the menu`);
  const ids = await page.locator(`${lib} [data-doc]`).evaluateAll((els) => els.map((e) => e.dataset.doc));
  ok(ids.length === 1 && ids[0] === 'crystal-retention.md', `${T}: #roblox leaves just its document (${ids.join(', ')})`);
  ok((await page.locator(`${lib} [data-filter-token="tag"]`).count()) === 1 && (await page.locator(`${lib} [data-filter-button][data-active="1"]`).count()) === 1, `${T}: the active filter shows as a token and on the button`);
  await shot(page, `${tag}-ux-02-filtered`);
  // remembered on this device — and a cold launch (no #hash) resumes the place
  await page.goto(`${BASE}/v5?token=${TOKEN}&bg=01`);
  await page.waitForSelector('[data-v5-shell]');
  await sleep(1600);
  ok((await page.locator(`${lib} [data-filter-token="tag"]`).count()) === 1, `${T}: the filter is remembered after a reload`);
  ok((await top(page)) === 'library', `${T}: a cold launch soon after comes back to the Library`);
  await page.locator(`${lib} [data-filter-token="tag"]`).click();
  await sleep(600);
  ok((await page.locator(`${lib} [data-filter-token]`).count()) === 0 && (await page.locator(`${lib} [data-doc]`).count()) > 5, `${T}: tapping the token clears it`);

  // empty state with a way out
  await libSearch(page, 'zzzz-nothing-like-this');
  await sleep(900);
  ok((await page.locator(`${lib}`).innerText()).includes('No results for'), `${T}: a search with no hits says so`);
  await libSearch(page, '');

  // long-press / right-click: what you can do to a document
  const first = page.locator(`${lib} [data-doc]`).first();
  await first.click({ button: 'right' });
  await sleep(600);
  const items = await page.locator('[data-context-menu] [data-menu-item]').evaluateAll((els) => els.map((e) => e.dataset.menuItem));
  ok(items.includes('Open') && items.includes('Ask Mia about it') && items.includes('Archive') && items[items.length - 1] === 'Delete', `${T}: a document's context menu (${items.join(', ')})`);
  await shot(page, `${tag}-ux-03-context-menu`);
  await page.keyboard.press('Escape');
  await sleep(500);
  ok((await page.locator('[data-context-menu]').count()) === 0, `${T}: Esc closes the context menu`);
  ok((await top(page)) === 'library', `${T}: …without leaving the Library`);

  // swipe a row left: Ask Mia · Archive
  const box = await first.boundingBox();
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width - 30 - i * 15, box.y + box.height / 2 + 1);
  await page.mouse.up();
  await sleep(500);
  const shown = await page.locator(`${lib} [data-swipe-row] [data-swipe-action="archive"]`).first().evaluate((e) => e.getBoundingClientRect().width);
  ok(shown > 40, `${T}: swiping a row left reveals Ask Mia and Archive (${Math.round(shown)}px)`);
  await shot(page, `${tag}-ux-04-swipe`);
  await sleep(200);
  await first.click();
  await sleep(500);
  ok((await top(page)) === 'library', `${T}: a tap on an open row closes it (doesn't open the doc)`);

  // pull to refresh (a real touch drag)
  if (tag === 'phone') {
    await page.locator('[data-tab="fleet"]').first().click();
    await sleep(900);
    const cdp = await page.context().newCDPSession(page);
    const pt = (y) => [{ x: 195, y }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(260) });
    for (let y = 270; y <= 520; y += 25) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y) });
      await sleep(16);
    }
    const pulled = await page.locator('[data-ptr]').getAttribute('data-ptr').catch(() => null);
    await shot(page, `${tag}-ux-05-pull-to-refresh`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
    const busy = await page.locator('[data-ptr]').getAttribute('data-ptr').catch(() => null);
    ok(pulled === 'armed' && (busy === 'busy' || busy === 'done' || busy === 'same'), `${T}: pull to refresh on Fleet (${pulled} → ${busy})`);
    await until(async () => !(await page.locator('[data-ptr]').count()), 4000).catch(() => {});
    ok((await page.locator('[data-ptr]').count()) === 0, `${T}: …and it settles back`);
  }

  // iPad keyboard: ⌘ shortcuts and the hold-⌘ list
  if (tag !== 'phone') {
    await page.keyboard.press('Meta+3');
    await sleep(800);
    ok((await top(page)) === 'agents', `${T}: ⌘3 opens Fleet`);
    await page.keyboard.press('Meta+4');
    await sleep(800);
    await page.keyboard.press('Meta+f');
    await sleep(300);
    ok(await page.evaluate(() => document.activeElement?.matches('[data-library-search]')), `${T}: ⌘F finds in the Library`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Meta+i');
    await sleep(900);
    ok((await top(page)) === 'insights', `${T}: ⌘I opens Insights`);
    await page.keyboard.press('Meta+/');
    await sleep(500);
    ok((await page.locator('[data-shortcuts]').count()) === 1, `${T}: ⌘/ lists the shortcuts`);
    await shot(page, `${tag}-ux-06-shortcuts`);
    await page.keyboard.press('Meta+/');
    await sleep(400);
  }
  flush(page, T);
  await page.context().close();
}

// Daniel (on v4): "whenever I scroll, the liquid glass lags behind the text".
// While a page scrolls, no pane inside it is drawn by the shader (its CSS glass
// moves with the text in the compositor's frame); at rest the shader has it back.
async function scrollSyncChecks(browser) {
  console.log('Glass follows the scroll (task 0486)');
  const page = await newPage(browser, 'phone');
  await sleep(1800);
  const mode = await page.evaluate(() => document.documentElement.dataset.lensmode);
  ok(mode === 'gl', `scroll: the shader is on (${mode})`);
  const rest0 = await page.evaluate(() => document.querySelectorAll('.v5-home .lens-live').length);
  ok(rest0 >= 1, `scroll: at rest, Home's cards are shader glass (${rest0})`);
  // scroll Home with the wheel for ~40 frames, sampling every frame
  const res = await page.evaluate(async () => {
    const el = document.querySelector('.v5-home');
    let bad = 0;
    let frames = 0;
    let gated = 0;
    const lag = [];
    for (let i = 0; i < 40; i++) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 18, bubbles: true }));
      el.scrollTop += i < 20 ? 18 : -18;
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
      // after the first frame, nothing inside the scroller may be shader glass
      if (i > 0 && document.querySelectorAll('.v5-home .lens-live').length) bad++;
      if (window.__lensScrolled > 0) gated++;
      lag.push(window.__lensScrolled || 0);
    }
    return { bad, frames, gated };
  });
  ok(res.bad === 0 && res.gated >= res.frames - 2, `scroll: while scrolling, Home's cards show CSS glass, never a lagging shader pane (${JSON.stringify(res)})`);
  await sleep(700);
  const rest1 = await page.evaluate(() => document.querySelectorAll('.v5-home .lens-live').length);
  ok(rest1 >= 1, `scroll: once still, the shader takes them back (${rest1})`);
  // the window itself (it doesn't scroll) stays shader glass throughout
  await go(page, 'library', 1300);
  const win = await page.evaluate(async () => {
    const s = document.querySelector('[data-page="library"][data-top="true"] .v-scroll');
    let off = 0;
    for (let i = 0; i < 20; i++) {
      s.scrollTop += 30;
      await new Promise((r) => requestAnimationFrame(r));
      if (!document.querySelector('[data-page="library"][data-top="true"] .v5-win.lens-live')) off++;
    }
    return off;
  });
  ok(win === 0, `scroll: a window stays refracting glass while its content scrolls (${win} frames off)`);
  flush(page, 'scroll');
  await page.context().close();
}

async function componentChecks() {
  console.log('No v1 components');
  const v1html = await (await fetch(`${BASE}/?ui=v1`)).text();
  const v1js = [...new Set(v1html.match(/\/assets\/[^"]+\.js/g) || [])];
  let v1text = '';
  for (const u of v1js) v1text += await (await fetch(BASE + u)).text();
  // v1's lazy chunks too (its views are split)
  for (const u of new Set(v1text.match(/assets\/[A-Za-z0-9_-]+\.js/g) || [])) v1text += await (await fetch(`${BASE}/${u}`)).text().catch(() => '');
  const seen = Object.entries(V1_FINGERPRINTS).filter(([, f]) => v1text.includes(f)).length;
  ok(seen >= Object.keys(V1_FINGERPRINTS).length - 2, `the detector finds v1's components in v1's bundle (${seen}/${Object.keys(V1_FINGERPRINTS).length})`);
  const mine = [...loadedScripts].filter((u) => u.startsWith(BASE));
  ok(mine.every((u) => !u.includes('/assets/')), "v5 never loads v1's bundle");
  let text = '';
  for (const u of mine) text += await (await fetch(u)).text();
  const found = Object.entries(V1_FINGERPRINTS).filter(([, f]) => text.includes(f)).map(([k]) => k);
  ok(found.length === 0, `none of v1's shell/page components in the ${mine.length} scripts v5 loaded${found.length ? ': ' + found.join(', ') : ''}`);
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
    console.log(`Rig up: ${BASE}/v5?token=${TOKEN}  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }
  await servingChecks();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : Object.keys(VIEWS);
  for (const tag of only) for (const theme of VIEWS[tag]) {
    console.log(`Tour: ${tag} ${theme}`);
    await tour(browser, tag, theme);
  }
  await liteChecks(browser);
  await glChecks(browser);
  for (const tag of ['phone', 'ipad-land']) if (!process.env.ONLY || only.includes(tag)) await uxChecks(browser, tag);
  await scrollSyncChecks(browser);
  await browser.close();
  await componentChecks();
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
