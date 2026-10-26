import { useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { useMC, miaAnswer, miaDismiss, miaCanDismiss, agentName, reply, kill, sendKey } from '../../../src/lib/store.js';
import { fmtAge } from '../../../src/lib/format.js';
import { push, goView } from '../../lib/nav.js';
import { spring, tap } from '../../lib/motion.js';
import { Icon, useArm } from '../../ui/kit.jsx';

// Things waiting on Daniel, answerable where they stand: Mia's questions as
// one-tap option pills (plus "Other…" for his own words), an agent's numbered
// menu as pills that send the keystroke. A Mia question swipes away sideways
// to dismiss it (gone on every device; Mia is told).

export function Pill({ onClick, children, tone = 'neutral', title, ...rest }) {
  const cls =
    tone === 'primary'
      ? 'bg-ink text-page'
      : tone === 'crit'
        ? 'bg-crit text-white'
        : tone === 'critq'
          ? 'bg-crit/12 text-crit'
          : 'bg-fill text-ink hover:bg-fill2';
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      title={title}
      className={`inline-flex h-9 max-w-full flex-none items-center gap-1.5 rounded-full px-4 text-[0.86rem] font-semibold transition-colors ${cls}`}
      {...rest}
    >
      <span className="truncate">{children}</span>
    </motion.button>
  );
}

// Answer a Mia question: her options as pills, or your own words.
export function Answer({ question, autoOpen = false }) {
  const options = Array.isArray(question?.options) ? question.options.filter(Boolean) : [];
  const [open, setOpen] = useState(autoOpen || !options.length);
  const [text, setText] = useState('');
  const qid = question?.questionId || question?.id;
  const send = (t) => miaAnswer(qid, t) && setText('');
  return (
    <div className="flex flex-col gap-2" data-answer={qid}>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((o, i) => (
            <Pill key={`${i}:${o}`} onClick={() => send(String(o))} title={String(o)} tone={i === 0 ? 'primary' : 'neutral'} data-option={String(o)}>
              {String(o)}
            </Pill>
          ))}
          {!open && (
            <Pill onClick={() => setOpen(true)} title="Answer in your own words">
              Other…
            </Pill>
          )}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.form
            key="free"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.layout}
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text);
            }}
            className="flex items-center gap-2 overflow-hidden"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your answer…"
              autoFocus={options.length > 0}
              aria-label="Your answer"
              className="v-field h-10 min-w-0 flex-1 rounded-full px-4 text-[0.92rem]"
            />
            <motion.button {...tap} type="submit" disabled={!text.trim()} aria-label="Send answer" className="grid h-10 w-10 flex-none place-items-center rounded-full bg-ink text-page disabled:opacity-35">
              <Icon name="arrowUp" size={18} strokeWidth={2.4} />
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

// A card you can fling sideways to dismiss (Mia questions).
export function Swipe({ id, children, className = '' }) {
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const can = useMC((s) => miaCanDismiss(s.mia));
  const opacity = useTransform(x, [-200, -60, 0, 60, 200], [0.2, 0.9, 1, 0.9, 0.2]);
  const rot = useTransform(x, [-200, 200], [-2.5, 2.5]);
  if (!can) return <div className={className}>{children}</div>;
  return (
    <motion.div
      drag="x"
      dragDirectionLock
      dragSnapToOrigin
      dragElastic={0.6}
      dragConstraints={{ left: 0, right: 0 }}
      dragTransition={{ bounceStiffness: 520, bounceDamping: 40 }}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={(_, info) => {
        setTimeout(() => (dragged.current = false), 0);
        if (Math.abs(info.offset.x) > 110 || (Math.abs(info.offset.x) > 50 && Math.abs(info.velocity.x) > 700)) miaDismiss(id);
      }}
      onClickCapture={(e) => {
        if (!dragged.current) return;
        e.stopPropagation();
        e.preventDefault();
      }}
      style={{ x, opacity, rotate: rot, touchAction: 'pan-y' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function QuestionCard({ q, old = false }) {
  const can = useMC((s) => miaCanDismiss(s.mia));
  const asked = Date.parse(q.askedAt || q.at || '');
  return (
    <Swipe id={q.questionId}>
      <div className={`v-card p-4 ${old ? '' : 'lens-amber-rim'}`} data-amber={old ? undefined : '1'} data-depth="0.85" data-question={q.questionId}>
        <div className="flex items-start gap-3">
          <span className={`mt-[3px] grid h-7 w-7 flex-none place-items-center rounded-full ${old ? 'bg-fill text-ink3' : 'bg-warn/15 text-warn'}`}>
            <Icon name="mia" size={14} strokeWidth={2.2} />
          </span>
          <button onClick={() => goView('mia')} className="min-w-0 flex-1 text-left">
            <span className="flex items-baseline gap-2 text-[0.78rem] font-semibold text-ink3">
              <span className="text-ink">Mia asks</span>
              {q.taskId && <span className="font-mono font-medium">#{q.taskId}</span>}
              {Number.isFinite(asked) && <span className="font-medium">{fmtAge(Date.now() - asked)} ago</span>}
            </span>
            <span className="mt-1 block text-[0.98rem] font-medium leading-snug tracking-[-0.01em] text-ink">{q.text || 'Mia has a question'}</span>
          </button>
          {can && (
            <motion.button
              {...tap}
              onClick={() => miaDismiss(q.questionId)}
              aria-label="Dismiss question"
              data-dismiss={q.questionId}
              className="-mr-1.5 -mt-1 grid h-8 w-8 flex-none place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink"
            >
              <Icon name="close" size={15} />
            </motion.button>
          )}
        </div>
        <div className="mt-3.5 pl-10">
          <Answer question={q} />
        </div>
      </div>
    </Swipe>
  );
}

export function AgentAskCard({ item }) {
  const a = item.agent;
  const exited = item.kind === 'exited';
  const prompt = item.prompt;
  const [armed, fire] = useArm();
  return (
    <div className="v-card lens-amber-rim p-4" data-amber="1" data-depth="0.85" data-ask={a.id}>
      <button onClick={() => push('agent', { id: a.id })} className="flex w-full items-start gap-3 text-left">
        <span className={`mt-[3px] grid h-7 w-7 flex-none place-items-center rounded-full ${exited ? 'bg-crit/15 text-crit' : 'bg-warn/15 text-warn'}`}>
          <Icon name={exited ? 'alert' : 'terminal'} size={14} strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-[0.78rem] font-semibold">
            <span className="truncate text-ink">{agentName(a)}</span>
            {a.isManager && <span className="text-mgr">MGR</span>}
            {a.name && a.folder && <span className="truncate font-medium text-ink3">{a.folder}</span>}
          </span>
          <span className={`mt-1 block text-[0.98rem] font-medium leading-snug tracking-[-0.01em] ${exited ? 'text-crit' : 'text-ink'}`}>
            {exited ? 'Process exited unexpectedly' : prompt?.question || a.activity || 'Waiting for your input'}
          </span>
        </span>
        <Icon name="chevronRight" size={16} className="mt-1 flex-none text-ink3" />
      </button>
      <div className="mt-3.5 flex flex-wrap gap-2 pl-10">
        {exited ? (
          <Pill tone={armed ? 'crit' : 'critq'} onClick={() => fire(() => kill(a.id))}>
            {armed ? 'Tap again to clear' : 'Clear session'}
          </Pill>
        ) : prompt ? (
          <>
            {prompt.options.map((o) => (
              <Pill key={o.n} tone={(prompt.multi ? o.checked : o.selected) ? 'primary' : 'neutral'} onClick={() => sendKey(a.id, String(o.n))} title={o.desc || o.label}>
                <span className="mr-0.5 font-mono text-[0.72rem] opacity-60">{o.n}</span>
                {o.label}
              </Pill>
            ))}
            <Pill onClick={() => sendKey(a.id, 'enter')} title="Confirm the highlighted option">
              ⏎
            </Pill>
          </>
        ) : a.controllable ? (
          <>
            <Pill tone="primary" onClick={() => reply(a.id, 'Continue')}>
              Continue
            </Pill>
            <Pill onClick={() => reply(a.id, 'Yes')}>Yes</Pill>
            <Pill onClick={() => sendKey(a.id, 'enter')} title="Send a bare Enter">
              ⏎
            </Pill>
          </>
        ) : (
          <span className="text-[0.8rem] text-ink3">Read-only terminal — open it to look.</span>
        )}
      </div>
    </div>
  );
}
