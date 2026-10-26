import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC } from '../../src/lib/store.js';
import { useTalk, startTalk, endTalk, setTalkSlot } from '../../src/lib/talkSession.js';
import { useAnnounce, considerMessages, dismissAnnounce, hearAnnouncement, dismissLink } from '../../src/lib/announce.js';
import { useWake, resumeWake } from '../../src/lib/wake.js';
import { talkSupported } from '../../src/lib/voice.js';
import { useNav, openOverlay, closeOverlay } from '../lib/nav.js';
import { spring, tap } from '../lib/motion.js';
import { Icon } from '../ui/kit.jsx';
import { LABEL } from '../../src/views/mia/TalkParts.jsx';

// Talk mode in v2. The voice engine is v1's (views/mia/Talk.jsx: whisper on
// the relay, Mia's Kokoro voice from the Mac) — mounted ONCE here for as long
// as a session is on, its DOM moved between the full-screen voice view (the
// slot) and an off-screen park, so the mic and the speech queue never notice
// navigation. Minimised, the session lives in a pill just above the tab bar,
// where the thumb is. The same spot carries Mia's spoken announcements and
// links she sends.

const Talk = lazy(() => import('../../src/views/mia/Talk.jsx'));

// Tap handler for every "talk" button: must run inside the tap (iOS only
// unlocks audio + mic from a gesture).
export function startVoice(opts) {
  if (!talkSupported) {
    useMC.setState({ toast: 'Talk mode needs a microphone this browser doesn’t offer' });
    setTimeout(() => useMC.setState({ toast: '' }), 2600);
    return;
  }
  startTalk(opts);
  openOverlay('voice');
}

// Where the live session shows: the voice view mounts this.
export function TalkSlot() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    setTalkSlot(el);
    return () => {
      if (useTalk.getState().slot === el) setTalkSlot(null);
    };
  }, []);
  return <div ref={ref} data-talk-slot className="flex min-h-0 flex-1 flex-col" />;
}

function Meter({ levels, live }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!levels) return undefined;
    levels.add(setLevel);
    return () => levels.delete(setLevel);
  }, [levels]);
  return (
    <span aria-hidden="true" className="flex h-4 flex-none items-center gap-[2px]">
      {[0.55, 0.85, 1, 0.8, 0.5].map((w, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-current"
          animate={{ height: live ? 3 + Math.min(1, level * 1.5) * 13 * w : 3 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      ))}
    </span>
  );
}

function Pill({ children, label, k }) {
  return (
    <motion.div
      key={k}
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.97 }}
      transition={spring.snappy}
      role="region"
      aria-label={label}
      data-talk-pill
      className="v-bar pointer-events-auto flex h-12 max-w-[min(480px,calc(100vw-24px))] items-center gap-1 rounded-full pl-1.5 pr-1.5 text-ink"
    >
      {children}
    </motion.div>
  );
}

export default function TalkHost() {
  const on = useTalk((s) => s.on);
  const slot = useTalk((s) => s.slot);
  const phase = useTalk((s) => s.phase);
  const levels = useTalk((s) => s.levels);
  const mia = useMC((s) => s.mia);
  const cur = useAnnounce((s) => s.current);
  const link = useAnnounce((s) => s.link);
  const voiceOpen = useNav((s) => s.overlay?.name === 'voice');
  const tabbarUp = useNav((s) => !s.overlay);
  const wake = useWake();
  const park = useRef(null);
  const [node] = useState(() => {
    const d = document.createElement('div');
    d.className = 'flex min-h-0 flex-1 flex-col';
    d.dataset.talkHost = '';
    return d;
  });

  useLayoutEffect(() => {
    const target = slot || park.current;
    if (target && node.parentNode !== target) target.appendChild(node);
  }, [slot, on, node]);

  // Announcements watch the thread from here, so they work on every page.
  const msgs = mia?.messages;
  useEffect(() => considerMessages(msgs), [msgs]);

  // A session that ends while its view is open closes the view.
  const wasOn = useRef(on);
  useEffect(() => {
    if (wasOn.current && !on && voiceOpen) closeOverlay();
    wasOn.current = on;
  }, [on, voiceOpen]);

  // Keep the screen awake while "Hey Mia" listens (iOS kills the mic with it).
  useEffect(() => {
    if (!wake.on || wake.status !== 'listening' || !navigator.wakeLock) return undefined;
    let lock = null;
    let dead = false;
    const get = () => navigator.wakeLock.request('screen').then((l) => (dead ? l.release() : (lock = l))).catch(() => {});
    get();
    const vis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', vis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', vis);
      lock?.release?.().catch?.(() => {});
    };
  }, [wake.on, wake.status]);

  const showLink = !!link;
  const showSession = !showLink && on && !voiceOpen;
  const showAnnounce = !showLink && !on && !!cur;
  const showWake = !showLink && !showSession && !showAnnounce && wake.on && wake.status === 'interrupted';
  const live = phase === 'listening' || phase === 'hearing';

  const answer = () => {
    dismissAnnounce();
    startVoice({ context: cur.msg });
  };

  return (
    <>
      <div
        ref={park}
        aria-hidden="true"
        inert
        style={{ position: 'fixed', left: -10000, top: 0, width: 360, height: 640, overflow: 'hidden', pointerEvents: 'none' }}
      />
      {on &&
        createPortal(
          <Suspense fallback={null}>
            <Talk mia={mia} onExit={endTalk} />
          </Suspense>,
          node,
        )}
      <div
        className="pointer-events-none fixed inset-x-0 z-[55] flex justify-center px-3"
        style={{ bottom: tabbarUp ? 'calc(max(10px, env(safe-area-inset-bottom) - 4px) + 84px - var(--vgap, 0px))' : 'calc(max(14px, env(safe-area-inset-bottom)) - var(--vgap, 0px))' }}
      >
        <AnimatePresence mode="popLayout">
          {showSession && (
            <Pill k="session" label="Talking with Mia">
              <motion.button
                {...tap}
                onClick={() => openOverlay('voice')}
                data-pill-expand
                className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full px-3 text-[0.86rem] font-semibold"
              >
                <span className={phase === 'hearing' ? 'text-accent' : 'text-ink'}>
                  <Meter levels={levels} live={live || phase === 'speaking'} />
                </span>
                <span data-pill-phase={phase} className="truncate">
                  {LABEL[phase] || 'Talk'}
                </span>
                <Icon name="chevronUp" size={15} className="flex-none text-ink3" />
              </motion.button>
              <motion.button {...tap} onClick={() => endTalk()} data-pill-stop aria-label="End the voice session" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-crit text-white">
                <Icon name="stop" size={13} strokeWidth={2.6} />
              </motion.button>
            </Pill>
          )}
          {showLink && (
            <Pill k="link" label="Link from Mia">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setTimeout(dismissLink, 300)}
                data-link-offer
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-[0.86rem] font-semibold"
              >
                <Icon name="link" size={15} className="flex-none text-ink2" />
                <span className="truncate">Open {link.host}</span>
              </a>
              <motion.button {...tap} onClick={dismissLink} aria-label="Dismiss" className="grid h-9 w-9 flex-none place-items-center rounded-full text-ink3">
                <Icon name="close" size={15} />
              </motion.button>
            </Pill>
          )}
          {showAnnounce && (
            <Pill k={`a${cur.msg?.id || ''}`} label="Mia wants to talk">
              <motion.button
                {...tap}
                onClick={cur.state === 'locked' ? hearAnnouncement : answer}
                data-announce={cur.state}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-[0.86rem] font-semibold"
              >
                <Icon name="mia" size={15} className="flex-none text-accent" />
                <span className="truncate">{cur.state === 'locked' ? 'Mia wants to talk — tap to hear' : cur.text}</span>
              </motion.button>
              {cur.state !== 'locked' && (
                <motion.button {...tap} onClick={answer} data-announce-mic aria-label="Answer Mia" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-ink text-page">
                  <Icon name="mic" size={15} strokeWidth={2.2} />
                </motion.button>
              )}
              <motion.button {...tap} onClick={dismissAnnounce} aria-label="Dismiss" className="grid h-9 w-9 flex-none place-items-center rounded-full text-ink3">
                <Icon name="close" size={15} />
              </motion.button>
            </Pill>
          )}
          {showWake && (
            <Pill k="wake" label="Hey Mia paused">
              <motion.button {...tap} onClick={() => resumeWake()} className="flex h-9 items-center gap-2 rounded-full px-3 text-[0.86rem] font-semibold text-warn">
                <Icon name="ear" size={15} />
                Tap to resume “Hey Mia”
              </motion.button>
            </Pill>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
