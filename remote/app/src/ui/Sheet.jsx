import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { spring, fadeIn } from '../lib/motion.js';
import { useMedia } from '../lib/hooks.js';
import IconButton from './IconButton.jsx';

const MAXW = { sm: 'sm:max-w-[420px]', md: 'sm:max-w-[560px]', lg: 'sm:max-w-[760px]', full: 'sm:max-w-[1100px]' };

// One sheet, two shapes: on a phone it rises from the bottom with a drag
// handle (thumb reach); from 640px up it is a centred dialog. Both render
// through a portal so no ancestor's overflow/transform can clip them.
export default function Sheet({ open, onClose, title, size = 'md', footer, children }) {
  const wide = useMedia('(min-width: 640px)');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      // Keep Tab inside the sheet — a dialog that tabs into the page behind it
      // is a dialog you can lose.
      if (e.key !== 'Tab' || !box.current) return;
      const f = box.current.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  const panel = (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={`glass-strong flex max-h-[92dvh] min-h-0 w-full flex-col overflow-hidden ${
        wide ? (MAXW[size] || MAXW.md) : 'rounded-b-none'
      }`}
      style={wide ? undefined : { paddingBottom: 'var(--sab)' }}
      onClick={(e) => e.stopPropagation()}
    >
      {!wide && (
        <div className="grid flex-none cursor-grab place-items-center pt-2.5 pb-1 active:cursor-grabbing">
          <div className="h-1 w-9 rounded-full bg-white/25" />
        </div>
      )}
      {title && (
        <div className="flex flex-none items-center gap-3 px-5 pb-3 pt-4">
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">{title}</h2>
          <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />
        </div>
      )}
      <div className="noscroll min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
      {footer && <div className="flex-none border-t border-glass-line px-5 py-3.5">{footer}</div>}
    </div>
  );

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...fadeIn}
          // The scrim blurs the scene, not just dims it — otherwise the huge
          // Home headline stays legible straight through the sheet's glass.
          className="fixed inset-0 z-[90] flex justify-center bg-overlay backdrop-blur-lg sm:items-center sm:p-6"
          style={{ alignItems: wide ? undefined : 'flex-end' }}
          onClick={onClose}
        >
          {wide ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={spring.smooth}
              className={`flex w-full justify-center ${MAXW[size] || MAXW.md}`}
            >
              {panel}
            </motion.div>
          ) : (
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={spring.smooth}
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 120 || info.velocity.y > 700) onClose?.();
              }}
              className="w-full"
            >
              {panel}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
