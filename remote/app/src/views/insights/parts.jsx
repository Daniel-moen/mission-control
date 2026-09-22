import { motion, useReducedMotion } from 'motion/react';
import { ease, reduced } from '../../lib/motion.js';

// Shared furniture for the Insights window.
//
// Insights is a single large sheet of glass floating over the backdrop photo,
// so its sections are NOT stacked opaque panels — they are `glass-soft` insets
// (white 6 % fill, 12 % hairline) cut into the window. Nesting a second blur
// here would cost a whole extra compositing layer per card on the iPad and
// would read as glass-on-glass mush; the soft inset gives the separation
// without either.

export const cardCls = 'glass-soft rounded-xl3';

// Section enter. The window itself scales in (shell/Window), then its contents
// cascade — §4.4's stagger. One variant pair for every section so the cascade
// stays even no matter which sections the data happens to produce.
export const sectionIn = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.34, ease: ease.out } },
};

export const cascade = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

// Reduced motion keeps the cascade — it is what tells you the window filled in
// an order — but drops the travel and fades only.
const sectionInReduced = reduced(sectionIn);
export function useSectionIn() {
  return useReducedMotion() ? sectionInReduced : sectionIn;
}

export function Section({ className = '', children, ...rest }) {
  return (
    <motion.section variants={useSectionIn()} className={`${cardCls} ${className}`} {...rest}>
      {children}
    </motion.section>
  );
}

// Section heading: a quiet 11px label, an optional figure beside it, and
// whatever control the section owns pushed to the right.
export function Head({ title, meta, right, className = '' }) {
  return (
    <div className={`flex items-baseline gap-2 ${className}`}>
      <h3 className="label">{title}</h3>
      {meta != null && <span className="tnum text-[11px] text-ink3">{meta}</span>}
      {right && <div className="ml-auto flex-none">{right}</div>}
    </div>
  );
}

// A swatch that carries series identity beside a text label. Rect for
// areas/fills, a short stroke for lines — legends mirror their mark.
export function Key({ color, line = false }) {
  return line ? (
    <span className="inline-block h-[2px] w-3 flex-none rounded-full" style={{ background: color }} />
  ) : (
    <span className="inline-block h-2 w-2 flex-none rounded-[2px]" style={{ background: color }} />
  );
}
