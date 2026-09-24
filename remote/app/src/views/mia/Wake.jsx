import { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useWake, enableWake, disableWake, resumeWake, wakeSupported } from '../../lib/wake.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';

// "Hey Mia" controls. Every enable/resume is a tap, because iOS only opens the
// mic from one — and after the app has been in the background, iOS may need
// that tap again.

export const WAKE_HINT =
  'Say “Hey Mia” to start talking and “Okay Mia, I’m done” to finish. It runs on this device — no audio leaves it until Mia answers. On iPad and iPhone it only listens while this app is open on screen, so the screen is kept awake while it’s on; after switching apps, tap to resume.';

// The toggle (Mia header, Settings).
export function WakeToggle({ size = 'sm' }) {
  const w = useWake();
  if (!wakeSupported) return null;
  if (w.status === 'loading')
    return (
      <Button size={size} loading title="First time: downloads a 40 MB speech model, once">
        Hey Mia
      </Button>
    );
  if (w.on && w.status === 'interrupted')
    return (
      <Button size={size} variant="warn" icon="ear" onClick={() => resumeWake()}>
        Tap to resume “Hey Mia”
      </Button>
    );
  if (w.on)
    return (
      <Button size={size} variant="secondary" icon="ear" onClick={() => disableWake()} title="Listening for “Hey Mia” — tap to turn off" data-wake={w.status}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        Hey Mia on
      </Button>
    );
  return (
    <Button size={size} icon="earOff" onClick={() => enableWake()} title={w.error || 'Listen for “Hey Mia” (tap to allow the mic)'} data-wake="off">
      {w.wanted ? 'Resume “Hey Mia”' : 'Hey Mia'}
    </Button>
  );
}

// A small pill while listening, visible from every screen, so it's never on
// by surprise — and the place to tap after iOS paused it.
export function WakePill() {
  const w = useWake();
  // Keep the screen awake while listening: on iOS the wake word dies with it.
  useEffect(() => {
    if (!w.on || w.status !== 'listening') return undefined;
    let lock = null;
    let dead = false;
    const get = () =>
      navigator.wakeLock
        ?.request('screen')
        .then((l) => (dead ? l.release() : (lock = l)))
        .catch(() => {});
    get();
    const vis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', vis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', vis);
      lock?.release?.().catch?.(() => {});
    };
  }, [w.on, w.status]);

  const show = w.on && (w.status === 'listening' || w.status === 'interrupted');
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          onClick={() => (w.status === 'interrupted' ? resumeWake() : disableWake())}
          data-wake-pill={w.status}
          className={`pill glass-soft fixed left-1/2 z-[65] flex -translate-x-1/2 items-center gap-1.5 px-3 py-1 text-[11.5px] ${
            w.status === 'interrupted' ? 'text-warn' : 'text-ink2'
          }`}
          style={{ top: 'calc(env(safe-area-inset-top) + 10px)' }}
          aria-label={w.status === 'interrupted' ? 'Tap to resume listening for Hey Mia' : 'Listening for Hey Mia — tap to turn off'}
        >
          <Icon name="ear" size={12} />
          {w.status === 'interrupted' ? 'Tap to resume “Hey Mia”' : 'Listening for “Hey Mia”'}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
