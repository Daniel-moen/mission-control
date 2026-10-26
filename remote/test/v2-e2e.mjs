// Panel v2 end to end (task 0444): the real relay, the fake host as the Mac
// (temp Library, Mia questions old and new, tasks, usage, HQ registry), and
// the built panel in headless Chromium at iPhone, iPad portrait, iPad
// landscape and a Stage Manager window, in dark and light.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/v2-e2e.mjs
//   SHOTS=<dir>   screenshots of every view, both themes (default: a temp dir)
//   ONLY=a,b      only these viewports (phone,ipad-port,ipad-land,stage)
//   KEEP=1        leave the rig up and print the URL
//
//   • A/B: v1 stays the default; ?ui=v2 / ?ui=v1 flip it and the relay
//     remembers per device (mc_ui cookie); Settings switches back
//   • every view renders with no console errors and no sideways scroll
//   • Mia: one-tap answers (Home + chat), send a message, attach a report,
//     upload a file; tasks board + open-task
//   • navigation: tabs keep their stacks, push/pop, the left-edge swipe back,
//     deep links (#doc/…, #agent/…, #mia, #fleet, #settings, #channels)
//   • `mia panel` commands: view, open-doc (+heading), scroll-to, highlight,
//     open-task, open-agent, search, show-doc, close
//   • offline: the connection pill comes and goes; a cold start shows the
//     last picture of the fleet
//   • a screen recording + frame sequence of the key transitions

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
const PORT = Number(process.env.RIG_PORT || 8874);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v2-'));
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
async function newPage(browser, tag, { theme = 'dark', ui = 'v2', hash = '', reduced = false, video = null } = {}) {
  const vp = VIEWPORTS[tag];
  const ctx = await browser.newContext({
    ...vp,
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    permissions: ['microphone'],
    ...(video ? { recordVideo: { dir: video, size: vp.viewport } } : {}),
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of (202|404)/.test(m.text())) page.errors.push(`console: ${m.text()}`);
  });
  await page.route('**/tts', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, voice: 'Kokoro (Heart)', today: { requests: 3, chars: 412 }, limits: { maxChars: 600, dailyChars: 20000 } }) }) : r.fulfill({ status: 204, body: '' })));
  // a fixed photo, so the Lens screenshots are comparable run to run
  await page.goto(`${BASE}/?token=${TOKEN}&ui=${ui}&bg=${process.env.BG || '01'}${hash}`);
  if (ui === 'v2') await page.waitForSelector('[data-tabbar], [data-page]', { timeout: 15000 });
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
      if (el.closest('.v-scroll-x, .term, pre, .md-table, [data-chart], svg, table, [data-tabbar]')) return false;
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
const closeSheets = async (page) => {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) return;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
};

async function servingChecks() {
  console.log('A/B serving');
  const html = async (p, cookie) => {
    const r = await fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    return { body: await r.text(), cookie: r.headers.get('set-cookie') || '' };
  };
  const isV2 = (b) => b.includes('/v2/_next/');
  let r = await html('/');
  ok(!isV2(r.body), 'no cookie → v1 (the default)');
  r = await html('/?ui=v2');
  ok(isV2(r.body) && /mc_ui=v2/.test(r.cookie), '?ui=v2 → v2 and the mc_ui=v2 cookie');
  r = await html('/', 'mc_ui=v2');
  ok(isV2(r.body), 'cookie mc_ui=v2 → v2 at /');
  r = await html('/agent/whatever', 'mc_ui=v2');
  ok(isV2(r.body), 'cookie → v2 on SPA fallbacks too');
  r = await html('/?ui=v1', 'mc_ui=v2');
  ok(!isV2(r.body) && /mc_ui=v1/.test(r.cookie), '?ui=v1 → v1 and resets the cookie');
  r = await html('/v2.html');
  ok(isV2(r.body), '/v2.html serves v2 directly');
}

async function screenshots(browser, tag) {
  for (const theme of tag === 'stage' ? ['dark'] : ['dark', 'light']) {
    const page = await newPage(browser, tag, { theme });
    const n = (v) => `${tag}-${theme}-${v}`;
    const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
    ok(theme0 === theme, `${tag}/${theme}: follows the system theme (${theme0})`);
    await shot(page, n('01-home'));
    let side = await noSideScroll(page);
    ok(!side, `${tag}/${theme}: Home has no sideways scroll ${side}`);

    await go(page, 'mia', 1200);
    await shot(page, n('02-mia-chat'));
    side = await noSideScroll(page);
    ok(!side, `${tag}/${theme}: Mia has no sideways scroll ${side}`);
    if (await page.locator('[role="tab"]', { hasText: 'Tasks' }).count()) {
      await page.locator('[role="tab"]', { hasText: 'Tasks' }).first().click();
      await sleep(600);
      await shot(page, n('03-mia-tasks'));
      await page.locator('[role="tab"]', { hasText: 'Chat' }).first().click();
      await sleep(300);
    }
    await page.locator('[data-attach-button]').first().click();
    await sleep(700);
    await shot(page, n('04-attach-sheet'));
    await closeSheets(page);

    await go(page, 'fleet', 1000);
    await shot(page, n('05-agents'));
    side = await noSideScroll(page);
    ok(!side, `${tag}/${theme}: Agents has no sideways scroll ${side}`);
    const firstAgent = page.locator('[data-agent]').first();
    if (await firstAgent.count()) {
      await firstAgent.click();
      await sleep(1100);
      await shot(page, n('06-agent'));
      side = await noSideScroll(page);
      ok(!side, `${tag}/${theme}: Agent has no sideways scroll ${side}`);
    }

    await go(page, 'library', 1000);
    await shot(page, n('07-library'));
    side = await noSideScroll(page);
    ok(!side, `${tag}/${theme}: Library has no sideways scroll ${side}`);
    await libSearch(page, 'Raw incident');
    await shot(page, n('07b-library-search'));
    await page.locator('[data-doc="raw-incident-hooks.md"]').first().click();
    await sleep(1400);
    await shot(page, n('08-doc'));
    await page.locator('[data-doc-details]').first().click();
    await sleep(600);
    await shot(page, n('09-doc-details'));
    await closeSheets(page);
    await page.locator('[data-library-new]').first().click();
    await sleep(400);
    await shot(page, n('10-library-new-menu'));
    await page.locator('[data-new="research"]').first().click().catch(() => {});
    await sleep(700);
    await shot(page, n('11-research-sheet'));
    await closeSheets(page);

    await go(page, 'insights', 1300);
    await shot(page, n('12-insights'));
    await go(page, 'settings', 900);
    await shot(page, n('13-settings'));
    await go(page, 'hq', 1500);
    await shot(page, n('14-hq'));
    await go(page, 'channels', 1500);
    await shot(page, n('15-channels'));

    await go(page, '', 700);
    await page.keyboard.press('Meta+k');
    await sleep(500);
    await page.keyboard.type('raw');
    await sleep(900);
    await shot(page, n('16-search'));
    await closeSheets(page);
    await page.locator('[data-home-launch]').first().click();
    await sleep(700);
    await shot(page, n('17-launch'));
    await closeSheets(page);

    panel('show-doc', 'raw-incident-hooks.md');
    await sleep(1500);
    await shot(page, n('18-viewer'));
    await closeSheets(page);
    ok((await page.locator('[data-tab-talk]').count()) === 1, `${tag}/${theme}: the app is intact after Mia's viewer closes`);

    await page.locator('[data-tab-talk]').first().click();
    await sleep(1500);
    await shot(page, n('19-voice'));
    await page.locator('[data-voice-min]').first().click().catch(() => {});
    await sleep(700);
    await shot(page, n('20-voice-pill'));
    await page.locator('[data-pill-stop]').first().click().catch(() => {});
    await sleep(400);

    await go(page, 'console', 1200);
    await shot(page, n('21-console'));
    await go(page, '', 600);

    flush(page, `${tag}/${theme}`);
    await page.context().close();
  }
}

async function behaviour(browser) {
  console.log('Behaviour (phone)');
  const page = await newPage(browser, 'phone');

  // ---- Home: one-tap answer ----------------------------------------------------
  const home = await page.evaluate(() => document.body.innerText);
  ok(home.includes('Publish the Phoenix Short') && !home.includes('Fresnaye dossier include'), 'Home: the last hour’s question, not older ones');
  ok((await page.locator('[data-older-questions]').count()) === 1, 'Home: a link to the older questions');
  await page.locator('[data-question="q_new12"] [data-option="18:00"]').first().click();
  await until(async () => (await thread()).some((m) => m.kind === 'answer' && m.questionId === 'q_new12' && m.text === '18:00'), 6000, 'answer').then(
    () => ok(true, 'Home: one tap answers Mia (miaAnswer reached the Mac)'),
    () => ok(false, 'Home: one tap answers Mia (miaAnswer reached the Mac)'),
  );
  await sleep(600);
  ok((await page.locator('[data-question="q_new12"]').count()) === 0, 'Home: the answered card leaves');

  // ---- tabs keep their stacks; push / pop / swipe back --------------------------
  await page.locator('[data-tab="library"]').click();
  await sleep(700);
  ok((await top(page)) === 'library', 'tab: Library');
  ok((await page.locator('[data-doc]').count()) < 40, `Library: virtualised (${await page.locator('[data-doc]').count()} of 64 rows in the DOM)`);
  await libSearch(page, 'Crystal');
  await page.locator('[data-doc="crystal-retention.md"]').first().click();
  await sleep(1100);
  ok((await top(page)) === 'doc' && (await page.evaluate(() => location.hash)) === '#doc/crystal-retention.md', 'a doc grows out of its row (#doc/…)');
  ok((await page.locator('[data-tabbar]').count()) === 0, 'phone: the tab bar steps aside on a pushed page');
  await page.locator('[data-tab]').count();
  // swipe from the left edge
  const vh = 844;
  await page.mouse.move(6, vh / 2);
  await page.mouse.down();
  for (let x = 6; x <= 320; x += 22) {
    await page.mouse.move(x, vh / 2 + 2);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(900);
  ok((await top(page)) === 'library', 'swipe from the left edge goes back');
  // a short swipe springs back
  await page.locator('[data-doc="crystal-retention.md"]').first().click();
  await sleep(1100);
  await page.mouse.move(6, vh / 2);
  await page.mouse.down();
  for (let x = 6; x <= 60; x += 12) {
    await page.mouse.move(x, vh / 2);
    await sleep(30);
  }
  await sleep(200);
  await page.mouse.up();
  await sleep(900);
  ok((await top(page)) === 'doc', 'a short drag springs back (still on the doc)');
  // the Back button
  await page.locator('[data-page="doc"][data-top="true"] [data-back]').first().click();
  await sleep(900);
  ok((await top(page)) === 'library', 'Back pops');
  await page.locator('[data-doc="crystal-retention.md"]').first().click();
  await sleep(900);
  await page.locator('[data-tab]').count();
  await page.evaluate(() => (location.hash = 'mia'));
  await sleep(800);
  ok((await top(page)) === 'mia', '#mia switches to Mia');
  await page.evaluate(() => (location.hash = 'library'));
  await sleep(800);
  ok((await top(page)) === 'library', '#library is the Library root');

  // ---- Mia: chat, attach a report, upload a file -------------------------------
  await page.locator('[data-tab="mia"]').click();
  await sleep(800);
  const box = page.locator('[data-thread] textarea').first();
  await box.fill('v2 says hello');
  await box.press('Enter');
  await until(async () => (await thread()).some((m) => m.from === 'daniel' && m.text === 'v2 says hello'), 6000, 'chat').then(
    () => ok(true, 'Mia: Enter sends a message'),
    () => ok(false, 'Mia: Enter sends a message'),
  );
  // the older question answered inline in the chat
  const q3 = page.locator('[data-answer="q_old3h"] [data-option="No"]');
  if (await q3.count()) {
    await q3.first().click();
    await until(async () => (await thread()).some((m) => m.kind === 'answer' && m.questionId === 'q_old3h'), 6000, 'answer2').then(
      () => ok(true, 'Mia chat: one tap answers an older question'),
      () => ok(false, 'Mia chat: one tap answers an older question'),
    );
  } else ok(true, 'Mia chat: (older question hidden by the age rule)');
  await page.locator('[data-attach-button]').first().click();
  await sleep(600);
  await page.locator('[data-attach-pick="raw-incident-hooks.md"]').first().click();
  await sleep(500);
  ok((await page.locator('[data-composer-refs] [data-ref="doc:raw-incident-hooks.md"]').count()) === 1, 'attach: the report rides as a chip');
  await box.fill('look at this');
  await box.press('Enter');
  await until(async () => (await thread()).some((m) => m.from === 'daniel' && m.text.includes('📎 Report') && m.text.includes('raw-incident-hooks.md')), 6000, 'ref').then(
    () => ok(true, 'attach: Mia gets the reference line'),
    () => ok(false, 'attach: Mia gets the reference line'),
  );
  // upload
  await page.locator('[data-attach-button]').first().click();
  await sleep(500);
  const chooser = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
  await page.locator('[data-attach-files]').first().click();
  const fc = await chooser;
  if (fc) {
    const f = path.join(TMP, 'notes.txt');
    fs.writeFileSync(f, 'Hello from the v2 e2e.\n');
    await fc.setFiles(f);
    await sleep(400);
    ok((await page.locator('[data-staged="notes.txt"]').count()) === 1, 'upload: the file waits in the tray');
    await page.locator('[data-thread] [aria-label="Send"]').first().click();
    await until(async () => (await thread()).some((m) => m.kind === 'upload' && (m.file?.name || '').includes('notes')), 10000, 'upload').then(
      () => ok(true, 'upload: the Mac saved it and it shows in the thread'),
      () => ok(false, 'upload: the Mac saved it and it shows in the thread'),
    );
  } else ok(false, 'upload: the file picker opens from the tap');

  // ---- panel commands ----------------------------------------------------------
  panel('view', 'insights');
  await sleep(1200);
  ok((await top(page)) === 'insights', 'mia panel view insights');
  panel('open-doc', 'raw-incident-hooks', 'What to change');
  await sleep(2200);
  ok((await top(page)) === 'doc' && (await page.evaluate(() => location.hash)) === '#doc/raw-incident-hooks.md', 'mia panel open-doc');
  const scrolled = await page.evaluate(() => document.querySelector('[data-reader="doc"]')?.scrollTop || 0);
  ok(scrolled > 100, `open-doc --at scrolled to the heading (${Math.round(scrolled)}px)`);
  panel('highlight', 'Narration only between beats');
  await sleep(1500);
  ok((await page.locator('[data-reader="doc"] .mia-mark').count()) === 1, 'mia panel highlight marks the line');
  panel('scroll', 'top');
  await sleep(1200);
  ok((await page.evaluate(() => document.querySelector('[data-page="doc"][data-top="true"] [data-reader="doc"]')?.scrollTop || 0)) < 10, 'mia panel scroll top');
  panel('open-task', '1');
  await sleep(1400);
  ok((await top(page)) === 'mia' && (await page.locator('[data-task="0001"]').count()) === 1, 'mia panel open-task shows the task on the board');
  const agentId = await page.evaluate(async () => {
    const r = await fetch('/api/v1/agents', { headers: { Authorization: 'Bearer test' } });
    const j = await r.json();
    return (j.agents || []).find((a) => a.status !== 'done')?.sessionId || (j.agents || [])[0]?.sessionId || (j.agents || [])[0]?.id || '';
  });
  if (agentId) {
    panel('open-agent', agentId);
    await sleep(1400);
    ok((await top(page)) === 'agent', 'mia panel open-agent');
  }
  panel('search', 'crystal');
  await sleep(1000);
  ok((await page.locator('[data-search] input').inputValue().catch(() => '')) === 'crystal', 'mia panel search opens Search pre-filled');
  await closeSheets(page);
  panel('show-doc', 'mandates-fresnaye');
  await sleep(1500);
  ok((await page.locator('[data-sheet="Shown by Mia"] [data-reader="viewer"]').count()) === 1, 'mia panel show-doc opens the viewer');
  panel('close');
  await sleep(900);
  ok((await page.locator('[data-sheet="Shown by Mia"]').count()) === 0, 'mia panel close closes it');

  // ---- settings: theme, motion, back to v1 --------------------------------------
  await page.evaluate(() => (location.hash = 'settings'));
  await sleep(900);
  await page.locator('[data-settings] [role="tab"]', { hasText: 'Light' }).first().click();
  await sleep(300);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'Settings: Light theme applies at once');
  await page.locator('[data-settings] [role="tab"]', { hasText: 'Dark' }).first().click();
  await sleep(300);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'Settings: Dark theme');

  // ---- offline → reconnect --------------------------------------------------------
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await until(() => page.locator('[data-conn]').count(), 25000, 'pill').then(
    () => ok(true, 'offline: the connection pill shows'),
    () => ok(false, 'offline: the connection pill shows'),
  );
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await page.locator('[data-conn]').count()) === 0, 20000, 'relink').then(
    () => ok(true, 'online again: it relinks by itself'),
    () => ok(false, 'online again: it relinks by itself'),
  );

  // ---- switch back to v1 ----------------------------------------------------------
  await page.locator('[data-ui-switch] [role="tab"]', { hasText: 'Classic' }).first().click();
  await page.waitForLoadState('load');
  await sleep(1800);
  ok((await page.locator('[data-dock], nav[aria-label="Dock"]').count()) > 0 || (await page.evaluate(() => !document.documentElement.classList.contains('v2'))), 'Settings › Classic switches this device to v1');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'mc_ui');
  ok(cookie?.value === 'v1', 'and remembers it (mc_ui=v1)');
  flush(page, 'phone/behaviour');
  await page.context().close();

  // ---- and from v1's Settings to v2 ----------------------------------------------
  const p1 = await newPage(browser, 'phone', { ui: 'v1', hash: '#settings' });
  await sleep(800);
  await p1.locator('[data-ui-switch="v2"]').first().click();
  await p1.waitForSelector('[data-tabbar]', { timeout: 15000 }).catch(() => {});
  ok(await p1.evaluate(() => document.documentElement.classList.contains('v2')), 'v1 Settings › Try it switches this device to v2');
  ok((await p1.context().cookies()).find((c) => c.name === 'mc_ui')?.value === 'v2', 'and remembers it (mc_ui=v2)');
  flush(p1, 'phone/v1→v2');
  await p1.context().close();

  // ---- cold start offline: the last picture -------------------------------------
  const p2 = await newPage(browser, 'phone');
  await sleep(1500);
  const cached = await p2.evaluate(() => localStorage.getItem('mc.v2.lastSeen'));
  ok(!!cached && JSON.parse(cached).agents?.length > 0, 'the last picture of the fleet is kept on the device');
  // The relay unreachable on a cold start: the socket and the HTTP fallback both fail.
  await p2.routeWebSocket(/\/ws/, (ws) => ws.close());
  await p2.route('**/api/v1/**', (r) => r.abort());
  await p2.reload();
  await sleep(2500);
  ok((await p2.locator('[data-conn]').count()) === 1, 'cold start, relay down: the connection pill says so');
  await p2.locator('[data-tab="agents"]').click();
  await sleep(700);
  ok((await p2.locator('[data-agent]').count()) > 0, 'cold start, relay down: the last picture of the fleet shows');
  await p2.context().close();

  // ---- reduced motion -----------------------------------------------------------
  const p3 = await newPage(browser, 'phone', { reduced: true });
  await p3.locator('[data-tab="library"]').click();
  await sleep(500);
  await libSearch(p3, 'Crystal');
  await p3.locator('[data-doc="crystal-retention.md"]').first().click();
  await sleep(500);
  const clip = await p3.evaluate(() => getComputedStyle(document.querySelector('[data-page="doc"][data-top="true"]')).clipPath);
  ok(clip === 'none' || clip === '', 'reduced motion: no zoom, a plain fade');
  flush(p3, 'phone/reduced');
  await p3.context().close();
}

async function perf(browser) {
  console.log('Performance');
  const ctx = await browser.newContext({ ...VIEWPORTS.phone, hasTouch: true });
  const page = await ctx.newPage();
  const bytes = { js: 0, css: 0 };
  page.on('response', async (r) => {
    const u = r.url();
    if (!/\/(assets|_next)\//.test(u)) return;
    const len = Number(r.headers()['content-length'] || 0) || (await r.body().catch(() => Buffer.alloc(0))).length;
    if (u.endsWith('.js')) bytes.js += len;
    if (u.endsWith('.css')) bytes.css += len;
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/?token=${TOKEN}&ui=v2`);
  await page.waitForSelector('[data-tabbar]');
  const ready = Date.now() - t0;
  console.log(`  first load: ${Math.round(bytes.js / 1024)} KB JS, ${Math.round(bytes.css / 1024)} KB CSS (decoded; test/v2-budget.mjs weighs the gzipped transfer), shell up in ${ready} ms`);
  // frame pacing during a push + pop
  await sleep(1500);
  await page.locator('[data-tab="library"]').click();
  await sleep(800);
  await libSearch(page, 'Raw incident');
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let n = 0;
        const tick = (t) => {
          deltas.push(t - last);
          last = t;
          if (++n < 90) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
        setTimeout(() => document.querySelector('[data-doc="raw-incident-hooks.md"]')?.click(), 50);
        setTimeout(() => document.querySelector('[data-page="doc"][data-top="true"] [data-back]')?.click(), 700);
      }),
  );
  const slow = frames.filter((d) => d > 34).length;
  console.log(`  push + pop: ${frames.length} frames, ${slow} over 34 ms, worst ${Math.round(Math.max(...frames))} ms (headless, indicative only)`);
  ok(slow <= 6, `push/pop animation stays smooth (${slow} long frames)`);
  await ctx.close();
}

// ---- Lens (task 0445) ------------------------------------------------------------
const lum = ([r, g, b]) => {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
async function lensChecks(browser) {
  console.log('Lens');
  // the scene, the glass, the time
  let page = await newPage(browser, 'ipad-land');
  await until(() => page.evaluate(() => document.documentElement.dataset.lensmode === 'gl' && document.querySelectorAll('.lens-live').length >= 3), 8000, 'lens').catch(() => {});
  const st = await page.evaluate(() => ({ mode: document.documentElement.dataset.lensmode, live: document.querySelectorAll('.lens-live').length, canvas: !!document.querySelector('.lens-canvas') }));
  ok(st.mode === 'gl' && st.canvas, `Lens: the WebGL scene runs (${st.mode})`);
  ok(st.live >= 3, `Lens: Home's panes are live glass (${st.live})`);
  await page.locator('[data-tab="agents"]').click();
  await sleep(900);
  const agentsLive = await page.evaluate(() => [...document.querySelectorAll('.lens-live')].filter((e) => e.closest('[data-page="agents"]')).length);
  ok(agentsLive >= 2, `Lens: other pages' cards are glass too (${agentsLive} on Agents)`);
  const menu = await page.evaluate(() => [...document.querySelectorAll('.v-bar, [role="dialog"] .v-card')].some((e) => e.classList.contains('lens-live')));
  ok(!menu, 'Lens: floating chrome is never shader glass (nothing scrolls under it)');
  flush(page, 'lens/ipad');
  await page.context().close();

  // legibility on every photo: what the GPU actually drew behind the text
  const files = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'app', 'public', 'bg', 'manifest.json'), 'utf8')).map((e) => e.file.replace('.jpg', ''));
  for (const theme of ['dark', 'light']) {
    const worst = { pane: theme === 'dark' ? 0 : 1, page: theme === 'dark' ? 0 : 1 };
    for (const bg of files) {
      process.env.BG = bg;
      page = await newPage(browser, 'ipad-land', { theme });
      await sleep(1200);
      // inside the greeting pane, in its padding (no text there)
      const pts = await page.evaluate(() => {
        const r = document.querySelector('[data-greeting]').getBoundingClientRect();
        return [[r.left + 10, r.top + 10], [r.right - 14, r.top + r.height / 2], [r.left + r.width / 2, r.bottom - 10]];
      });
      const pane = (await page.evaluate((p) => window.__v3gl?.sample(p), pts)) || [];
      // a content page: the open scene behind the title
      await page.locator('[data-tab="agents"]').click();
      await sleep(1600);
      const open = (await page.evaluate(() => window.__v3gl?.sample([[300, 60], [900, 120], [600, 400], [100, 700]]))) || [];
      for (const c of pane) worst.pane = theme === 'dark' ? Math.max(worst.pane, lum(c)) : Math.min(worst.pane, lum(c));
      for (const c of open) worst.page = theme === 'dark' ? Math.max(worst.page, lum(c)) : Math.min(worst.page, lum(c));
      flush(page, `lens/${theme}/${bg}`);
      await page.context().close();
    }
    delete process.env.BG;
    // the theme's three text tones, as the page defines them
    page = await newPage(browser, 'phone', { theme });
    const inks = await page.evaluate(() => ['--color-ink', '--color-ink2', '--color-ink3'].map((v) => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue(v).trim().replace('#', '');
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    }));
    await page.context().close();
    console.log(`  ${theme}: worst luminance behind text — glass ${worst.pane.toFixed(3)}, open scene ${worst.page.toFixed(3)} (over ${files.length} photos)`);
    for (const [k, need, name] of [[0, 4.5, 'primary'], [1, 4.5, 'secondary'], [2, 3, 'tertiary (meta labels)']]) {
      const l = lum(inks[k]);
      const rp = ratio(l, worst.pane);
      const rg = ratio(l, worst.page);
      ok(rp >= need && rg >= need, `Lens ${theme}: ${name} text ≥ ${need}:1 on every photo — glass ${rp.toFixed(1)}:1, page ${rg.toFixed(1)}:1`);
    }
  }

  // lite glass: reduced motion → no shader, no backdrop blur, still designed
  page = await newPage(browser, 'phone', { reduced: true });
  await sleep(1200);
  const lite = await page.evaluate(() => ({ glass: document.documentElement.dataset.glass, mode: document.documentElement.dataset.lensmode, canvas: !!document.querySelector('.lens-canvas'), photo: !!document.querySelector('.lens-lite-photo'), blur: getComputedStyle(document.querySelector('.v-bar')).backdropFilter }));
  ok(lite.glass === 'lite' && lite.mode === 'css' && !lite.canvas, `Lens: reduced motion → lite glass, no shader (${JSON.stringify(lite)})`);
  ok(lite.blur === 'none' || lite.blur === '', 'Lens lite: no backdrop blur anywhere (the cheapest glass)');
  flush(page, 'lens/lite');
  await page.context().close();

  // Settings: glass quality and the backdrop
  page = await newPage(browser, 'phone', { hash: '#settings' });
  await sleep(900);
  await page.locator('[data-glass-pref] button', { hasText: 'Lite' }).click();
  await sleep(500);
  ok((await page.evaluate(() => document.documentElement.dataset.glass)) === 'lite', 'Settings › Glass › Lite switches to lite glass');
  await page.locator('[data-glass-pref] button', { hasText: 'Auto' }).click();
  await page.locator('[data-backdrop="05.jpg"]').click();
  await sleep(400);
  const pick = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.backdrop') || '{}'));
  ok(pick.file === '05.jpg', 'Settings › Backdrop pins a photo (shared with v1: mc.backdrop)');
  await page.locator('[data-backdrop="auto"]').click();
  await sleep(300);
  ok(!JSON.parse(await page.evaluate(() => localStorage.getItem('mc.backdrop') || '{}')).file, 'Settings › Backdrop › Auto follows the time of day again');
  flush(page, 'lens/settings');
  await page.context().close();
}

async function recordTransitions(browser, tag = 'phone') {
  console.log(`Recording the key transitions (${tag})`);
  const vid = path.join(SHOTS, 'video');
  const frames = path.join(SHOTS, tag === 'phone' ? 'frames' : `frames-${tag}`);
  fs.mkdirSync(vid, { recursive: true });
  fs.mkdirSync(frames, { recursive: true });
  const page = await newPage(browser, tag, { video: vid });
  const W = VIEWPORTS[tag].viewport.width;
  const H = VIEWPORTS[tag].viewport.height;
  let i = 0;
  const burst = async (label, n = 8, gap = 45) => {
    for (let k = 0; k < n; k++) {
      await page.screenshot({ path: path.join(frames, `${String(++i).padStart(3, '0')}-${label}.png`) });
      await sleep(gap);
    }
  };
  await burst('home', 2, 200);
  await page.locator('[data-tile="tile-insights"]').click();
  await burst('zoom-into-insights');
  await sleep(600);
  await page.locator('[data-page="insights"][data-top="true"] [data-back]').first().click();
  await burst('zoom-back');
  await page.locator('[data-tab="library"]').click();
  await burst('tab-library', 5);
  await libSearch(page, 'Raw incident');
  await page.locator('[data-doc="raw-incident-hooks.md"]').first().click();
  await burst('doc-grows-from-row');
  await sleep(500);
  await page.mouse.move(6, H / 2);
  await page.mouse.down();
  for (let x = 6; x <= W * 0.85; x += 18) {
    await page.mouse.move(x, H / 2 + 2);
    if (x % 54 === 6) await page.screenshot({ path: path.join(frames, `${String(++i).padStart(3, '0')}-swipe-back.png`) });
    await sleep(16);
  }
  await page.mouse.up();
  await burst('swipe-release', 5);
  await page.locator('[data-tab="mia"]').click();
  await sleep(600);
  await page.locator('[data-attach-button]').first().click();
  await burst('sheet-up', 6);
  await closeSheets(page);
  await page.locator('[data-tab="home"]').click();
  await sleep(500);
  const path0 = await page.video()?.path();
  await page.context().close();
  if (path0) {
    const dest = path.join(SHOTS, `transitions-${tag}.webm`);
    fs.renameSync(path0, dest);
    console.log(`  🎞  ${dest}`);
  }
  fs.rmSync(vid, { recursive: true, force: true });
  console.log(`  🖼  ${i} frames in ${frames}`);
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
    console.log(`Rig up: ${BASE}/?token=${TOKEN}&ui=v2  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }

  await servingChecks();
  // the real GPU (Metal), so Lens's shader runs as it would on a device
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : Object.keys(VIEWPORTS);
  if (!process.env.SKIP_SHOTS) {
    for (const tag of only) {
      console.log(`Screens: ${tag}`);
      await screenshots(browser, tag);
    }
  }
  if (!process.env.SKIP_BEHAVIOUR) await behaviour(browser);
  await perf(browser);
  if (!process.env.SKIP_LENS) await lensChecks(browser);
  if (!process.env.SKIP_VIDEO) {
    await recordTransitions(browser, 'phone');
    await recordTransitions(browser, 'ipad-land');
  }
  await browser.close();

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
