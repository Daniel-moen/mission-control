import { motion } from 'motion/react';
import { press } from '../lib/motion.js';
import Icon from './Icon.jsx';

// Round frosted button — the top bar's vocabulary.
const VARIANT = {
  glass: 'glass-soft glass-soft-hover text-ink backdrop-blur-xl',
  ghost: 'text-ink2 hover:bg-white/[0.08] hover:text-ink',
  primary: 'bg-ink text-bg',
  accent: 'bg-accent text-accent-ink',
  danger: 'bg-crit/15 border border-crit/30 text-crit hover:bg-crit/22',
};

// Touch targets stay ≥40px on anything a thumb reaches (md and up).
const SIZE = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-12 w-12' };
const ICON_SIZE = { sm: 15, md: 18, lg: 21 };

export default function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  active = false,
  className = '',
  ...rest
}) {
  return (
    <motion.button
      {...press}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={`pill grid flex-none place-items-center transition-colors
        ${active ? 'bg-white/[0.14] text-ink' : VARIANT[variant] || VARIANT.ghost}
        ${SIZE[size] || SIZE.md} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={ICON_SIZE[size] || 18} />
    </motion.button>
  );
}
