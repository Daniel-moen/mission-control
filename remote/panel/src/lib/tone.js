// v9 status → visual mapping, used everywhere so status color stays consistent
// and MEANS something: working = cyan (motion + glow), needs-you = amber,
// done = green, exited = red-tinted neutral. `edge` is a luminous gradient
// rail; `halo` is the card's ambient status light. Class strings are literal
// so Tailwind sees them.
export const TONE = {
  working: {
    dot: 'bg-accent',
    text: 'text-accent',
    chip: 'bg-accent/12 text-accent',
    edge: 'bg-gradient-to-b from-accent-bright via-accent to-accent/30',
    ring: '',
    halo: 'shadow-[inset_0_1px_0_rgba(147,200,255,0.09),0_0_36px_-14px_rgba(34,217,238,0.55)]',
    css: 'var(--color-accent)',
  },
  waiting: {
    dot: 'bg-warn',
    text: 'text-warn',
    chip: 'bg-warn/15 text-warn',
    edge: 'bg-gradient-to-b from-warn via-warn to-warn/30',
    ring: 'ring-1 ring-warn/50',
    halo: 'shadow-[inset_0_1px_0_rgba(255,214,150,0.12),0_0_40px_-12px_rgba(255,184,77,0.55)]',
    css: 'var(--color-warn)',
  },
  done: {
    dot: 'bg-ok',
    text: 'text-ok',
    chip: 'bg-ok/12 text-ok',
    edge: 'bg-gradient-to-b from-ok/80 via-ok/50 to-ok/20',
    ring: '',
    halo: '',
    css: 'var(--color-ok)',
  },
  exited: {
    dot: 'bg-crit/80',
    text: 'text-crit',
    chip: 'bg-crit/12 text-crit',
    edge: 'bg-gradient-to-b from-crit/70 via-crit/40 to-crit/20',
    ring: '',
    halo: '',
    css: 'var(--color-crit)',
  },
};
