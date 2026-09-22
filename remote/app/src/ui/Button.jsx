import { motion } from 'motion/react';
import { press } from '../lib/motion.js';
import Icon from './Icon.jsx';
import Spinner from './Spinner.jsx';

// Buttons are pills. primary = white fill (the signature action), accent =
// green fill (live/go), warn = amber (needs-you actions), secondary = frosted
// glass, ghost = text only, danger = crit tint.
const VARIANT = {
  primary: 'bg-ink text-bg font-semibold hover:bg-white',
  accent: 'bg-accent text-accent-ink font-semibold hover:bg-accent-bright',
  warn: 'bg-warn text-[#241a02] font-semibold hover:brightness-110',
  secondary: 'glass-soft glass-soft-hover text-ink',
  ghost: 'text-ink2 hover:bg-white/[0.08] hover:text-ink',
  danger: 'bg-crit/15 text-crit border border-crit/30 hover:bg-crit/22',
};

const SIZE = {
  sm: 'h-8 px-3.5 gap-1.5 text-[12.5px]',
  md: 'h-10 px-4.5 gap-2 text-[13.5px]',
  lg: 'h-12 px-6 gap-2.5 text-[15px]',
};

const ICON_SIZE = { sm: 14, md: 16, lg: 18 };

export default function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  block = false,
  className = '',
  children,
  disabled,
  ...rest
}) {
  return (
    <motion.button
      {...press}
      disabled={disabled || loading}
      className={`pill inline-flex items-center justify-center whitespace-nowrap tracking-tight transition-colors
        disabled:pointer-events-none disabled:opacity-40
        ${VARIANT[variant] || VARIANT.secondary} ${SIZE[size] || SIZE.md} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {loading ? (
        <Spinner size={ICON_SIZE[size] || 16} />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size] || 16} />
      ) : null}
      {children}
    </motion.button>
  );
}
