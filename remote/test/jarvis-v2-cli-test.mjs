// `mia jarvis` v2 (task 0204): company actions, the Library filed by company,
// knowledge with sources (redacted), company-tagged tasks, and the 'action'
// control from HQ → relay → `mia jarvis sync` → findings.jsonl. Temp MIA_DIR
// + MC_LIBRARY and a real relay (node server.js).
//   node test/jarvis-v2-cli-test.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jarvis-v2-'));
const MIA_DIR = path.join(TMP, 'mia');
const LIB = path.join(TMP, 'library');
const PORT = 8881;
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const baseEnv = { ...process.env, MC_LIBRARY: LIB, MC_RELAY_URL: `http://localhost:${PORT}`, MC_TOKEN: 'test', MC_DOC_NO_DEFAULTS: '1' };
const run = (args, miaDir = MIA_DIR, extra = {}) =>
  new Promise((resolve) => {
    const p = spawn('bash', [path.join(REPO, 'scripts', 'mia'), ...args], { env: { ...baseEnv, MIA_DIR: miaDir, ...extra } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const mia = (...args) => run(['jarvis', ...args]);
const regPath = (d = MIA_DIR) => path.join(d, 'jarvis', 'registry.json');
const reg = (d) => JSON.parse(fs.readFileSync(regPath(d), 'utf8'));
const writeReg = (r, d) => fs.writeFileSync(regPath(d), JSON.stringify(r, null, 2));
const findings = () => {
  try { return fs.readFileSync(path.join(MIA_DIR, 'jarvis', 'findings.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
// No internet in tests: no health checks, no probes.
const quiet = (r) => {
  for (const p of r.projects) { p.healthcheck = null; p.probes = []; }
  r.jarvis.lastHealthAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  r.jarvis.healthEveryMinutes = 100000;
  return r;
};
const V2_COMPANY = ['actions', 'memory', 'keywords'];
const V2_TOP = ['library', 'libraryOverrides', 'sharedMemory'];
const strip = (r) => {
  for (const c of r.companies) for (const k of V2_COMPANY) delete c[k];
  for (const k of V2_TOP) delete r[k];
  return r;
};

// ---- fixtures: Library docs + memory ------------------------------------------
fs.mkdirSync(LIB, { recursive: true });
const doc = (id, front, body) => fs.writeFileSync(path.join(LIB, `${id}.md`), `---\n${front}\n---\n${body}\n`);
doc('games-roadmap', 'kind: plan\nstatus: draft\ncompany: games', '# Studio roadmap Q4\n\nWe ship one update a fortnight and keep the backlog short for every title.');
doc('cg-notes', 'kind: notes\ndir: ~/CrystalGarden/docs', '# Pet balance notes\n\nRare drop rates feel too generous after the latest event weekend update.');
doc('mandate-review', 'kind: report\nsubject: mandate review\ntags: q4, pipeline', '# Mandate review\n\nThree sole mandates expired this month and two renewals are still pending.');
doc('dry-check', 'kind: research\nstatus: final', '# Dry-ager market check\n\n**Answer:** The dry-ager sells best to steakhouses in Gauteng, then butcheries.\n\n## Detail\n\nLong body text that should never be picked as the summary of this document.');
doc('sourdough', 'kind: note\ntags: bread', '# Sourdough baking notes\n\nFeed the starter twice a day and bake at two hundred and thirty degrees.');
fs.mkdirSync(path.join(MIA_DIR, 'memory'), { recursive: true });
fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
fs.writeFileSync(path.join(MIA_DIR, 'memory', 'oblivion.md'), [
  '# Oblivion', '', '## Contacts',
  '- Pieter handles mandates, reach him at pieter@example.com',
  '- Agent cell is +27 82 555 1234 for after-hours calls',
  '- Dashboard password: hunter2 (rotate monthly)',
  '- SSH into root@1.2.3.4 to restart the crawler',
  '- The VPS sits at 209.159.148.182 behind Caddy',
  '', '## Focus',
  '- Mandates over R10m in Fresnaye are the focus this quarter',
  '- short', '',
].join('\n'));
fs.writeFileSync(path.join(MIA_DIR, 'memory', 'other-projects.md'), '# Other\n- Dry-ager panel leads go stale after a week without follow-up\n- Something entirely unrelated to any business here\n');
fs.writeFileSync(path.join(MIA_DIR, 'schedule.json'), JSON.stringify({ heartbeats: [], reminders: [] }));
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const task = (id, extra) => fs.writeFileSync(path.join(MIA_DIR, 'tasks', `${id}.json`), JSON.stringify({ id, status: 'running', dir: '/tmp', createdAt: now, updatedAt: now, ...extra }));
task('0600', { title: 'Generic chore', company: 'games' });
task('0601', { title: 'Penny chat fix', company: 'games' });
task('0602', { title: 'Something', project: 'crystal-garden' });
task('0603', { title: 'Penny tone tweaks' });
task('0604', { title: 'Penny follow-up', company: 'nope' });
task('0605', { title: 'Nothing matches this one' });

const relay = spawn('node', ['server.js'], {
  cwd: path.join(DIR, '..'),
  env: { ...process.env, MC_TOKEN: 'test', PORT: String(PORT), JARVIS_STORE: path.join(TMP, 'relay-jarvis.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
  stdio: 'ignore',
});
const HDR = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
const api = async (p, opts = {}) => {
  const res = await fetch(`http://localhost:${PORT}/api/v1${p}`, { headers: HDR, ...opts });
  return { status: res.status, body: await res.json() };
};
const control = (b) => api('/jarvis/control', { method: 'POST', body: JSON.stringify(b) });

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/health`); break; } catch { await sleep(100); }
  }

  console.log('seed + upgrade');
  let r = await mia('seed');
  ok(r.status === 0, 'seed');
  const R0 = reg();
  ok(R0.companies.every((c) => Array.isArray(c.actions) && c.actions.some((a) => a.id === 'scout') && Array.isArray(c.memory) && Array.isArray(c.keywords)), 'seed already has v2 company keys (scout on every company)');
  writeReg(quiet(strip(R0)));
  ok(!('actions' in reg().companies[0]) && !('library' in reg()), 'registry stripped back to v1 shape');
  r = await mia('upgrade');
  ok(r.status === 0 && /registry upgraded: 8 companies with actions, 4\/5 Library docs filed/.test(r.stdout), `upgrade summary (${r.stdout.trim()})`);
  const R1 = reg();
  ok(R1.companies.every((c) => c.actions.some((a) => a.id === 'scout' && a.tier === 'cheap')), 'every company gets a Scout now action');
  const video = R1.companies.find((c) => c.id === 'video');
  ok(video.actions.some((a) => a.id === 'new-video' && a.project === 'bodycam' && a.inputs[0].name === 'topic'), 'seeded video actions');
  ok(R1.companies.find((c) => c.id === 'oblivion').memory.includes('oblivion.md') && R1.companies.find((c) => c.id === 'oblivion').keywords.includes('mandate'), 'memory map + company keywords');
  ok(JSON.stringify(R1.sharedMemory) === '["other-projects.md"]' && typeof R1.libraryOverrides === 'object', 'sharedMemory + libraryOverrides');
  ok(Object.keys(R1.library).length === 5, 'library filed into the registry');
  // upgrade never overwrites what Mia changed
  R1.companies.find((c) => c.id === 'games').keywords = ['custom'];
  writeReg(R1);
  await mia('upgrade');
  ok(JSON.stringify(reg().companies.find((c) => c.id === 'games').keywords) === '["custom"]', 'upgrade keeps existing v2 keys');
  const R1b = reg(); // drop it again so the next upgrade restores the seeded words
  delete R1b.companies.find((c) => c.id === 'games').keywords;
  writeReg(R1b);
  await mia('upgrade');

  console.log('library filing');
  r = await mia('library', '--json');
  const lib = Object.fromEntries((json(r) || []).map((x) => [x.id, x]));
  ok(lib['games-roadmap']?.company === 'games' && lib['games-roadmap'].by === 'frontmatter' && lib['games-roadmap'].project === null, 'company: frontmatter → frontmatter');
  ok(lib['cg-notes']?.company === 'games' && lib['cg-notes'].project === 'crystal-garden' && lib['cg-notes'].by === 'rule', 'dir under a project\'s match dir → rule, project');
  ok(lib['mandate-review']?.company === 'oblivion' && lib['mandate-review'].project === null && lib['mandate-review'].by === 'rule', 'company keyword only ("mandate") → company-wide');
  ok(lib['dry-check']?.company === 'dryager' && lib['dry-check'].project === 'dryager-panel', 'project keyword → project');
  ok(lib.sourdough?.company === '' && lib.sourdough.by === 'none', 'unrelated → not filed (none)');
  r = await mia('library', '--unfiled', '--json');
  ok(json(r)?.length === 1 && json(r)[0].id === 'sourdough', '--unfiled');
  r = await mia('library', '--company', 'games', '--json');
  ok(json(r)?.map((x) => x.id).sort().join() === 'cg-notes,games-roadmap', '--company games');
  r = await mia('library');
  ok(r.status === 0 && /^sourdough\t-\t-\tnone\t/m.test(r.stdout), 'plain listing');

  r = await mia('file', 'sourdough.md', 'dryager');
  ok(r.status === 0 && /sourdough → dryager \(manual\)/.test(r.stdout), `file <doc.md> <company> → manual (${r.stdout.trim()})`);
  ok(reg().libraryOverrides.sourdough === 'dryager' && reg().library.sourdough.by === 'manual', 'override saved');
  r = await mia('file', 'games-roadmap', 'crystal-garden');
  ok(r.status === 0 && reg().library['games-roadmap'].project === 'crystal-garden' && reg().library['games-roadmap'].company === 'games' && reg().library['games-roadmap'].by === 'manual', 'file to a project → its company + project, beats frontmatter');
  r = await mia('file', 'games-roadmap', '-');
  ok(r.status === 0 && reg().library['games-roadmap'].by === 'frontmatter' && !('games-roadmap' in reg().libraryOverrides), "file <doc> - reverts to the rules");
  r = await mia('file', 'sourdough', 'ghost');
  ok(r.status !== 0 && /no company or project 'ghost'/.test(r.stderr), 'unknown owner rejected');
  r = await mia('file', 'nope-doc', 'games');
  ok(r.status === 2 && /no Library doc 'nope-doc'/.test(r.stderr), 'missing doc: exit 2 (override kept for later)');
  ok(reg().libraryOverrides['nope-doc'] === 'games', 'override for a future doc kept');
  r = await mia('file', 'only-one');
  ok(r.status !== 0 && /usage/.test(r.stderr), 'file usage');

  console.log('knowledge');
  r = await mia('knowledge', 'oblivion', '--json');
  const K = json(r);
  ok(K && Object.keys(K).join() === 'oblivion', 'one company');
  const ob = K.oblivion;
  const mem = ob.filter((f) => f.source.kind === 'memory');
  ok(mem.length === 6, `6 memory facts (the 'short' bullet dropped) (${mem.length})`);
  ok(mem.every((f) => f.source.file === 'oblivion.md' && Number.isInteger(f.source.line)), 'memory facts carry file + line');
  ok(mem[0].source.line === 4 && mem[0].section === 'Contacts' && mem.find((f) => /Fresnaye/.test(f.text)).section === 'Focus' && mem.find((f) => /Fresnaye/.test(f.text)).source.line === 11, 'line numbers + sections');
  const out = r.stdout;
  ok(!out.includes('pieter@example.com') && out.includes('‹email›'), 'email redacted');
  ok(!/\+27|555 1234/.test(out) && out.includes('‹number›'), 'phone redacted');
  ok(!out.includes('209.159.148.182') && out.includes('‹ip›'), 'IP redacted');
  ok(!out.includes('hunter2') && out.includes('‹hidden›'), 'password value hidden');
  ok(!out.includes('root@1.2.3.4') && !out.includes('1.2.3.4'), 'ssh target redacted');
  const md = ob.find((f) => f.source.kind === 'doc');
  ok(md && md.source.id === 'mandate-review' && md.source.title === 'Mandate review' && /^Three sole mandates/.test(md.text) && md.section === 'report', 'Library doc summary as a fact (first paragraph)');
  r = await mia('knowledge', 'dryager', '--json');
  const dk = json(r)?.dryager || [];
  ok(dk.some((f) => f.source.file === 'other-projects.md' && f.source.line === 2 && f.project === 'dryager-panel'), 'shared memory line filed by project rules');
  const dd = dk.find((f) => f.source.kind === 'doc' && f.source.id === 'dry-check');
  ok(dd && dd.text === 'The dry-ager sells best to steakhouses in Gauteng, then butcheries.', `summary from **Answer:** (${dd?.text})`);
  ok(dk.some((f) => f.source.kind === 'doc' && f.source.id === 'sourdough'), 'manually filed doc shows in that company\'s knowledge');
  r = await mia('knowledge', '--json');
  ok(json(r) && Object.keys(json(r)).length === 8 && !JSON.stringify(json(r)).includes('Something entirely unrelated'), 'all companies; unmatched shared line not filed');
  r = await mia('knowledge', 'ghost');
  ok(r.status !== 0 && /no company 'ghost'/.test(r.stderr), 'unknown company rejected');
  r = await mia('knowledge', 'oblivion');
  ok(r.status === 0 && /\[oblivion\.md:4\]/.test(r.stdout) && /\[doc mandate-review\]/.test(r.stdout), 'plain output cites sources');

  console.log('actions');
  r = await mia('actions');
  ok(r.status === 0 && /^video\tnew-video\tsmart\tMake a new video \{topic\}$/m.test(r.stdout), 'actions lists id, tier, label, inputs');
  r = await mia('actions', 'games', '--json');
  ok(Object.keys(json(r) || {}).join() === 'games' && json(r).games.some((a) => a.id === 'propose-crystal'), 'actions <company> --json');
  ok((await mia('actions', 'ghost')).status !== 0, 'actions unknown company');
  r = await mia('action', 'add', 'games', 'new-level', '--label', 'New level', '--prompt', 'Build a {theme} level for {game}', '--input', 'theme:Theme:e.g. lava', '--input', 'game', '--project', 'crystal', '--tier', 'mid', '--hint', 'One level');
  ok(r.status === 0 && /games\/new-level: New level/.test(r.stdout), `action add (${r.stdout.trim()}${r.stderr.trim()})`);
  let na = reg().companies.find((c) => c.id === 'games').actions.find((a) => a.id === 'new-level');
  ok(na && na.project === 'crystal-garden' && na.tier === 'mid' && na.hint === 'One level' && na.icon === 'sparkles', 'saved with project (by prefix), tier, hint, default icon');
  ok(na.inputs.length === 2 && na.inputs[0].name === 'theme' && na.inputs[0].label === 'Theme' && na.inputs[0].placeholder === 'e.g. lava' && na.inputs[1].label === 'game' && na.inputs[1].required === true, '--input name:Label:placeholder (repeatable)');
  r = await mia('action', 'add', 'games', 'bad', '--label', 'Bad', '--prompt', 'Do {thing} with {other}', '--input', 'thing');
  ok(r.status !== 0 && /\{other\}/.test(r.stderr) && /no --input defines it/.test(r.stderr), 'undefined {placeholder} rejected');
  r = await mia('action', 'add', 'games', 'bad', '--label', 'Bad', '--prompt', 'x', '--project', 'penny');
  ok(r.status !== 0 && /project penny is not in games/.test(r.stderr), '--project in another company rejected');
  r = await mia('action', 'add', 'games', 'bad', '--label', 'Bad', '--prompt', 'x', '--project', 'ghost');
  ok(r.status !== 0 && /no project 'ghost'/.test(r.stderr), '--project unknown rejected');
  if (/Traceback/.test(r.stderr)) console.log('    (note: unknown --project exits through an uncaught Bad traceback, not die())');
  ok((await mia('action', 'add', 'games', 'bad', '--label', 'Bad', '--prompt', 'x', '--tier', 'huge')).status !== 0, 'bad tier rejected');
  ok((await mia('action', 'add', 'games', 'Bad_ID', '--label', 'Bad', '--prompt', 'x')).status !== 0, 'bad id rejected');
  ok((await mia('action', 'add', 'games', 'bad', '--prompt', 'x')).status !== 0, 'label required');
  ok((await mia('action', 'add', 'ghost', 'bad', '--label', 'B', '--prompt', 'x')).status !== 0, 'unknown company rejected');
  ok((await mia('action', 'add', 'games', 'bad', '--label', 'B', '--prompt', 'x', '--input', 'two words')).status !== 0, 'input name must be a word');
  ok(!reg().companies.find((c) => c.id === 'games').actions.some((a) => a.id === 'bad'), 'no rejected action was saved');
  r = await mia('action', 'add', 'games', 'new-level', '--label', 'New level v2', '--prompt', 'Build a level');
  const ga = reg().companies.find((c) => c.id === 'games').actions;
  ok(r.status === 0 && ga.filter((a) => a.id === 'new-level').length === 1 && ga.find((a) => a.id === 'new-level').label === 'New level v2', 'add with an existing id replaces it');
  r = await mia('action', 'remove', 'games', 'new-level');
  ok(r.status === 0 && /removed games\/new-level/.test(r.stdout) && !reg().companies.find((c) => c.id === 'games').actions.some((a) => a.id === 'new-level'), 'action remove');
  r = await mia('action', 'remove', 'games', 'new-level');
  ok(r.status !== 0 && /no action 'new-level' on games/.test(r.stderr), 'remove twice → error');
  ok((await mia('action')).status !== 0, 'action usage');

  console.log('relay: action control validation');
  const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, `v${i}`]));
  let c = await control({ action: 'action', company: 'video', actionId: 'new-video', inputs: { topic: '  the 2019 Phoenix stop  ', n: 5, o: { x: 1 }, list: ['a'], 'bad key': 'x' }, label: 'Make a new video', told: true });
  ok(c.status === 200 && c.body.control.company === 'video' && c.body.control.actionId === 'new-video' && c.body.control.told === true, 'valid action control queued');
  ok(JSON.stringify(c.body.control.inputs) === '{"topic":"the 2019 Phoenix stop"}', `non-string inputs + bad keys dropped, values trimmed (${JSON.stringify(c.body.control.inputs)})`);
  const cValid = c.body.control.id;
  c = await control({ action: 'action', company: 'games', actionId: 'scout', inputs: big });
  ok(c.status === 200 && Object.keys(c.body.control.inputs).length === 8 && !('k8' in c.body.control.inputs), '>8 input keys trimmed to 8');
  c = await control({ action: 'action', company: 'oblivion', actionId: 'mandate-targets', inputs: { area: 'x'.repeat(1000) } });
  ok(c.status === 200 && c.body.control.inputs.area.length === 400, 'long input cut to 400');
  const cLong = c.body.control.id;
  c = await control({ action: 'action', company: 'Bad Co!', actionId: 'scout' });
  ok(c.status === 400 && /company/.test(c.body.error), 'malformed company → 400');
  c = await control({ action: 'action', company: 'games', actionId: '' });
  ok(c.status === 400 && /actionId/.test(c.body.error), 'missing actionId → 400');
  c = await control({ action: 'action', company: 'games', actionId: 'scout', inputs: ['a', 'b'] });
  ok(c.status === 200 && JSON.stringify(c.body.control.inputs) === '{}', 'array inputs → {}');
  const cMissing = (await control({ action: 'action', company: 'video', actionId: 'new-video', inputs: {} })).body.control.id;
  const cUnknown = (await control({ action: 'action', company: 'video', actionId: 'ghost-action' })).body.control.id;
  const cNoCo = (await control({ action: 'action', company: 'ghostco', actionId: 'scout' })).body.control.id;
  await control({ action: 'level', project: 'penny', level: 1 });

  console.log('sync');
  const before = findings().length;
  r = await mia('sync');
  if (process.env.E2E_VERBOSE) console.log(r.stdout, r.stderr);
  ok(r.status === 0 && r.stdout.trim().endsWith('pushed'), `sync pushed (${r.stdout.trim().split('\n').pop()})`);
  ok(new RegExp(`applied ${cValid}: action video/new-video`).test(r.stdout), 'valid action applied');
  ok(new RegExp(`skipped ${cMissing}: Make a new video needs Topic`).test(r.stdout), 'missing required input skipped');
  ok(new RegExp(`skipped ${cUnknown}: no action 'ghost-action' on video`).test(r.stdout), 'unknown action id skipped');
  ok(new RegExp(`skipped ${cNoCo}: no company 'ghostco'`).test(r.stdout), 'unknown company skipped');
  ok(/applied .*: penny autonomy/.test(r.stdout), 'other controls in the same sync still applied');
  const F = findings().slice(before);
  const fa = F.find((f) => f.control === cValid);
  ok(fa && fa.kind === 'action' && fa.company === 'video' && fa.action === 'new-video' && fa.project === 'bodycam' && fa.by === 'daniel' && fa.told === true, 'findings: kind action with company/action/project');
  ok(fa && fa.inputs.topic === 'the 2019 Phoenix stop' && fa.text.startsWith('Make a new video: Make a new bodycam video on the 2019 Phoenix stop.') && !fa.text.includes('{topic}'), 'rendered text with the input');
  const fl = F.find((f) => f.control === cLong);
  ok(fl && fl.company === 'oblivion' && fl.text.includes('x'.repeat(400)) && !fl.text.includes('x'.repeat(401)), 'long input rendered (cut to 400)');
  ok(!F.some((f) => f.control === cMissing || f.control === cUnknown || f.control === cNoCo), 'skipped controls leave no finding');
  ok(F.filter((f) => f.kind === 'action' && f.company === 'games' && f.action === 'scout').length === 2, 'scout actions (no inputs) applied');

  const st = (await api('/jarvis')).body;
  ok(st.pending.length === 0, 'relay queue drained (skipped ones too)');
  const S = st.state;
  ok(S.schema === 2 && S.version === 1, 'state.schema === 2');
  const sd = Object.fromEntries(S.docs.map((d) => [d.id, d]));
  ok(S.docs.length === 5 && S.docs.every((d) => 'company' in d && 'project' in d && 'filedBy' in d && 'summary' in d), 'state.docs carry company/project/filedBy/summary');
  ok(sd['cg-notes'].company === 'games' && sd['cg-notes'].project === 'crystal-garden' && sd['cg-notes'].filedBy === 'rule', 'doc filed by rule');
  ok(sd.sourdough.company === 'dryager' && sd.sourdough.filedBy === 'manual', 'manual filing reaches the relay');
  ok(sd['games-roadmap'].company === 'games' && sd['games-roadmap'].filedBy === 'frontmatter' && sd['games-roadmap'].kind === 'plan' && sd['games-roadmap'].status === 'draft', 'frontmatter kind/status');
  ok(sd['dry-check'].summary.startsWith('The dry-ager sells best'), 'doc summary in the index');
  ok(!('dir' in sd['cg-notes']), 'doc dir not pushed');
  ok(S.knowledge && Object.keys(S.knowledge).sort().join() === R0.companies.map((c) => c.id).sort().join(), 'state.knowledge keyed by every company');
  const pushed = JSON.stringify(S);
  ok(!pushed.includes('hunter2') && !pushed.includes('pieter@example.com') && !pushed.includes('209.159.148.182') && !pushed.includes('root@1.2.3.4') && !pushed.includes('555 1234'), 'nothing sensitive from memory reaches the relay');
  const T = Object.fromEntries(S.tasks.map((t) => [t.id, t]));
  ok(T['0600'].company === 'games' && T['0600'].project === null, 'explicit company, no project');
  ok(T['0601'].company === 'games' && T['0601'].project === null, 'explicit company beats the rules (Penny title stays in games)');
  ok(T['0602'].company === 'games' && T['0602'].project === 'crystal-garden', 'explicit project → its company');
  ok(T['0603'].company === 'klear' && T['0603'].project === 'penny', 'untagged → rules');
  ok(T['0604'].company === 'klear' && T['0604'].project === 'penny', 'unknown company → rules');
  ok(T['0605'].company === '' && T['0605'].project === null, 'no match → unfiled');
  ok(S.registry.companies.every((c) => Array.isArray(c.actions)), 'registry pushed with actions');
  ok(S.findings.some((f) => f.kind === 'action' && f.control === cValid), 'action finding pushed');

  r = await mia('sync');
  ok(findings().filter((f) => f.control === cValid).length === 1, 'second sync: action not re-applied');

  console.log('backward compat (registry without v2 keys)');
  const OLD = path.join(TMP, 'mia-old');
  fs.mkdirSync(path.join(OLD, 'jarvis'), { recursive: true });
  fs.mkdirSync(path.join(OLD, 'tasks'), { recursive: true });
  const old = quiet(strip(reg()));
  delete old.updatedAt;
  writeReg(old, OLD);
  fs.writeFileSync(path.join(OLD, 'tasks', '0700.json'), JSON.stringify({ id: '0700', title: 'Crystal Garden pets', status: 'running', createdAt: now, updatedAt: now }));
  r = await run(['jarvis', 'show'], OLD);
  ok(r.status === 0 && /Games/.test(r.stdout) && /crystal-garden/.test(r.stdout), 'show works');
  ok(!('actions' in reg(OLD).companies[0]) && !('library' in reg(OLD)), 'show does not rewrite the file');
  r = await run(['jarvis', 'actions', 'video'], OLD);
  ok(r.status === 0 && /new-video/.test(r.stdout), 'actions available in memory (load adds them)');
  r = await run(['jarvis', 'sync'], OLD);
  ok(r.status === 0 && r.stdout.trim().endsWith('pushed'), `sync works (${r.stdout.trim()})`);
  const S2 = (await api('/jarvis')).body.state;
  ok(S2.schema === 2 && S2.docs.length === 5 && S2.registry.companies.every((c) => c.actions.some((a) => a.id === 'scout')), 'pushed v2 state from a v1 registry');
  ok(S2.tasks.find((t) => t.id === '0700')?.company === 'games', 'tasks filed by company');
  ok(Object.keys(S2.knowledge).length === 8, 'knowledge present (no memory dir → docs only)');
  const R2 = reg(OLD);
  ok(R2.library && R2.libraryOverrides && R2.companies.every((c) => Array.isArray(c.actions)), 'sync saved the v2 keys once it had a change to save');
} finally {
  relay.kill();
}
await sleep(200);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 }); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
