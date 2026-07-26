// v10 status → visual mapping, used everywhere so status color stays consistent
// and MEANS something: working = green (alive), needs-you = amber, done = quiet
// neutral, exited = red. Color marks state that needs the eye — a finished
// agent goes calm. Class strings are literal so Tailwind sees them.
export const TONE = {
  working: {
    dot: 'bg-accent',
    text: 'text-accent',
    chip: 'bg-accent/10 text-accent',
    edge: 'bg-accent',
    ring: '',
    halo: '',
    css: 'var(--color-accent)',
  },
  waiting: {
    dot: 'bg-warn',
    text: 'text-warn',
    chip: 'bg-warn/12 text-warn',
    edge: 'bg-warn',
    ring: 'ring-1 ring-warn/40',
    halo: '',
    css: 'var(--color-warn)',
  },
  done: {
    dot: 'bg-ink3',
    text: 'text-ink2',
    chip: 'bg-white/[0.06] text-ink2',
    edge: 'bg-line2',
    ring: '',
    halo: '',
    css: 'var(--color-ink3)',
  },
  exited: {
    dot: 'bg-crit/80',
    text: 'text-crit',
    chip: 'bg-crit/12 text-crit',
    edge: 'bg-crit/70',
    ring: '',
    halo: '',
    css: 'var(--color-crit)',
  },
};
