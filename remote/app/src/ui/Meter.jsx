import { motion } from 'motion/react';
import { spring } from '../lib/motion.js';

// Utilization meter. The fill carries severity (accent → warn → crit); the
// track is a lighter step of the SAME hue so the state reads across the whole
// bar. The figure is ink, never the data colour — identity comes from the label.
export default function Meter({ value = 0, label = '', sub = '', className = '' }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const color = v >= 0.9 ? 'var(--color-crit)' : v >= 0.7 ? 'var(--color-warn)' : 'var(--color-accent)';
  return (
    <div className={`min-w-0 ${className}`} title={`${label} ${Math.round(v * 100)}%${sub ? ' · ' + sub : ''}`}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="label truncate">{label}</span>
        <span className="ml-auto flex-none text-[12px] font-medium tnum text-ink2">{Math.round(v * 100)}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: `color-mix(in oklab, ${color} 16%, transparent)` }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={false}
          animate={{ width: `${v * 100}%` }}
          transition={spring.gentle}
        />
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-ink3">{sub}</div>}
    </div>
  );
}
