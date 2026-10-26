import { lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNav, closeOverlay } from '../lib/nav.js';
import { useTalk, endTalk } from '../../src/lib/talkSession.js';
import { useMC } from '../../src/lib/store.js';
import { usePrefs } from '../lib/prefs.js';
import { spring, fade, tap } from '../lib/motion.js';
import { Icon } from '../ui/kit.jsx';
import { TalkSlot } from './TalkHost.jsx';

// Full-screen takeovers. The terminal console and the TV / car modes are
// v1's own (they were designed as dark, full-bleed instruments and already
// feel native); v2 frames them and owns how they come and go. The voice view
// is v2's: a quiet dark room around the live talk session.

const Console = lazy(() => import('../../src/views/agent/TerminalConsole.jsx'));
const Tv = lazy(() => import('../../src/views/modes/TvMode.jsx'));
const Car = lazy(() => import('../../src/views/modes/CarMode.jsx'));

function Voice() {
  const phase = useTalk((s) => s.phase);
  const on = useTalk((s) => s.on);
  const mia = useMC((s) => s.mia);
  const presence = !mia ? 'Mia is off' : mia.online ? 'Mia is listening' : 'Mia is offline — what you say waits for her';
  return (
    <div className="flex h-full flex-col bg-[#09090b] text-ink" data-theme="dark" data-voice={phase}>
      {/* a slow, soft light that breathes with the conversation — no glow theatre */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[-20%] mx-auto h-[70%] max-w-[900px] rounded-full"
        style={{ background: 'radial-gradient(closest-side, rgba(62,207,142,0.10), transparent)' }}
        animate={{ opacity: phase === 'hearing' || phase === 'speaking' ? 1 : 0.45, scale: phase === 'hearing' ? 1.06 : 1 }}
        transition={spring.gentle}
      />
      <header className="relative z-10 flex flex-none items-center gap-3 px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}>
        <motion.button
          {...tap}
          onClick={closeOverlay}
          aria-label="Minimise"
          data-voice-min
          className="grid h-11 w-11 place-items-center rounded-full bg-white/[0.07] text-ink"
        >
          <Icon name="chevronDown" size={20} strokeWidth={2.2} />
        </motion.button>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-[1rem] font-semibold tracking-[-0.01em]">Talking with Mia</div>
          <div className="truncate text-[0.76rem] text-ink3">{presence}</div>
        </div>
        <motion.button
          {...tap}
          onClick={() => {
            endTalk();
            closeOverlay();
          }}
          aria-label="End"
          className="h-11 rounded-full bg-crit/15 px-4 text-[0.86rem] font-semibold text-crit"
        >
          End
        </motion.button>
      </header>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{on ? <TalkSlot /> : null}</div>
    </div>
  );
}

export default function Overlays() {
  const o = useNav((s) => s.overlay);
  const reduce = usePrefs((s) => s.reduce);
  const v = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: fade }
    : { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' }, transition: spring.sheet };
  return (
    <AnimatePresence>
      {o && (
        <motion.div
          key={o.name}
          {...v}
          className="fixed inset-0 z-[70] overflow-hidden"
          style={{ bottom: 'calc(0px - var(--vgap))' }}
          data-overlay={o.name}
          data-theme="dark"
        >
          <Suspense fallback={<div className="h-full w-full bg-[#09090b]" />}>
            {o.name === 'voice' && <Voice />}
            {o.name === 'console' && <Console agentId={o.params.id || null} onSelect={() => {}} onClose={closeOverlay} />}
            {o.name === 'tv' && <Tv onClose={() => (location.hash = '')} />}
            {o.name === 'car' && <Car onClose={() => (location.hash = '')} />}
          </Suspense>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
