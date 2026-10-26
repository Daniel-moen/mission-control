import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, useMotionValue, useTransform } from 'motion/react';
import { spring, fade } from '../lib/motion.js';
import { usePrefs } from '../lib/prefs.js';
import { useWide } from './hooks.js';
import { IconBtn } from './kit.jsx';

// One sheet primitive. On a phone it rises from the bottom edge (thumb
// reach); on an iPad it's a centred card. Either way the header is a drag
// handle: pull it down and the sheet follows the finger, rubber-bands, and
// either springs back or flies off with the release velocity.
//
// Sheets stack (a download sheet over the doc's details sheet); Escape and
// the scrim only ever close the top one.

const stack = [];
const MAXW = { sm: 440, md: 560, lg: 720, xl: 960 };

export default function Sheet({ open, onClose, title, size = 'md', children, footer, actions, padded = true, height, label, scrollProps = {} }) {
  const id = useId();
  const wide = useWide(640);
  const reduce = usePrefs((s) => s.reduce);
  const drag = useDragControls();
  // How far the sheet is being pulled down — the scrim lightens with it.
  const pull = useMotionValue(0);
  const scrim = useTransform(pull, [0, 400], [1, 0.2]);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    pull.set(0);
    stack.push(id);
    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      e.stopPropagation();
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      window.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, [open, id, onClose, pull]);

  const end = (_, info) => {
    if (info.offset.y > 110 || info.velocity.y > 650) onClose?.();
    else pull.set(0);
  };

  const maxW = MAXW[size] || MAXW.md;
  const enter = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: fade }
    : wide
      ? { initial: { opacity: 0, y: 40, scale: 0.97 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 30, scale: 0.98 }, transition: spring.sheet }
      : { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' }, transition: spring.sheet };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="sheet" className="fixed inset-0 z-[80]" style={{ bottom: 'calc(0px - var(--vgap))' }} data-sheet={label || title || ''}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            className="absolute inset-0"
            onClick={onClose}
          >
            <motion.div style={{ opacity: scrim }} className="h-full w-full bg-scrim" />
          </motion.div>
          <div
            className={`pointer-events-none absolute inset-0 flex justify-center ${wide ? 'items-center p-6' : 'items-end'}`}
            style={wide ? { paddingTop: 'max(24px, env(safe-area-inset-top))' } : { paddingTop: 'max(44px, env(safe-area-inset-top))' }}
          >
            <motion.div
              ref={box}
              role="dialog"
              aria-modal="true"
              aria-label={label || title}
              {...enter}
              drag="y"
              dragListener={false}
              dragControls={drag}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0.05, bottom: 0.8 }}
              onDrag={(_, info) => pull.set(Math.max(0, info.offset.y))}
              onDragEnd={end}
              style={{ maxWidth: wide ? maxW : undefined, height: height && !wide ? height : undefined }}
              className={`pointer-events-auto flex w-full min-h-0 flex-col overflow-hidden bg-card shadow-[0_-10px_60px_-20px_rgba(0,0,0,0.6)] ${
                wide ? 'max-h-[min(860px,calc(100dvh-48px))] rounded-[28px] border border-hair' : 'max-h-full rounded-t-[28px] border-t border-hair'
              }`}
            >
              <div className="flex-none touch-none select-none" onPointerDown={(e) => drag.start(e)}>
                <div className="grid place-items-center pb-1 pt-2">
                  <span className="h-[5px] w-10 rounded-full bg-fill2" />
                </div>
                {(title || actions) && (
                  <div className="flex items-center gap-2 px-5 pb-3 pt-1.5">
                    <h2 className="min-w-0 flex-1 truncate text-[1.08rem] font-bold tracking-[-0.02em] text-ink">{title}</h2>
                    {actions}
                    <IconBtn icon="close" label="Close" size="sm" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} />
                  </div>
                )}
              </div>
              <div {...scrollProps} className={`v-scroll min-h-0 flex-1 ${padded ? 'px-5 pb-5' : ''}`} style={!wide && !footer ? { paddingBottom: 'max(20px, env(safe-area-inset-bottom))' } : undefined}>
                {children}
              </div>
              {footer && (
                <div className="v-hair-t flex-none px-5 pt-3" style={{ paddingBottom: wide ? 14 : 'max(14px, env(safe-area-inset-bottom))' }}>
                  {footer}
                </div>
              )}
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export const sheetOpen = () => stack.length > 0;
