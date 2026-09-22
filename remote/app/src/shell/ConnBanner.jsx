import { motion, AnimatePresence } from 'motion/react';
import { useLink, useNow } from '../lib/hooks.js';
import { dataAge, reconnectNow } from '../lib/store.js';
import { spring } from '../lib/motion.js';
import Icon from '../ui/Icon.jsx';

// Unmissable but non-modal: shown whenever the panel is not fully linked
// (host streaming), with an honest seconds-since-last-data count. Over the
// backdrop it reads as a tinted glass strip rather than a full-bleed bar.
export default function ConnBanner() {
  const link = useLink();
  useNow(); // re-render at 1 Hz so the age below stays honest
  const off = link === 'offline';
  const age = dataAge();

  return (
    <AnimatePresence initial={false}>
      {link !== 'linked' && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={spring.smooth}
          className="relative z-30 overflow-hidden"
          role="status"
        >
          <div className="flex justify-center px-4 pb-1 pt-1">
            <div
              className={`pill flex max-w-full items-center gap-2.5 border px-4 py-2 text-[12.5px] backdrop-blur-xl ${
                off ? 'border-crit/30 bg-crit/12 text-crit' : 'border-warn/30 bg-warn/12 text-warn'
              }`}
            >
              <Icon name="alert" size={15} className="flex-none" />
              <span className="min-w-0 truncate font-medium">
                {off ? 'Reconnecting…' : 'Your Mac is offline'}
              </span>
              <span className="flex-none font-mono text-[11.5px] tnum opacity-80">
                {age !== null ? `${age}s ago` : 'no data yet'}
              </span>
              <button
                onClick={reconnectNow}
                className="pill ml-1 flex-none bg-white/12 px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-white/20"
              >
                Retry
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
