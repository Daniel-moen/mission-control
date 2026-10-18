import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, attentionList, agentName, reply, kill, sendKey } from '../../lib/store.js';
import { fmtAge } from '../../lib/format.js';
import { spring, ease } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Answer from '../mia/Answer.jsx';
import { DismissButton, Swipeable } from '../mia/Dismiss.jsx';
import { useNow } from '../../lib/hooks.js';

// Bottom-left stack: every agent that needs a human, each as a frosted card
// with INLINE answers — the parsed menu options as tappable pills — so most
// asks are answered in one tap without opening the workspace at all.
// Cards leave the moment the agent stops waiting.

const MAX = 3;
// Home shows only what Mia asked in the last hour (task 0290); older open
// questions wait in her chat, one small link away.
export const RECENT_MS = 60 * 60 * 1000;
export const isRecentQuestion = (q, now = Date.now()) => {
  const t = Date.parse(q?.askedAt || '');
  return !Number.isFinite(t) || now - t <= RECENT_MS;
};

function Pill({ tone = 'neutral', onClick, children, title }) {
  const cls =
    tone === 'accent'
      ? 'bg-ink text-bg font-semibold'
      : tone === 'crit'
        ? 'bg-crit text-white font-semibold'
        : tone === 'critq'
          ? 'border border-crit/40 text-crit'
          : 'glass-soft glass-soft-hover text-ink';
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      transition={spring.snappy}
      onClick={onClick}
      title={title}
      className={`pill inline-flex h-8 max-w-full flex-none items-center gap-1.5 px-3.5 text-[12.5px] transition-colors ${cls}`}
    >
      <span className="truncate">{children}</span>
    </motion.button>
  );
}

// A question from Mia — same frosted card, her options as pills. Answering
// sends miaAnswer; the card leaves as soon as the answer is echoed. The X (or
// a sideways swipe) dismisses it: gone everywhere, and Mia stops waiting.
// Old questions (past the max age) only show here when Daniel asks to see them.
function MiaCard({ item, onOpenMia }) {
  const q = item.question;
  const asked = Date.parse(q.askedAt);
  return (
    <Swipeable questionId={q.questionId}>
      <motion.div
        layout
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={spring.smooth}
        data-question={q.questionId}
        className="glass w-full p-4"
      >
        <div className="flex items-start gap-1">
          <button onClick={() => onOpenMia?.()} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
            <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${item.old ? 'bg-ink3' : 'bg-warn'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[14px] font-semibold tracking-tight text-ink">Mia</span>
                {q.taskId && <span className="truncate font-mono text-[11px] text-ink3">#{q.taskId}</span>}
                {item.old && Number.isFinite(asked) && (
                  <span className="truncate text-[11px] text-ink3">asked {fmtAge(Date.now() - asked)} ago</span>
                )}
              </span>
              <span className="mt-0.5 block line-clamp-3 text-[12.5px] leading-snug text-ink2">{q.text || 'Mia has a question'}</span>
            </span>
          </button>
          <DismissButton questionId={q.questionId} className="-mr-1.5 -mt-1.5" />
        </div>
        <div className="mt-3">
          <Answer question={q} />
        </div>
      </motion.div>
    </Swipeable>
  );
}

function Card({ item, onOpen, armed, onArm }) {
  const a = item.agent;
  const exited = item.kind === 'exited';
  const prompt = item.prompt;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={spring.smooth}
      className="glass w-full p-4"
    >
      <button onClick={() => onOpen?.(a.id)} className="flex w-full items-start gap-2.5 text-left">
        <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${exited ? 'bg-crit' : 'bg-warn'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold tracking-tight text-ink">{agentName(a)}</span>
            {a.name && a.folder && <span className="truncate text-[11.5px] text-ink3">{a.folder}</span>}
            {a.isManager && <span className="flex-none text-[9.5px] font-semibold text-mgr">MGR</span>}
          </span>
          <span className={`mt-0.5 block line-clamp-2 text-[12.5px] leading-snug ${exited ? 'text-crit' : 'text-ink2'}`}>
            {exited ? 'Process exited unexpectedly' : prompt?.question || a.activity || 'Waiting for your input'}
          </span>
        </span>
        <Icon name="chevronRight" size={15} className="mt-1 flex-none text-ink3" />
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {exited ? (
          <Pill tone={armed ? 'crit' : 'critq'} onClick={() => onArm(a.id)}>
            {armed ? 'Tap again to clear' : 'Clear session'}
          </Pill>
        ) : prompt ? (
          <>
            {prompt.options.map((o) => {
              const chosen = prompt.multi ? o.checked : o.selected;
              return (
                <Pill
                  key={o.n}
                  tone={chosen ? 'accent' : 'neutral'}
                  onClick={() => sendKey(a.id, String(o.n))}
                  title={o.desc || o.label}
                >
                  <span className="mr-1 font-mono text-[11px] opacity-60">{o.n}</span>
                  {o.label}
                </Pill>
              );
            })}
            <Pill onClick={() => sendKey(a.id, 'enter')} title="Confirm the highlighted option">
              ⏎
            </Pill>
          </>
        ) : a.controllable ? (
          <>
            <Pill tone="accent" onClick={() => reply(a.id, 'Continue')}>
              Continue
            </Pill>
            <Pill onClick={() => reply(a.id, 'Yes')}>Yes</Pill>
            <Pill onClick={() => sendKey(a.id, 'enter')} title="Send a bare Enter">
              ⏎
            </Pill>
            <Pill onClick={() => onOpen?.(a.id)}>Open</Pill>
          </>
        ) : (
          <span className="text-[12px] text-ink3">Read-only terminal — open the workspace to inspect it.</span>
        )}
      </div>
    </motion.div>
  );
}

export default function AttentionCards({ onOpen, onOpenMia }) {
  const agents = useMC(useShallow((s) => s.agents));
  const mia = useMC((s) => s.mia);
  useMC((s) => s.miaLocal); // an answer given here drops its card at once
  const now = useNow() || Date.now();
  const all = attentionList(agents, mia);
  const items = all.filter((it) => it.kind !== 'mia' || isRecentQuestion(it.question, now));
  const older = all.length - items.length;
  const [expanded, setExpanded] = useState(false);

  // Two-tap clear for an exited session: the first tap arms for 3s.
  const [armed, setArmed] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const arm = (id) => {
    if (armed === id) {
      clearTimeout(timer.current);
      setArmed(null);
      kill(id);
    } else {
      setArmed(id);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(null), 3000);
    }
  };

  const shown = expanded ? items : items.slice(0, MAX);
  const more = items.length - shown.length;

  return (
    <div className="pointer-events-none relative z-20 flex w-full justify-start px-4 sm:px-6 lg:justify-center">
      {/* A column on phones and iPad portrait; a row of three on wide screens,
          so the cards never climb over the greeting. */}
      <div className="pointer-events-auto flex w-full max-w-[380px] flex-col gap-2.5 lg:grid lg:max-w-[1120px] lg:grid-cols-3 lg:items-start">
        <AnimatePresence initial={false}>
          {shown.map((it, i) => (
            <motion.div
              key={it.key}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: i * 0.05 } }}
              exit={{ opacity: 0, y: 10, transition: { duration: 0.18, ease: ease.out } }}
            >
              {it.kind === 'mia' ? (
                <MiaCard item={it} onOpenMia={onOpenMia} />
              ) : (
                <Card item={it} onOpen={onOpen} armed={armed === it.agent.id} onArm={arm} />
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {(more > 0 || expanded) && items.length > MAX && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="glass-soft glass-soft-hover pill self-start px-3.5 py-1.5 text-[12px] font-medium text-ink2 transition-colors lg:col-span-3 lg:justify-self-start"
          >
            {expanded ? 'Show less' : `+${more} more`}
          </button>
        )}

        {older > 0 && (
          <button
            onClick={() => onOpenMia?.()}
            data-older-questions={older}
            className="self-start text-left text-[12px] font-medium text-ink3 underline-offset-2 transition-colors hover:text-ink2 hover:underline lg:col-span-3"
          >
            {older} older question{older === 1 ? '' : 's'} in Mia’s chat →
          </button>
        )}
      </div>
    </div>
  );
}
