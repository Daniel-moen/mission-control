import { useShallow } from 'zustand/react/shallow';
import { motion } from 'motion/react';
import { useMC, miaTaskCancel, miaTaskSet, agentName, agentStatus, miaOpenQuestions } from '../src/lib/store.js';
import { QuestionCard } from '../v2/views/parts/Needs.jsx';
import { push, pop } from '../v2/lib/nav.js';
import { tap } from '../v2/lib/motion.js';
import { Dot, Empty, Group, Icon, Row, Select, useArm } from '../v2/ui/kit.jsx';
import Page from '../v2/shell/Page.jsx';

// v5 (task 0483): a task has its own page — the brief, where it runs, the
// executor agent, the result, every question and the whole log, and the
// actions (priority, cancel, queue again). Opened from the board, a #id chip
// in Mia's chat, search, HQ, or `mia panel open-task` (#task/<id>).

const LIVE = new Set(['queued', 'asking', 'running', 'checking']);
const LABEL = { queued: 'Queued', asking: 'Waiting on you', running: 'Running', checking: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const TONE = { asking: 'text-warn', running: 'text-accent', checking: 'text-mgr', failed: 'text-crit' };
const DOT = { asking: 'waiting', running: 'working', checking: 'working', failed: 'exited', cancelled: 'done', done: 'done', queued: 'done' };
const PRIORITIES = [
  { value: '1', label: 'P1 · highest' },
  { value: '2', label: 'P2' },
  { value: '3', label: 'P3 · normal' },
  { value: '4', label: 'P4' },
  { value: '5', label: 'P5 · lowest' },
];
const ms = (at) => {
  const t = typeof at === 'number' ? (at > 1e12 ? at : at * 1000) : Date.parse(at || '');
  return Number.isFinite(t) ? t : 0;
};
const when = (at) => (ms(at) ? new Date(ms(at)).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const clock = (at) => (ms(at) ? new Date(ms(at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

export default function Task({ params }) {
  const { t, agents, mia, miaLocal } = useMC(useShallow((s) => ({ t: (s.mia?.tasks || []).find((x) => x.id === params.id) || null, agents: s.agents, mia: s.mia, miaLocal: s.miaLocal })));
  const [armed, fire] = useArm();
  if (!t)
    return (
      <Page title={`Task ${params.id}`}>
        <Empty icon="tasks" title="Not on the board" hint="This task isn’t on Mia’s board any more (or hasn’t synced yet)." />
      </Page>
    );
  const live = LIVE.has(t.status);
  const ex = t.executor && typeof t.executor === 'object' ? t.executor : null;
  const exAgent = ex?.sessionId ? agents.find((a) => a.id === ex.sessionId) : null;
  const result = t.result == null ? '' : typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2);
  const questions = Array.isArray(t.questions) ? t.questions : [];
  const log = Array.isArray(t.log) ? t.log : [];
  const prio = Number(t.priority) || 3;
  // v5.1 (task 0486): a question waiting on Daniel is answered right here,
  // not a dead end that says "Waiting on you" with nothing to press
  const open = miaOpenQuestions(mia, miaLocal).filter((q) => String(q.taskId || '') === String(t.id));

  return (
    <Page title={t.title || 'Untitled task'} subtitle={null} maxW={860}>
      <div className="flex flex-col gap-6 pb-6" data-task-page={t.id}>
        <div className="flex flex-wrap items-center gap-2 text-[0.86rem]">
          <span className={`flex items-center gap-2 rounded-full bg-fill px-3 py-1.5 font-semibold ${TONE[t.status] || 'text-ink2'}`} data-task-status={t.status}>
            <Dot status={DOT[t.status] || 'done'} size={7} />
            {LABEL[t.status] || t.status}
          </span>
          <span className="v-num rounded-full bg-fill px-3 py-1.5 font-mono text-ink2">#{t.id}</span>
          <span className="v-num rounded-full bg-fill px-3 py-1.5 font-semibold text-ink2">P{prio}</span>
          {t.createdAt && <span className="text-ink3">Added {when(t.createdAt)}</span>}
        </div>

        {t.detail && t.detail !== t.title && (
          <section className="v-card p-5">
            <div className="v-eyebrow mb-2">Brief</div>
            <p className="whitespace-pre-wrap break-words text-[0.98rem] leading-relaxed text-ink">{t.detail}</p>
          </section>
        )}

        {(t.dir || ex) && (
          <Group title="Where it runs">
            {t.dir && (
              <Row icon="folder" label={String(t.dir).replace(/\/+$/, '').split('/').pop()} hint={t.dir} last={!ex} />
            )}
            {ex && (
              <Row
                icon="agents"
                label={exAgent ? agentName(exAgent) : ex.sessionId ? 'Executor session has ended' : ex.dispatchedAt ? 'Executor starting…' : 'Executor'}
                hint={exAgent ? exAgent.activity || agentStatus(exAgent) : ex.dispatchedAt ? `Dispatched ${when(ex.dispatchedAt)}` : ''}
                onClick={exAgent ? () => push('agent', { id: exAgent.id }) : undefined}
                last
                data-task-executor
              />
            )}
          </Group>
        )}

        {result && (
          <section className="v-card p-5">
            <div className="v-eyebrow mb-2">Result</div>
            <p className="whitespace-pre-wrap break-words text-[0.94rem] leading-relaxed text-ink2">{result}</p>
          </section>
        )}

        {open.length > 0 && (
          <section className="flex flex-col gap-3" data-task-asks>
            <div className="v-eyebrow px-1 text-warn">Waiting on you</div>
            {open.map((q) => (
              <QuestionCard key={q.questionId} q={q} />
            ))}
          </section>
        )}

        {questions.length > 0 && (
          <Group title="Questions">
            {questions.map((q, i) => (
              <div key={q.id || i} className={`px-4 py-3 ${i < questions.length - 1 ? 'v-hair-b' : ''}`}>
                <div className="text-[0.94rem] text-ink">{q.text}</div>
                <div className={`mt-1 text-[0.84rem] ${q.answer != null ? 'text-ink2' : 'text-warn'}`}>{q.answer != null ? `→ ${q.answer}` : 'Not answered yet'}</div>
              </div>
            ))}
          </Group>
        )}

        {log.length > 0 && (
          <Group title={`Log · ${log.length}`}>
            {log.map((l, i) => (
              <div key={i} className={`flex gap-3 px-4 py-2.5 text-[0.88rem] ${i < log.length - 1 ? 'v-hair-b' : ''}`}>
                <span className="v-num w-16 flex-none pt-px text-[0.76rem] text-ink3">{clock(l.at)}</span>
                <span className="min-w-0 break-words text-ink2">{l.text}</span>
              </div>
            ))}
          </Group>
        )}

        <div className="flex flex-wrap items-center gap-2.5" data-task-actions>
          {live && <Select label="Priority" value={String(prio)} onChange={(v) => miaTaskSet(t.id, 'priority', Number(v))} options={PRIORITIES} className="w-[160px]" />}
          {live && (
            <motion.button
              {...tap}
              onClick={() => fire(() => (miaTaskCancel(t.id), pop()))}
              className={`flex h-10 items-center gap-1.5 rounded-full px-4 text-[0.86rem] font-semibold ${armed ? 'bg-crit text-white' : 'bg-crit/12 text-crit'}`}
            >
              <Icon name="close" size={15} />
              {armed ? 'Tap again to cancel' : 'Cancel task'}
            </motion.button>
          )}
          {!live && t.status !== 'done' && (
            <motion.button {...tap} onClick={() => miaTaskSet(t.id, 'status', 'queued')} className="flex h-10 items-center gap-1.5 rounded-full bg-fill px-4 text-[0.86rem] font-semibold text-ink">
              <Icon name="retry" size={15} />
              Queue again
            </motion.button>
          )}
        </div>
      </div>
    </Page>
  );
}
