import { motion, AnimatePresence } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, agentStatus, agentName, fmtTokens } from '../../lib/store.js';
import { fmtMoney } from '../../lib/format.js';
import { useNow } from '../../lib/hooks.js';
import { spring, ease } from '../../lib/motion.js';
import Ticker from '../../ui/Ticker.jsx';
import Button from '../../ui/Button.jsx';

// The centre stage. One greeting, one honest sentence about the fleet, one
// button that does the most useful thing available right now, and a quiet row
// of figures. Anything more belongs in a window.

function greetingFor(h) {
  if (h >= 5 && h < 12) return 'Good morning.';
  if (h >= 12 && h < 17) return 'Good afternoon.';
  if (h >= 17 && h < 22) return 'Good evening.';
  return 'Good night.';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function Home({ onOpenAgent, onFleet, onLaunch }) {
  const now = useNow();
  const { agents, summary, link } = useMC(
    useShallow((s) => ({ agents: s.agents, summary: s.summary, link: s.link })),
  );

  const c = counts(agents);
  const waiting = agents.filter((a) => agentStatus(a) === 'waiting');
  const first = waiting[0] || null;
  const s = summary || {};

  // One sentence, and it has to be true. Link trouble outranks fleet news —
  // nothing else on this screen is trustworthy while the Mac is quiet.
  let sentence;
  if (link === 'offline') sentence = 'Reconnecting to your Mac…';
  else if (link === 'relay') sentence = 'Your Mac is offline.';
  else if (c.working && c.waiting)
    sentence = `${plural(c.working, 'agent', 'agents')} working · ${plural(c.waiting, 'needs', 'need')} you`;
  else if (c.working) sentence = `${plural(c.working, 'agent', 'agents')} working — nothing waiting on you`;
  else if (c.waiting === 1 && first) sentence = `${agentName(first)} is asking a question`;
  else if (c.waiting > 1) sentence = `${c.waiting} agents need you`;
  else if (agents.length) sentence = `All quiet — ${plural(c.done, 'agent', 'agents')} finished, nothing waiting`;
  else sentence = 'No agents running.';

  const cta = c.waiting && first
    ? { label: `Answer ${agentName(first)}`, variant: 'warn', icon: 'alert', onClick: () => onOpenAgent?.(first.id) }
    : c.working
      ? { label: 'Open fleet', variant: 'secondary', icon: 'agents', onClick: () => onFleet?.() }
      : { label: 'Launch an agent', variant: 'primary', icon: 'launch', onClick: () => onLaunch?.() };

  const hasData = agents.length > 0 || (s.totalTokens ?? 0) > 0;
  const stats = [
    { key: 'burn', node: <Ticker value={Math.round(s.tokensPerSec ?? 0)} format={(n) => String(Math.round(n))} />, unit: 'tok/s', live: (s.tokensPerSec ?? 0) > 0 },
    { key: 'spend', node: <Ticker value={s.totalCost ?? 0} format={(n) => fmtMoney(n)} />, unit: '' },
    // Four figures don't fit one phone row, and a lone wrapped pill looks
    // like a mistake — the token total is the one that can wait.
    { key: 'tokens', node: <Ticker value={s.totalTokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />, unit: 'tokens', hide: 'hidden sm:inline-flex' },
    { key: 'fleet', node: <span className="tnum">{c.working}/{agents.length}</span>, unit: 'working' },
  ];

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <motion.h1
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: ease.out }}
        className="max-w-[16ch] text-[42px] font-bold leading-[1.02] tracking-[-0.035em] text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.5)] sm:text-[60px] lg:text-[68px]"
      >
        {greetingFor(new Date(now || Date.now()).getHours())}
      </motion.h1>

      <div className="mt-3.5 flex h-[34px] items-center sm:h-[40px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={sentence}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: ease.out }}
            className="max-w-[34ch] text-[17px] font-light leading-snug tracking-tight text-white/75 sm:text-[24px]"
          >
            {sentence}
          </motion.p>
        </AnimatePresence>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring.smooth, delay: 0.08 }}
        className="mt-7"
      >
        <Button size="lg" variant={cta.variant} icon={cta.icon} onClick={cta.onClick} className="px-7 shadow-2">
          {cta.label}
        </Button>
      </motion.div>

      {hasData && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.16 }}
          className="mt-9 flex flex-wrap items-center justify-center gap-2"
        >
          {stats.map((st) => (
            <span
              key={st.key}
              className={`glass-soft pill items-baseline gap-1.5 px-3 py-1.5 text-[12.5px] text-white/80 ${st.hide || 'inline-flex'}`}
            >
              <span className={`font-medium ${st.live ? 'text-accent' : 'text-white'}`}>{st.node}</span>
              {st.unit && <span className="text-[11px] text-white/45">{st.unit}</span>}
            </span>
          ))}
        </motion.div>
      )}
    </div>
  );
}
