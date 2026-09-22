import { motion } from 'motion/react';
import { spring } from '../lib/motion.js';

const FILL = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  mgr: 'bg-mgr',
  neutral: 'bg-ink2',
};

export default function Progress({ value = 0, tone = 'accent', className = '' }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <div className={`h-[3px] w-full overflow-hidden rounded-full bg-white/[0.07] ${className}`}>
      <motion.div
        className={`h-full rounded-full ${FILL[tone] || FILL.accent}`}
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={spring.gentle}
      />
    </div>
  );
}
