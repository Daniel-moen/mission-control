import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

// v3 (task 0445): which direction is this, and a way to hop to the others
// (or back to v1/v2) — the device remembers the pick like ?ui= does.
const ALL = [
  { ui: 'v3a', name: 'Lens', hint: 'spatial glass' },
  { ui: 'v3b', name: 'Presence', hint: 'Mia, alive' },
  { ui: 'v3c', name: 'Press', hint: 'kinetic editorial' },
  { ui: 'v2', name: 'v2', hint: 'Quiet' },
  { ui: 'v1', name: 'v1', hint: 'Studio Glass' },
];
export default function Switcher({ current, className = '', style }) {
  const [open, setOpen] = useState(false);
  const me = ALL.find((d) => d.ui === current);
  const pick = (ui) => {
    try {
      localStorage.setItem('mc.ui', ui);
    } catch {}
    document.cookie = `mc_ui=${ui}; path=/; max-age=31536000; samesite=lax`;
    location.replace(ui.startsWith('v3') ? `/${ui}${location.hash}` : `/?ui=${ui}${location.hash}`);
  };
  return (
    <div className={`v3-switch ${className}`} style={style} data-switcher>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            className="v3-switch-menu"
          >
            {ALL.map((d) => (
              <button key={d.ui} onClick={() => pick(d.ui)} data-pick={d.ui} className={d.ui === current ? 'on' : ''}>
                <b>{d.name}</b>
                <span>{d.hint}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <button className="v3-switch-chip" onClick={() => setOpen((v) => !v)} aria-label="Design direction">
        <i>{current.slice(-1).toUpperCase()}</i>
        {me?.name}
      </button>
    </div>
  );
}
