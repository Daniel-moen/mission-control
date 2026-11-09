// The agent-centred view of a snapshot. Pure functions only (unit-tested in
// test/unit/model.test.mjs), so every screen reads the same story:
//
//   crew      who is working right now: Mia, her headless executors (mia-core
//             jobs, with their live tool-call tail), and interactive sessions.
//   flow      Mia's tasks folded into four stages: queued → running →
//             checking → done (asking = queued + "needs you").
//   attention what is waiting on Daniel: Mia's questions (one tap) and agent
//             sessions parked at a menu or prompt.

import type { Agent, Job, Mia, MiaQuestion, MiaTask } from './types';

export type Stage = 'queued' | 'running' | 'checking' | 'done';
export const STAGES: Stage[] = ['queued', 'running', 'checking', 'done'];
export const STAGE_LABEL: Record<Stage, string> = { queued: 'Queued', running: 'Running', checking: 'Checking', done: 'Done' };

export function stageOf(t: Pick<MiaTask, 'status'>): Stage {
  switch (t.status) {
    case 'running':
      return 'running';
    case 'checking':
      return 'checking';
    case 'done':
    case 'failed':
    case 'cancelled':
      return 'done';
    default:
      return 'queued'; // queued, asking, anything new
  }
}

export const isLive = (j: Job) => j.status === 'running' || j.status === 'waiting';

// "opus" / "claude-opus-5-5" / "claude-fable-5-2" → "Opus" / "Opus 5.5" / "Fable 5.2"
export function modelName(m?: string | null): string {
  const s = String(m || '').toLowerCase();
  if (!s) return '';
  const fam = ['fable', 'opus', 'sonnet', 'haiku'].find((f) => s.includes(f));
  if (!fam) return m || '';
  const v = s.match(new RegExp(`${fam}-(\\d+)(?:-(\\d{1,2}))?(?:-|$)`));
  const name = fam[0].toUpperCase() + fam.slice(1);
  return v ? `${name} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : name;
}
export function modelTone(m?: string | null): 'opus' | 'fable' | 'sonnet' | 'haiku' | 'other' {
  const s = String(m || '').toLowerCase();
  return (['opus', 'fable', 'sonnet', 'haiku'].find((f) => s.includes(f)) as any) || 'other';
}

// All jobs per task (a task can run several turns/attempts as separate jobs).
export function jobsByTask(mia: Mia | null): Map<string, Job[]> {
  const out = new Map<string, Job[]>();
  for (const j of mia?.jobs?.jobs || []) {
    if (!j.taskId) continue;
    const list = out.get(j.taskId) || [];
    list.push(j);
    out.set(j.taskId, list);
  }
  return out;
}

// One tool-call line from a job tail ("  Bash cd ~/x && npm test") → { tool, text }.
export function tailLine(line?: string): { tool: string; text: string } | null {
  const s = String(line || '').trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z][A-Za-z0-9_]+)\s+([\s\S]*)$/);
  if (m && /^(Bash|Read|Edit|Write|Grep|Glob|WebFetch|WebSearch|Task|Agent|Skill|TodoWrite|NotebookEdit|Monitor|mcp__\w+)/.test(m[1]))
    return { tool: m[1], text: m[2].replace(/\s+/g, ' ').trim() };
  return { tool: '', text: s.replace(/\s+/g, ' ') };
}

// Human sentence for what a tool call does. Short, present tense.
export function describeTool(t: { tool: string; text: string } | null): string {
  if (!t) return '';
  const short = (x: string, n = 70) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);
  const file = (x: string) => x.split(/\s+/)[0].replace(/^.*\//, '');
  switch (t.tool) {
    case 'Bash': {
      const c = t.text.replace(/^cd\s+\S+\s*(&&|;)\s*/, '');
      if (/\b(pytest|npm (run )?test|node --test|jest|vitest|playwright)\b/.test(c)) return 'Running tests';
      if (/\b(npm|pnpm|yarn) (run )?build|next build|vite build|make\b/.test(c)) return 'Building';
      if (/\bgit (commit|push|merge|rebase)/.test(c)) return 'Committing';
      if (/\b(curl|wget)\b/.test(c)) return 'Fetching a URL';
      if (/\b(grep|rg|find|ls)\b/.test(c.split('|')[0])) return 'Searching the code';
      return `Running ${short(c, 56)}`;
    }
    case 'Read':
      return `Reading ${file(t.text)}`;
    case 'Edit':
    case 'NotebookEdit':
      return `Editing ${file(t.text)}`;
    case 'Write':
      return `Writing ${file(t.text)}`;
    case 'Grep':
    case 'Glob':
      return 'Searching the code';
    case 'WebSearch':
      return `Searching the web`;
    case 'WebFetch':
      return 'Reading a web page';
    case 'TodoWrite':
      return 'Updating the plan';
    case 'Task':
    case 'Agent':
      return 'Briefing a helper';
    case 'Skill':
      return `Using ${short(t.text, 40)}`;
    default:
      return t.tool ? `${t.tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}` : short(t.text);
  }
}

export interface TaskCard {
  task: MiaTask;
  id: string;
  title: string;
  stage: Stage;
  status: string;
  asking: boolean;
  failed: boolean;
  cancelled: boolean;
  model: string;
  cost: number;
  outputTokens: number;
  startedAt: number; // ms, 0 = not started
  finishedAt: number;
  live: Job | null;
  now: string; // what it is doing right now (one line)
  attempts: number;
  priority: number;
  updatedAt: number;
}

const ms = (iso?: string | null) => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function cleanTitle(t?: string) {
  // Mia often appends "(Daniel 9 Nov)" provenance; keep the card title tight.
  return String(t || '').replace(/\s*\((?:Daniel|from Daniel)[^)]*\)\s*$/i, '').trim();
}

export function taskCards(mia: Mia | null): TaskCard[] {
  if (!mia) return [];
  const byTask = jobsByTask(mia);
  return mia.tasks.map((t) => {
    const jobs = byTask.get(t.id) || [];
    const live = jobs.find(isLive) || null;
    const cost = jobs.reduce((n, j) => n + (Number(j.costUsd) || 0), 0);
    const out = jobs.reduce((n, j) => n + (Number(j.outputTokens) || 0), 0);
    const stage = stageOf(t);
    const lastLog = (t.log || []).slice(-1)[0]?.text || '';
    const tail = live?.tail?.length ? tailLine(live.tail[live.tail.length - 1]) : null;
    let now = '';
    if (t.status === 'asking') now = 'Waiting for your answer';
    else if (live?.status === 'waiting') now = live.waitReason ? `Paused: ${live.waitReason}` : 'Paused';
    else if (tail) now = describeTool(tail);
    else if (stage === 'checking') now = 'Mia is reviewing the result';
    else if (stage === 'running') now = 'Working';
    else now = lastLog;
    const started = ms(t.executor?.dispatchedAt) || Math.min(...jobs.map((j) => ms(j.startedAt) || Infinity).concat([Infinity]));
    return {
      task: t,
      id: t.id,
      title: cleanTitle(t.title) || `Task ${t.id}`,
      stage,
      status: String(t.status || 'queued'),
      asking: t.status === 'asking',
      failed: t.status === 'failed',
      cancelled: t.status === 'cancelled',
      model: t.executor?.model || live?.model || jobs[jobs.length - 1]?.model || '',
      cost,
      outputTokens: out,
      startedAt: Number.isFinite(started) ? started : 0,
      finishedAt: ms(t.executor?.finishedAt) || (stage === 'done' ? ms(t.updatedAt) : 0),
      live,
      now,
      attempts: Math.max(1, ...jobs.map((j) => Number(j.attempts) || 1)),
      priority: Number(t.priority) || 3,
      updatedAt: ms(t.updatedAt),
    };
  });
}

// Lanes in board order. Active lanes oldest-first (the one running longest
// leads); done newest-first.
export function flow(cards: TaskCard[]): Record<Stage, TaskCard[]> {
  const lanes: Record<Stage, TaskCard[]> = { queued: [], running: [], checking: [], done: [] };
  for (const c of cards) lanes[c.stage].push(c);
  lanes.queued.sort((a, b) => Number(b.asking) - Number(a.asking) || a.priority - b.priority || a.id.localeCompare(b.id));
  lanes.running.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  lanes.checking.sort((a, b) => a.updatedAt - b.updatedAt);
  lanes.done.sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));
  return lanes;
}

// ---- crew ---------------------------------------------------------------------
export type CrewKind = 'mia' | 'executor' | 'session';
export interface CrewMember {
  key: string;
  kind: CrewKind;
  name: string;
  model: string;
  state: 'working' | 'waiting' | 'paused' | 'idle' | 'exited';
  doing: string;
  cost: number;
  startedAt: number;
  progress: { done: number; total: number } | null;
  taskId?: string;
  agent?: Agent;
  job?: Job;
  tps: number;
}

export function agentState(a: Agent): CrewMember['state'] {
  if (a.alive === false && a.status !== 'done') return 'exited';
  return a.status === 'active' ? 'working' : a.status === 'idle' ? 'waiting' : 'idle';
}

export function todoProgress(a?: Agent) {
  const td = a?.todos || [];
  if (!td.length) return null;
  return { done: td.filter((t) => t.status === 'completed').length, total: td.length };
}

export function isMiaAgent(a: Agent, mia: Mia | null) {
  return a.isMia === true || (!!mia?.sessionId && a.id === mia.sessionId);
}

export function crew(agents: Agent[], mia: Mia | null): CrewMember[] {
  const out: CrewMember[] = [];
  const tasks = new Map((mia?.tasks || []).map((t) => [t.id, t]));
  const claimed = new Set<string>();
  for (const j of mia?.jobs?.jobs || []) {
    if (!isLive(j)) continue;
    const t = j.taskId ? tasks.get(j.taskId) : undefined;
    const a = agents.find((x) => x.id === j.sessionId);
    if (a) claimed.add(a.id);
    const tl = j.tail?.length ? tailLine(j.tail[j.tail.length - 1]) : null;
    out.push({
      key: `job:${j.id}`,
      kind: 'executor',
      name: t ? cleanTitle(t.title) || `Task ${t.id}` : j.beat ? `Heartbeat · ${j.beat}` : j.kind ? `${j.kind[0].toUpperCase()}${j.kind.slice(1)} job` : `Job ${j.id}`,
      model: j.model || '',
      state: j.status === 'waiting' ? 'paused' : 'working',
      doing: j.status === 'waiting' ? (j.waitReason ? `Paused: ${j.waitReason}` : 'Paused') : describeTool(tl) || 'Starting up',
      cost: Number(j.costUsd) || 0,
      startedAt: ms(j.startedAt),
      progress: a ? todoProgress(a) : null,
      taskId: j.taskId || undefined,
      agent: a,
      job: j,
      tps: a?.tokensPerSec || 0,
    });
  }
  for (const a of agents) {
    if (claimed.has(a.id)) continue;
    if (isMiaAgent(a, mia)) continue;
    const st = agentState(a);
    if (st === 'idle' && a.status === 'done') continue; // finished sessions live in Fleet
    const taskId = (mia?.tasks || []).find((t) => t.executor?.sessionId === a.id)?.id;
    out.push({
      key: `agent:${a.id}`,
      kind: 'session',
      name: a.name || a.folder || 'Session',
      model: a.model || '',
      state: st,
      doing: st === 'waiting' ? 'Waiting for input' : st === 'exited' ? 'Exited' : (a.activity || '').replace(/^—$/, '') || 'Working',
      cost: Number(a.cost) || 0,
      startedAt: 0,
      progress: todoProgress(a),
      taskId,
      agent: a,
      tps: a.tokensPerSec || 0,
    });
  }
  const rank = { waiting: 0, working: 1, paused: 2, exited: 3, idle: 4 } as const;
  out.sort((x, y) => rank[x.state] - rank[y.state] || x.startedAt - y.startedAt);
  return out;
}

// ---- spend ----------------------------------------------------------------------
// Today's spend from mia-core jobs (local day) + live interactive sessions.
export function spendToday(mia: Mia | null, now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let total = 0;
  let runs = 0;
  for (const j of mia?.jobs?.jobs || []) {
    const t = ms(j.finishedAt) || ms(j.startedAt);
    if (t >= start || isLive(j)) {
      total += Number(j.costUsd) || 0;
      runs += 1;
    }
  }
  return { total, runs };
}

// ---- attention ----------------------------------------------------------------
export interface AttentionItem {
  key: string;
  kind: 'question' | 'menu' | 'idle' | 'exited';
  question?: MiaQuestion;
  agent?: Agent;
  prompt?: { question: string; options: { n: number; label: string; desc?: string }[] } | null;
}

// ---- formatting -------------------------------------------------------------------
export function money(n: number) {
  if (!n) return '$0';
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}
export function elapsed(fromMs: number, now = Date.now()) {
  if (!fromMs) return '';
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}
export function ago(fromMs: number, now = Date.now()) {
  if (!fromMs) return '';
  const s = Math.round((now - fromMs) / 1000);
  if (s < 45) return 'just now';
  const e = elapsed(fromMs, now);
  return `${e.split(' ')[0]} ago`;
}
export function tokens(n: number) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}
