import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, saveToken, dataAge, reconnectNow } from '../../src/lib/store.js';
import { spring } from '../lib/motion.js';
import { useV2Cache } from '../lib/offline.js';
import { Button, Icon } from '../ui/kit.jsx';

// Small shell pieces: the toast, the connection pill, the sign-in gate.

export function Toast() {
  const text = useMC((s) => s.toast);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[96] flex justify-center px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px)' }}>
      <AnimatePresence>
        {text && (
          <motion.div
            key={text}
            initial={{ opacity: 0, y: -18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.97 }}
            transition={spring.snappy}
            className="v-bar max-w-[min(520px,92vw)] break-words rounded-full px-4 py-2.5 text-center text-[0.86rem] font-medium text-ink"
            role="status"
            data-toast
          >
            {text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

// Not linked → a calm pill under the status bar with an honest age, and a
// retry. Showing the cached picture from before (lib/offline.js) says so.
export function ConnPill() {
  const link = useMC((s) => s.link);
  const hasSnap = useMC((s) => !!s.snapshot);
  useMC((s) => s.now);
  const age = dataAge();
  const cached = !hasSnap && useV2Cache.at ? Math.round((Date.now() - useV2Cache.at) / 60000) : null;
  const off = link === 'offline';
  const label = off ? 'Reconnecting…' : 'Your Mac is offline';
  const when = cached != null ? `showing ${cached < 1 ? 'a moment' : `${cached} min`} ago` : age != null ? `${age < 60 ? `${age}s` : `${Math.round(age / 60)}m`} ago` : '';
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}>
      <AnimatePresence>
        {link !== 'linked' && (
          <motion.div
            key="conn"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={spring.snappy}
            role="status"
            data-conn={link}
            className={`v-bar pointer-events-auto flex h-9 items-center gap-2 rounded-full pl-3 pr-1 text-[0.8rem] font-semibold ${off ? 'text-crit' : 'text-warn'}`}
          >
            <span className={`h-2 w-2 rounded-full ${off ? 'bg-crit' : 'bg-warn'} v-breathe`} />
            <span>{label}</span>
            {when && <span className="v-num font-medium text-ink3">· {when}</span>}
            <button onClick={reconnectNow} className="ml-1 h-7 rounded-full bg-fill px-3 text-[0.76rem] font-semibold text-ink hover:bg-fill2">
              Retry
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Gate() {
  const [value, setValue] = useState('');
  const verifying = useMC((s) => s.verifying);
  const reason = useMC((s) => s.gateReason);
  const go = () => value.trim() && !verifying && saveToken(value);
  return (
    <div className="fixed inset-0 z-[2] grid place-items-center px-6" style={{ bottom: 'calc(0px - var(--vgap))' }}>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={spring.sheet} className="w-full max-w-sm">
        <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-ink text-page">
          <Icon name="sparkles" size={26} />
        </span>
        <h1 className="v-title mt-6 text-ink">Mission Control</h1>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-ink2">Enter your access token to connect to your Mac.</p>
        <input
          aria-label="Access token"
          className="v-field mt-7 h-12 w-full px-4 font-mono text-[1rem]"
          type="password"
          placeholder="Access token"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        {reason && (
          <p role="alert" className="mt-3 text-[0.86rem] leading-relaxed text-crit">
            {reason}
          </p>
        )}
        <Button tone="primary" size="lg" className="mt-4 w-full" disabled={!value.trim()} loading={verifying} onClick={go}>
          {verifying ? 'Checking…' : 'Connect'}
        </Button>
      </motion.div>
    </div>
  );
}
