import { motion } from 'motion/react';
import { press } from '../lib/motion.js';

const TONE = {
  neutral: { cls: 'glass-soft text-ink2', dot: 'bg-ink3' },
  ok: { cls: 'bg-accent/12 text-accent border border-accent/25', dot: 'bg-accent' },
  warn: { cls: 'bg-warn/14 text-warn border border-warn/30', dot: 'bg-warn' },
  crit: { cls: 'bg-crit/14 text-crit border border-crit/30', dot: 'bg-crit' },
  mgr: { cls: 'bg-mgr/14 text-mgr border border-mgr/30', dot: 'bg-mgr' },
  accent: { cls: 'bg-accent text-accent-ink border border-transparent', dot: 'bg-accent-ink' },
};

export default function Chip({ tone = 'neutral', dot = false, onClick, active = false, className = '', children, ...rest }) {
  const t = TONE[tone] || TONE.neutral;
  const base = `pill inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-[12px] font-medium leading-none ${t.cls} ${
    active ? 'ring-1 ring-white/20' : ''
  } ${className}`;
  const body = (
    <>
      {dot && <span className={`h-1.5 w-1.5 flex-none rounded-full ${t.dot}`} />}
      {children}
    </>
  );
  if (!onClick) return <span className={base} {...rest}>{body}</span>;
  return (
    <motion.button {...press} onClick={onClick} className={`${base} transition-colors hover:brightness-125`} {...rest}>
      {body}
    </motion.button>
  );
}
