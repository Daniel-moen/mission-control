import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaTaskAdd, miaTaskCancel, miaTaskSet, miaSchedule, agentName, agentStatus } from '../../../src/lib/store.js';
import { dictate, speechSupported } from '../../../src/lib/speech.js';
import { push } from '../../lib/nav.js';
import { usePrefs } from '../../lib/prefs.js';
import { spring, tap } from '../../lib/motion.js';
import { Dot, Empty, Icon, Select, Toggle, useArm } from '../../ui/kit.jsx';
import { DirPicker } from '../Forms.jsx';

// Mia's task board. Live work first, in lifecycle order (queued → asking →
// running → checking), done after, failed and cancelled folded away as
// history. A card opens in place to show its brief, questions, log and the
// executor agent; priority and cancel are right there. The field on top is
// the fastest way to hand Mia a job (type or dictate).

const GROUPS = [
  { key: 'asking', label: 'Waiting on you', tone: 'text-warn' },
  { key: 'running', label: 'Running', tone: 'text-accent' },
  { key: 'checking', label: 'Checking', tone: 'text-mgr' },
  { key: 'queued', label: 'Queued', tone: 'text-ink2' },
  { key: 'done', label: 'Done', tone: 'text-ink2' },
];
const LIVE = new Set(['queued', 'asking', 'running', 'checking']);
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
const base = (d) => String(d || '').replace(/\/+$/, '').split('/').pop() || d;
const prio = (t) => Number(t.priority) || 3;
const clock = (at) => (ms(at) ? new Date(ms(at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

function Glyph({ status }) {
  if (status === 'running') return <Dot status="working" size={9} />;
  if (status === 'asking') return <Dot status="waiting" size={9} pulse={false} />;
  if (status === 'checking') return <span className="h-[9px] w-[9px] flex-none rounded-full bg-mgr" />;
  if (status === 'done') return <Icon name="check" size={15} strokeWidth={2.4} className="flex-none text-accent" />;
  if (status === 'failed') return <Icon name="alert" size={14} className="flex-none text-crit" />;
  if (status === 'cancelled') return <Icon name="ban" size={14} className="flex-none text-ink3" />;
  return <span className="h-[9px] w-[9px] flex-none rounded-full border-[1.5px] border-ink3" />;
}

function AddTask() {
  const [title, setTitle] = useState('');
  const [more, setMore] = useState(false);
  const [dir, setDir] = useState('');
  const [priority, setPriority] = useState('3');
  const [rec, setRec] = useState(false);
  const mic = useRef(null);
  useEffect(() => () => mic.current?.stop(), []);
  const toggleMic = () => {
    if (mic.current) return mic.current.stop();
    const stop = () => {
      mic.current = null;
      setRec(false);
    };
    mic.current = dictate({ base: title, onText: setTitle, onEnd: stop, onError: stop });
    setRec(!!mic.current);
  };
  const submit = (e) => {
    e?.preventDefault();
    mic.current?.stop();
    if (!title.trim()) return;
    if (miaTaskAdd({ title, dir, priority })) setTitle('');
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-add-task>
      <div className="flex items-center gap-2">
        <div className={`flex min-w-0 flex-1 items-center rounded-full border bg-card ${rec ? 'border-crit/50' : 'border-hair focus-within:border-hair2'}`}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task for Mia"
            aria-label="New task"
            className="h-11 min-w-0 flex-1 bg-transparent pl-4 text-[0.95rem] text-ink outline-none placeholder:text-ink3"
          />
          {speechSupported && (
            <button type="button" onClick={toggleMic} aria-label="Dictate task" className={`m-1 grid h-9 w-9 place-items-center rounded-full ${rec ? 'bg-crit text-white' : 'text-ink3 hover:text-ink'}`}>
              <Icon name="mic" size={17} />
            </button>
          )}
        </div>
        <motion.button
          {...tap}
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-label="Folder and priority"
          aria-pressed={more}
          className={`grid h-11 w-11 flex-none place-items-center rounded-full ${more || dir ? 'bg-ink text-page' : 'bg-fill text-ink2'}`}
        >
          <Icon name="folder" size={17} />
        </motion.button>
        <motion.button {...tap} type="submit" disabled={!title.trim()} aria-label="Add task" className="grid h-11 w-11 flex-none place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-35">
          <Icon name="plus" size={19} strokeWidth={2.4} />
        </motion.button>
      </div>
      <AnimatePresence initial={false}>
        {more && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="overflow-hidden">
            <div className="flex flex-col gap-2 pt-1">
              <DirPicker value={dir} onChange={setDir} />
              <Select label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} className="w-full" />
              <p className="px-2 text-[0.74rem] text-ink3">No folder → Mia decides where the work happens.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

function TaskCard({ t, agents, flash, cardRef }) {
  const reduce = usePrefs((s) => s.reduce);
  const [open, setOpen] = useState(false);
  const [armed, fire] = useArm();
  const live = LIVE.has(t.status);
  const ex = t.executor && typeof t.executor === 'object' ? t.executor : null;
  const exAgent = ex?.sessionId ? agents.find((a) => a.id === ex.sessionId) : null;
  const result = t.result == null ? '' : typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
  const questions = Array.isArray(t.questions) ? t.questions : [];
  const log = Array.isArray(t.log) ? t.log : [];
  useEffect(() => {
    if (flash) setOpen(true);
  }, [flash]);

  return (
    <motion.div
      ref={cardRef}
      layout={reduce ? false : 'position'}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={spring.layout}
      className={`v-card transition-shadow duration-500 ${flash ? 'ring-2 ring-accent/60' : ''}`}
      data-task={t.id}
      data-status={t.status}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((v) => !v))}
        className="flex cursor-pointer items-start gap-3 p-4"
      >
        <span className="mt-[7px] flex h-3 w-4 flex-none items-center justify-center">
          <Glyph status={t.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block break-words text-[0.98rem] font-semibold leading-snug tracking-[-0.01em] ${t.status === 'cancelled' ? 'text-ink3 line-through' : 'text-ink'}`}>
            {t.title || 'Untitled task'}
          </span>
          <span className="v-num mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.76rem] text-ink3">
            <span className="font-mono">#{t.id}</span>
            {t.dir && (
              <span className="flex min-w-0 items-center gap-1" title={t.dir}>
                <Icon name="folder" size={11} />
                <span className="truncate">{base(t.dir)}</span>
              </span>
            )}
            <span className={prio(t) === 1 ? 'font-bold text-ink2' : ''}>P{prio(t)}</span>
          </span>
        </span>
        {live && (
          <motion.button
            {...tap}
            onClick={(e) => {
              e.stopPropagation();
              fire(() => miaTaskCancel(t.id));
            }}
            aria-label={armed ? 'Tap again to cancel' : 'Cancel task'}
            className={`flex h-8 flex-none items-center rounded-full px-2.5 text-[0.76rem] font-semibold transition-colors ${armed ? 'bg-crit text-white' : 'text-ink3 hover:bg-fill hover:text-ink2'}`}
          >
            {armed ? 'Cancel?' : <Icon name="close" size={15} />}
          </motion.button>
        )}
      </div>

      {(ex || (t.status === 'done' && result)) && (
        <div className="-mt-1.5 flex flex-col gap-2 px-4 pb-4 pl-11">
          {ex &&
            (exAgent ? (
              <motion.button
                {...tap}
                onClick={() => push('agent', { id: exAgent.id })}
                className="flex max-w-full items-center gap-2 self-start rounded-full bg-fill py-1.5 pl-2.5 pr-2 text-[0.8rem] font-medium text-ink2 hover:text-ink"
              >
                <Dot status={agentStatus(exAgent)} size={7} />
                <span className="truncate">Executor · {agentName(exAgent)}</span>
                <Icon name="chevronRight" size={14} className="flex-none text-ink3" />
              </motion.button>
            ) : (
              <span className="text-[0.76rem] text-ink3">{ex.sessionId ? 'Executor session has ended' : ex.dispatchedAt ? 'Executor starting…' : null}</span>
            ))}
          {t.status === 'done' && result && <p className={`whitespace-pre-wrap break-words text-[0.86rem] leading-relaxed text-ink2 ${open ? '' : 'line-clamp-3'}`}>{result}</p>}
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="overflow-hidden">
            <div className="v-hair-t flex flex-col gap-3 px-4 py-3.5 pl-11 text-[0.86rem] leading-relaxed">
              {t.detail && t.detail !== t.title && <p className="whitespace-pre-wrap break-words text-ink2">{t.detail}</p>}
              {t.dir && <p className="break-all font-mono text-[0.74rem] text-ink3">{t.dir}</p>}
              {questions.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="v-eyebrow">Questions</span>
                  {questions.map((q, i) => (
                    <div key={q.id || i} className="text-ink2">
                      {q.text}
                      <span className="block text-ink3">{q.answer != null ? `→ ${q.answer}` : 'waiting on you'}</span>
                    </div>
                  ))}
                </div>
              )}
              {log.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="v-eyebrow">Log</span>
                  {log.slice(-6).map((l, i) => (
                    <div key={i} className="flex gap-2.5 text-ink3">
                      <span className="v-num w-14 flex-none text-[0.72rem]">{clock(l.at)}</span>
                      <span className="min-w-0 break-words text-ink2">{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {live && <Select label="Priority" value={String(prio(t))} onChange={(v) => miaTaskSet(t.id, 'priority', Number(v))} options={PRIORITIES} className="w-[150px]" />}
                {!live && t.status !== 'done' && (
                  <motion.button {...tap} onClick={() => miaTaskSet(t.id, 'status', 'queued')} className="flex h-9 items-center gap-1.5 rounded-full bg-fill px-3.5 text-[0.8rem] font-semibold text-ink">
                    <Icon name="retry" size={14} />
                    Queue again
                  </motion.button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Schedule({ schedule }) {
  const [open, setOpen] = useState(false);
  const hbs = Array.isArray(schedule?.heartbeats) ? schedule.heartbeats : [];
  const rems = (Array.isArray(schedule?.reminders) ? schedule.reminders : []).filter((r) => !r.fired);
  if (!hbs.length && !rems.length) return null;
  return (
    <section className="pt-2">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-2 text-left" aria-expanded={open}>
        <span className="text-[0.92rem] font-bold text-ink">Schedule</span>
        <span className="v-num text-[0.86rem] text-ink3">{hbs.length + rems.length}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} className="ml-auto text-ink3" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="overflow-hidden">
            <div className="v-card mb-2 overflow-hidden">
              {hbs.map((h, i) => (
                <div key={h.id} className={`flex items-center gap-3 px-4 py-3 ${i < hbs.length + rems.length - 1 ? 'v-hair-b' : ''}`}>
                  <Icon name="clock" size={16} className="flex-none text-ink3" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[0.9rem] font-medium ${h.enabled === false ? 'text-ink3' : 'text-ink'}`}>{h.label || h.id}</span>
                    <span className="block text-[0.74rem] text-ink3">{h.at ? `Daily at ${h.at}` : h.everyMinutes ? `Every ${h.everyMinutes} min` : ''}</span>
                  </span>
                  <Toggle on={h.enabled !== false} label={h.label || h.id} onChange={() => miaSchedule('setHeartbeat', { ...h, enabled: h.enabled === false })} />
                </div>
              ))}
              {rems.map((r, i) => (
                <div key={r.id} className={`flex items-center gap-3 px-4 py-3 ${hbs.length + i < hbs.length + rems.length - 1 ? 'v-hair-b' : ''}`}>
                  <Icon name="bell" size={16} className="flex-none text-ink3" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[0.9rem] text-ink">{r.text}</span>
                    <span className="block text-[0.74rem] text-ink3">{ms(r.at) ? new Date(ms(r.at)).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : r.at}</span>
                  </span>
                  <button onClick={() => miaSchedule('removeReminder', { id: r.id })} aria-label="Remove reminder" className="grid h-8 w-8 flex-none place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink">
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export default function Tasks({ mia, focus }) {
  const agents = useMC((s) => s.agents);
  const [history, setHistory] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const refs = useRef(new Map());
  const [flash, setFlash] = useState(null);

  const grouped = useMemo(() => {
    const g = { queued: [], asking: [], running: [], checking: [], done: [], history: [] };
    for (const t of mia.tasks) {
      if (!t || !t.id) continue;
      if (g[t.status]) g[t.status].push(t);
      else if (t.status === 'failed' || t.status === 'cancelled') g.history.push(t);
      else g.queued.push(t);
    }
    const byPrio = (a, b) => prio(a) - prio(b) || ms(a.createdAt) - ms(b.createdAt);
    const byRecent = (a, b) => ms(b.updatedAt) - ms(a.updatedAt);
    for (const k of ['queued', 'asking', 'running', 'checking']) g[k].sort(byPrio);
    g.done.sort(byRecent);
    g.history.sort(byRecent);
    return g;
  }, [mia.tasks]);

  // `mia panel open-task`, a #id chip in the thread, search: show that card.
  useEffect(() => {
    if (!focus?.id) return undefined;
    const t = mia.tasks.find((x) => x.id === focus.id);
    if (t && (t.status === 'failed' || t.status === 'cancelled')) setHistory(true);
    if (t && t.status === 'done') setAllDone(true);
    const raf = requestAnimationFrame(() => {
      refs.current.get(focus.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(focus.id);
    });
    const off = setTimeout(() => setFlash(null), 1800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  const card = (t) => (
    <TaskCard key={t.id} t={t} agents={agents} flash={flash === t.id} cardRef={(el) => (el ? refs.current.set(t.id, el) : refs.current.delete(t.id))} />
  );

  return (
    <div className="flex flex-col gap-5 pb-4" data-tasks>
      <AddTask />
      {!mia.tasks.length ? (
        <Empty icon="tasks" title="No tasks yet" hint="Add one above or just tell Mia in the chat. She picks the folder, briefs an agent, and checks the work." />
      ) : (
        GROUPS.map(({ key, label, tone }) => {
          let list = grouped[key];
          if (!list.length) return null;
          const hidden = key === 'done' && !allDone ? Math.max(0, list.length - 5) : 0;
          if (hidden) list = list.slice(0, 5);
          return (
            <section key={key} data-group={key}>
              <div className="mb-2 flex items-baseline gap-2 px-1">
                <h3 className={`text-[0.92rem] font-bold ${tone}`}>{label}</h3>
                <span className="v-num text-[0.86rem] text-ink3">{grouped[key].length}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                <AnimatePresence initial={false} mode="popLayout">
                  {list.map(card)}
                </AnimatePresence>
              </div>
              {(hidden > 0 || (key === 'done' && allDone && grouped.done.length > 5)) && (
                <button onClick={() => setAllDone((v) => !v)} className="mt-2.5 px-1 text-[0.82rem] font-semibold text-ink3 hover:text-ink2">
                  {allDone ? 'Show fewer' : `Show ${hidden} more`}
                </button>
              )}
            </section>
          );
        })
      )}
      {grouped.history.length > 0 && (
        <section>
          <button onClick={() => setHistory((v) => !v)} className="flex w-full items-center gap-2 px-1 py-1 text-left" aria-expanded={history}>
            <span className="text-[0.92rem] font-bold text-ink3">Failed &amp; cancelled</span>
            <span className="v-num text-[0.86rem] text-ink3">{grouped.history.length}</span>
            <Icon name={history ? 'chevronUp' : 'chevronDown'} size={16} className="ml-auto text-ink3" />
          </button>
          <AnimatePresence initial={false}>
            {history && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="overflow-hidden">
                <div className="flex flex-col gap-2.5 pt-2">{grouped.history.map(card)}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
      <Schedule schedule={mia.schedule} />
    </div>
  );
}
