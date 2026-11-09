'use client';
// Small building blocks: the Glass surface (with its pointer sheen), icons,
// springs, a number that glides to its new value, and a line of text that
// rolls when it changes — the "live" feel of an agent's current action.

import { AnimatePresence, animate, motion, useMotionValue, useTransform, type HTMLMotionProps } from 'motion/react';
import { forwardRef, useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { registerLens, unregisterLens, type Lens } from '@/lib/glass';

export const spring = { type: 'spring' as const, stiffness: 420, damping: 38, mass: 0.9 };
export const softSpring = { type: 'spring' as const, stiffness: 260, damping: 32, mass: 1 };
// gel: a sheet grows from its source and settles with a little give
export const sheetSpring = { type: 'spring' as const, stiffness: 300, damping: 26, mass: 1 };
// press: glass flexes out and springs back with a wobble
export const pressSpring = { type: 'spring' as const, stiffness: 520, damping: 18, mass: 0.7 };
// liquid: bouncy enough to read as fluid, used for blooming controls
export const liquidSpring = { type: 'spring' as const, stiffness: 360, damping: 20, mass: 0.9 };

// Sheen: the glass highlight follows the pointer (or finger) across a surface.
// …and the specular rim turns to face it (--la), easing back to the shared
// orbiting light when the pointer leaves.
function onMove(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty('--mx', `${x * 100}%`);
  el.style.setProperty('--my', `${y * 100}%`);
  el.style.setProperty('--la', `${(Math.atan2(y - 0.5, x - 0.5) * 180) / Math.PI + 90}deg`);
}
function onLeave(e: React.PointerEvent<HTMLElement>) {
  e.currentTarget.style.removeProperty('--la');
}

// Two materials, like Apple's: content surfaces (cards) are a light frosted
// layer; `lens` marks a floating control (dock, top pills, composer…) that
// gets the full Liquid Glass — refraction + specular rim from the WebGL lens
// layer, a clear body, adaptive tint and a press that flexes and lights up.
type GlassProps = HTMLMotionProps<'div'> & { variant?: 'thin' | 'deep' | ''; as?: 'div' | 'button'; radius?: number; lens?: boolean };
export const Glass = forwardRef<HTMLDivElement, GlassProps>(function Glass({ variant = '', className = '', radius, style, as = 'div', lens = false, children, onPointerDown, ...rest }, ref) {
  const C: any = as === 'button' ? motion.button : motion.div;
  const own = useRef<HTMLElement | null>(null);
  const lensRef = useRef<Lens | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );
  useEffect(() => {
    if (!lens || !own.current) return;
    const l = registerLens(own.current);
    lensRef.current = l;
    return () => {
      unregisterLens(l);
      lensRef.current = null;
    };
  }, [lens]);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const l = lensRef.current;
    if (l) {
      l.pressAt = performance.now();
      const el = e.currentTarget;
      el.classList.add('pressed');
      const up = () => {
        l.pressAt = 0;
        el.classList.remove('pressed');
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
      };
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    }
    onPointerDown?.(e as any);
  };
  const tap = lens && as === 'button' && !('whileTap' in rest) ? { whileTap: { scale: 1.07 }, transition: rest.transition || pressSpring } : null;
  return (
    <C
      ref={setRef}
      className={`glass ${variant} ${lens ? 'lens' : ''} ${className}`}
      style={{ ...(radius ? ({ '--r': `${radius}px` } as CSSProperties) : null), ...(style as object) }}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerDown={down}
      {...tap}
      {...rest}
    >
      <span className="lg-edge" aria-hidden />
      <span className="lg-caustic" aria-hidden />
      {children as ReactNode}
    </C>
  );
});

// A value that glides (cost ticking up, counts changing).
export function Num({ value, format = (n: number) => String(Math.round(n)), className = '' }: { value: number; format?: (n: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      mv.set(value);
      return;
    }
    const c = animate(mv, value, { duration: 0.9, ease: [0.2, 0.8, 0.2, 1] });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span className={`num ${className}`}>{text}</motion.span>;
}

// One line that rolls up when its text changes.
export function LiveText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`live-line ${className}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={text}
          initial={{ y: 14, opacity: 0, filter: 'blur(3px)' }}
          animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
          exit={{ y: -14, opacity: 0, filter: 'blur(3px)' }}
          transition={{ duration: 0.42, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

// Icons: drawn to sit with SF Symbols (1.7 stroke, round caps).
const P: Record<string, ReactNode> = {
  now: <><circle cx="12" cy="12" r="8.2" /><path d="M12 7.6V12l3 2" /></>,
  tasks: <><rect x="3.8" y="4.5" width="5" height="15" rx="1.8" /><rect x="10.5" y="4.5" width="5" height="10" rx="1.8" /><rect x="17.2" y="4.5" width="3.2" height="6.5" rx="1.4" /></>,
  mia: <><path d="M4.5 18.5 6 15.2A7.6 7.6 0 1 1 9 18" /><path d="M9 11.5h.01M12 11.5h.01M15 11.5h.01" strokeWidth="2.4" /></>,
  library: <><path d="M5 4.5h4v15H5zM10.5 4.5h4v15h-4z" /><path d="m16.2 5.3 3.6-1 3.9 14.6-3.6 1z" transform="translate(-2.4 .4)" /></>,
  fleet: <><circle cx="7" cy="8" r="2.6" /><circle cx="17" cy="8" r="2.6" /><circle cx="12" cy="16" r="2.6" /><path d="M8.8 10 11 13.8M15.2 10 13 13.8" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.8v2.7" /></>,
  wave: <><path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4" /></>,
  send: <><path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></>,
  back: <><path d="M14.5 5.5 8 12l6.5 6.5" /></>,
  chevron: <><path d="m9.5 6 6 6-6 6" /></>,
  stop: <><rect x="6.5" y="6.5" width="11" height="11" rx="2.4" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.2a2.2 2.2 0 0 0 4 0" /></>,
  search: <><circle cx="11" cy="11" r="6.2" /><path d="m15.6 15.6 4 4" /></>,
  doc: <><path d="M7 3.8h6.5L18 8.3v11.9H7z" /><path d="M13.3 3.8v4.6H18M9.8 12.5h5.5M9.8 15.8h5.5" /></>,
  page: <><rect x="4" y="4.5" width="16" height="15" rx="2.5" /><path d="M4 8.8h16M7 6.6h.01M9.3 6.6h.01" /></>,
  research: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m14.6 14.6 5 5M8.2 10.5h4.6M10.5 8.2v4.6" /></>,
  plan: <><path d="M5 6.5h2M10 6.5h9M5 12h2M10 12h9M5 17.5h2M10 17.5h9" /></>,
  check: <><path d="m5.5 12.5 4.2 4.2L18.5 7.8" /></>,
  terminal: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" /></>,
  bolt: <><path d="M13 3.5 5.5 13.2h5.6L10.5 20.5 18.5 10.6h-5.7z" /></>,
  sparkle: <><path d="M12 3.5c.6 4.1 2.4 6 6.5 6.6-4.1.6-5.9 2.5-6.5 6.6-.6-4.1-2.4-6-6.5-6.6 4.1-.6 5.9-2.5 6.5-6.6Z" /><path d="M18.5 15.5c.3 1.7 1 2.5 2.5 2.8-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1.1 2.5-2.8Z" /></>,
  more: <><path d="M6.5 12h.01M12 12h.01M17.5 12h.01" strokeWidth="2.6" /></>,
  restart: <><path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" /><path d="M5 4.5v3.8h3.8" /></>,
  external: <><path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17 14v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h4.5" /></>,
};
export function Icon({ name, size = 22, stroke = 1.7, className = '', style }: { name: string; size?: number; stroke?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      {P[name] || P.doc}
    </svg>
  );
}

export function ModelChip({ model }: { model?: string }) {
  if (!model) return null;
  const s = model.toLowerCase();
  const tone = ['opus', 'fable', 'sonnet', 'haiku'].find((f) => s.includes(f)) || '';
  const fam = tone ? tone[0].toUpperCase() + tone.slice(1) : model;
  const v = tone ? s.match(new RegExp(`${tone}-(\\d+)(?:-(\\d{1,2}))?(?:-|$)`)) : null;
  return <span className={`chip ${tone}`}>{v ? `${fam} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : fam}</span>;
}

// Wraps a list so items fade/slide in once, never pop.
export const listItem = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.18 } },
};
