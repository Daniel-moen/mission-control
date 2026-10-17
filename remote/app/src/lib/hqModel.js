// Jarvis HQ — the pure half (task 0199). No React, no store, no DOM: just the
// shaping of what the Mac pushed (GET /api/v1/jarvis) plus the live snapshot
// into what HQ draws. Kept import-free so test/hq-model-test.mjs runs it in
// plain Node. The state side (fetching, controls, telling Mia) is lib/hq.js.
//
// Source of truth: ~/.mission-control/mia/jarvis/registry.json on the Mac
// (scripts/mia-jarvis; schema in its README). The relay holds the last pushed
// copy and the controls Daniel tapped that the Mac hasn't applied yet; HQ
// shows those optimistically (overlay) with a quiet "syncing" mark.

export const LEVELS = [
  { value: 0, key: 'off', label: 'Off', short: 'Off', hint: 'Nothing proactive' },
  { value: 1, key: 'watch', label: 'Watch', short: 'Watch', hint: 'Health alerts only' },
  { value: 2, key: 'suggest', label: 'Suggest', short: 'Suggest', hint: 'Pitches fixes, waits for your tap' },
  { value: 3, key: 'fix', label: 'Fix with undo', short: 'Fix', hint: 'Safe fixes on her own, one-tap undo' },
];
export const levelOf = (v) => LEVELS.find((l) => l.value === Number(v)) || LEVELS[2];

export const PITCH_STEPS = [0.14, 0.5, 1, 2, 3];
const PITCH_LABEL = { 0.14: 'About once a week', 0.5: 'Every other day', 1: 'Once a day', 2: 'Twice a day', 3: 'Three a day' };
export const pitchLabel = (v) => PITCH_LABEL[v] || `${v} a day`;
export function stepPitch(cur, how) {
  const c = Number(cur);
  let i = PITCH_STEPS.reduce((best, s, k) => (Math.abs(s - c) < Math.abs(PITCH_STEPS[best] - c) ? k : best), 2);
  if (how === 'quieter') i = Math.max(0, i - 1);
  if (how === 'louder') i = Math.min(PITCH_STEPS.length - 1, i + 1);
  return PITCH_STEPS[i];
}

const OPEN = new Set(['queued', 'asking', 'running', 'checking']);
export const isOpenTask = (t) => OPEN.has(t?.status);

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const ts = (iso) => {
  const n = Date.parse(iso || '');
  return Number.isFinite(n) ? n : 0;
};

// ---- the registry, with Daniel's not-yet-applied taps on top ----------------
// pending: relay queue + this device's own just-sent controls. Applied in
// order, so the last tap wins; each project/flag it touched is marked so the
// view can show "syncing" until the Mac confirms.
export function overlay(registry, pending = []) {
  if (!registry || typeof registry !== 'object') return null;
  const reg = {
    ...registry,
    jarvis: { paused: false, pitchesPerDay: 1, ...(registry.jarvis || {}) },
    companies: arr(registry.companies),
    projects: arr(registry.projects).map((p) => ({ ...p, autonomy: Number.isInteger(p.autonomy) ? p.autonomy : 2 })),
  };
  const sync = { projects: {}, paused: false, pitch: false };
  for (const c of pending || []) {
    if (!c || typeof c !== 'object') continue;
    if (c.action === 'level') {
      const p = reg.projects.find((x) => x.id === c.project);
      if (p) {
        p.autonomy = Number(c.level);
        sync.projects[p.id] = { ...(sync.projects[p.id] || {}), level: true };
      }
    } else if (c.action === 'scout') {
      const p = reg.projects.find((x) => x.id === c.project);
      if (p) {
        p.scoutRequestedAt = c.at || new Date().toISOString();
        sync.projects[p.id] = { ...(sync.projects[p.id] || {}), scout: true };
      }
    } else if (c.action === 'pause' || c.action === 'resume') {
      reg.jarvis = { ...reg.jarvis, paused: c.action === 'pause' };
      sync.paused = true;
    } else if (c.action === 'pitch') {
      reg.jarvis = { ...reg.jarvis, pitchesPerDay: stepPitch(reg.jarvis.pitchesPerDay, c.value) };
      sync.pitch = true;
    } else if (c.action === 'action') {
      const k = `${c.company}/${c.actionId}`;
      sync.actions = { ...(sync.actions || {}), [k]: c.at || new Date().toISOString() };
    }
  }
  reg.sync = sync;
  return reg;
}

// ---- tasks → projects -------------------------------------------------------
// The Mac tags every task it pushes (`project`); tasks newer than its last
// push (straight from the live snapshot) go through the same rules here.
// Mirrors matcher() in scripts/mia-jarvis: a folder under `dirs` (or a
// `-suffix` worktree of it) beats a keyword in the title, which beats a
// `fallbackDirs` folder; the longest hit wins.
const HOME_RE = /^~(?=\/|$)/;
export function makeMatcher(projects, home = '') {
  const norm = (d) => String(d || '').replace(HOME_RE, home).replace(/\/+$/, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = arr(projects).map((p) => {
    const m = p.match || {};
    return {
      id: p.id,
      dirs: (m.dirs || []).map(norm).filter(Boolean),
      fb: (m.fallbackDirs || []).map(norm).filter(Boolean),
      kws: (m.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean),
    };
  });
  const under = (dir, d) => dir === d || dir.startsWith(d + '/') || dir.startsWith(d + '-');
  return (task) => {
    const dir = norm(task?.dir);
    const title = String(task?.title || '').toLowerCase();
    let best = null;
    let score = 0;
    for (const r of rules) {
      let s = 0;
      for (const d of r.dirs) if (dir && under(dir, d)) s = Math.max(s, 100 + d.length);
      for (const k of r.kws) {
        if (new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9])`).test(title)) s = Math.max(s, 50 + k.length);
      }
      for (const d of r.fb) if (dir && under(dir, d)) s = Math.max(s, 10);
      if (s > score) {
        best = r.id;
        score = s;
      }
    }
    return best;
  };
}

// The Mac's slim tasks (45 days, project-tagged) merged with the snapshot's
// live ones (fresher status). Live wins on status/title; the Mac's tag wins on
// project, else the matcher decides.
export function mergeTasks(macTasks, liveTasks, match) {
  const by = new Map();
  for (const t of arr(macTasks)) by.set(String(t.id), { ...t });
  for (const t of arr(liveTasks)) {
    const id = String(t.id || '');
    if (!id) continue;
    const prev = by.get(id);
    by.set(id, {
      ...(prev || {}),
      id,
      title: t.title ?? prev?.title ?? '',
      status: t.status ?? prev?.status ?? '',
      dir: t.dir ?? prev?.dir,
      createdAt: t.createdAt ?? prev?.createdAt,
      updatedAt: t.updatedAt ?? prev?.updatedAt,
      result: typeof t.result === 'string' ? t.result : prev?.result || '',
      project: prev?.project ?? null,
    });
  }
  const out = [...by.values()];
  for (const t of out) if (!t.project && match) t.project = match(t);
  return out.sort((a, b) => ts(b.updatedAt || b.createdAt) - ts(a.updatedAt || a.createdAt));
}

// ---- numbers ------------------------------------------------------------------
// Change over the history: last value against the one ~a week back (or the
// oldest we have). `good` is true when it moved the way this metric wants.
export function trendOf(metric) {
  const h = arr(metric?.history).filter((p) => Number.isFinite(Number(p.v)));
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const lt = ts(last.t);
  const target = lt - 7 * 86400e3;
  let base = h[0];
  for (const p of h) if (ts(p.t) <= target) base = p;
  if (base === last) base = h[h.length - 2];
  const a = Number(base.v);
  const b = Number(last.v);
  const delta = b - a;
  if (!delta) return { dir: 'flat', delta: 0, pct: 0, good: null };
  const dir = delta > 0 ? 'up' : 'down';
  const better = metric.better === 'down' ? 'down' : 'up';
  return { dir, delta, pct: a ? (delta / Math.abs(a)) * 100 : null, good: dir === better };
}

// Uptime over the health samples (-1 = down) and the response-time series.
export function uptimeOf(health) {
  const samples = (Array.isArray(health?.recent) ? health.recent : []).filter((s) => Array.isArray(s) && s.length >= 2);
  if (!samples.length) return null;
  const up = samples.filter((s) => Number(s[1]) >= 0).length;
  return { pct: (100 * up) / samples.length, n: samples.length, since: samples[0][0] };
}
export function latencySeries(health, n = 48) {
  return (health?.recent || [])
    .filter((s) => Array.isArray(s))
    .slice(-n)
    .map((s) => Math.max(0, Number(s[1]) || 0));
}

export function fmtNum(v, unit = '') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s =
    a >= 1e6 ? `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e4 ? `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k` : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1);
  return unit ? (unit === '%' ? `${s}%` : `${s} ${unit}`) : s;
}

// The 2-3 numbers a card leads with: Mia's own metrics first (in registry
// order), then what the checker knows (uptime, response time), then tasks
// shipped in 30 days — so a project nobody has measured yet still says
// something true instead of showing dashes.
export function keyNumbers(project, tasks = [], max = 3, now = Date.now()) {
  const out = [];
  for (const m of arr(project?.metrics)) {
    if (m.value == null) continue;
    out.push({ key: m.name, label: m.label || m.name, value: fmtNum(m.value, m.unit), trend: trendOf(m), spark: arr(m.history).map((p) => Number(p.v)) });
  }
  const h = project?.health;
  const up = uptimeOf(h);
  if (up && up.n >= 2) out.push({ key: 'uptime', label: 'Uptime', value: `${up.pct >= 99.95 ? '100' : up.pct.toFixed(1)}%`, trend: null, auto: true });
  if (h && h.status !== 'down' && Number(h.ms) > 0) {
    const lat = latencySeries(h);
    out.push({ key: 'ms', label: 'Response', value: h.ms >= 1000 ? `${(h.ms / 1000).toFixed(1)} s` : `${h.ms} ms`, trend: null, spark: lat.length > 2 ? lat : null, auto: true });
  }
  const shipped = tasks.filter((t) => t.status === 'done' && now - ts(t.updatedAt) < 30 * 86400e3).length;
  out.push({ key: 'shipped', label: 'Shipped 30d', value: String(shipped), trend: null, auto: true });
  return out.slice(0, max);
}

// ---- health ---------------------------------------------------------------------
// 'up' | 'slow' | 'down' | 'stale' (no check for >1h) | 'none' (nothing to check).
export function healthOf(project, now = Date.now()) {
  const h = project?.health;
  if (!project?.healthcheck && !h) return { status: 'none', label: 'Not monitored' };
  if (!h || !h.checkedAt) return { status: 'unknown', label: 'Not checked yet' };
  const age = now - ts(h.checkedAt);
  if (h.status === 'down') return { status: 'down', label: h.error ? `Down · ${h.error}` : 'Down', since: h.since };
  if (age > 3600e3) return { status: 'stale', label: 'Last check over an hour ago', since: h.checkedAt };
  if (h.status === 'slow') return { status: 'slow', label: `Slow · ${h.ms} ms`, since: h.since };
  return { status: 'up', label: 'Up', since: h.since };
}

// Worst first: what a company badge shows.
const RANK = { down: 4, slow: 3, stale: 2, unknown: 1, up: 0, none: -1 };
export function worstHealth(list) {
  let w = { status: 'none' };
  for (const h of list) if ((RANK[h.status] ?? -1) > (RANK[w.status] ?? -1)) w = h;
  return w;
}

// ---- questions + docs -----------------------------------------------------------
// A question belongs to a project through its task, else by keyword.
export function questionsFor(projectId, questions, tasks, match) {
  const taskProject = new Map(tasks.map((t) => [String(t.id), t.project]));
  return arr(questions).filter((q) => {
    if (q.taskId && taskProject.has(String(q.taskId))) return taskProject.get(String(q.taskId)) === projectId;
    return match ? match({ title: q.text }) === projectId : false;
  });
}

export function docsFor(project, docs) {
  const pinned = new Set((project?.docs || []).map((d) => String(d).replace(/\.md$/, '')));
  const kws = (project?.match?.keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 4);
  const name = String(project?.name || '').toLowerCase();
  const hits = [];
  for (const d of arr(docs)) {
    const id = String(d.id || '').replace(/\.md$/, '');
    const hay = `${d.title || ''} ${d.subject || ''} ${(d.tags || []).join(' ')} ${id}`.toLowerCase();
    const pin = pinned.has(id);
    if (pin || (name.length >= 4 && hay.includes(name)) || kws.some((k) => hay.includes(k))) hits.push({ ...d, pinned: pin });
  }
  return hits.sort((a, b) => Number(b.pinned) - Number(a.pinned) || ts(b.updatedAt) - ts(a.updatedAt));
}

// ---- activity feed --------------------------------------------------------------
// Findings (found / fixed / shipped / health / control / scout) and finished
// tasks, newest first. kind decides the glyph and tone in the view.
export function feedOf({ findings = [], tasks = [], projectIds = null, companyId = null, limit = 60 } = {}) {
  const inScope = (pid) => !projectIds || projectIds.has(pid);
  const items = [];
  for (const f of arr(findings)) {
    // A company-wide line (an action button, task 0204) carries `company`.
    if (projectIds && !inScope(f.project) && !(companyId && f.company === companyId)) continue;
    items.push({ id: f.id || `f:${f.at}:${f.text}`, at: f.at, project: f.project || '', kind: f.kind || 'note', text: f.text || '', by: f.by || 'mia' });
  }
  for (const t of arr(tasks)) {
    if (!(t.status === 'done' || t.status === 'failed')) continue;
    if (projectIds && !inScope(t.project)) continue;
    items.push({ id: `t:${t.id}`, at: t.updatedAt, project: t.project || '', kind: t.status === 'done' ? 'shipped' : 'failed', text: t.title, task: t.id, by: 'mia' });
  }
  return items.sort((a, b) => ts(b.at) - ts(a.at)).slice(0, limit);
}

export function lastFinding(findings, projectId) {
  let best = null;
  for (const f of arr(findings)) {
    if (f.project !== projectId) continue;
    if (!['found', 'fixed', 'shipped', 'scout', 'health', 'note'].includes(f.kind)) continue;
    if (!best || ts(f.at) >= ts(best.at)) best = f;
  }
  return best;
}

// ---- what Mia is told ---------------------------------------------------------------
// The [MC] line each control sends through the existing chat path. Written
// for Mia: what changed, from where, and that it's already saved.
export function miaLine(c, reg) {
  const p = reg?.projects?.find((x) => x.id === c.project);
  const name = p ? `${p.name} (${p.id})` : c.project;
  switch (c.action) {
    case 'level': {
      const lv = levelOf(c.level);
      const was = p ? levelOf(p.autonomy) : null;
      return `HQ: set ${name} autonomy to ${lv.label} (level ${lv.value}${was && was.value !== lv.value ? `, was ${was.label}` : ''}). Saved to the Jarvis registry.`;
    }
    case 'pause':
      return 'HQ: Jarvis pause. Stop everything proactive (scouting, pitches, auto-fixes) until I resume. Saved to the Jarvis registry.';
    case 'resume':
      return 'HQ: Jarvis resume. Proactive mode back on. Saved to the Jarvis registry.';
    case 'pitch':
      return `HQ: ${c.value === 'quieter' ? 'quieter' : 'louder'}. Pitch ${pitchLabel(stepPitch(reg?.jarvis?.pitchesPerDay ?? 1, c.value)).toLowerCase()} from now on. Saved to the Jarvis registry.`;
    case 'scout':
      return `HQ: scout ${name} now. Look at its numbers and health and tell me what you find.`;
    case 'action':
      return actionLine(c, reg);
    default:
      return '';
  }
}

export function fmtWhen(iso, now = Date.now()) {
  const t = ts(iso);
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---- one project / one company, everything a card needs -------------------------
// view: useHQView()'s { registry, tasks, findings, match }; questions: Mia's
// open questions from the snapshot.
export function projectInfo(project, view, questions = [], now = Date.now()) {
  const tasks = arr(view?.tasks).filter((t) => t.project === project.id);
  return {
    project,
    health: healthOf(project, now),
    numbers: keyNumbers(project, tasks, 3, now),
    running: tasks.filter(isOpenTask),
    tasks,
    finding: lastFinding(view?.findings, project.id),
    questions: questionsFor(project.id, questions, arr(view?.tasks), view?.match),
    syncing: view?.registry?.sync?.projects?.[project.id] || null,
  };
}

export function companyInfo(company, view, questions = [], now = Date.now()) {
  const projects = arr(view?.registry?.projects)
    .filter((p) => p.company === company.id)
    .map((p) => projectInfo(p, view, questions, now));
  const tasks = companyTasks(company.id, projects.map((p) => p.project), view?.tasks);
  return {
    company,
    projects,
    tasks,
    health: worstHealth(projects.map((p) => p.health)),
    running: tasks.filter(isOpenTask).length,
    questions: projects.reduce((n, p) => n + p.questions.length, 0),
    down: projects.filter((p) => p.health.status === 'down').length,
  };
}

// Board headline: how many projects are up / down / unmonitored.
export function boardSummary(companies) {
  const all = companies.flatMap((c) => c.projects);
  const by = (s) => all.filter((p) => p.health.status === s).length;
  return {
    projects: all.length,
    up: by('up') + by('slow'),
    down: by('down'),
    watched: all.filter((p) => p.health.status !== 'none').length,
    running: all.reduce((n, p) => n + p.running.length, 0),
    questions: all.reduce((n, p) => n + p.questions.length, 0),
  };
}


// ---- company-centric (task 0204) ---------------------------------------------
// The Mac (schema 2) files every Library doc and task under a company and
// sends what Mia knows about each one with its source. An older Mac sends
// neither: then docs come from the snapshot + docsFor() keywords, tasks from
// their project, and Knowledge says so instead of looking empty.

const stem = (id) => String(id || '').replace(/\.md$/, '');

// Every doc filed under the company, newest first. macDocs: state.docs (Mac
// index, has company/project); snapDocs: the live snapshot's list (fresher
// titles/status, and the only source when the Mac is older).
export function companyDocs(companyId, projects, macDocs, snapDocs) {
  const out = new Map();
  const snap = new Map(arr(snapDocs).map((d) => [stem(d.id), d]));
  if (arr(macDocs).length) {
    for (const d of arr(macDocs)) {
      if (d.company !== companyId) continue;
      const s = snap.get(stem(d.id));
      out.set(stem(d.id), { ...d, ...(s ? { title: s.title || d.title, status: s.status || d.status, updatedAt: s.updatedAt || d.updatedAt, kind: s.kind || d.kind } : {}), id: s?.id || d.id });
    }
  } else {
    for (const p of arr(projects)) for (const d of docsFor(p, snapDocs)) if (!out.has(stem(d.id))) out.set(stem(d.id), { ...d, company: companyId, project: p.id, filedBy: 'keyword' });
  }
  return [...out.values()].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
}

// Docs nobody has filed yet (Library "Not filed" group).
export function unfiledDocs(macDocs) {
  return arr(macDocs).filter((d) => !d.company);
}

// Grouped for the Library tab: one group per project, then "Company-wide".
export function groupDocs(docs, projects) {
  const names = Object.fromEntries(arr(projects).map((p) => [p.id, p.name]));
  const groups = new Map();
  for (const d of docs) {
    const k = d.project && names[d.project] ? d.project : '';
    if (!groups.has(k)) groups.set(k, { id: k, label: k ? names[k] : 'Company-wide', docs: [] });
    groups.get(k).docs.push(d);
  }
  const order = arr(projects).map((p) => p.id);
  return [...groups.values()].sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : order.indexOf(a.id) - order.indexOf(b.id)));
}

// Tasks of a company: the Mac's tag (`company`), else via the project.
export function companyTasks(companyId, projects, tasks) {
  const pids = new Set(arr(projects).map((p) => p.id));
  return arr(tasks).filter((t) => (t.company ? t.company === companyId : pids.has(t.project)));
}

export const TASK_FILTERS = [
  { value: 'open', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];
export function filterTasks(tasks, f) {
  if (f === 'open') return tasks.filter(isOpenTask);
  if (f === 'done') return tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
  return tasks;
}

// Knowledge: facts with sources; grouped by where they came from.
export function companyKnowledge(companyId, knowledge) {
  if (!knowledge || typeof knowledge !== 'object') return null; // older Mac
  return arr(knowledge[companyId]);
}
export function filterFacts(facts, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return facts;
  return facts.filter((f) => `${f.text} ${f.section || ''} ${f.source?.title || ''} ${f.source?.file || ''}`.toLowerCase().includes(s));
}
export function groupFacts(facts) {
  const groups = new Map();
  for (const f of facts) {
    const src = f.source || {};
    const k = src.kind === 'doc' ? 'doc' : `m:${src.file || ''}:${f.section || ''}`;
    const label = src.kind === 'doc' ? 'From the Library' : f.section || src.file || 'Memory';
    if (!groups.has(k)) groups.set(k, { id: k, label, file: src.kind === 'doc' ? '' : src.file || '', facts: [] });
    groups.get(k).facts.push(f);
  }
  return [...groups.values()].sort((a, b) => (a.id === 'doc' ? 1 : b.id === 'doc' ? -1 : 0));
}
export function sourceLabel(src) {
  if (!src) return '';
  if (src.kind === 'doc') return src.title || src.id;
  return src.line ? `${src.file} · line ${src.line}` : src.file || '';
}

// ---- action buttons -------------------------------------------------------------
export const TIER_LABEL = { cheap: 'Haiku', mid: 'Sonnet', smart: 'Opus' };

export function actionsOf(company) {
  return arr(company?.actions).filter((a) => a.id && a.label && a.prompt);
}

export function missingInputs(action, inputs = {}) {
  return arr(action?.inputs).filter((i) => i.required !== false && !String(inputs[i.name] ?? '').trim());
}

export function renderPrompt(action, inputs = {}) {
  return String(action?.prompt || '').replace(/\{(\w+)\}/g, (m, k) => {
    const v = String(inputs[k] ?? '').trim();
    return v || m;
  });
}

// The [MC] line Mia gets: which company, which button, the job itself, and
// the tier the button suggests (Mia still decides how to dispatch).
export function actionLine(c, reg) {
  const co = arr(reg?.companies).find((x) => x.id === c.company);
  const a = actionsOf(co).find((x) => x.id === c.actionId);
  if (!co || !a) return '';
  const p = a.project ? arr(reg?.projects).find((x) => x.id === a.project) : null;
  const tier = a.tier ? ` Suggested tier: ${a.tier} (${TIER_LABEL[a.tier] || a.tier}).` : '';
  return `HQ action · ${co.name}${p ? ` · ${p.name}` : ''} · ${a.label}: ${renderPrompt(a, c.inputs || {})}${tier} Filed under ${co.id}${p ? `/${p.id}` : ''}.`;
}

// The last time each action was sent (findings kind 'action' + pending taps).
export function actionHistory(companyId, findings, sync) {
  const last = {};
  for (const f of arr(findings)) {
    if (f.kind !== 'action' || f.company !== companyId || !f.action) continue;
    if (!last[f.action] || ts(f.at) > ts(last[f.action].at)) last[f.action] = { at: f.at, text: f.text, inputs: f.inputs || {} };
  }
  for (const [k, at] of Object.entries(sync?.actions || {})) {
    const [co, id] = k.split('/');
    if (co === companyId && (!last[id] || ts(at) >= ts(last[id].at))) last[id] = { at, pending: true };
  }
  return last;
}

// ---- history charts ---------------------------------------------------------------
// One metric's history → points for an SVG area chart: x in [0,1] by time,
// y in [0,1] by value (with a little headroom), plus the labels the axis shows.
export function chartOf(metric, { maxPoints = 90 } = {}) {
  const h = arr(metric?.history)
    .map((p) => ({ t: ts(p.t), v: Number(p.v) }))
    .filter((p) => p.t && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t)
    .slice(-maxPoints);
  if (h.length < 2) return null;
  const t0 = h[0].t;
  const t1 = h[h.length - 1].t;
  let lo = Math.min(...h.map((p) => p.v));
  let hi = Math.max(...h.map((p) => p.v));
  if (hi === lo) {
    hi += Math.abs(hi) * 0.1 || 1;
    lo -= Math.abs(lo) * 0.1 || 1;
  }
  const pad = (hi - lo) * 0.12;
  const y0 = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  const y1 = hi + pad;
  const span = t1 - t0 || 1;
  const points = h.map((p) => ({ ...p, x: (p.t - t0) / span, y: (p.v - y0) / (y1 - y0) }));
  return {
    points,
    min: Math.min(...h.map((p) => p.v)),
    max: Math.max(...h.map((p) => p.v)),
    first: points[0],
    last: points[points.length - 1],
    days: Math.max(1, Math.round(span / 86400e3)),
  };
}
