// HQ v2 (task 0204): the company-centric half of app/src/lib/hqModel.js —
// docs/tasks/knowledge filed by company, action buttons, history charts.
//   node test/hq-v2-model-test.mjs
import * as M from '../app/src/lib/hqModel.js';

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};
const NOW = Date.parse('2026-10-14T10:00:00Z');
const iso = (agoMs) => new Date(NOW - agoMs).toISOString().replace(/\.\d+Z$/, 'Z');
const H = 3600e3;
const D = 24 * H;

const registry = {
  jarvis: { paused: false, pitchesPerDay: 1 },
  companies: [
    { id: 'games', name: 'Games', actions: [
      { id: 'propose', label: 'Propose improvements', prompt: 'Propose 3 improvements for Crystal Garden.', project: 'crystal-garden', tier: 'mid' },
      { id: 'level', label: 'New level', prompt: 'Build a {theme} level for {game}.', inputs: [{ name: 'theme', label: 'Theme' }, { name: 'game', label: 'Game', required: false }], tier: 'smart' },
      { id: 'scout', label: 'Scout now', prompt: 'Scout Games now.' },
      { id: 'broken', label: 'No prompt' },
      { label: 'No id', prompt: 'x' },
    ] },
    { id: 'klear', name: 'Klear', actions: [{ id: 'odd', label: 'Odd tier', prompt: 'Do it.', tier: 'turbo' }] },
    { id: 'empty', name: 'Empty' },
  ],
  projects: [
    { id: 'crystal-garden', name: 'Crystal Garden', company: 'games', match: { keywords: ['crystal garden', 'pets'] } },
    { id: 'empire-clash', name: 'Empire Clash', company: 'games', match: { keywords: ['empire clash'] } },
    { id: 'penny', name: 'Penny', company: 'klear', match: { keywords: ['penny'] } },
  ],
};
const games = registry.projects.filter((p) => p.company === 'games');

console.log('companyDocs (schema 2 Mac)');
{
  const mac = [
    { id: 'cg-plan', title: 'Old title', status: 'draft', kind: 'plan', company: 'games', project: 'crystal-garden', updatedAt: iso(5 * D), filedBy: 'rule' },
    { id: 'ec-notes.md', title: 'EC notes', company: 'games', project: 'empire-clash', updatedAt: iso(D), filedBy: 'frontmatter' },
    { id: 'wide', title: 'Studio roadmap', company: 'games', project: null, updatedAt: iso(3 * D), filedBy: 'rule' },
    { id: 'penny-x', title: 'Penny tone', company: 'klear', project: 'penny', updatedAt: iso(0) },
    { id: 'loose', title: 'Loose', company: '', project: null, updatedAt: iso(0) },
  ];
  const snap = [
    { id: 'cg-plan.md', title: 'Fresh title', status: 'final', updatedAt: iso(H), kind: 'report' },
    { id: 'ec-notes', title: '', updatedAt: '' },
  ];
  const d = M.companyDocs('games', games, mac, snap);
  ok(d.length === 3 && d.every((x) => x.company === 'games'), 'only the company\'s docs (3)');
  ok(d.map((x) => x.id).join(',') === 'cg-plan.md,ec-notes,wide', `newest first, snapshot id wins (${d.map((x) => x.id)})`);
  const cg = d[0];
  ok(cg.title === 'Fresh title' && cg.status === 'final' && cg.kind === 'report' && cg.updatedAt === iso(H), 'snapshot fresher title/status/kind/updatedAt override');
  ok(cg.project === 'crystal-garden' && cg.filedBy === 'rule', 'Mac filing kept');
  const ec = d.find((x) => x.id === 'ec-notes');
  ok(ec.title === 'EC notes' && ec.updatedAt === iso(D), 'empty snapshot fields fall back to the Mac copy (id with/without .md matched)');
  ok(d.find((x) => x.id === 'wide').title === 'Studio roadmap', 'doc without a snapshot entry kept as is');
  ok(M.companyDocs('empty', [], mac, snap).length === 0, 'company with nothing filed → []');
  ok(M.companyDocs('games', games, mac, null).length === 3, 'no snapshot list → Mac index alone');
}

console.log('companyDocs (older Mac: keyword fallback)');
{
  const snap = [
    { id: 'pets.md', title: 'Pets and Crystal Garden', updatedAt: iso(2 * D) },
    { id: 'clash', title: 'Empire Clash balance', updatedAt: iso(D) },
    { id: 'both', title: 'Crystal Garden vs Empire Clash', updatedAt: iso(3 * D) },
    { id: 'penny', title: 'Penny', updatedAt: iso(0) },
  ];
  for (const mac of [undefined, null, []]) {
    const d = M.companyDocs('games', games, mac, snap);
    ok(d.length === 3 && d.every((x) => x.company === 'games' && x.filedBy === 'keyword'), `macDocs=${JSON.stringify(mac)} → docsFor keyword matching`);
  }
  const d = M.companyDocs('games', games, [], snap);
  ok(d.map((x) => x.id).join(',') === 'clash,pets.md,both', 'newest first');
  ok(d.find((x) => x.id === 'both').project === 'crystal-garden', 'a doc matching two projects is filed once, under the first');
  ok(d.find((x) => x.id === 'clash').project === 'empire-clash', 'project set from the matching project');
  ok(M.companyDocs('games', [], [], snap).length === 0, 'no projects → nothing');
}

console.log('unfiledDocs + groupDocs');
{
  ok(M.unfiledDocs([{ id: 'a', company: 'games' }, { id: 'b', company: '' }, { id: 'c' }, null]).map((d) => d.id).join() === 'b,c', 'unfiled = no company');
  ok(M.unfiledDocs(undefined).length === 0, 'unfiledDocs(undefined) → []');
  const docs = [
    { id: '1', project: null },
    { id: '2', project: 'empire-clash' },
    { id: '3', project: 'crystal-garden' },
    { id: '4', project: 'ghost' },
    { id: '5', project: 'empire-clash' },
  ];
  const g = M.groupDocs(docs, games);
  ok(g.map((x) => x.id).join('|') === 'crystal-garden|empire-clash|', `project order, then Company-wide last (${g.map((x) => x.label)})`);
  ok(g[0].label === 'Crystal Garden' && g[1].label === 'Empire Clash' && g[2].label === 'Company-wide', 'labels');
  ok(g[1].docs.map((d) => d.id).join() === '2,5', 'docs keep their order inside a group');
  ok(g[2].docs.map((d) => d.id).join() === '1,4', 'unknown project falls into Company-wide');
  ok(M.groupDocs([{ id: 'x' }], games).length === 1 && M.groupDocs([], games).length === 0, 'only non-empty groups');
  const g2 = M.groupDocs([{ id: 'w' }, { id: 'c', project: 'crystal-garden' }], games);
  ok(g2[0].id === 'crystal-garden' && g2[1].id === '', 'Company-wide last even when it came first');
}

console.log('companyTasks + filterTasks');
{
  const tasks = [
    { id: '1', project: 'crystal-garden', status: 'running' },
    { id: '2', company: 'games', project: 'penny', status: 'done' },
    { id: '3', company: 'klear', project: 'crystal-garden', status: 'queued' },
    { id: '4', project: 'penny', status: 'failed' },
    { id: '5', company: 'games', project: null, status: 'cancelled' },
    { id: '6', project: 'empire-clash', status: 'asking' },
    { id: '7', project: null, status: 'done' },
  ];
  const g = M.companyTasks('games', games, tasks);
  ok(g.map((t) => t.id).join() === '1,2,5,6', `explicit task.company beats project (${g.map((t) => t.id)})`);
  ok(M.companyTasks('klear', registry.projects.filter((p) => p.company === 'klear'), tasks).map((t) => t.id).join() === '3,4', 'klear: tagged + via project');
  ok(M.companyTasks('games', games, undefined).length === 0, 'no tasks → []');
  ok(M.filterTasks(g, 'open').map((t) => t.id).join() === '1,6', 'open = queued/asking/running/checking');
  ok(M.filterTasks(tasks, 'done').map((t) => t.id).join() === '2,4,5,7', 'done = done/failed/cancelled');
  ok(M.filterTasks(tasks, 'all').length === 7 && M.filterTasks(tasks, undefined).length === 7, 'all / unknown filter → everything');
  ok(M.TASK_FILTERS.map((f) => f.value).join() === 'open,done,all', 'TASK_FILTERS values');
}

console.log('companyInfo (tasks/running)');
{
  const view = {
    registry,
    tasks: [
      { id: '1', project: 'crystal-garden', status: 'running', title: 'a' },
      { id: '2', company: 'games', project: null, status: 'queued', title: 'b' },
      { id: '3', project: 'empire-clash', status: 'done', title: 'c', updatedAt: iso(H) },
      { id: '4', project: 'penny', status: 'running', title: 'd' },
    ],
    findings: [],
  };
  const info = M.companyInfo(registry.companies[0], view, [], NOW);
  ok(info.tasks.map((t) => t.id).join() === '1,2,3', 'company tasks include company-tagged ones without a project');
  ok(info.running === 2, `running counts open company tasks (${info.running})`);
  ok(info.projects.length === 2 && info.projects[0].running.length === 1, 'projects still carry their own running list');
  const k = M.companyInfo(registry.companies[1], view, [], NOW);
  ok(k.running === 1 && k.tasks.length === 1, 'klear: 1 running');
}

console.log('knowledge');
{
  ok(M.companyKnowledge('games', undefined) === null && M.companyKnowledge('games', null) === null, 'older Mac (no knowledge) → null');
  ok(M.companyKnowledge('games', 'nope') === null, 'non-object → null');
  ok(Array.isArray(M.companyKnowledge('ghost', {})) && M.companyKnowledge('ghost', {}).length === 0, 'known-empty → []');
  const facts = [
    { text: 'Mandates over R10m in Fresnaye', section: 'Focus', source: { kind: 'memory', file: 'oblivion.md', line: 4 } },
    { text: 'Agent cell ‹number›', section: 'Contacts', source: { kind: 'memory', file: 'oblivion.md', line: 9 } },
    { text: 'Buyers want sea views', section: 'report', source: { kind: 'doc', id: 'buyers', title: 'Buyer brief' } },
    { text: 'Second focus line', section: 'Focus', source: { kind: 'memory', file: 'oblivion.md', line: 5 } },
    { text: 'Shared line', section: '', source: { kind: 'memory', file: 'other-projects.md', line: 2 } },
    { text: 'Doc two', section: 'plan', source: { kind: 'doc', id: 'p2' } },
  ];
  const k = M.companyKnowledge('oblivion', { oblivion: [...facts, null, 'x'] });
  ok(k.length === facts.length, 'non-object facts dropped');
  ok(M.filterFacts(facts, '').length === 6 && M.filterFacts(facts, '   ').length === 6 && M.filterFacts(facts, null).length === 6, 'empty query → all');
  ok(M.filterFacts(facts, 'FRESNAYE').length === 1, 'text match, case-insensitive');
  ok(M.filterFacts(facts, 'contacts').length === 1, 'section match');
  ok(M.filterFacts(facts, 'buyer brief').length === 1, 'source title match');
  ok(M.filterFacts(facts, 'other-projects').length === 1, 'source file match');
  ok(M.filterFacts(facts, 'zzz').length === 0, 'no match → []');
  const g = M.groupFacts(facts);
  ok(g.map((x) => x.label).join('|') === 'Focus|Contacts|other-projects.md|From the Library', `groups by file+section, Library last (${g.map((x) => x.label)})`);
  ok(g[0].facts.length === 2 && g[0].file === 'oblivion.md', 'same file+section grouped');
  ok(g[3].facts.length === 2 && g[3].file === '' && g[3].id === 'doc', 'all docs in one group, no file');
  ok(M.groupFacts([{ text: 'x', source: {} }])[0].label === 'Memory', 'no section, no file → "Memory"');
  ok(M.sourceLabel(null) === '' && M.sourceLabel(undefined) === '', 'sourceLabel(null) → ""');
  ok(M.sourceLabel({ kind: 'doc', id: 'buyers', title: 'Buyer brief' }) === 'Buyer brief', 'doc → title');
  ok(M.sourceLabel({ kind: 'doc', id: 'p2' }) === 'p2', 'doc without title → id');
  ok(M.sourceLabel({ kind: 'memory', file: 'oblivion.md', line: 4 }) === 'oblivion.md · line 4', 'memory → file · line');
  ok(M.sourceLabel({ kind: 'memory', file: 'oblivion.md' }) === 'oblivion.md' && M.sourceLabel({ kind: 'memory' }) === '', 'memory without line / file');
}

console.log('actions');
{
  const acts = M.actionsOf(registry.companies[0]);
  ok(acts.map((a) => a.id).join() === 'propose,level,scout', 'actionsOf drops actions without id/label/prompt');
  ok(M.actionsOf(null).length === 0 && M.actionsOf(registry.companies[2]).length === 0, 'no company / no actions → []');
  const lvl = acts[1];
  ok(M.missingInputs(lvl, {}).map((i) => i.name).join() === 'theme', 'required by default; required:false never missing');
  ok(M.missingInputs(lvl).length === 1, 'inputs default {}');
  ok(M.missingInputs(lvl, { theme: '   ' }).length === 1, 'whitespace counts as missing');
  ok(M.missingInputs(lvl, { theme: 'lava' }).length === 0, 'filled → none missing');
  ok(M.missingInputs(lvl, { theme: 0 }).length === 0, 'number 0 counts as a value');
  ok(M.missingInputs(acts[0], {}).length === 0 && M.missingInputs(null, {}).length === 0, 'no inputs → none missing');
  ok(M.renderPrompt(lvl, { theme: '  lava ', game: 'Crystal Garden' }) === 'Build a lava level for Crystal Garden.', 'renderPrompt fills + trims');
  ok(M.renderPrompt(lvl, { theme: 'lava' }) === 'Build a lava level for {game}.', 'missing value keeps {placeholder}');
  ok(M.renderPrompt(lvl, { theme: '', game: ' ' }) === 'Build a {theme} level for {game}.', 'blank values keep placeholders');
  ok(M.renderPrompt(lvl) === 'Build a {theme} level for {game}.', 'no inputs → prompt as is');
  ok(M.renderPrompt(null) === '' && M.renderPrompt({}) === '', 'no action → ""');
  ok(M.renderPrompt({ prompt: 'a {b-c} {x}' }, { x: 'y' }) === 'a {b-c} y', 'only \\w placeholders replaced');

  const l1 = M.actionLine({ action: 'action', company: 'games', actionId: 'propose' }, registry);
  ok(l1.includes('Games') && l1.includes('Crystal Garden') && l1.includes('Propose improvements') && l1.includes('Propose 3 improvements for Crystal Garden.'), `actionLine: company, project, label, prompt (${l1})`);
  ok(l1.includes('Suggested tier: mid (Sonnet)') && l1.includes('Filed under games/crystal-garden.'), 'tier text + filing');
  const l2 = M.actionLine({ action: 'action', company: 'games', actionId: 'level', inputs: { theme: 'ice' } }, registry);
  ok(l2.includes('Build a ice level for {game}.') && l2.includes('Suggested tier: smart (Opus)') && l2.includes('Filed under games.') && !l2.includes('Crystal Garden'), `rendered prompt, no project → company only (${l2})`);
  const l3 = M.actionLine({ company: 'games', actionId: 'scout' }, registry);
  ok(l3.includes('Scout now') && !l3.includes('Suggested tier'), 'no tier → no tier text');
  ok(M.actionLine({ company: 'klear', actionId: 'odd' }, registry).includes('Suggested tier: turbo (turbo)'), 'unknown tier name echoed');
  ok(M.actionLine({ company: 'games', actionId: 'ghost' }, registry) === '', 'unknown action → ""');
  ok(M.actionLine({ company: 'games', actionId: 'broken' }, registry) === '', 'invalid (no prompt) action → ""');
  ok(M.actionLine({ company: 'ghost', actionId: 'propose' }, registry) === '', 'unknown company → ""');
  ok(M.actionLine({ company: 'games', actionId: 'propose' }, null) === '', 'no registry → ""');
  ok(M.miaLine({ action: 'action', company: 'games', actionId: 'propose' }, registry) === l1, 'miaLine(action) = actionLine');
  ok(M.miaLine({ action: 'action', company: 'games', actionId: 'ghost' }, registry) === '', 'miaLine unknown action → ""');
  ok(M.TIER_LABEL.cheap === 'Haiku' && M.TIER_LABEL.mid === 'Sonnet' && M.TIER_LABEL.smart === 'Opus', 'TIER_LABEL');
}

console.log('actionHistory');
{
  const findings = [
    { kind: 'action', company: 'games', action: 'propose', at: iso(3 * H), text: 'old', inputs: { a: '1' } },
    { kind: 'action', company: 'games', action: 'propose', at: iso(H), text: 'new' },
    { kind: 'action', company: 'klear', action: 'odd', at: iso(H), text: 'klear' },
    { kind: 'control', company: 'games', action: 'level', at: iso(0), text: 'not an action' },
    { kind: 'action', company: 'games', at: iso(0), text: 'no action id' },
    { kind: 'action', company: 'games', action: 'level', at: iso(5 * H), text: 'level old' },
    { kind: 'action', company: 'games', action: 'scout', at: iso(0), text: 'scout fresh' },
  ];
  const h = M.actionHistory('games', findings, { actions: { 'games/level': iso(2 * H), 'games/scout': iso(H), 'klear/odd': iso(0), 'games/new': iso(0) } });
  ok(Object.keys(h).sort().join() === 'level,new,propose,scout', `only this company's actions (${Object.keys(h)})`);
  ok(h.propose.text === 'new' && !h.propose.pending && JSON.stringify(h.propose.inputs) === '{}', 'newest finding wins, inputs default {}');
  ok(h.level.pending === true && h.level.at === iso(2 * H), 'newer pending tap overrides an older finding');
  ok(h.scout.text === 'scout fresh' && !h.scout.pending, 'pending tap older than the finding: finding kept (Mac already applied)');
  ok(h.new.pending === true, 'pending-only action listed');
  ok(Object.keys(M.actionHistory('games', undefined, undefined)).length === 0, 'nothing → {}');
  ok(Object.keys(M.actionHistory('games', findings, null)).join() === 'propose,level,scout', 'no sync → findings only');
}

console.log('overlay (action controls)');
{
  const o = M.overlay(registry, [
    { action: 'action', company: 'games', actionId: 'propose', at: iso(H) },
    { action: 'action', company: 'games', actionId: 'level' },
    { action: 'action', company: 'games', actionId: 'propose', at: iso(0) },
  ]);
  ok(o.sync.actions['games/propose'] === iso(0), 'later tap of the same action wins');
  ok(typeof o.sync.actions['games/level'] === 'string' && !Number.isNaN(Date.parse(o.sync.actions['games/level'])), 'tap without at → now');
  ok(Object.keys(o.sync.projects).length === 0 && o.sync.paused === false && o.sync.pitch === false, 'action changes nothing else');
  ok(M.overlay(registry, [{ action: 'pause' }]).sync.actions === undefined, 'no action control → no sync.actions');
  ok(o.companies[0].actions.length === 5, 'companies carried through');
  const h = M.actionHistory('games', [], o.sync);
  ok(h.propose.pending && h.level.pending, 'overlay sync feeds actionHistory');
}

console.log('feedOf companyId');
{
  const findings = [
    { id: 'a', kind: 'action', company: 'games', project: '', at: iso(H), text: 'company-wide action' },
    { id: 'b', kind: 'found', project: 'crystal-garden', at: iso(2 * H), text: 'cg' },
    { id: 'c', kind: 'action', company: 'klear', project: '', at: iso(0), text: 'klear action' },
    { id: 'd', kind: 'found', project: 'penny', at: iso(0), text: 'penny' },
  ];
  const ids = new Set(['crystal-garden', 'empire-clash']);
  const f = M.feedOf({ findings, projectIds: ids, companyId: 'games' });
  ok(f.map((x) => x.id).join() === 'a,b', `company line + project lines (${f.map((x) => x.id)})`);
  ok(M.feedOf({ findings, projectIds: ids }).map((x) => x.id).join() === 'b', 'without companyId: company-wide line not in scope');
  ok(M.feedOf({ findings }).length === 4, 'unscoped: everything');
  ok(f[0].kind === 'action' && f[0].project === '', 'kind/project carried');
}

console.log('chartOf');
{
  ok(M.chartOf(undefined) === null && M.chartOf({}) === null, 'no history → null');
  ok(M.chartOf({ history: [{ t: iso(0), v: 3 }] }) === null, '1 point → null');
  ok(M.chartOf({ history: [{ t: iso(0), v: 3 }, { t: 'garbage', v: 4 }, { t: iso(H), v: 'x' }, null] }) === null, 'invalid points dropped → <2 → null');
  const c = M.chartOf({ history: [{ t: iso(0), v: 10 }, { t: iso(10 * D), v: 1 }, { t: iso(5 * D), v: '4' }] });
  ok(c.points.map((p) => p.v).join() === '1,4,10', 'sorted by time, values numeric');
  ok(c.points[0].x === 0 && c.points[2].x === 1 && Math.abs(c.points[1].x - 0.5) < 1e-9, 'x from 0..1 by time');
  ok(c.points.every((p) => p.y >= 0 && p.y <= 1) && c.points[2].y < 1, 'y in [0,1] with headroom at the top');
  ok(Math.abs(c.points[0].y - 1 / (10 + 9 * 0.12)) < 1e-9, 'positive series: floor clamps to 0 when the pad would go negative');
  ok(c.first === c.points[0] && c.last === c.points[2] && 'x' in c.first && 'y' in c.last && c.first.v === 1 && c.last.v === 10, 'first/last carry x/y');
  ok(c.min === 1 && c.max === 10 && c.days === 10, 'min/max/days');
  const n = M.chartOf({ history: [{ t: iso(D), v: -5 }, { t: iso(0), v: 5 }] });
  ok(n.points[0].y > 0 && n.points[1].y < 1 && Math.abs(n.points[0].y - 0.12 / 1.24) < 1e-9, 'negative series: padded both ways');
  const flat = M.chartOf({ history: [{ t: iso(D), v: 5 }, { t: iso(0), v: 5 }] });
  ok(flat.points.every((p) => Math.abs(p.y - 0.5) < 1e-9), 'flat series gets headroom (centred, no NaN)');
  ok(flat.min === 5 && flat.max === 5, 'flat min/max are the real values');
  const zero = M.chartOf({ history: [{ t: iso(D), v: 0 }, { t: iso(0), v: 0 }] });
  ok(zero.points.every((p) => Number.isFinite(p.y) && p.y > 0 && p.y < 1), 'flat zero series finite');
  const same = M.chartOf({ history: [{ t: iso(0), v: 1 }, { t: iso(0), v: 2 }] });
  ok(same && same.points.every((p) => Number.isFinite(p.x)) && same.days === 1, 'same timestamp: no divide-by-zero, days ≥ 1');
  const long = { history: Array.from({ length: 200 }, (_, i) => ({ t: iso((200 - i) * H), v: i })) };
  ok(M.chartOf(long).points.length === 90, 'default maxPoints 90');
  const m10 = M.chartOf(long, { maxPoints: 10 });
  ok(m10.points.length === 10 && m10.first.v === 190 && m10.last.v === 199, 'maxPoints keeps the newest');
  ok(M.chartOf(long, { maxPoints: 1 }) === null, 'maxPoints 1 → <2 → null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
