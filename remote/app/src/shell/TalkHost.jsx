import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useIsPresent } from 'motion/react';
import { useMC } from '../lib/store.js';
import { useMedia } from '../lib/hooks.js';
import { spring, press } from '../lib/motion.js';
import { useTalk, startTalk, endTalk, setTalkSlot, requestExpand } from '../lib/talkSession.js';
import { useAnnounce, considerMessages, dismissAnnounce, hearAnnouncement, dismissLink } from '../lib/announce.js';
import Icon from '../ui/Icon.jsx';
import Talk from '../views/mia/Talk.jsx';
import { LABEL } from '../views/mia/TalkParts.jsx';

// The talk session's home at the app root (lib/talkSession.js explains the
// arrangement). TalkHost keeps <Talk> mounted while a session is on and moves
// its DOM node between the Mia view's <TalkSlot/> and an off-screen park;
// off the Mia view TalkPill shows the session in the top bar. The pill also
// carries Mia's spoken announcements (lib/announce.js) with a mic to answer.
//
// Placement: on a desk-width screen the pill sits in the middle of the slim
// top bar, between the clock and the controls. Narrower, where a window
// covers the bar, it gets its own strip under the status bar: --talkbar
// pushes the top bar and the full-screen windows down by that much, so the
// pill never covers a control, and the dock at the bottom is never touched.

const STRIP = 48; // px reserved under the safe area on narrow screens

export function TalkSlot() {
  const ref = useRef(null);
  // A Mia window that is animating away (or held by AnimatePresence) is no
  // longer where Daniel is looking: give the session back to the pill at once.
  const present = useIsPresent();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!present) return undefined;
    setTalkSlot(el);
    return () => {
      if (useTalk.getState().slot === el) setTalkSlot(null);
    };
  }, [present]);
  return <div ref={ref} data-talk-slot className="flex min-h-0 flex-1 flex-col border-t border-glass-line" />;
}

function Meter({ levels, live }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!levels) return undefined;
    levels.add(setLevel);
    return () => levels.delete(setLevel);
  }, [levels]);
  const bars = [0.55, 0.85, 1, 0.8, 0.5];
  return (
    <span aria-hidden="true" data-meter className="flex h-4 flex-none items-center gap-[2px]">
      {bars.map((w, i) => (
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

function PillShell({ children, desktop, label }) {
  return (
    <motion.div
      // Enter only: the pill swaps kinds and hands off to the Mia view often,
      // and a lingering exit copy would sit over the view it handed off to.
      initial={{ opacity: 0, y: -10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={spring.snappy}
      role="region"
      aria-label={label}
      data-talk-pill
      className="glass-strong fixed left-1/2 z-[58] flex h-9 -translate-x-1/2 items-center gap-1 pl-1 pr-1 text-ink"
      style={{
        top: desktop ? 'calc(env(safe-area-inset-top) + 6px)' : 'calc(env(safe-area-inset-top) + 6px)',
        borderRadius: 9999,
        maxWidth: desktop ? 'min(380px, calc(100vw - 600px))' : 'min(460px, calc(100vw - 24px))',
        minWidth: 0,
      }}
    >
      {children}
    </motion.div>
  );
}

function SessionPill({ onExpand, desktop }) {
  const phase = useTalk((s) => s.phase);
  const levels = useTalk((s) => s.levels);
  const engine = useTalk((s) => s.engine);
  const live = phase === 'listening' || phase === 'hearing';
  const tone = phase === 'hearing' ? 'text-accent' : phase === 'speaking' ? 'text-ink' : live ? 'text-ink' : 'text-ink2';
  return (
    <PillShell desktop={desktop} label="Talking with Mia">
      <motion.button
        {...press}
        onClick={onExpand}
        data-pill-expand
        aria-label={`${LABEL[phase] || 'Talk'} — open Mia`}
        className={`pill flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-[12.5px] font-medium ${tone}`}
      >
        <Meter levels={levels} live={live || phase === 'speaking'} />
        <span data-pill-phase={phase} className="truncate">
          {LABEL[phase] || 'Talk'}
        </span>
        {engine === 'realtime' && <span className="hidden flex-none text-[10px] font-medium tracking-[0.08em] text-ink3 sm:inline">RT</span>}
        <Icon name="expand" size={12} className="flex-none text-ink3" />
      </motion.button>
      <motion.button
        {...press}
        onClick={() => endTalk()}
        data-pill-stop
        aria-label="End the voice session"
        className="grid h-7 w-7 flex-none place-items-center rounded-full bg-crit/15 text-crit"
      >
        <Icon name="stop" size={12} strokeWidth={2.4} />
      </motion.button>
    </PillShell>
  );
}

function AnnouncePill({ cur, desktop }) {
  const locked = cur.state === 'locked';
  const answer = () => {
    // The tap opens the mic (inside the gesture) and the session starts with
    // the announcement as context, so a short "yes" answers it.
    dismissAnnounce();
    startTalk({ context: cur.msg });
  };
  return (
    <PillShell desktop={desktop} label="Mia wants to talk">
      <motion.button
        {...press}
        onClick={locked ? hearAnnouncement : answer}
        data-announce={cur.state}
        aria-label={locked ? 'Mia wants to talk — tap to hear' : `Mia: ${cur.text} — tap to answer`}
        className="pill flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-[12.5px] font-medium text-ink"
      >
        <Icon name="mia" size={13} className="flex-none text-ink2" />
        <span className="truncate">{locked ? 'Mia wants to talk — tap to hear' : cur.text}</span>
      </motion.button>
      {!locked && (
        <motion.button
          {...press}
          onClick={answer}
          data-announce-mic
          aria-label="Answer Mia"
          className="grid h-7 w-7 flex-none place-items-center rounded-full bg-ink text-bg"
        >
          <Icon name="mic" size={13} strokeWidth={2.2} />
        </motion.button>
      )}
      <motion.button
        {...press}
        onClick={dismissAnnounce}
        aria-label="Dismiss"
        className="grid h-7 w-7 flex-none place-items-center rounded-full text-ink3 hover:text-ink"
      >
        <Icon name="close" size={13} />
      </motion.button>
    </PillShell>
  );
}

function LinkPill({ link, desktop }) {
  return (
    <PillShell desktop={desktop} label="Link from Mia">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => setTimeout(dismissLink, 300)}
        data-link-offer
        className="pill flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-[12.5px] font-medium text-ink"
      >
        <Icon name="link" size={13} className="flex-none text-ink2" />
        <span className="truncate">Open {link.host}</span>
      </a>
      <motion.button
        {...press}
        onClick={dismissLink}
        aria-label="Dismiss"
        className="grid h-7 w-7 flex-none place-items-center rounded-full text-ink3 hover:text-ink"
      >
        <Icon name="close" size={13} />
      </motion.button>
    </PillShell>
  );
}

export default function TalkHost({ onExpand }) {
  const on = useTalk((s) => s.on);
  const slot = useTalk((s) => s.slot);
  const mia = useMC((s) => s.mia);
  const cur = useAnnounce((s) => s.current);
  const link = useAnnounce((s) => s.link);
  const desktop = useMedia('(min-width: 1024px)');
  const park = useRef(null);
  const [node] = useState(() => {
    const d = document.createElement('div');
    d.className = 'flex min-h-0 flex-1 flex-col';
    d.dataset.talkHost = '';
    return d;
  });

  // Where the live Talk view sits: inside the Mia view, or parked.
  useLayoutEffect(() => {
    const target = slot || park.current;
    if (target && node.parentNode !== target) target.appendChild(node);
  }, [slot, on, node]);

  // Announcements watch the thread from here, so they work on every view.
  const msgs = mia?.messages;
  useEffect(() => considerMessages(msgs), [msgs]);

  // One pill at a time: a link waiting for its tap, then the session, then an
  // announcement.
  const showLink = !!link;
  const showSession = !showLink && on && !slot;
  const showAnnounce = !showLink && !on && !!cur;
  const pill = showLink || showSession || showAnnounce;

  useEffect(() => useTalk.setState({ pill }), [pill]);

  // Narrow screens: make room for the pill under the status bar.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--talkbar', pill && !desktop ? `${STRIP}px` : '0px');
    return () => root.style.setProperty('--talkbar', '0px');
  }, [pill, desktop]);

  return (
    <>
      {/* Off-screen, not display:none — the realtime <audio> and the level
          meter keep running while the view is parked. */}
      <div
        ref={park}
        aria-hidden="true"
        inert
        style={{ position: 'fixed', left: -10000, top: 0, width: 360, height: 640, overflow: 'hidden', pointerEvents: 'none' }}
      />
      {on && createPortal(<Talk mia={mia} onExit={endTalk} />, node)}
      {showSession && (
          <SessionPill
            key="session"
            onExpand={() => {
              requestExpand();
              onExpand?.();
            }}
            desktop={desktop}
          />
        )}
        {showLink && <LinkPill key="link" link={link} desktop={desktop} />}
      {showAnnounce && <AnnouncePill key={`a${cur.msg?.id || ''}`} cur={cur} desktop={desktop} />}
    </>
  );
}
