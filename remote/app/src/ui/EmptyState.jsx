import { motion } from 'motion/react';
import { fadeUp } from '../lib/motion.js';
import Icon from './Icon.jsx';

export default function EmptyState({ icon = 'sparkles', title, hint, action, className = '' }) {
  return (
    <motion.div {...fadeUp} className={`grid place-items-center px-6 py-14 text-center ${className}`}>
      <div className="glass-soft grid h-11 w-11 place-items-center rounded-xl2 text-ink2">
        <Icon name={icon} size={20} />
      </div>
      <div className="mt-3.5 text-[14px] font-medium tracking-tight text-ink">{title}</div>
      {hint && <div className="mt-1 max-w-[42ch] text-[12.5px] leading-relaxed text-ink3">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  );
}
