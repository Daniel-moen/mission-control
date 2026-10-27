import { useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, agentStatus, agentName, fmtTokens, isMiaAgent, attentionList } from '../src/lib/store.js';
import { fmtMoney } from '../src/lib/format.js';
import Ticker from '../src/ui/Ticker.jsx';
import { push, goView, openSheet } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring, tap } from '../v2/lib/motion.js';
import { useWide } from '../v2/ui/hooks.js';
import { Icon } from '../v2/ui/kit.jsx';
import { place } from './Chrome.jsx';
import { QuestionCard, AgentAskCard } from '../v2/views/parts/Needs.jsx';

// v5 Home (task 0483) — v1's resting scene, in Lens glass. The photo is the
// room. One greeting, one honest sentence about the fleet, one button that
// does the most useful thing right now, a quiet row of figures — and under
// them, everything waiting on Daniel as glass cards he can answer in place
// (Mia's questions from the last hour; older ones wait in her chat). Every
// other place opens as a window from the dock.

const RECENT_MS = 60 * 60 * 1000;
const isRecent = (q, now) => {
  const t = Date.parse(q?.askedAt || '');
  return !Number.isFinite(t) || now - t <= RECENT_MS;
};
function greetingFor(h) {
  if (h >= 5 && h < 12) return 'Good morning.';
  if (h >= 12 && h < 17) return 'Good afternoon.';
  if (h >= 17 && h < 22) return 'Good evening.';
  return 'Good night.';
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function Home() {
  const { agents, summary, link, mia, now } = useMC(useShallow((s) => ({ agents: s.agents, summary: s.summary, link: s.link, mia: s.mia, now: s.now })));
  const reduce = usePrefs((s) => s.reduce);
  const wide = useWide(1000);
  const [all, setAll] = useState(false);
  const t = now || Date.now();

  const c = counts(agents);
  const waiting = agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a));
  c.waiting = waiting.length;
  const first = waiting[0] || null;
  const items = attentionList(agents, mia);
  const shownItems = items.filter((it) => it.kind !== 'mia' || isRecent(it.question, t));
  const olderQs = items.length - shownItems.length;
  const miaQs = shownItems.filter((it) => it.kind === 'mia').length;
  const s = summary || {};

  // One sentence, and it has to be true (v1's rules, word for word).
  let sentence;
  if (link === 'offline') sentence = 'Reconnecting to your Mac…';
  else if (link === 'relay') sentence = 'Your Mac is offline.';
  else if (miaQs && !c.waiting) sentence = `Mia has ${miaQs === 1 ? 'a question' : `${miaQs} questions`} for you`;
  else if (c.working && c.waiting) sentence = `${plural(c.working, 'agent', 'agents')} working · ${plural(c.waiting, 'needs', 'need')} you`;
  else if (c.working) sentence = `${plural(c.working, 'agent', 'agents')} working — nothing waiting on you`;
  else if (c.waiting === 1 && first) sentence = `${agentName(first)} is asking a question`;
  else if (c.waiting > 1) sentence = `${c.waiting} agents need you`;
  else if (agents.length) sentence = `All quiet — ${plural(c.done, 'agent', 'agents')} finished, nothing waiting`;
  else sentence = 'No agents running.';

  const cta =
    miaQs && !c.waiting
      ? { label: 'Answer Mia', tone: 'warn', icon: 'mia', run: () => goView('mia') }
      : c.waiting && first
        ? { label: `Answer ${agentName(first)}`, tone: 'warn', icon: 'alert', run: () => push('agent', { id: first.id }) }
        : c.working
          ? { label: 'Open fleet', tone: 'glass', icon: 'agents', run: () => goView('fleet') }
          : { label: 'Launch an agent', tone: 'primary', icon: 'launch', run: () => openSheet('launch') };

  const hasData = agents.length > 0 || (s.totalTokens ?? 0) > 0;
  const stats = [
    { key: 'burn', node: <Ticker value={Math.round(s.tokensPerSec ?? 0)} format={(n) => String(Math.round(n))} />, unit: 'tok/s', live: (s.tokensPerSec ?? 0) > 0, go: 'insights' },
    { key: 'spend', node: <Ticker value={s.totalCost ?? 0} format={(n) => fmtMoney(n)} />, unit: 'today', go: 'insights' },
    { key: 'tokens', node: <Ticker value={s.totalTokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />, unit: 'tokens', hide: true, go: 'insights' },
    { key: 'fleet', node: <span className="v-num">{c.working}/{agents.length}</span>, unit: 'working', go: 'fleet' },
  ];

  const MAX = wide ? 4 : 3;
  const shown = all ? shownItems : shownItems.slice(0, MAX);

  return (
    <div className="v5-home v-scroll absolute inset-0" data-home>
      <div className="mx-auto flex min-h-full w-full max-w-[1040px] flex-col px-4 sm:px-6" style={{ paddingTop: 'var(--win-top)', paddingBottom: 'var(--home-bottom)' }}>
        <section className={`flex flex-col items-center justify-center text-center ${shownItems.length ? 'min-h-[min(46dvh,420px)] py-8' : 'flex-1 py-10'}`} data-hero>
          <motion.h1
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] }}
            className="v5-hero-title max-w-[16ch] text-[2.65rem] font-bold leading-[1.02] tracking-[-0.035em] sm:text-[3.75rem] lg:text-[4.25rem]"
          >
            {greetingFor(new Date(t).getHours())}
          </motion.h1>
          <div className="mt-3.5 flex min-h-[34px] items-center sm:min-h-[40px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={sentence}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.24 }}
                className="v5-hero-sub max-w-[34ch] text-[1.06rem] font-light leading-snug tracking-tight sm:text-[1.5rem]"
                data-home-sentence
              >
                {sentence}
              </motion.p>
            </AnimatePresence>
          </div>
          <motion.button
            {...tap}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.sheet, delay: 0.08 }}
            onClick={cta.run}
            className={`v5-btn v5-btn-${cta.tone} mt-7 flex h-12 items-center gap-2.5 rounded-full px-7 text-[0.96rem] font-semibold`}
            data-home-cta
          >
            <Icon name={cta.icon} size={18} />
            {cta.label}
          </motion.button>
          {hasData && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.16 }} className="mt-9 flex flex-wrap items-center justify-center gap-2" data-figures>
              {stats.map((st) => (
                <motion.button
                  {...tap}
                  key={st.key}
                  onClick={() => place(st.go)}
                  className={`v5-figure items-baseline gap-1.5 rounded-full px-3.5 py-2 text-[0.8rem] ${st.hide ? 'hidden sm:inline-flex' : 'inline-flex'}`}
                  data-lens
                  data-depth="0.4"
                  data-figure={st.key}
                >
                  <span className={`font-semibold ${st.live ? 'text-accent' : 'text-ink'}`}>{st.node}</span>
                  <span className="text-[0.7rem] text-ink3">{st.unit}</span>
                </motion.button>
              ))}
            </motion.div>
          )}
        </section>

        {shownItems.length > 0 && (
          <section className="pb-4" data-needs={shownItems.length}>
            <div className="mb-3 flex items-baseline gap-2 px-1">
              <h2 className="v5-hero-title text-[1.15rem] font-bold tracking-[-0.02em]">Waiting on you</h2>
              <span className="v-num text-[1rem] font-semibold text-warn">{shownItems.length}</span>
            </div>
            <LayoutGroup>
              <div className={`grid items-start gap-3 ${wide ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <AnimatePresence initial={false} mode="popLayout">
                  {shown.map((it, i) => (
                    <motion.div
                      key={it.key}
                      layout={!reduce}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.layout, delay: 0.08 + Math.min(i, 6) * 0.04 } }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
                    >
                      {it.kind === 'mia' ? <QuestionCard q={it.question} /> : <AgentAskCard item={it} />}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </LayoutGroup>
            <div className="mt-3 flex flex-wrap gap-4 px-1">
              {shownItems.length > MAX && (
                <button onClick={() => setAll((v) => !v)} className="v5-hero-sub text-[0.86rem] font-semibold">
                  {all ? 'Show less' : `Show ${shownItems.length - MAX} more`}
                </button>
              )}
            </div>
          </section>
        )}
        {olderQs > 0 && (
          <button onClick={() => goView('mia')} data-older-questions={olderQs} className="v5-hero-sub self-center pb-4 text-[0.86rem] font-semibold">
            {olderQs} older question{olderQs === 1 ? '' : 's'} in Mia’s chat →
          </button>
        )}
      </div>
    </div>
  );
}
