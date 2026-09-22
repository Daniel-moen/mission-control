import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC } from '../lib/store.js';
import { spring } from '../lib/motion.js';

// One line of feedback, bottom-centre, above the dock. Never blocks a tap.
export default function Toast() {
  const text = useMC((s) => s.toast);
  return createPortal(
    <AnimatePresence>
      {text && (
        <motion.div
          key={text}
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={spring.snappy}
          className="glass-strong pointer-events-none fixed left-1/2 z-[95] max-w-[92vw] -translate-x-1/2 break-words px-4 py-2.5 text-[13.5px] text-ink"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 88px)', borderRadius: 9999 }}
          role="status"
        >
          {text}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
