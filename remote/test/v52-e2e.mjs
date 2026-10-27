// Panel v5.2 end to end (task 0491): chat first, at /v52 beside v5. The real
// relay, the fake host as the Mac and the built panel in headless Chromium
// (Metal GPU) at iPhone, iPad portrait and iPad landscape, dark and light.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/v52-e2e.mjs
//   SHOTS=<dir>   screenshots (default: a temp dir)      VIDEO=1  short recordings too
//   ONLY=a,b      only these viewports (phone,ipad-port,ipad-land)
//   KEEP=1        leave the rig up and print the URL
//
//   • serving: /v52 beside /v5 and / (v1), ?ui=v52 and the mc_ui cookie
//   • the chat is the home screen: fills the view, composer + mic in reach,
//     Mia's questions / tasks / what's running as glass cards in the stream;
//     a card opens in place and grows into the pane
//   • the side panel: button, ⌘\, Esc, scrim, left-edge swipe (follows the
//     finger), drag to shut; every item lands in the pane, the chat stays
//   • the pane: X / Esc / sheet drag-down close it; right-edge swipe reopens
//   • every `mia panel` target (open-doc --at, highlight, scroll-to, scroll,
//     close, open-task, open-agent, view *, show-doc, show-url, search)
//   • the extras: ⌘K palette, chips, long-press → task / reminder, rings,
//     the ambient light, the orb, message arrival
//   • frame timing during chat scroll, pane and side-panel animation, and
//     the glass never lagging (shader ↔ CSS hand-over)
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v52-'));
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
  await page.goto(`${BASE}/v52?token=${TOKEN}&bg=${process.env.BG || '01'}${hash}`);
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


// ---- v5.2 probes ------------------------------------------------------------------
const st = (page) =>
  page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const pane = document.querySelector('[data-v52-pane]');
    const tops = [...document.querySelectorAll('[data-v52-pane="open"] [data-page][data-top="true"]')].filter((e) => e.getClientRects().length);
    return {
      hash: location.hash,
      pane: pane?.dataset.v52Pane,
      paneTab: pane?.dataset.paneTab,
      top: tops.pop()?.dataset.page || '',
      side: document.querySelector('[data-side]')?.dataset.side,
      stage: r('[data-v52-stage]'),
      paneR: r('[data-v52-pane]'),
      sideR: r('[data-side]'),
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
  const isV52 = (b) => /<html[^>]*class="v5 v52"/.test(b);
  const isV5 = (b) => /<html[^>]*class="v5"/.test(b);
  let r = await get('/v52');
  ok(r.status === 200 && isV52(r.body), '/v52 serves v5.2');
  r = await get('/v5');
  ok(isV5(r.body) && !isV52(r.body), '/v5 still serves v5 (side by side)');
  r = await get('/');
  ok(!isV52(r.body) && !isV5(r.body), 'no cookie → v1 stays the default at /');
  r = await get('/?ui=v52');
  ok(isV52(r.body) && /mc_ui=v52/.test(r.cookie), '?ui=v52 → v5.2 and the mc_ui=v52 cookie');
  r = await get('/', 'mc_ui=v52');
  ok(isV52(r.body), 'cookie mc_ui=v52 → v5.2 at / (deep links and pushes land in v5.2)');
  r = await get('/', 'mc_ui=v5');
  ok(isV5(r.body), 'cookie mc_ui=v5 → still v5');
  const css = [...new Set((await get('/v52')).body.match(/\/v2\/_next\/static\/css\/[^"\\]+\.css/g) || [])];
  let t = '';
  for (const c of css) t += (await get(c)).body;
  ok(t.includes('.v52-stage') && t.includes('.v5-win'), `v5.2's stylesheet carries v5's glass and its own (${css.length} file)`);
  ok(!t.includes('1b1b21') && !/--blur:\s*28px/.test(t), "no v1 stylesheet inside v5.2's");
}

// The chat is the home screen: it fills the view, the composer and the mic are in reach.
async function chatFirst(browser, tag, theme) {
  const T = `${tag} ${theme}`;
  const page = await newPage(browser, tag, { theme });
  await settle(1500);
  const s = await st(page);
  ok(s.hash === '' && s.pane === 'closed', `${T}: opens on the chat (no hash, no pane) (${s.hash} ${s.pane})`);
  ok(s.stage && s.stage.w >= s.W * (s.W >= 1000 ? 0.95 : 0.96) && s.stage.h >= s.H * 0.9, `${T}: the chat fills the view (${s.stage?.w}×${s.stage?.h} of ${s.W}×${s.H})`);
  ok(onScreen(s.composer, s) && s.composer.b <= s.H && s.composer.b >= s.H - 120, `${T}: the composer sits at the foot, in reach (${JSON.stringify(s.composer)})`);
  ok(onScreen(s.talk, s) && s.talk.b <= s.H, `${T}: the mic (Mia's orb) is beside it`);
  const n = await page.evaluate(() => ({
    msgs: document.querySelectorAll('[data-v52-stage] [data-msg]').length,
    qcards: document.querySelectorAll('[data-v52-stage] [data-question-card]').length,
    opts: document.querySelectorAll('[data-v52-stage] [data-question-card] button').length,
    task: document.querySelectorAll('[data-v52-stage] [data-task-card]').length,
    live: document.querySelectorAll('[data-live-card]').length,
    chips: document.querySelectorAll('[data-chip]').length,
    orb: document.querySelectorAll('[data-head-orb]').length,
    rings: document.querySelectorAll('[data-ring]').length,
    mode: document.documentElement.dataset.lensmode,
    stageLive: document.querySelector('[data-v52-stage]')?.classList.contains('lens-live'),
  }));
  ok(n.msgs >= 5, `${T}: Mia's thread is the page (${n.msgs} messages)`);
  ok(n.qcards >= 1 && n.opts >= 2, `${T}: questions are glass cards with tap answers (${n.qcards} cards, ${n.opts} buttons)`);
  ok(n.task >= 1, `${T}: a task Mia talks about is a card in the chat (${n.task})`);
  ok(n.live === 1, `${T}: the live card shows what's running`);
  ok(n.chips >= 3, `${T}: quick-action chips under the composer (${n.chips})`);
  ok(n.orb === 1 && n.rings >= 1, `${T}: the orb and the agents' progress rings are in the header (${n.rings} rings)`);
  ok(n.mode === 'gl' && n.stageLive, `${T}: the chat is shader glass (${n.mode}, ${n.stageLive})`);
  const g = await glassAudit(page);
  ok(!g.problems.length, `${T}: everything on screen is glass ${g.problems.slice(0, 2).join(' | ')}`);
  ok((await noSideScroll(page)) === '', `${T}: nothing scrolls sideways`);
  await shotV(page, `${tag}-${theme}-chat`);

  // a task card opens in place, then grows into the pane
  await page.locator('[data-v52-stage] [data-task-card] > button').first().click();
  await settle(700);
  ok((await page.locator('[data-task-card][class*="open"] [data-card-open]').count()) === 1, `${T}: a task card opens in place (its actions inside the card)`);
  await shotV(page, `${tag}-${theme}-card-open`);
  await page.locator('[data-task-card] [data-card-open]').first().click();
  await settle(1100);
  const s2 = await st(page);
  ok(s2.pane === 'open' && s2.top === 'task' && /^#task\//.test(s2.hash), `${T}: Open grows the card into the pane (${s2.top} ${s2.hash})`);
  if (s2.W >= 1000) ok(s2.stage.r <= s2.paneR.l && s2.stage.w >= 300, `${T}: the chat stays alive beside the pane (${s2.stage.w}px)`);
  else ok(s2.stage && s2.stage.h > 0 && s2.paneR.t > 0, `${T}: the chat stays behind the sheet, peeking out (${s2.paneR.t}px)`);
  await shotV(page, `${tag}-${theme}-task-pane`);
  await page.locator('[data-v52-pane="open"] [data-close-window]:visible').first().click();
  await settle(1000);
  const s3 = await st(page);
  ok(s3.pane === 'closed' && s3.hash === '', `${T}: X closes the pane back to the chat`);
  flush(page, T);
  await track(page);
  await page.context().close();
}

const ITEMS = [
  ['home', 'home', '#home'],
  ['tasks', 'tasks', '#tasks'],
  ['fleet', 'agents', '#fleet'],
  ['library', 'library', '#library'],
  ['hq', 'hq', '#hq'],
  ['insights', 'insights', '#insights'],
  ['settings', 'settings', '#settings'],
];

// The side panel: open and close every way, and every item lands in the pane.
async function sidePanel(browser, tag) {
  const T = `${tag} side`;
  const page = await newPage(browser, tag);
  await settle(1200);
  const wide = (await st(page)).W >= 1000;
  await page.locator('[data-side-toggle]').click();
  await settle(800);
  let s = await st(page);
  ok(s.side === (wide ? 'pinned' : 'over') && s.sideR.l >= 0 && s.sideR.l < 30, `${T}: the button opens it (${s.side} at ${s.sideR?.l})`);
  if (wide) ok(s.stage.l >= s.sideR.r && s.stage.w >= s.W * 0.6, `${T}: beside the chat; the chat stays dominant (${s.sideR.w}px panel, ${s.stage.w}px chat)`);
  else ok(s.sideR.w <= s.W * 0.9 && (await page.locator('[data-side-scrim]').count()) === 1, `${T}: over the chat, with a scrim (${s.sideR.w}px)`);
  const g = await glassAudit(page);
  ok(!g.problems.length, `${T}: the panel is glass ${g.problems.slice(0, 2).join(' | ')}`);
  ok((await page.locator('[data-side] [data-side-item]').count()) === 8, `${T}: Chat, Home, Tasks, Fleet, Library, HQ, Insights, Settings`);
  await shotV(page, `${tag}-side-open`);

  for (const [key, want, hash] of ITEMS) {
    // on a phone the pane is a sheet over the chat (and its header): dismiss it first, as you would
    if (!wide && (await st(page)).pane === 'open') {
      await page.locator('[data-v52-pane="open"] [data-close-window]:visible').first().click();
      await settle(900);
    }
    if ((await st(page)).side === 'closed') {
      await page.locator('[data-side-toggle]').click();
      await settle(700);
    }
    await page.locator(`[data-side-item="${key}"]`).click();
    await settle(1200);
    s = await st(page);
    ok(s.pane === 'open' && s.top === want && s.hash === hash, `${T}: ${key} opens in the pane (${s.top} ${s.hash})`);
    ok(s.stage && s.stage.w > 0, `${T}: …and the chat stays alive (${s.stage?.w}px)`);
    if (key === 'library' || key === 'home') await shotV(page, `${tag}-pane-${key}`);
  }
  // Chat closes the pane
  if (!wide) {
    await page.keyboard.press('Meta+Backslash');
    await settle(800);
  } else if ((await st(page)).side === 'closed') {
    await page.locator('[data-side-toggle]').click();
    await settle(700);
  }
  await page.locator('[data-side-item="chat"]').click();
  await settle(1000);
  s = await st(page);
  ok(s.pane === 'closed' && s.hash === '', `${T}: Chat with Mia closes the pane`);

  // close: the button, ⌘\ (wide) / Esc and the scrim (narrow)
  if ((await st(page)).side === 'closed') {
    await page.locator('[data-side-toggle]').click();
    await settle(700);
  }
  if (wide) {
    await page.keyboard.press('Meta+Backslash');
    await settle(800);
    ok((await st(page)).side === 'closed', `${T}: ⌘\\ hides it`);
    await page.keyboard.press('Meta+Backslash');
    await settle(800);
    ok((await st(page)).side === 'pinned', `${T}: ⌘\\ brings it back`);
    await page.locator('[data-side-close]').click();
    await settle(800);
    ok((await st(page)).side === 'closed', `${T}: its own button hides it`);
  } else {
    await page.keyboard.press('Escape');
    await settle(800);
    ok((await st(page)).side === 'closed', `${T}: Esc closes it`);
    await page.locator('[data-side-toggle]').click();
    await settle(800);
    await page.mouse.click(s.W - 20, s.H / 2);
    await settle(800);
    ok((await st(page)).side === 'closed', `${T}: tapping the chat beside it closes it`);
  }

  // the left-edge swipe follows the finger and opens it; a drag shuts it
  const edge = await page.evaluate(async () => {
    const stage = document.querySelector('[data-v52-stage]');
    const y = innerHeight / 2;
    const ev = (type, x, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 }));
    ev('pointerdown', 6, stage.querySelector('[data-thread]') || stage);
    const xs = [];
    for (let x = 6; x <= 260; x += 22) {
      ev('pointermove', x);
      await new Promise((r) => requestAnimationFrame(r));
      xs.push(Math.round(document.querySelector('[data-side]').getBoundingClientRect().left));
    }
    ev('pointerup', 260);
    return xs;
  });
  const followed = edge.slice(1).every((x, i) => x >= edge[i]);
  await settle(900);
  s = await st(page);
  ok(followed && edge[edge.length - 1] > edge[0] + 150, `${T}: a left-edge swipe pulls the panel with the finger (${edge.slice(0, 4).join(',')}…${edge[edge.length - 1]})`);
  ok(s.side !== 'closed', `${T}: …and lets go open (${s.side})`);
  const box = s.sideR;
  await page.mouse.move(box.l + box.w * 0.5, box.t + 200);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.l + box.w * 0.5 - i * 26, box.t + 200, { steps: 1 });
  await page.mouse.up();
  await settle(900);
  ok((await st(page)).side === 'closed', `${T}: dragging it left shuts it`);

  // the right-edge swipe brings back the pane you just closed
  await page.evaluate(() => (location.hash = 'library'));
  await settle(1100);
  await page.locator('[data-v52-pane="open"] [data-close-window]:visible').first().click();
  await settle(900);
  await page.evaluate(async () => {
    const stage = document.querySelector('[data-v52-stage]');
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

  // on a phone the pane is a sheet: drag it down by its top to dismiss
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
    ok(ys[ys.length - 1] > pr.t + 150, `${T}: the sheet follows the finger down (${pr.t} → ${ys[ys.length - 1]})`);
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
  ok(await page.evaluate(() => [...document.querySelectorAll('[data-v52-pane="open"] h2')].some((h) => /What to change/.test(h.textContent) && h.getBoundingClientRect().top < innerHeight * 0.6 && h.getBoundingClientRect().top > 0)), `${T}: …scrolled to the heading`);
  await shotV(page, `${tag}-panel-open-doc`);
  id = panel('highlight', 'Cut the intro card entirely');
  await res(id, 'highlight');
  ok((await page.locator('[data-v52-pane="open"] .mia-mark').count()) >= 1, `${T}: highlight marks the text in the open doc`);
  id = panel('scroll-to', 'Sources');
  await res(id, 'scroll-to');
  id = panel('scroll', 'top');
  await res(id, 'scroll top');
  await settle(1000);
  ok(await page.evaluate(() => (document.querySelector('[data-v52-pane="open"] [data-reader="doc"]')?.scrollTop ?? 1) < 40), `${T}: scroll moves the doc in the pane, not the chat`);
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
  ok(await page.evaluate(() => document.querySelector('[data-v52-stage] [data-reader="thread"]').scrollTop < 40), `${T}: with no pane, scroll moves the chat`);
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
  const prose = page.locator('[data-v52-stage] [data-prose]').first();
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
  const amb = await page.evaluate(() => {
    const a = document.querySelector('[data-ambient]');
    const anims = a.getAnimations({ subtree: true }).filter((x) => x.animationName?.startsWith('v52-drift'));
    return { level: a.dataset.level, rate: anims[0]?.playbackRate, n: anims.length, warm: a.dataset.warm };
  });
  ok(amb.n === 3 && Number(amb.level) >= 1 && amb.rate > 0.5, `${T}: executors running → the room's light moves (${JSON.stringify(amb)})`);
  const orb = await page.evaluate(() => document.querySelector('[data-head-orb]').dataset.orb);
  ok(['idle', 'thinking'].includes(orb), `${T}: Mia's orb shows her state (${orb})`);
  await page.locator('[data-ring]').first().click();
  await settle(1100);
  s = await st(page);
  ok(s.pane === 'open' && s.top === 'agent', `${T}: a progress ring opens its agent`);
  await page.keyboard.press('Escape');
  await settle(900);

  // send: the message arrives with a spring
  await page.locator('[data-composer]').fill('Ping from the v5.2 rig');
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

// Frame timing: the chat scrolling, the pane and the side panel animating.
// The glass must never lag: while the chat scrolls the chat pane itself (it
// doesn't scroll) stays shader glass and nothing inside the scroller is; a
// pane in flight is CSS glass (it moves in the compositor's frame) and the
// shader takes it once it's still.
async function frames(browser) {
  console.log('Frame timing and glass sync');
  const page = await newPage(browser, 'ipad-land');
  await settle(1800);
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
          const pane = document.querySelector('[data-v52-pane]');
          glass.push({
            stage: document.querySelector('[data-v52-stage]')?.classList.contains('lens-live'),
            inner: document.querySelectorAll('[data-v52-stage] .lens-live').length,
            paneLive: !!document.querySelector('[data-v52-pane] .v5-win.lens-live'),
            paneOff: pane?.hasAttribute('data-lens-off'),
            x: Math.round(pane?.getBoundingClientRect().left || 0),
          });
        }
        const s = [...dts].sort((a, b) => a - b);
        return { p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], long: dts.filter((d) => d > 50).length, glass };
      },
      { fnSrc, n },
    );
  const scroll = await sample(`const el = document.querySelector('[data-v52-stage] [data-reader="thread"]'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true })); el.scrollTop += i < 30 ? -24 : 24;`);
  ok(scroll.p95 < 40 && scroll.long <= 2, `chat scroll: p50 ${scroll.p50.toFixed(1)} ms, p95 ${scroll.p95.toFixed(1)} ms, ${scroll.long} long frames`);
  ok(scroll.glass.every((g) => g.stage && g.inner === 0), `chat scroll: the chat's glass stays shader glass and nothing inside the scroller is drawn by the shader (never lags)`);
  // the pane sliding in and out
  const open = await sample(`if (i === 2) location.hash = 'library';`, 50);
  ok(open.p95 < 40 && open.long <= 2, `pane open: p50 ${open.p50.toFixed(1)} ms, p95 ${open.p95.toFixed(1)} ms, ${open.long} long frames`);
  const moving = open.glass.filter((g, i) => i > 3 && i < 45 && open.glass[i - 1] && g.x !== open.glass[i - 1].x);
  ok(moving.length > 3 && moving.every((g) => !g.paneLive), `pane open: while it moves the pane is CSS glass, never a trailing shader pane (${moving.length} moving frames)`);
  await sleep(800);
  ok(await page.evaluate(() => !!document.querySelector('[data-v52-pane] .v5-win.lens-live')), 'pane at rest beside the chat: the shader draws it');
  const lib = await sample(`const s = document.querySelector('[data-page="library"][data-top="true"] .v-scroll'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true })); s.scrollTop += 30;`, 40);
  ok(lib.p95 < 40 && lib.glass.slice(2).every((g) => g.paneLive), `pane scroll: p95 ${lib.p95.toFixed(1)} ms and the pane stays refracting glass while its list scrolls`);
  const close = await sample(`if (i === 2) document.querySelector('[data-v52-pane="open"] [data-close-window]').click();`, 50);
  ok(close.p95 < 40 && close.long <= 2, `pane close: p50 ${close.p50.toFixed(1)} ms, p95 ${close.p95.toFixed(1)} ms`);
  const side = await sample(`if (i === 2) document.querySelector('[data-side-toggle]').click(); if (i === 30) document.querySelector('[data-side-toggle]').click();`, 60);
  ok(side.p95 < 40 && side.long <= 2, `side panel open + close: p50 ${side.p50.toFixed(1)} ms, p95 ${side.p95.toFixed(1)} ms`);
  console.log(`    (rAF intervals: scroll ${scroll.p50.toFixed(1)}/${scroll.p95.toFixed(1)}, pane ${open.p50.toFixed(1)}/${open.p95.toFixed(1)}, side ${side.p50.toFixed(1)}/${side.p95.toFixed(1)} ms p50/p95)`);
  // a short recording of the motion, for the report
  flush(page, 'frames');
  await page.context().close();
  if (process.env.VIDEO) {
    const vdir = path.join(SHOTS, 'video');
    for (const tag of ['ipad-land', 'phone']) {
      const p = await newPage(browser, tag, { video: vdir });
      await settle(1500);
      await p.locator('[data-side-toggle]').click();
      await settle(1000);
      await p.locator('[data-side-item="library"]').click();
      await settle(1400);
      await p.keyboard.press('Escape');
      await settle(1000);
      await p.locator('[data-v52-stage] [data-task-card] > button').first().click();
      await settle(800);
      await p.locator('[data-task-card] [data-card-open]').first().click();
      await settle(1400);
      await p.keyboard.press('Escape');
      await settle(1200);
      await p.context().close();
    }
  }
}

// Reduced motion and lite glass: no shader, nothing slides, still works.
async function liteChecks(browser) {
  console.log('Reduced motion → lite glass');
  const page = await newPage(browser, 'phone', { reduced: true });
  await settle(1200);
  const m = await page.evaluate(() => ({ glass: document.documentElement.dataset.glass, lens: document.documentElement.dataset.lensmode, orb: document.querySelector('[data-head-orb]')?.className, amb: document.querySelector('[data-ambient]')?.className }));
  ok(m.glass === 'lite' && m.lens !== 'gl', `lite: CSS glass, no shader (${m.glass} ${m.lens})`);
  ok(/still/.test(m.orb || '') && /still/.test(m.amb || ''), 'lite: the orb and the ambient light hold still');
  await page.locator('[data-side-toggle]').click();
  await settle(600);
  await page.locator('[data-side-item="library"]').click();
  await settle(900);
  const s = await st(page);
  ok(s.pane === 'open' && s.top === 'library', 'lite: the side panel and the pane still work');
  const g = await glassAudit(page);
  ok(!g.problems.length, `lite: everything is glass ${g.problems.slice(0, 2).join(' | ')}`);
  await shotV(page, 'phone-lite-library');
  flush(page, 'lite');
  await page.context().close();
}

async function componentChecks() {
  const mine = [...loadedScripts].filter((u) => u.startsWith(BASE));
  ok(mine.length > 0 && mine.every((u) => !u.includes('/assets/')), `v5.2 never loads v1's bundle (${mine.length} scripts)`);
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
    console.log(`Rig up: ${BASE}/v52?token=${TOKEN}  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }
  await servingChecks();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : ['phone', 'ipad-port', 'ipad-land'];
  for (const tag of only) {
    for (const theme of tag === 'ipad-port' ? ['dark'] : ['dark', 'light']) {
      console.log(`Chat first: ${tag} ${theme}`);
      await chatFirst(browser, tag, theme);
    }
  }
  for (const tag of only) {
    console.log(`Side panel: ${tag}`);
    await sidePanel(browser, tag);
  }
  for (const tag of only.filter((t) => t !== 'ipad-port')) {
    console.log(`mia panel targets: ${tag}`);
    await panelTargets(browser, tag);
  }
  for (const tag of only.filter((t) => t !== 'ipad-port')) {
    console.log(`Extras: ${tag}`);
    await extras(browser, tag);
  }
  await frames(browser);
  await liteChecks(browser);
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
