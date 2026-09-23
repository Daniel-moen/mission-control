import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaTaskAdd, miaTaskCancel, miaTaskSet, miaSchedule, agentName, agentStatus, allDirs } from '../../lib/store.js';
import { dictate, speechSupported } from '../../lib/speech.js';
import { spring, press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Select from '../../ui/Select.jsx';
import StatusDot from '../../ui/StatusDot.jsx';
import EmptyState from '../../ui/EmptyState.jsx';

// Mia's task list as a board: one column of groups in lifecycle order, each
// card a frosted chip. Failed and cancelled fold away — they're history, not
// work. The add field at the top is the fastest way to hand Mia a job.

const GROUPS = [
  { key: 'queued', label: 'Queued' },
  { key: 'asking', label: 'Asking' },
  { key: 'running', label: 'Running' },
  { key: 'checking', label: 'Checking' },
  { key: 'done', label: 'Done' },
];
const LIVE = new Set(['queued', 'asking', 'running', 'checking']);
const OTHER = '__other';
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

// Status glyph — colour means the same thing it means everywhere else.
function Glyph({ status }) {
  if (status === 'running') return <StatusDot status="working" size={8} />;
  if (status === 'asking') return <StatusDot status="waiting" size={8} pulse={false} />;
  if (status === 'checking') return <span className="h-2 w-2 flex-none rounded-full bg-mgr" />;
  if (status === 'done') return <Icon name="check" size={14} className="flex-none text-ink2" />;
  if (status === 'failed') return <Icon name="alert" size={13} className="flex-none text-crit" />;
  if (status === 'cancelled') return <Icon name="ban" size={13} className="flex-none text-ink3" />;
  return <span className="h-2 w-2 flex-none rounded-full border border-ink3" />;
}

// ---------------------------------------------------------------------------

function AddTask() {
  const knownDirs = useMC((s) => s.knownDirs);
  const localDirs = useMC((s) => s.localDirs);
  const dirs = useMemo(() => allDirs(), [knownDirs, localDirs]);

  const [title, setTitle] = useState('');
  const [more, setMore] = useState(false);
  const [dir, setDir] = useState('');
  const [other, setOther] = useState(false);
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
    if (!miaTaskAdd({ title, dir, priority })) return;
    setTitle('');
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task for Mia…"
            className={`glass-soft h-10 w-full rounded-full pl-4 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-glass-line2 ${
              speechSupported ? 'pr-10' : 'pr-4'
            } ${rec ? 'border-crit/50' : ''}`}
          />
          {speechSupported && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label="Dictate task"
              className={`absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full transition-colors ${
                rec ? 'anim-pulse bg-crit/15 text-crit' : 'text-ink3 hover:text-ink2'
              }`}
            >
              <Icon name="mic" size={15} />
            </button>
          )}
        </div>
        <motion.button
          {...press}
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-label="Folder and priority"
          aria-pressed={more}
          className={`pill grid h-10 w-10 flex-none place-items-center transition-colors ${
            more || dir ? 'bg-white/[0.14] text-ink' : 'glass-soft glass-soft-hover text-ink2'
          }`}
        >
          <Icon name="folder" size={16} />
        </motion.button>
        <motion.button
          {...press}
          type="submit"
          disabled={!title.trim()}
          aria-label="Add task"
          className="pill grid h-10 w-10 flex-none place-items-center bg-ink text-bg transition-opacity disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon name="plus" size={17} />
        </motion.button>
      </div>

      <AnimatePresence initial={false}>
        {more && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 pt-0.5">
              <div className="flex gap-2">
                <Select
                  className="min-w-0 flex-1 font-mono"
                  aria-label="Project folder"
                  value={other ? OTHER : dir}
                  onChange={(v) => {
                    if (v === OTHER) {
                      setOther(true);
                      setDir('');
                    } else {
                      setOther(false);
                      setDir(v);
                    }
                  }}
                  options={[
                    { value: '', label: 'Any folder — Mia decides' },
                    ...dirs.map((d) => ({ value: d, label: d })),
                    { value: OTHER, label: 'Other folder…' },
                  ]}
                />
                <Select className="w-[124px] flex-none" aria-label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} />
              </div>
              {other && (
                <input
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="~/path/to/project"
                  className="glass-soft h-10 w-full rounded-xl2 px-3.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink3 focus:border-glass-line2"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

// ---------------------------------------------------------------------------

function TaskCard({ t, agents, onOpenAgent, flash, cardRef }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const live = LIVE.has(t.status);
  const ex = t.executor && typeof t.executor === 'object' ? t.executor : null;
  const exAgent = ex?.sessionId ? agents.find((a) => a.id === ex.sessionId) : null;
  const result = t.result == null ? '' : typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
  const questions = Array.isArray(t.questions) ? t.questions : [];
  const log = Array.isArray(t.log) ? t.log : [];

  const cancel = (e) => {
    e.stopPropagation();
    if (armed) {
      clearTimeout(timer.current);
      setArmed(false);
      miaTaskCancel(t.id);
    } else {
      setArmed(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(false), 3000);
    }
  };

  return (
    <motion.div
      ref={cardRef}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring.smooth}
      className={`glass-soft rounded-xl3 transition-[border-color,box-shadow] duration-500 ${flash ? 'border-glass-line2 ring-1 ring-white/30' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((v) => !v))}
        className="flex cursor-pointer items-start gap-2.5 p-3.5"
      >
        <span className="mt-[7px] flex h-2 w-3.5 flex-none items-center justify-center">
          <Glyph status={t.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block break-words text-[14px] font-semibold leading-snug tracking-tight ${t.status === 'cancelled' ? 'text-ink3 line-through decoration-ink3/50' : 'text-ink'}`}>
            {t.title || 'Untitled task'}
          </span>
          <span className="tnum mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink3">
            <span className="font-mono">#{t.id}</span>
            {t.dir && (
              <span className="flex min-w-0 items-center gap-1" title={t.dir}>
                <Icon name="folder" size={11} />
                <span className="truncate">{base(t.dir)}</span>
              </span>
            )}
            <span className={prio(t) === 1 ? 'font-semibold text-ink2' : ''}>P{prio(t)}</span>
          </span>
        </span>
        {live && (
          <motion.button
            {...press}
            onClick={cancel}
            aria-label={armed ? 'Tap again to cancel' : 'Cancel task'}
            title={armed ? 'Tap again to cancel' : 'Cancel task'}
            className={`pill flex h-7 flex-none items-center gap-1 px-2 text-[11.5px] transition-colors ${
              armed ? 'bg-crit font-semibold text-white' : 'text-ink3 hover:bg-white/[0.08] hover:text-ink2'
            }`}
          >
            {armed ? 'Cancel?' : <Icon name="close" size={14} />}
          </motion.button>
        )}
      </div>

      {(ex || (t.status === 'done' && result)) && (
        <div className="-mt-1 flex flex-col gap-2 px-3.5 pb-3.5 pl-[38px]">
          {ex &&
            (exAgent ? (
              <button
                onClick={() => onOpenAgent?.(exAgent.id)}
                className="pill glass-soft glass-soft-hover flex max-w-full items-center gap-2 self-start px-3 py-1 text-[12px] text-ink2 transition-colors hover:text-ink"
              >
                <StatusDot status={agentStatus(exAgent)} size={6} />
                <span className="truncate">Executor · {agentName(exAgent)}</span>
                <Icon name="chevronRight" size={13} className="flex-none text-ink3" />
              </button>
            ) : (
              <span className="text-[11.5px] text-ink3">
                {ex.sessionId ? 'Executor session has ended' : ex.dispatchedAt ? 'Executor starting…' : null}
              </span>
            ))}
          {t.status === 'done' && result && (
            <p className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink2 ${open ? '' : 'line-clamp-3'}`}>
              {result}
            </p>
          )}
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3 border-t border-glass-line px-3.5 py-3 pl-[38px] text-[12.5px] leading-relaxed">
              {t.detail && t.detail !== t.title && <p className="whitespace-pre-wrap break-words text-ink2">{t.detail}</p>}
              {t.dir && <p className="break-all font-mono text-[11.5px] text-ink3">{t.dir}</p>}
              {questions.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="label">Questions</span>
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
                  <span className="label">Log</span>
                  {log.slice(-6).map((l, i) => (
                    <div key={i} className="flex gap-2 text-ink3">
                      <span className="tnum flex-none text-[11px]">
                        {ms(l.at) ? new Date(ms(l.at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}
                      </span>
                      <span className="min-w-0 break-words text-ink2">{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {live && (
                  <Select
                    className="w-[124px]"
                    aria-label="Priority"
                    value={String(prio(t))}
                    onChange={(v) => miaTaskSet(t.id, 'priority', Number(v))}
                    options={PRIORITIES}
                  />
                )}
                {!live && t.status !== 'done' && (
                  <motion.button
                    {...press}
                    onClick={() => miaTaskSet(t.id, 'status', 'queued')}
                    className="pill glass-soft glass-soft-hover flex h-8 items-center gap-1.5 px-3 text-[12px] text-ink transition-colors"
                  >
                    <Icon name="retry" size={13} />
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

// ---------------------------------------------------------------------------

function Schedule({ schedule }) {
  const [open, setOpen] = useState(false);
  const hbs = Array.isArray(schedule?.heartbeats) ? schedule.heartbeats : [];
  const rems = (Array.isArray(schedule?.reminders) ? schedule.reminders : []).filter((r) => !r.fired);
  if (!hbs.length && !rems.length) return null;
  return (
    <div className="pt-2">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-1.5 text-left">
        <span className="text-[12.5px] font-semibold text-ink2">Schedule</span>
        <span className="tnum text-[12px] text-ink3">{hbs.length + rems.length}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} className="ml-auto text-ink3" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1.5 pb-2 pt-1">
              {hbs.map((h) => (
                <div key={h.id} className="glass-soft flex items-center gap-3 rounded-xl2 px-3 py-2">
                  <Icon name="clock" size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] ${h.enabled === false ? 'text-ink3' : 'text-ink'}`}>{h.label || h.id}</span>
                    <span className="block text-[11px] text-ink3">
                      {h.at ? `Daily at ${h.at}` : h.everyMinutes ? `Every ${h.everyMinutes} min` : ''}
                    </span>
                  </span>
                  <button
                    onClick={() => miaSchedule('setHeartbeat', { ...h, enabled: h.enabled === false })}
                    className={`pill h-7 flex-none px-2.5 text-[11.5px] transition-colors ${
                      h.enabled === false ? 'glass-soft glass-soft-hover text-ink3' : 'bg-white/[0.14] text-ink'
                    }`}
                  >
                    {h.enabled === false ? 'Off' : 'On'}
                  </button>
                </div>
              ))}
              {rems.map((r) => (
                <div key={r.id} className="glass-soft flex items-center gap-3 rounded-xl2 px-3 py-2">
                  <Icon name="bell" size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[13px] text-ink">{r.text}</span>
                    <span className="block text-[11px] text-ink3">
                      {ms(r.at) ? new Date(ms(r.at)).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : r.at}
                    </span>
                  </span>
                  <button
                    onClick={() => miaSchedule('removeReminder', { id: r.id })}
                    aria-label="Remove reminder"
                    className="grid h-7 w-7 flex-none place-items-center rounded-full text-ink3 transition-colors hover:bg-white/[0.08] hover:text-ink2"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function Tasks({ mia, onOpenAgent, highlight }) {
  const agents = useMC((s) => s.agents);
  const [showHistory, setShowHistory] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const refs = useRef(new Map());
  const [flash, setFlash] = useState(null);

  const grouped = useMemo(() => {
    const g = { queued: [], asking: [], running: [], checking: [], done: [], history: [] };
    for (const t of mia.tasks) {
      if (!t || !t.id) continue;
      if (g[t.status]) g[t.status].push(t);
      else if (t.status === 'failed' || t.status === 'cancelled') g.history.push(t);
      else g.queued.push(t); // unknown status — show it rather than lose it
    }
    const byPrio = (a, b) => prio(a) - prio(b) || ms(a.createdAt) - ms(b.createdAt);
    const byRecent = (a, b) => ms(b.updatedAt) - ms(a.updatedAt);
    for (const k of ['queued', 'asking', 'running', 'checking']) g[k].sort(byPrio);
    g.done.sort(byRecent);
    g.history.sort(byRecent);
    return g;
  }, [mia.tasks]);

  // A #id chip in the thread points here: scroll to the card and flash it.
  useEffect(() => {
    if (!highlight?.id) return undefined;
    const t = mia.tasks.find((x) => x.id === highlight.id);
    if (t && (t.status === 'failed' || t.status === 'cancelled')) setShowHistory(true);
    if (t && t.status === 'done') setAllDone(true);
    const raf = requestAnimationFrame(() => {
      refs.current.get(highlight.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(highlight.id);
    });
    const off = setTimeout(() => setFlash(null), 1600);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(off);
    };
  }, [highlight]);

  const card = (t) => (
    <TaskCard
      key={t.id}
      t={t}
      agents={agents}
      onOpenAgent={onOpenAgent}
      flash={flash === t.id}
      cardRef={(el) => (el ? refs.current.set(t.id, el) : refs.current.delete(t.id))}
    />
  );

  const total = mia.tasks.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-3 sm:px-5">
        <AddTask />
      </div>
      <div className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-5">
        {!total ? (
          <EmptyState
            icon="tasks"
            title="No tasks yet"
            hint="Add one above or just tell Mia in the thread. She picks the folder, briefs an agent, and checks the work."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {GROUPS.map(({ key, label }) => {
              let list = grouped[key];
              if (!list.length) return null;
              const hidden = key === 'done' && !allDone ? Math.max(0, list.length - 5) : 0;
              if (hidden) list = list.slice(0, 5);
              return (
                <section key={key}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <h3 className={`text-[12.5px] font-semibold ${key === 'asking' ? 'text-warn' : 'text-ink2'}`}>{label}</h3>
                    <span className="tnum text-[12px] text-ink3">{grouped[key].length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    <AnimatePresence initial={false} mode="popLayout">
                      {list.map(card)}
                    </AnimatePresence>
                  </div>
                  {(hidden > 0 || (key === 'done' && allDone && grouped.done.length > 5)) && (
                    <button
                      onClick={() => setAllDone((v) => !v)}
                      className="mt-2 text-[12px] font-medium text-ink3 transition-colors hover:text-ink2"
                    >
                      {allDone ? 'Show fewer' : `Show ${hidden} more`}
                    </button>
                  )}
                </section>
              );
            })}

            {grouped.history.length > 0 && (
              <section>
                <button onClick={() => setShowHistory((v) => !v)} className="flex w-full items-center gap-2 py-1 text-left">
                  <span className="text-[12.5px] font-semibold text-ink3">Failed & cancelled</span>
                  <span className="tnum text-[12px] text-ink3">{grouped.history.length}</span>
                  <Icon name={showHistory ? 'chevronUp' : 'chevronDown'} size={14} className="ml-auto text-ink3" />
                </button>
                <AnimatePresence initial={false}>
                  {showHistory && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={spring.smooth}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-2 pt-2">{grouped.history.map(card)}</div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}
          </div>
        )}
        <Schedule schedule={mia.schedule} />
      </div>
    </div>
  );
}
