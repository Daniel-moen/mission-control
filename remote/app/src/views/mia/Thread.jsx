import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaSend, miaRead, miaAnswerFor, miaStart } from '../../lib/store.js';
import { spring, press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import MicField from '../agent/MicField.jsx';
import Answer from './Answer.jsx';

// The Mia ↔ Daniel conversation (messages.jsonl), rendered as rows of ink on
// glass — a name, a time, the words. No bubbles: who is speaking is carried by
// the name line, and colour is kept for meaning only (a notify gets a thin
// accent rule, an open question a thin amber one, system events go quiet).

const toMs = (at) => {
  if (!at) return 0;
  if (typeof at === 'number') return at > 1e12 ? at : at * 1000;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};
const hhmm = (ms) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function TaskChip({ id, onTask }) {
  if (!id) return null;
  return (
    <button
      onClick={() => onTask?.(id)}
      className="pill glass-soft glass-soft-hover inline-flex h-5 items-center px-2 font-mono text-[10.5px] text-ink3 transition-colors hover:text-ink2"
      title={`Show task ${id}`}
    >
      #{id}
    </button>
  );
}

function EventRow({ m }) {
  return (
    <div className="flex items-baseline gap-2 py-1 pl-0.5 text-[12px] leading-snug text-ink3">
      <span className="mt-[5px] h-1 w-1 flex-none self-start rounded-full bg-ink3/70" />
      <span className="min-w-0 flex-1 break-words">{m.text}</span>
      <span className="tnum flex-none text-[10.5px] text-ink3/70">{hhmm(toMs(m.at))}</span>
    </div>
  );
}

function MessageRow({ m, head, mia, onTask, pending }) {
  const fromMia = m.from === 'mia';
  const isQ = m.kind === 'question';
  const isNotify = m.kind === 'notify';
  const open = isQ && m.questionId && mia.openIds.has(m.questionId);
  const answer = isQ && !open ? miaAnswerFor(mia.block, m.questionId, mia.local) : null;

  const rule = isNotify
    ? m.urgent
      ? 'border-l-2 border-warn/70 pl-3'
      : 'border-l-2 border-accent/60 pl-3'
    : open
      ? 'border-l-2 border-warn/70 pl-3'
      : '';

  return (
    <div className={head ? 'pt-3.5' : 'pt-1.5'}>
      {head && (
        <div className="mb-1 flex items-center gap-2">
          <span className={`text-[12.5px] font-semibold tracking-tight ${fromMia ? 'text-ink' : 'text-ink2'}`}>
            {fromMia ? 'Mia' : 'You'}
          </span>
          <span className="tnum text-[11px] text-ink3">{hhmm(toMs(m.at))}</span>
        </div>
      )}
      <div className={rule}>
        {(isNotify || isQ) && (
          <div className={`mb-0.5 flex items-center gap-1.5 text-[11px] font-medium ${isNotify ? (m.urgent ? 'text-warn' : 'text-accent') : open ? 'text-warn' : 'text-ink3'}`}>
            <Icon name={isNotify ? 'bell' : 'chat'} size={11} />
            {isNotify ? (m.urgent ? 'Urgent' : 'Update') : open ? 'Question' : 'Asked'}
          </div>
        )}
        <div className={`whitespace-pre-wrap break-words text-[14.5px] leading-relaxed ${pending ? 'text-ink3' : fromMia ? 'text-ink' : 'text-ink2'}`}>
          {m.text}
        </div>
        {(m.taskId || pending) && (
          <div className="mt-1 flex items-center gap-2">
            <TaskChip id={m.taskId} onTask={onTask} />
            {pending && <span className="text-[11px] text-ink3">Sending…</span>}
          </div>
        )}
        {isQ &&
          (open ? (
            <div className="mt-2.5">
              <Answer question={m} />
            </div>
          ) : (
            <div className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug text-ink2">
              <Icon name="check" size={14} className="mt-[2px] flex-none text-ink3" />
              {answer != null ? (
                <span className="min-w-0 break-words">
                  <span className="text-ink3">You answered · </span>
                  {answer}
                </span>
              ) : (
                <span className="text-ink3">Closed</span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

// "Visible" for read-marking: the tab is foregrounded AND this region is shown.
function usePageVisible() {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setV(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

export default function Thread({ mia, active = true, onTask }) {
  const local = useMC((s) => s.miaLocal);
  const link = useMC((s) => s.link);
  const pageVisible = usePageVisible();

  const openIds = useMemo(
    () => new Set(mia.pendingQuestions.map((q) => q.questionId).filter((id) => id && !(id in local.answered))),
    [mia.pendingQuestions, local.answered],
  );

  // Rows: the thread, minus answer lines whose question is on screen (the
  // answer renders inline under it), plus local echoes still in flight.
  const rows = useMemo(() => {
    const asked = new Set(mia.messages.filter((m) => m.kind === 'question' && m.questionId).map((m) => m.questionId));
    const out = [];
    let prev = null;
    let prevDay = '';
    const push = (m, key, pending = false) => {
      const ms = toMs(m.at);
      const day = dayLabel(ms);
      if (day && day !== prevDay) {
        out.push({ type: 'day', key: `day:${day}:${key}`, label: day });
        prevDay = day;
        prev = null;
      }
      if (m.from === 'system' || m.kind === 'event') {
        out.push({ type: 'event', key, m });
        prev = null;
        return;
      }
      const head = !prev || prev.from !== m.from || ms - toMs(prev.at) > 10 * 60 * 1000;
      out.push({ type: 'msg', key, m, head, pending });
      prev = m;
    };
    mia.messages.forEach((m, i) => {
      if (m.kind === 'answer' && m.questionId && asked.has(m.questionId)) return;
      push(m, m.id || `i${i}`);
    });
    for (const p of local.sent) push({ from: 'daniel', kind: 'chat', text: p.text, at: p.at }, p.id, true);
    return out;
  }, [mia.messages, local.sent]);

  // ---- auto-scroll ---------------------------------------------------------
  // Follow new messages only while you're at the bottom; scrolled up reading
  // history, you get a "New messages" pill instead of being yanked down.
  const scroller = useRef(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);
  const lastKey = rows.length ? rows[rows.length - 1].key : '';

  const toBottom = (smooth) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stuck.current = true;
    setBehind(false);
  };
  useLayoutEffect(() => {
    if (stuck.current) toBottom(false);
    else setBehind(true);
  }, [lastKey, openIds.size]);
  // Re-shown on a phone tab switch: land on the latest again.
  useLayoutEffect(() => {
    if (active) toBottom(false);
  }, [active]);

  // ---- read marker ---------------------------------------------------------
  const lastId = useMemo(() => {
    for (let i = mia.messages.length - 1; i >= 0; i--) if (mia.messages[i].id) return mia.messages[i].id;
    return '';
  }, [mia.messages]);
  useEffect(() => {
    if (active && pageVisible && link === 'linked' && lastId) miaRead(lastId);
  }, [active, pageVisible, link, lastId]);

  const ctx = { block: mia, local, openIds };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {!mia.enabled && (
        <div className="mx-4 mb-2 flex flex-none items-center gap-3 rounded-xl3 border border-glass-line bg-white/[0.04] px-3.5 py-2.5 sm:mx-5">
          <span className="h-2 w-2 flex-none rounded-full bg-ink3" />
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink2">
            Mia is off. Messages and tasks wait here until she starts.
          </span>
          <Button size="sm" variant="primary" icon="play" onClick={() => miaStart()}>
            Start
          </Button>
        </div>
      )}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          stuck.current = atEnd;
          if (atEnd && behind) setBehind(false);
        }}
        className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-3 sm:px-5"
      >
        {!rows.length ? (
          <EmptyState
            icon="mia"
            title="Nothing here yet"
            hint="Tell Mia what you need — a task, a question, a reminder. She hands the work to an agent, asks only when she has to, and tells you when it's done."
          />
        ) : (
          <div className="mx-auto flex max-w-[720px] flex-col">
            {rows.map((r) =>
              r.type === 'day' ? (
                <div key={r.key} className="flex items-center gap-3 pb-1 pt-5 first:pt-1">
                  <span className="h-px flex-1 bg-glass-line" />
                  <span className="text-[11px] font-medium text-ink3">{r.label}</span>
                  <span className="h-px flex-1 bg-glass-line" />
                </div>
              ) : r.type === 'event' ? (
                <EventRow key={r.key} m={r.m} />
              ) : (
                <MessageRow key={r.key} m={r.m} head={r.head} mia={ctx} onTask={onTask} pending={r.pending} />
              ),
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {behind && (
          <motion.button
            {...press}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={spring.snappy}
            onClick={() => toBottom(true)}
            className="glass-strong pill absolute bottom-[84px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium text-ink"
          >
            <Icon name="arrowDown" size={13} />
            New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div className="flex-none border-t border-glass-line px-4 pb-4 pt-3 sm:px-5">
        <div className="mx-auto max-w-[720px]">
          <MicField
            onSend={(t) => miaSend(t)}
            placeholder={mia.enabled ? 'Message Mia…' : 'Message Mia — she’ll read it when she starts'}
          />
        </div>
      </div>
    </div>
  );
}
