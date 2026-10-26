// v2 motion vocabulary. Everything moves on springs (velocity carries over
// from a finger, nothing ever snaps); durations only for fades. Values are
// tuned for 120 Hz ProMotion and still settle cleanly at 60.

export const spring = {
  // page pushes / pops, sheets settling — critically damped, no overshoot
  page: { type: 'spring', stiffness: 420, damping: 44, mass: 1 },
  // sheets and zoom transitions — a hair of life
  sheet: { type: 'spring', stiffness: 380, damping: 36, mass: 0.9 },
  // buttons, pills, indicators
  snappy: { type: 'spring', stiffness: 600, damping: 40, mass: 0.7 },
  // layout reflow (lists re-sorting, cards leaving)
  layout: { type: 'spring', stiffness: 460, damping: 42 },
  // numbers and meters
  gentle: { type: 'spring', stiffness: 170, damping: 26 },
};

export const fade = { duration: 0.18, ease: [0.25, 1, 0.5, 1] };

// Tap feedback: a quick sink, released on a spring.
export const tap = { whileTap: { scale: 0.96 }, transition: spring.snappy };
export const tapSoft = { whileTap: { scale: 0.985 }, transition: spring.snappy };

// Rubber-banding past an edge (iOS feel): the further you pull, the less it moves.
export const rubber = (x, limit = 120) => (x <= 0 ? 0 : limit * (1 - 1 / (x / limit + 1)));

// "Enter" for content rows: rise a few px and fade. Reduced motion: fade only.
export const rise = (reduce, i = 0) => ({
  initial: reduce ? { opacity: 0 } : { opacity: 0, y: 8 },
  animate: reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
  transition: reduce ? fade : { ...spring.layout, delay: Math.min(i, 8) * 0.025 },
});
