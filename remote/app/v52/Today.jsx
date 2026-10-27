import { motion, AnimatePresence } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, agentStatus, agentName, fmtTokens, isMiaAgent, attentionList } from '../src/lib/store.js';
import { fmtMoney } from '../src/lib/format.js';
import Ticker from '../src/ui/Ticker.jsx';
import { push, goView, openSheet } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring, tap } from '../v2/lib/motion.js';
import { Icon } from '../v2/ui/kit.jsx';
import Page from '../v2/shell/Page.jsx';
import { QuestionCard, AgentAskCard } from '../v2/views/parts/Needs.jsx';

// v5.2 Home (task 0491) — "Today": v5's Home and Insights' headline in one
// page, in the pane beside the chat. The greeting and the one true sentence
// (v1's rules, word for word), the useful button, the figures (each opens
// Insights), and everything waiting on Daniel as cards he answers in place.

function greetingFor(h) {
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Good night';
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function Today() {
  const { agents, summary, link, mia, now } = useMC(useShallow((s) => ({ agents: s.agents, summary: s.summary, link: s.link, mia: s.mia, now: s.now })));
  const reduce = usePrefs((s) => s.reduce);
  const t = now || Date.now();
  const c = counts(agents);
  const waiting = agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a));
  c.waiting = waiting.length;
  const first = waiting[0] || null;
  const items = attentionList(agents, mia);
  const miaQs = items.filter((it) => it.kind === 'mia').length;
  const s = summary || {};

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

  const cta = c.waiting && first
    ? { label: `Answer ${agentName(first)}`, tone: 'warn', icon: 'alert', run: () => push('agent', { id: first.id }) }
    : c.working
      ? { label: 'Open Fleet', tone: 'glass', icon: 'agents', run: () => goView('fleet') }
      : { label: 'Launch an agent', tone: 'primary', icon: 'launch', run: () => openSheet('launch') };

  const stats = [
    { key: 'burn', node: <Ticker value={Math.round(s.tokensPerSec ?? 0)} format={(n) => String(Math.round(n))} />, unit: 'tok/s', live: (s.tokensPerSec ?? 0) > 0 },
    { key: 'spend', node: <Ticker value={s.totalCost ?? 0} format={(n) => fmtMoney(n)} />, unit: 'today' },
    { key: 'tokens', node: <Ticker value={s.totalTokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />, unit: 'tokens' },
    { key: 'fleet', node: <span className="v-num">{c.working}/{agents.length}</span>, unit: 'working' },
  ];

  return (
    <Page title={greetingFor(new Date(t).getHours())} subtitle={new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} maxW={860}>
      <div className="flex flex-col gap-6 pb-8" data-today>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={sentence}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24 }}
            className="text-[1.3rem] font-light leading-snug tracking-tight text-ink sm:text-[1.5rem]"
            data-home-sentence
          >
            {sentence}
          </motion.p>
        </AnimatePresence>
        <div className="flex flex-wrap items-center gap-2.5">
          <motion.button {...tap} onClick={cta.run} className={`v5-btn v5-btn-${cta.tone} flex h-11 items-center gap-2 rounded-full px-5 text-[0.92rem] font-semibold`} data-home-cta>
            <Icon name={cta.icon} size={17} />
            {cta.label}
          </motion.button>
        </div>

        <button onClick={() => push('insights', {})} className="v-card grid grid-cols-2 gap-px overflow-hidden p-0 text-left sm:grid-cols-4" data-figures data-open-insights>
          {stats.map((st) => (
            <span key={st.key} className="flex flex-col gap-1 px-4 py-3.5" data-figure={st.key}>
              <span className={`text-[1.35rem] font-semibold tracking-tight ${st.live ? 'text-accent' : 'text-ink'}`}>{st.node}</span>
              <span className="text-[0.74rem] font-medium text-ink3">{st.unit}</span>
            </span>
          ))}
        </button>

        {items.length > 0 && (
          <section data-needs={items.length}>
            <div className="mb-3 flex items-baseline gap-2 px-1">
              <h2 className="text-[1.15rem] font-bold tracking-[-0.02em] text-ink">Waiting on you</h2>
              <span className="v-num text-[1rem] font-semibold text-warn">{items.length}</span>
            </div>
            <div className="grid grid-cols-1 items-start gap-3">
              <AnimatePresence initial={false} mode="popLayout">
                {items.slice(0, 8).map((it, i) => (
                  <motion.div
                    key={it.key}
                    layout={!reduce}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.layout, delay: Math.min(i, 6) * 0.04 } }}
                    exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
                  >
                    {it.kind === 'mia' ? <QuestionCard q={it.question} /> : <AgentAskCard item={it} />}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
        )}

        <section className="v-card overflow-hidden p-0" data-today-links>
          {[
            { icon: 'gauge', label: 'Insights', hint: 'Spend, tokens and usage over time', run: () => push('insights', {}) },
            { icon: 'hq', label: 'HQ', hint: 'Companies and channels', run: () => push('hq', {}) },
            { icon: 'tasks', label: 'Mia’s tasks', hint: 'The board behind the chat', run: () => push('tasks', {}) },
          ].map((r, i, a) => (
            <motion.button {...tap} key={r.label} onClick={r.run} className={`flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-fill ${i < a.length - 1 ? 'v-hair-b' : ''}`}>
              <span className="grid h-8 w-8 flex-none place-items-center rounded-[10px] bg-fill text-ink2">
                <Icon name={r.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.95rem] font-semibold text-ink">{r.label}</span>
                <span className="block truncate text-[0.8rem] text-ink3">{r.hint}</span>
              </span>
              <Icon name="chevronRight" size={16} className="text-ink3" />
            </motion.button>
          ))}
        </section>
      </div>
    </Page>
  );
}
