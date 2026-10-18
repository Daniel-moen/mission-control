// Model routing + company tagging in the CLIs (task 0204), against a temp
// MIA_DIR and a temp library — nothing touches ~/.mission-control or a relay:
//   mia dispatch --tier/--kind/--model, routing.json, mia routing, mia verify,
//   mia task add/set --company (Jarvis registry ids), mc-doc --company.
//   node test/routing-cli-test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-routing-cli-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const ENV = { ...process.env, MIA_DIR, MC_LIBRARY: LIB, MC_DOC_NO_DEFAULTS: '1', MC_RELAY_URL: '', MC_TOKEN: '' };
const run = (script, args, input) => {
  const r = spawnSync('bash', [path.join(REPO, 'scripts', script), ...args], { env: ENV, input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};
const mia = (...args) => run('mia', args);
const mcdoc = (...args) => run('mc-doc', args);
const task = (id) => JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'tasks', `${id}.json`), 'utf8'));
const req = (id) => JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'dispatch', `${id}.json`), 'utf8'));
const add = (title, ...extra) => mia('task', 'add', title, '--dir', WORK, ...extra).stdout.trim();
const dispatch = (id, ...flags) => run('mia', ['dispatch', id, '--stdin', ...flags], 'Do the thing.\n');
const ROUTING = path.join(MIA_DIR, 'routing.json');

try {
  console.log('mia dispatch routing');
  let id = add('No routing');
  let r = dispatch(id);
  ok(r.status === 0, 'plain dispatch works');
  let q = req(id);
  ok(q.model === null && !('tier' in q) && !('kind' in q), 'no flags: model null, no tier/kind keys');
  ok(!('routing' in task(id)) && task(id).log.at(-1).text === `Dispatch requested in ${WORK}`, 'no flags: no routing on the task, log line unchanged');

  const cases = [
    [['--tier', 'cheap'], 'cheap', null, 'claude-haiku-5-5'],
    [['--tier', 'mid'], 'mid', null, 'claude-sonnet-5-5'],
    [['--tier', 'smart'], 'smart', null, 'claude-opus-5-5'],
    [['--kind', 'scout'], 'cheap', 'scout', 'claude-haiku-5-5'],
    [['--kind', 'health'], 'cheap', 'health', 'claude-haiku-5-5'],
    [['--kind', 'research'], 'mid', 'research', 'claude-sonnet-5-5'],
    [['--kind', 'refresh'], 'mid', 'refresh', 'claude-sonnet-5-5'],
    [['--kind', 'build'], 'smart', 'build', 'claude-opus-5-5'],
    [['--kind', 'review'], 'smart', 'review', 'claude-opus-5-5'],
    [['--kind', 'scout', '--tier', 'smart'], 'smart', 'scout', 'claude-opus-5-5'],
    [['--tier', 'cheap', '--model', 'my-model'], 'cheap', null, 'my-model'],
    [['--kind', 'build', '--model', 'my-model'], 'smart', 'build', 'my-model'],
  ];
  for (const [flags, tier, kind, model] of cases) {
    id = add(`Route ${flags.join(' ')}`);
    r = dispatch(id, ...flags);
    q = req(id);
    ok(r.status === 0 && q.model === model && q.tier === tier && q.kind === kind, `${flags.join(' ')} → ${tier} · ${model}`);
  }
  id = add('Model only');
  dispatch(id, '--model', 'claude-x');
  q = req(id);
  ok(q.model === 'claude-x' && !('tier' in q) && !('routing' in task(id)), '--model alone: as before');

  id = add('Routing recorded');
  dispatch(id, '--kind', 'triage');
  let t = task(id);
  ok(JSON.stringify(t.routing) === JSON.stringify({ tier: 'cheap', kind: 'triage', model: 'claude-haiku-5-5', verify: 'smart' }), 'cheap: routing recorded with verify=smart');
  ok(t.log.at(-1).text === `Dispatch requested in ${WORK} (cheap · claude-haiku-5-5)`, 'log line names tier · model');
  id = add('Smart recorded');
  dispatch(id, '--tier', 'smart');
  ok(task(id).routing.verify === null, 'smart: verify null');

  id = add('Bad flags');
  r = dispatch(id, '--tier', 'genius');
  ok(r.status !== 0 && /unknown tier: genius/.test(r.stderr) && /cheap, mid, smart/.test(r.stderr), 'unknown tier dies with the list');
  r = dispatch(id, '--kind', 'dance');
  ok(r.status !== 0 && /unknown kind: dance/.test(r.stderr) && /scout/.test(r.stderr) && /verify/.test(r.stderr), 'unknown kind dies with the list');
  ok(!fs.existsSync(path.join(MIA_DIR, 'dispatch', `${id}.json`)), 'nothing dispatched on error');

  console.log('routing.json + mia routing');
  r = mia('routing');
  ok(r.status === 0 && r.stdout.includes('tier cheap\tclaude-haiku-5-5') && r.stdout.includes('kind scout\tcheap') && r.stdout.includes('kind build\tsmart'), 'mia routing prints the defaults');
  ok(r.stdout.trim().split('\n').length === 3 + 18, 'one line per tier and kind (heartbeat + inbox added in 0292)');
  fs.writeFileSync(ROUTING, JSON.stringify({ tiers: { cheap: 'claude-tiny', mid: 'claude-middle' }, kinds: { scout: 'mid', poem: 'smart', bogus: 'huge' } }));
  r = mia('routing');
  ok(r.stdout.includes('tier cheap\tclaude-tiny') && r.stdout.includes('tier smart\tclaude-opus-5-5') && r.stdout.includes('kind scout\tmid') && r.stdout.includes('kind poem\tsmart') && !r.stdout.includes('bogus'), 'overrides merged over defaults');
  ok(/bogus/.test(r.stderr), 'bad kind mapping warned about');
  id = add('Override');
  dispatch(id, '--kind', 'scout');
  q = req(id);
  ok(q.tier === 'mid' && q.model === 'claude-middle', 'override: scout → mid → claude-middle');
  id = add('Override 2');
  dispatch(id, '--kind', 'poem');
  ok(req(id).model === 'claude-opus-5-5', 'new kind from routing.json works');
  fs.writeFileSync(ROUTING, '{ not json');
  id = add('Malformed');
  r = dispatch(id, '--tier', 'cheap');
  ok(r.status === 0 && req(id).model === 'claude-haiku-5-5' && /warning/.test(r.stderr) && /malformed/.test(r.stderr), 'malformed routing.json: warning + defaults');
  r = dispatch(add('Malformed plain'));
  ok(r.status === 0 && r.stderr === '', 'plain dispatch never reads routing.json');
  fs.rmSync(ROUTING);

  console.log('mia verify');
  const orig = add('Ship the widget');
  dispatch(orig, '--kind', 'scout');
  r = mia('verify', orig);
  const vid = r.stdout.trim();
  ok(r.status === 0 && /^\d{4}$/.test(vid) && vid !== orig, `verify prints the new id (${vid})`);
  const vt = task(vid);
  ok(vt.title === `Verify ${orig}: Ship the widget` && vt.detail.includes(orig) && vt.dir === WORK, 'new task title/detail/dir');
  ok(vt.verifies === orig && task(orig).routing.verifiedBy === vid, 'verifies / verifiedBy links');
  ok(task(orig).routing.tier === 'cheap', "original's routing kept");
  q = req(vid);
  ok(q.tier === 'smart' && q.kind === 'verify' && q.model === 'claude-opus-5-5' && q.dir === WORK, 'dispatched on the smart tier');
  const brief = fs.readFileSync(q.brief, 'utf8');
  ok(brief.includes(path.join(MIA_DIR, 'briefs', `${orig}.report.md`)) && brief.includes(path.join(MIA_DIR, 'briefs', `${vid}.report.md`)), 'brief names both report paths');
  ok(brief.includes(`mia task note ${orig} "VERIFIED: PASS`) && /never redo/i.test(brief) && /git log/.test(brief) && /tests/.test(brief), 'brief: verdict note, git check, tests, no redo');
  ok(vt.routing.tier === 'smart' && vt.routing.verify === null, 'verify task has smart routing');
  r = mia('verify', orig, '--tier', 'mid');
  ok(r.status === 0 && req(r.stdout.trim()).model === 'claude-sonnet-5-5', 'verify --tier mid');
  ok(task(orig).routing.verifiedBy === r.stdout.trim(), 'verifiedBy points at the latest check');
  const nodir = mia('task', 'add', 'No folder').stdout.trim();
  r = mia('verify', nodir);
  ok(r.status !== 0 && /no folder/.test(r.stderr), 'verify of a task without a folder dies');
  const other = fs.mkdtempSync(path.join(TMP, 'other-'));
  r = mia('verify', nodir, '--dir', other);
  ok(r.status === 0 && req(r.stdout.trim()).dir === other, 'verify --dir');
  ok(mia('verify', '9999').status !== 0, 'verify of a missing task dies');

  console.log('task --company');
  id = add('Before registry', '--company', 'whatever');
  ok(task(id).company === 'whatever' && !('project' in task(id)), 'no registry: stored as given');
  fs.mkdirSync(path.join(MIA_DIR, 'jarvis'), { recursive: true });
  fs.writeFileSync(path.join(MIA_DIR, 'jarvis', 'registry.json'), JSON.stringify({
    companies: [{ id: 'klear', name: 'Klear' }, { id: 'games', name: 'Games' }],
    projects: [{ id: 'houston', name: 'Houston', company: 'klear', match: { dirs: [], keywords: [] } },
      { id: 'crystal-garden', name: 'Crystal Garden', company: 'games', match: {} }],
  }));
  id = add('Company id', '--company', 'klear');
  ok(task(id).company === 'klear' && !('project' in task(id)), 'company id');
  id = add('Project id', '--company', 'crystal-garden');
  ok(task(id).company === 'games' && task(id).project === 'crystal-garden', 'project id → company + project');
  r = mia('task', 'add', 'Nope', '--company', 'acme');
  ok(r.status !== 0 && /unknown company or project: acme/.test(r.stderr) && /klear/.test(r.stderr) && /houston/.test(r.stderr), 'invalid id dies listing valid ids');
  ok(!mia('task', 'list').stdout.includes('Nope'), 'no task created on error');
  const list = mia('task', 'list').stdout.trim().split('\n');
  ok(list.every((l) => l.split('\t').length === 4), 'task list output unchanged');
  r = mia('task', 'set', id, 'company', 'houston');
  ok(r.status === 0 && task(id).company === 'klear' && task(id).project === 'houston', 'task set company <project>');
  r = mia('task', 'set', id, 'company', 'games');
  ok(task(id).company === 'games' && !('project' in task(id)), 'task set company <company> clears project');
  ok(mia('task', 'set', id, 'company', 'acme').status !== 0 && task(id).company === 'games', 'task set invalid company dies, task unchanged');
  r = mia('task', 'set', id, 'company', '');
  ok(r.status === 0 && !('company' in task(id)) && !('project' in task(id)), 'task set company "" clears both');
  mia('task', 'set', id, 'company', 'klear');
  r = mia('task', 'set', id, 'company');
  ok(r.status === 0 && !('company' in task(id)), 'task set company (no value) clears');
  r = mia('verify', add('Tagged', '--company', 'houston'));
  ok(task(r.stdout.trim()).project === 'houston', 'verify task inherits company/project');

  console.log('mia help');
  r = mia('help');
  ok(/--tier cheap\|mid\|smart/.test(r.stdout) && /mia verify <id>/.test(r.stdout) && /mia routing/.test(r.stdout) && /--company/.test(r.stdout), 'help mentions tier/verify/routing/company');

  console.log('mc-doc --company');
  r = mcdoc('new', '--kind', 'research', '--title', 'Acme pricing', '--subject', 'Acme', '--tags', 'a,b', '--company', 'klear');
  const docPath = r.stdout.trim();
  let raw = fs.readFileSync(docPath, 'utf8');
  ok(r.status === 0 && /^---\nkind: research\nstatus: draft\nsubject: Acme\ntags: a, b\ncompany: klear\ncreated: \S+\n---\n# Acme pricing\n/.test(raw), 'new --company: frontmatter line after tags, before created');
  r = mcdoc('new', '--kind', 'note', '--title', 'Plain');
  ok(!/company:/.test(fs.readFileSync(r.stdout.trim(), 'utf8')), 'no --company: no company line');
  const docId = path.basename(docPath);
  r = mcdoc('set', docId, 'company', 'games');
  raw = fs.readFileSync(docPath, 'utf8');
  ok(r.status === 0 && raw.includes('\ncompany: games\n') && !raw.includes('klear') && raw.includes('subject: Acme'), 'set company replaces it');
  r = mcdoc('set', docId, 'status', 'done');
  ok(fs.readFileSync(docPath, 'utf8').includes('\ncompany: games\n'), 'other set keeps company');
  r = mcdoc('set', docId, 'company', '');
  raw = fs.readFileSync(docPath, 'utf8');
  ok(r.status === 0 && !/company:/.test(raw) && raw.includes('status: done'), 'set company "" clears it');
  ok(mcdoc('set', docId, 'colour', 'x').status !== 0, 'unknown key still refused');
  ok(/--company <id>/.test(mcdoc('help').stdout), 'mc-doc help mentions --company');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
