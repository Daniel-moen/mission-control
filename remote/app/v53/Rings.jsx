import { motion, AnimatePresence } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, agentStatus, agentName, isMiaAgent } from '../src/lib/store.js';
import { push } from '../v2/lib/nav.js';
import { spring, tap } from '../v2/lib/motion.js';
import { growFrom } from './state.js';

// Agent progress rings (task 0491, a "cool thing"): every executor that's
// working or waiting on Daniel, as a ring in the chat's header — like Apple
// Watch's rings. The fill is the agent's own todo list (done / total); with
// no list it's a slow spinning arc. Green = working, amber = needs you.
// Tap a ring: that agent, growing out of the ring.

const R = 10;
const C = 2 * Math.PI * R;

export function useExecutors() {
  return useMC(
    useShallow((s) =>
      (s.agents || [])
        .filter((a) => !isMiaAgent(a) && ['working', 'waiting'].includes(agentStatus(a)))
        .sort((a, b) => (agentStatus(a) === 'waiting' ? -1 : 0) - (agentStatus(b) === 'waiting' ? -1 : 0)),
    ),
  );
}

export function progressOf(a) {
  const td = Array.isArray(a?.todos) ? a.todos : [];
  if (!td.length) return null;
  return td.filter((t) => t.status === 'completed').length / td.length;
}

export function Ring({ a, size = 26 }) {
  const st = agentStatus(a);
  const p = progressOf(a);
  const tone = st === 'waiting' ? 'var(--color-warn)' : 'var(--color-accent)';
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" className={`v53-ring ${p == null && st === 'working' ? 'spin' : ''}`} aria-hidden="true">
      <circle cx="13" cy="13" r={R} fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="3" />
      <motion.circle
        cx="13"
        cy="13"
        r={R}
        fill="none"
        stroke={tone}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={C}
        initial={false}
        animate={{ strokeDashoffset: C * (1 - (st === 'waiting' ? 1 : p == null ? 0.28 : Math.max(0.04, p))) }}
        transition={spring.gentle}
        transform="rotate(-90 13 13)"
      />
      {st === 'waiting' && <circle cx="13" cy="13" r="3" fill={tone} />}
    </svg>
  );
}

export default function Rings({ max = 4 }) {
  const ex = useExecutors();
  if (!ex.length) return null;
  const shown = ex.slice(0, max);
  return (
    <div className="flex items-center gap-0.5" data-rings={ex.length}>
      <AnimatePresence initial={false}>
        {shown.map((a) => {
          const p = progressOf(a);
          const st = agentStatus(a);
          const what = st === 'waiting' ? 'needs you' : p != null ? `${Math.round(p * 100)}% of its list done` : 'working';
          return (
            <motion.button
              {...tap}
              key={a.id}
              layout
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={spring.snappy}
              onClick={(e) => (growFrom(e.currentTarget), push('agent', { id: a.id }))}
              className="grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-fill"
              title={`${agentName(a)} — ${what}`}
              aria-label={`${agentName(a)}, ${what}`}
              data-ring={a.id}
              data-ring-state={st}
            >
              <Ring a={a} />
            </motion.button>
          );
        })}
      </AnimatePresence>
      {ex.length > max && max > 1 && <span className="v-num px-1 text-[0.74rem] font-semibold text-ink3">+{ex.length - max}</span>}
    </div>
  );
}
