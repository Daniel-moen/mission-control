// The pure half of Jarvis HQ (app/src/lib/hqModel.js, task 0199).
//   node test/hq-model-test.mjs
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
  companies: [{ id: 'dryager', name: 'Dry-ager' }, { id: 'games', name: 'Games' }],
  projects: [
    { id: 'dryager-panel', name: 'Dry-ager panel', company: 'dryager', autonomy: 2, healthcheck: { type: 'http' },
      health: { status: 'up', ms: 300, checkedAt: iso(5 * 60e3), since: iso(D), recent: [[iso(2 * H), 280], [iso(H), -1], [iso(0), 300]] },
      metrics: [{ name: 'stale_leads', label: 'Stale leads', better: 'down', value: 9, history: [{ t: iso(10 * D), v: 14 }, { t: iso(8 * D), v: 12 }, { t: iso(0), v: 9 }] }],
      match: { dirs: ['~/dryager-panel'], keywords: ['dry-ager', 'dryager'] } },
    { id: 'crystal-garden', name: 'Crystal Garden', company: 'games', healthcheck: null,
      match: { dirs: ['~/CrystalGarden'], keywords: ['crystal garden'] } },
    { id: 'mc-panel', name: 'Panel', company: 'mc', match: { keywords: ['panel'], fallbackDirs: ['~/widget-claude'] } },
  ],
};

console.log('overlay');
{
  const o = M.overlay(registry, [
    { action: 'level', project: 'dryager-panel', level: 3 },
    { action: 'pause' },
    { action: 'pitch', value: 'louder' },
    { action: 'scout', project: 'crystal-garden', at: iso(0) },
    { action: 'level', project: 'nope', level: 1 },
  ]);
  ok(o.projects[0].autonomy === 3 && registry.projects[0].autonomy === 2, 'level applied on a copy, original untouched');
  ok(o.projects[1].autonomy === 2, 'missing autonomy defaults to Suggest (2)');
  ok(o.jarvis.paused === true && o.sync.paused, 'pause overlaid + marked syncing');
  ok(o.jarvis.pitchesPerDay === 2 && o.sync.pitch, 'louder: 1 → 2 a day');
  ok(o.projects[1].scoutRequestedAt && o.sync.projects['crystal-garden'].scout, 'scout stamped');
  ok(M.overlay(registry, [{ action: 'pause' }, { action: 'resume' }]).jarvis.paused === false, 'last tap wins');
  ok(M.overlay(null) === null, 'no registry → null');
}

console.log('pitch steps');
ok(M.stepPitch(1, 'quieter') === 0.5 && M.stepPitch(0.14, 'quieter') === 0.14 && M.stepPitch(3, 'louder') === 3, 'clamped steps');
ok(M.stepPitch(1.7, '') === 2, 'snaps to nearest step');

console.log('task matching');
{
  const match = M.makeMatcher(registry.projects, '/Users/d');
  ok(match({ dir: '/Users/d/dryager-panel', title: 'x' }) === 'dryager-panel', 'folder match');
  ok(match({ dir: '/Users/d/dryager-panel-0123', title: 'x' }) === 'dryager-panel', 'worktree suffix match');
  ok(match({ dir: '/Users/d/widget-claude', title: 'Crystal Garden: new pets' }) === 'crystal-garden', 'keyword beats fallback dir');
  ok(match({ dir: '/Users/d/widget-claude', title: 'Something' }) === 'mc-panel', 'fallback dir when nothing else');
  ok(match({ title: 'panelling the walls' }) === null, 'keyword needs word boundaries');
  const tasks = M.mergeTasks(
    [{ id: '1', title: 'old', status: 'running', project: 'dryager-panel', updatedAt: iso(H) }],
    [{ id: '1', title: 'old', status: 'done', updatedAt: iso(0) }, { id: '2', title: 'Crystal Garden pets', status: 'queued', createdAt: iso(10) }],
    match,
  );
  ok(tasks.find((t) => t.id === '1').status === 'done' && tasks.find((t) => t.id === '1').project === 'dryager-panel', 'live status wins, Mac tag kept');
  ok(tasks.find((t) => t.id === '2').project === 'crystal-garden', 'live-only task matched here');
}

console.log('numbers + health');
{
  const t = M.trendOf(registry.projects[0].metrics[0]);
  ok(t.dir === 'down' && t.good === true && Math.round(t.pct) === -25, 'trend vs ~a week back (12 → 9, down is good)');
  ok(M.trendOf({ history: [{ v: 1 }] }) === null, 'one point → no trend');
  const up = M.uptimeOf(registry.projects[0].health);
  ok(Math.round(up.pct) === 67 && up.n === 3, 'uptime counts -1 as down');
  ok(M.fmtNum(12345) === '12.3k' && M.fmtNum(2500000) === '2.5M' && M.fmtNum(42, '%') === '42%' && M.fmtNum('x') === '—', 'fmtNum');
  const nums = M.keyNumbers(registry.projects[0], [{ status: 'done', updatedAt: iso(D) }], 3, NOW);
  ok(nums.map((n) => n.key).join() === 'stale_leads,uptime,ms', "Mia's metrics first, then uptime/response");
  const nums2 = M.keyNumbers(registry.projects[1], [{ status: 'done', updatedAt: iso(D) }, { status: 'done', updatedAt: iso(40 * D) }], 3, NOW);
  ok(nums2.length === 1 && nums2[0].value === '1', 'unmeasured project still says something true (shipped 30d)');
  ok(M.healthOf(registry.projects[0], NOW).status === 'up', 'up');
  ok(M.healthOf(registry.projects[1], NOW).status === 'none', 'no check → none');
  ok(M.healthOf({ healthcheck: {}, health: { status: 'up', checkedAt: iso(2 * H) } }, NOW).status === 'stale', 'old check → stale');
  ok(M.healthOf({ healthcheck: {}, health: { status: 'down', error: 'HTTP 502', checkedAt: iso(0) } }, NOW).label === 'Down · HTTP 502', 'down with reason');
  ok(M.healthOf({ healthcheck: {} }, NOW).status === 'unknown', 'never checked → unknown');
  ok(M.worstHealth([{ status: 'up' }, { status: 'down' }, { status: 'none' }]).status === 'down', 'worst health wins');
}

console.log('questions, docs, feed');
{
  const match = M.makeMatcher(registry.projects, '/Users/d');
  const tasks = [{ id: '7', project: 'dryager-panel' }];
  const qs = [{ questionId: 'a', taskId: '7', text: 'x' }, { questionId: 'b', text: 'Should the dry-ager panel email Terje?' }, { questionId: 'c', text: 'Lunch?' }];
  ok(M.questionsFor('dryager-panel', qs, tasks, match).map((q) => q.questionId).join() === 'a,b', 'by task, then by keyword');
  const docs = [
    { id: 'dryager-playbook', title: 'Dry-ager sales playbook', updatedAt: iso(D) },
    { id: 'misc', title: 'Something else', updatedAt: iso(0) },
    { id: 'pinned-one', title: 'Notes', updatedAt: iso(9 * D) },
  ];
  const d = M.docsFor({ ...registry.projects[0], docs: ['pinned-one.md'] }, docs);
  ok(d.map((x) => x.id).join() === 'pinned-one,dryager-playbook', 'pinned first, then keyword hits');
  const feed = M.feedOf({
    findings: [{ id: 'f1', at: iso(H), project: 'dryager-panel', kind: 'found', text: 'stale leads' }, { id: 'f2', at: iso(0), project: '', kind: 'control', text: 'paused' }],
    tasks: [{ id: '9', status: 'done', title: 'Ship it', project: 'dryager-panel', updatedAt: iso(2 * H) }, { id: '10', status: 'running', title: 'busy' }],
  });
  ok(feed.map((f) => f.id).join() === 'f2,f1,t:9', 'findings + finished tasks, newest first');
  ok(M.feedOf({ findings: feed, projectIds: new Set(['dryager-panel']) }).every((f) => f.project === 'dryager-panel'), 'scoped to a company');
  ok(M.lastFinding([{ project: 'p', kind: 'control', text: 'x', at: iso(0) }, { project: 'p', kind: 'found', text: 'y', at: iso(H) }], 'p').text === 'y', 'last finding skips control lines');
}

console.log('what Mia is told');
{
  ok(M.miaLine({ action: 'level', project: 'dryager-panel', level: 3 }, registry) ===
    'HQ: set Dry-ager panel (dryager-panel) autonomy to Fix with undo (level 3, was Suggest). Saved to the Jarvis registry.', 'level line');
  ok(M.miaLine({ action: 'pause' }, registry).startsWith('HQ: Jarvis pause.'), 'pause line');
  ok(M.miaLine({ action: 'pitch', value: 'quieter' }, registry).includes('every other day'), 'pitch line names the new rate');
  ok(M.miaLine({ action: 'scout', project: 'crystal-garden' }, registry).startsWith('HQ: scout Crystal Garden (crystal-garden) now.'), 'scout line');
}

console.log('board');
{
  const view = { registry: M.overlay(registry), tasks: [{ id: '1', project: 'dryager-panel', status: 'running', title: 'x' }], findings: [], match: () => null };
  const cos = view.registry.companies.map((c) => M.companyInfo(c, view, [], NOW));
  ok(cos[0].running === 1 && cos[0].projects[0].running.length === 1, 'running task on the card');
  const s = M.boardSummary(cos);
  ok(s.projects === 2 && s.up === 1 && s.watched === 1 && s.running === 1, 'board summary');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
