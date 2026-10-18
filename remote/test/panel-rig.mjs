// A demo rig for screenshots (task 0290): the real relay, the fake host as the
// Mac (temp Library, Mia questions old and new), a seeded Jarvis registry, the
// real Channels HQ sync when ~/channels-hq is there, and the built panel in
// headless Chromium. It only takes pictures — the assertions live in the
// *-e2e suites.
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> SHOTS=<dir> node test/panel-rig.mjs
//   KEEP=1 leaves the rig running (prints the URL) until Ctrl-C.

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
const HQ = process.env.CHANNELS_HQ || path.join(os.homedir(), 'channels-hq');
const PORT = Number(process.env.RIG_PORT || 8881);
const TOKEN = 'test';
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rig-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const SHOTS = process.env.SHOTS || path.join(TMP, 'shots');
const PREFIX = process.env.PREFIX || '';
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(MIA_DIR, { recursive: true });

const ENV = {
  MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR, FAKE_HOST_LIBRARY: LIB, FAKE_HOST_PAGE_KIND: '1',
  JARVIS_STORE: path.join(TMP, 'j.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'),
  CHANNELS_STORE: path.join(TMP, 'channels.json'), CHANNELS_MEDIA: path.join(TMP, 'media'), USAGE_STORE: path.join(TMP, 'usage.json'),
  DOC_ASSETS: path.join(TMP, 'da'), DOC_PAGES: path.join(TMP, 'dp'), OPENAI_API_KEY: '', RAILWAY_VOLUME_MOUNT_PATH: '',
  MC_LIBRARY: LIB, MC_RELAY_URL: BASE, MC_DOC_NO_DEFAULTS: '1',
};
const procs = [];
function boot(cmd, args, name, env = {}, cwd = path.join(DIR, '..')) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}
const run = (args) => new Promise((resolve) => {
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
    await sleep(150);
  }
}
const isoAgo = (min) => new Date(Date.now() - min * 60e3).toISOString();

function writeLibrary() {
  fs.mkdirSync(LIB, { recursive: true });
  const doc = (name, front, body) => fs.writeFileSync(path.join(LIB, `${name}.md`), `---\n${front}\n---\n${body}\n`);
  const para = 'The short version: the opening seconds decide everything. Viewers who stay past the first tense moment watch to the end, and the ones who leave do so before any narration starts. That argues for letting the footage breathe and explaining afterwards.';
  doc('raw-incident-hooks', 'kind: research\nstatus: done\nsubject: Bodycam channel\ntags: youtube, research\ncompany: video\ncreated: 2026-10-10T10:00:00Z',
    `# Raw Incident: what makes bodycam videos work\n\n**Answer:** Let the footage breathe, explain after, and open on the most tense second.\n\n## What the numbers say\n\n${para}\n\n${para}\n\n| Video | 24h views | Retention |\n|---|---|---|\n| Phoenix stop | 18,400 | 61% |\n| Kern pursuit | 9,100 | 48% |\n| LAPD standoff | 6,800 | 44% |\n\n## What to change\n\n- Cut the intro card entirely.\n- Open on the moment the officer reaches the window.\n- Narration only between beats, never over them.\n\n${para}\n\n## Sources\n\n${para}`);
  doc('crystal-retention', 'kind: plan\nstatus: active\nsubject: Crystal Garden\ntags: roblox\ncreated: 2026-10-11T10:00:00Z', '# Crystal Garden: come back tomorrow\n\nA plan to lift day-1 retention from 18% to 25% with a daily harvest and a streak.');
  doc('mandates-fresnaye', 'kind: research\nstatus: done\nsubject: Oblivion\ntags: mandate\ncreated: 2026-10-09T10:00:00Z', '# Mandate targets in Fresnaye\n\n**In one line:** Nine homes over R10m look ready to sell; three have owners who bought before 2010.');
  doc('lunch-ideas', 'kind: note\nstatus: draft\ncreated: 2026-10-08T10:00:00Z', '# Lunch ideas\n\nSomething unrelated to any company at all, just a note.');
}

function writeMia() {
  // Mia's thread: questions from 10 minutes, 3 hours and 2 days ago.
  const lines = [
    { id: 'r_1', at: isoAgo(2 * 24 * 60), from: 'mia', kind: 'question', text: 'Keep the old Kern thumbnail or test the new one?', options: ['Keep', 'Test new'], questionId: 'q_old2d' },
    { id: 'r_2', at: isoAgo(180), from: 'mia', kind: 'question', text: 'Should the Fresnaye dossier include the 2009 sales?', options: ['Yes', 'No'], questionId: 'q_old3h' },
    { id: 'r_3', at: isoAgo(25), from: 'mia', kind: 'chat', text: 'Tempe long-form is live. 1,240 views in the first hour, retention 58% at 30s — best opening of the week.' },
    { id: 'r_4', at: isoAgo(12), from: 'mia', kind: 'question', text: 'Publish the Phoenix Short now or hold it for the 18:00 slot?', options: ['Now', '18:00'], questionId: 'q_new12' },
  ];
  fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), '');
  return () => fs.appendFileSync(path.join(MIA_DIR, 'messages.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function seedJarvis() {
  fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [], reminders: [] }));
  const r = await run(['jarvis', 'seed']);
  if (r.status !== 0) console.error('jarvis seed:', r.out);
  const REG = path.join(MIA_DIR, 'jarvis', 'registry.json');
  const R = JSON.parse(fs.readFileSync(REG, 'utf8'));
  for (const p of R.projects) { p.probes = []; if (p.healthcheck) p.healthcheck = null; }
  fs.writeFileSync(REG, JSON.stringify(R, null, 2));
  await run(['jarvis', 'upgrade']);
  const s = await run(['jarvis', 'sync']);
  if (s.status !== 0) console.error('jarvis sync:', s.out);
}

// Claude usage the way the Mac pushes it (task 0290); an older relay just 404s.
async function seedUsage() {
  const body = {
    source: 'rig', at: new Date().toISOString(),
    windows: [
      { key: 'session', label: 'Session (5h)', pct: 83, resetsAt: new Date(Date.now() + 96 * 60e3).toISOString() },
      { key: 'weekly', label: 'Week', pct: 41, active: true, resetsAt: new Date(Date.now() + 3.2 * 24 * 3600e3).toISOString() },
    ],
  };
  await fetch(`${BASE}/api/v1/usage`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: Number(process.env.DPR || 1) });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (202|404)/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  await page.route('**/tts', (r) => r.fulfill({ status: 204, body: '' }));
  await page.goto(`${BASE}/?token=${TOKEN}`);
  await page.waitForSelector('[aria-label="Live"]', { timeout: 15000, state: 'attached' });
  await sleep(1200);
  return page;
}
async function calm(page) {
  const b = page.getByRole('button', { name: 'Minimise Mia' });
  if (await b.count()) await b.first().click().catch(() => {});
  await sleep(300);
}
const waitImages = (page) => page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))));
async function go(page, hash, wait = 1300) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(wait);
  await calm(page);
}
const shot = async (page, name) => { await waitImages(page); await sleep(400); await page.screenshot({ path: path.join(SHOTS, `${PREFIX}${name}.png`) }); console.log(`  📷 ${PREFIX}${name}.png`); };

async function main() {
  writeLibrary();
  const postMia = writeMia();
  boot('node', ['server.js'], 'relay');
  await until(async () => (await fetch(`${BASE}/health`)).ok, 8000, 'relay');
  boot('node', ['test/fake-host.mjs'], 'host');
  await until(async () => (await (await fetch(`${BASE}/health`)).json()).host, 8000, 'host');
  await sleep(500);
  postMia();
  await seedJarvis();
  await seedUsage();
  if (fs.existsSync(path.join(HQ, '.venv', 'bin', 'python'))) {
    const HQDATA = path.join(TMP, 'hqdata');
    fs.mkdirSync(HQDATA, { recursive: true });
    if (fs.existsSync(path.join(HQ, 'data', 'stats.jsonl'))) fs.copyFileSync(path.join(HQ, 'data', 'stats.jsonl'), path.join(HQDATA, 'stats.jsonl'));
    boot(path.join(HQ, '.venv', 'bin', 'python'), ['-m', 'hq.server'], 'channels-hq', {
      HQ_PORT: String(PORT + 1), HQ_NO_STATS: '1', HQ_RELAY_SYNC: '1', HQ_ACTIONS: path.join(TMP, 'actions.jsonl'), HQ_NO_MIA: '1', HQ_DATA: HQDATA,
    }, HQ);
    await until(async () => (await (await fetch(`${BASE}/api/v1/channels`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).state?.channels?.length, 60000, 'channels').catch(() => console.error('channels state never arrived'));
  }
  if (process.env.KEEP) {
    console.log(`Rig up: ${BASE}/?token=${TOKEN}  (Ctrl-C to stop)`);
    await new Promise(() => {});
  }

  const browser = await chromium.launch();
  const sizes = [['ipad-land', { width: 1180, height: 820 }], ['ipad-port', { width: 820, height: 1180 }], ['phone', { width: 390, height: 844 }]];
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const errors = [];
  for (const [tag, vp] of sizes) {
    console.log(tag);
    const page = await newPage(browser, vp);
    const want = (n) => !only || only.includes(n);
    if (want('home')) { await go(page, '', 1500); await shot(page, `${tag}-home`); }
    if (want('mia')) { await go(page, 'mia'); await shot(page, `${tag}-mia-chat`); }
    if (want('hq')) { await go(page, 'hq', 1800); await shot(page, `${tag}-hq`); }
    if (want('channels')) { await go(page, 'channels', 2200); await shot(page, `${tag}-hq-channels`); }
    if (want('fleet')) { await go(page, 'fleet'); await shot(page, `${tag}-fleet`); }
    if (want('library')) { await go(page, 'library'); await shot(page, `${tag}-library`); }
    if (want('report')) { await go(page, 'doc/raw-incident-hooks.md', 1800); await shot(page, `${tag}-library-report`); }
    if (want('attach') && process.env.ATTACH) {
      // The chat's clip → Reports → pick one → the chip in the composer.
      await go(page, 'mia');
      const clip = page.locator('[data-attach-button]');
      if (await clip.count()) {
        await clip.first().click();
        await sleep(600);
        await shot(page, `${tag}-attach-1-menu`);
        await page.locator('[data-attach-pick="raw-incident-hooks.md"]').first().click();
        await sleep(600);
        await shot(page, `${tag}-attach-2-chip`);
      }
      // From a report: "Ask Mia about this" → the chat with the doc attached.
      await go(page, 'doc/raw-incident-hooks.md', 1500);
      const ask = page.locator('[data-doc-to-mia]');
      if (await ask.count()) {
        await ask.first().click();
        await sleep(1200);
        await calm(page);
        await shot(page, `${tag}-attach-3-from-report`);
      }
    }
    errors.push(...page.errors.map((e) => `${tag}: ${e}`));
    await page.context().close();
  }
  await browser.close();
  if (errors.length) console.log('Console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
  else console.log('No console errors.');
}

const cleanup = () => {
  for (const p of procs) try { p.kill(); } catch {}
  if (!process.env.KEEP_TMP) setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 300);
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
main().then(() => { cleanup(); setTimeout(() => process.exit(0), 500); }, (e) => { console.error(e); cleanup(); setTimeout(() => process.exit(1), 500); });
