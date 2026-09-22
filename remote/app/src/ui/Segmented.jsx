import { useId } from 'react';
import { motion, LayoutGroup } from 'motion/react';
import { spring } from '../lib/motion.js';
import Icon from './Icon.jsx';

// Segmented control. The active pill is ONE element that glides between
// options (shared layoutId) instead of four that fade — that glide is the
// whole point.
export default function Segmented({ options = [], value, onChange, className = '' }) {
  const id = useId();
  return (
    <LayoutGroup id={id}>
      <div className={`glass-soft pill inline-flex items-center gap-0.5 p-0.5 ${className}`}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              onClick={() => onChange?.(o.value)}
              aria-pressed={on}
              className={`pill relative flex h-8 items-center justify-center gap-1.5 whitespace-nowrap px-3.5 text-[12.5px] font-medium transition-colors ${
                on ? 'text-ink' : 'text-ink3 hover:text-ink2'
              }`}
            >
              {on && (
                <motion.span
                  layoutId="seg-pill"
                  transition={spring.snappy}
                  className="pill absolute inset-0 bg-white/[0.14]"
                />
              )}
              <span className="relative flex items-center gap-1.5">
                {o.icon && <Icon name={o.icon} size={14} />}
                {o.label}
                {o.count != null && (
                  <span className={`tnum text-[11px] ${on ? 'text-ink3' : 'text-ink3/70'}`}>{o.count}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
