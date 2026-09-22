// The motion vocabulary — every enter/leave/press in the app pulls from here.
// Consistency IS the premium feel: one spring family, one ease, one set of
// variants. Import from 'motion/react' at the call sites, never 'framer-motion'.

export const spring = {
  snappy: { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 }, // buttons, chips, indicators
  smooth: { type: 'spring', stiffness: 300, damping: 34 }, // sheets, panes, layout
  gentle: { type: 'spring', stiffness: 170, damping: 26 }, // large moves, numbers
};

export const ease = { out: [0.2, 0.8, 0.2, 1] };

export const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  transition: { duration: 0.28, ease: ease.out },
};

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2 },
};

export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
  transition: spring.smooth,
};

export const sheetUp = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
  transition: spring.smooth,
}; // phone bottom sheet

export const slideIn = {
  initial: { x: 40, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: 40, opacity: 0 },
  transition: spring.smooth,
};

export const stagger = (delay = 0.04) => ({ animate: { transition: { staggerChildren: delay } } });

export const press = { whileTap: { scale: 0.97 }, transition: spring.snappy };

export const hoverLift = { whileHover: { y: -1 }, whileTap: { scale: 0.98 }, transition: spring.snappy };

// Reduced-motion fallback: keep the opacity fade, drop every translation and
// scale. Pass the variants object through this when `useReducedMotion()` is
// true — `reduced(fadeUp)` still fades, it just doesn't travel.
const MOTION_KEYS = ['y', 'x', 'scale', 'rotate'];
export function reduced(variants) {
  if (!variants || typeof variants !== 'object') return variants;
  const out = {};
  for (const [key, value] of Object.entries(variants)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    if (key === 'transition') {
      out[key] = value;
      continue;
    }
    const stripped = { ...value };
    for (const k of MOTION_KEYS) delete stripped[k];
    out[key] = stripped;
  }
  return out;
}
