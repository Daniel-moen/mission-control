// Status → visual mapping, used everywhere so status colour stays consistent
// and MEANS something: working = green (alive), needs-you = amber, done = quiet
// neutral, exited = red. Colour marks state that needs the eye — a finished
// agent goes calm. No glows, no halos: depth comes from surface + hairline.
// Class strings are literal so Tailwind sees them.
export const TONE = {
  working: {
    dot: 'bg-accent',
    text: 'text-accent',
    chip: 'bg-accent/10 text-accent',
    edge: 'bg-accent',
    border: 'border-accent/30',
    ring: '',
    css: 'var(--color-accent)',
  },
  waiting: {
    dot: 'bg-warn',
    text: 'text-warn',
    chip: 'bg-warn/12 text-warn',
    edge: 'bg-warn',
    border: 'border-warn/35',
    ring: 'ring-1 ring-warn/40',
    css: 'var(--color-warn)',
  },
  done: {
    dot: 'bg-ink3',
    text: 'text-ink2',
    chip: 'bg-white/[0.06] text-ink2',
    edge: 'bg-line2',
    border: 'border-line',
    ring: '',
    css: 'var(--color-ink3)',
  },
  exited: {
    dot: 'bg-crit/80',
    text: 'text-crit',
    chip: 'bg-crit/12 text-crit',
    edge: 'bg-crit/70',
    border: 'border-crit/30',
    ring: '',
    css: 'var(--color-crit)',
  },
  // Not an agent status — the manager accent, for fleet chrome.
  mgr: {
    dot: 'bg-mgr',
    text: 'text-mgr',
    chip: 'bg-mgr/12 text-mgr',
    edge: 'bg-mgr',
    border: 'border-mgr/30',
    ring: '',
    css: 'var(--color-mgr)',
  },
};

// Never returns undefined — an unknown status reads as "done" (calm).
export function toneOf(status) {
  return TONE[status] || TONE.done;
}
