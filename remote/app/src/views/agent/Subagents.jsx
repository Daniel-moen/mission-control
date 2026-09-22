import { motion, AnimatePresence } from 'motion/react';
import { fmtTokens } from '../../lib/store.js';
import { spring } from '../../lib/motion.js';
import StatusDot from '../../ui/StatusDot.jsx';

// The agent's own subagents — the Task tool's children. They appear and vanish
// mid-turn, so rows carry `layout` and live inside AnimatePresence: a finished
// helper fades out rather than snapping the list shut.
//
// `⑂` is the fork mark used across the panel for "this agent spawned that one".
// Older hosts don't report subagents at all, so an absent list renders nothing.
export default function Subagents({ agent, subagents, className = '' }) {
  const subs = subagents || agent?.subagents || [];
  if (!subs.length) return null;
  const running = subs.filter((s) => s.status === 'active').length;

  return (
    <section className={`rounded-xl3 border border-glass-line bg-white/[0.035] p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <span className="label flex items-center gap-1.5">
          <span className="text-[12px] text-ink3">⑂</span> Subagents
        </span>
        <span className="tnum text-[11.5px] text-ink3">
          {running ? `${running} running` : 'all done'} · {subs.length}
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        <AnimatePresence initial={false}>
          {subs.map((s, i) => (
            <motion.div
              key={s.id || i}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring.smooth}
              className="flex items-start gap-2.5"
            >
              <StatusDot status={s.status === 'active' ? 'working' : 'done'} size={8} className="mt-[5px]" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span
                    className={`truncate text-[13.5px] font-medium ${s.status === 'active' ? 'text-ink' : 'text-ink2'}`}
                  >
                    {s.desc || s.agentType || 'Subagent'}
                  </span>
                  {!!s.tokens && (
                    <span className="tnum flex-none font-mono text-[10.5px] text-ink3">{fmtTokens(s.tokens)}</span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] leading-snug text-ink3">
                  {s.status === 'active' ? s.activity || '—' : 'Done'}
                  {s.agentType && s.agentType !== 'general-purpose' ? ` · ${s.agentType}` : ''}
                </span>
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}
