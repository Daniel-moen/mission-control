import test from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, taskCards, flow, crew, modelName, tailLine, describeTool, spendToday, cleanTitle } from '../../src/lib/model.ts';
import { parsePrompt, cleanScreen, stripAnsi } from '../../src/lib/screen.ts';

const iso = (ago) => new Date(Date.now() - ago).toISOString();
const mia = (over = {}) => ({ enabled: true, online: true, sessionId: 'mia-1', model: '', runningModel: '', restarts: 0, readUpTo: '', messages: [], tasks: [], pendingQuestions: [], oldQuestions: [], closedQuestions: {}, questionMaxAgeHours: 48, schedule: null, pushKey: '', jobs: null, ...over });

test('stages fold the task statuses into four lanes', () => {
  assert.equal(stageOf({ status: 'queued' }), 'queued');
  assert.equal(stageOf({ status: 'asking' }), 'queued');
  assert.equal(stageOf({ status: 'running' }), 'running');
  assert.equal(stageOf({ status: 'checking' }), 'checking');
  for (const s of ['done', 'failed', 'cancelled']) assert.equal(stageOf({ status: s }), 'done');
  assert.equal(stageOf({ status: 'something-new' }), 'queued');
});

test('task cards sum job cost and show the live tool call', () => {
  const m = mia({
    tasks: [{ id: '0001', title: 'Ship it (Daniel 9 Nov)', status: 'running', executor: { dispatchedAt: iso(60000), model: 'opus' } }],
    jobs: { jobs: [
      { id: 1, taskId: '0001', status: 'finished', costUsd: 1.5 },
      { id: 2, taskId: '0001', status: 'running', costUsd: 0.25, attempts: 2, tail: ['  Read src/a.ts', '  Bash cd ~/x && npm test'] },
    ] },
  });
  const [c] = taskCards(m);
  assert.equal(c.title, 'Ship it');
  assert.equal(c.cost, 1.75);
  assert.equal(c.now, 'Running tests');
  assert.equal(c.attempts, 2);
  assert.equal(c.model, 'opus');
});

test('flow puts asking first in queued and newest first in done', () => {
  const m = mia({ tasks: [
    { id: '1', status: 'queued', priority: 3 }, { id: '2', status: 'asking' },
    { id: '3', status: 'done', updatedAt: iso(5000) }, { id: '4', status: 'done', updatedAt: iso(1000) },
  ] });
  const f = flow(taskCards(m));
  assert.deepEqual(f.queued.map((c) => c.id), ['2', '1']);
  assert.deepEqual(f.done.map((c) => c.id), ['4', '3']);
});

test('crew: live executors, sessions, never Mia herself, no double counting', () => {
  const agents = [
    { id: 'mia-1', status: 'active', name: 'Mia' },
    { id: 'sess-a', status: 'active', name: 'exec session' },
    { id: 'b', status: 'idle', name: 'waiting one' },
    { id: 'c', status: 'done', name: 'finished' },
  ];
  const m = mia({ tasks: [{ id: '7', title: 'T7', status: 'running' }], jobs: { jobs: [{ id: 9, taskId: '7', status: 'running', sessionId: 'sess-a', tail: ['  Edit app/page.tsx'] }, { id: 8, status: 'finished' }] } });
  const c = crew(agents, m);
  assert.deepEqual(c.map((x) => x.key), ['agent:b', 'job:9']);
  assert.equal(c[1].doing, 'Editing page.tsx');
  assert.equal(c[1].name, 'T7');
});

test('model names', () => {
  assert.equal(modelName('opus'), 'Opus');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-fable-5-2'), 'Fable 5.2');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName(''), '');
});

test('tool lines read as sentences', () => {
  assert.deepEqual(tailLine('  Bash ls -la'), { tool: 'Bash', text: 'ls -la' });
  assert.equal(describeTool(tailLine('  WebSearch foo')), 'Searching the web');
  assert.equal(describeTool(tailLine('  mcp__spark__list emails')), 'spark · list');
  assert.equal(describeTool(tailLine('plain words')), 'plain words');
});

test('spend today counts live jobs and today’s finished ones', () => {
  const m = mia({ jobs: { jobs: [
    { id: 1, status: 'running', costUsd: 1 },
    { id: 2, status: 'finished', costUsd: 2, finishedAt: new Date().toISOString() },
    { id: 3, status: 'finished', costUsd: 5, finishedAt: '2020-01-01T00:00:00Z' },
  ] } });
  assert.deepEqual(spendToday(m), { total: 3, runs: 2 });
});

test('cleanTitle strips provenance', () => assert.equal(cleanTitle('Panel remake (Daniel 9 Nov)'), 'Panel remake'));

test('parsePrompt finds an AskUserQuestion menu', () => {
  const screen = ['How should I proceed?', '', '❯ 1. [ ] Fix it', '     Patch it', '  2. [ ] Rewrite', '  3. Chat about this', 'Enter to select · ↑/↓ to navigate'].join('\n');
  const p = parsePrompt(screen);
  assert.ok(p);
  assert.equal(p.question, 'How should I proceed?');
  assert.deepEqual(p.options.map((o) => o.label), ['Fix it', 'Rewrite', 'Chat about this']);
  assert.equal(p.options[0].desc, 'Patch it');
  assert.equal(parsePrompt('just text\n1. one'), null);
});

test('screen helpers', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(cleanScreen('hello\nworld\n\n'), 'hello\nworld');
});
