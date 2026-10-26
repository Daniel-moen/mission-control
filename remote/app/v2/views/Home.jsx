import { useMemo, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, agentStatus, agentName, fmtTokens, isMiaAgent, attentionList, miaUnread, voiceText } from '../../src/lib/store.js';
import { fmtMoney } from '../../src/lib/format.js';
import { useUsage, worstWindow, levelOf } from '../../src/lib/usage.js';
import Ticker from '../../src/ui/Ticker.jsx';
import Sparkline from '../../src/ui/Sparkline.jsx';
import { setTab, openSheet, focusTask, push } from '../lib/nav.js';
import { zoomTo } from '../lib/zoom.js';
import { usePrefs } from '../lib/prefs.js';
import { spring, tap, rise } from '../lib/motion.js';
import { useWide } from '../ui/hooks.js';
import { Icon, IconBtn, Dot } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';
import { QuestionCard, AgentAskCard } from './parts/Needs.jsx';
import { startVoice } from '../shell/TalkHost.jsx';

// Home: the one-glance answer to "what's going on, and what needs me?".
// A greeting and one true sentence; then what's waiting on you, answerable
// right here; then the places, as live tiles — each grows into its page.

const RECENT_MS = 60 * 60 * 1000;
const isRecent = (q, now) => {
  const t = Date.parse(q?.askedAt || '');
  return !Number.isFinite(t) || now - t <= RECENT_MS;
};
const greeting = (h) => (h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : h >= 17 && h < 22 ? 'Good evening' : 'Good night');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LIVE_TASK = new Set(['queued', 'asking', 'running', 'checking']);

function Tile({ id, label, icon, onClick, children, className = '', tone = '', i = 0, badge }) {
  const reduce = usePrefs((s) => s.reduce);
  return (
    <motion.button
      {...rise(reduce, i)}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      data-zoom={id}
      data-tile={id}
      className={`v-tile relative flex min-h-[148px] flex-col overflow-hidden p-4 text-left ${className}`}
    >
      <span className="flex items-center gap-2">
        <span className={`grid h-8 w-8 place-items-center rounded-[10px] ${tone || 'bg-fill text-ink2'}`}>
          <Icon name={icon} size={16} strokeWidth={2.1} />
        </span>
        <span className="text-[0.86rem] font-semibold text-ink2">{label}</span>
        {badge ? (
          <span className="v-num ml-auto grid h-6 min-w-6 place-items-center rounded-full bg-warn px-1.5 text-[0.72rem] font-bold text-[#241a02]">{badge}</span>
        ) : (
          <Icon name="chevronRight" size={15} className="ml-auto text-ink3" />
        )}
      </span>
      <span className="mt-3 flex min-h-0 flex-1 flex-col">{children}</span>
    </motion.button>
  );
}

const Big = ({ children, className = '' }) => <span className={`v-num block text-[2rem] font-bold leading-none tracking-[-0.03em] text-ink ${className}`}>{children}</span>;
const Sub = ({ children }) => <span className="mt-1.5 block truncate text-[0.8rem] text-ink3">{children}</span>;

export default function Home() {
  const { agents, summary, link, mia, local, docs, history, now } = useMC(
    useShallow((s) => ({ agents: s.agents, summary: s.summary, link: s.link, mia: s.mia, local: s.miaLocal, docs: s.docs, history: s.history, now: s.now })),
  );
  const usage = useUsage((s) => s.usage);
  const reduce = usePrefs((s) => s.reduce);
  const wide = useWide(700);
  const xl = useWide(1100);
  const [all, setAll] = useState(false);

  const c = counts(agents);
  const waiting = agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a));
  c.waiting = waiting.length;
  const items = attentionList(agents, mia);
  const shownItems = items.filter((it) => it.kind !== 'mia' || isRecent(it.question, now));
  const olderQs = items.length - shownItems.length;
  const miaQs = shownItems.filter((it) => it.kind === 'mia').length;
  const s = summary || {};

  let sentence;
  if (link === 'offline') sentence = 'Reconnecting to your Mac…';
  else if (link === 'relay') sentence = 'Your Mac is offline.';
  else if (miaQs && !c.waiting) sentence = `Mia has ${miaQs === 1 ? 'a question' : `${miaQs} questions`} for you.`;
  else if (c.working && c.waiting) sentence = `${plural(c.working, 'agent', 'agents')} working, ${plural(c.waiting, 'needs', 'need')} you.`;
  else if (c.working) sentence = `${plural(c.working, 'agent', 'agents')} working. Nothing waiting on you.`;
  else if (c.waiting === 1) sentence = `${agentName(waiting[0])} is asking a question.`;
  else if (c.waiting > 1) sentence = `${c.waiting} agents need you.`;
  else if (agents.length) sentence = 'All quiet. Nothing waiting on you.';
  else sentence = 'No agents running.';

  const MAX = wide ? 6 : 3;
  const shown = all ? shownItems : shownItems.slice(0, MAX);

  // Tiles
  const lastMia = useMemo(() => {
    const ms = mia?.messages || [];
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].from === 'mia' && ms[i].kind !== 'event' && ms[i].text) return ms[i];
    return null;
  }, [mia]);
  const unread = mia ? miaUnread(mia, local) : 0;
  const tasks = (mia?.tasks || []).filter((t) => LIVE_TASK.has(t.status));
  const running = tasks.find((t) => t.status === 'running') || tasks[0];
  const recentDoc = useMemo(() => [...(docs || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0], [docs]);
  const tps = useMemo(() => history.slice(-40).map((h) => h.tps), [history]);
  const worst = worstWindow(usage, now || Date.now());
  const date = new Date(now || Date.now());

  return (
    <Page
      leading={<span className="pl-1 text-[0.86rem] font-semibold text-ink3">{date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>}
      actions={
        <>
          {!wide && <IconBtn icon="search" label="Search" size="md" tone="ghost" onClick={() => openSheet('search')} />}
          <IconBtn icon="settings" label="Settings" size="md" tone="ghost" onClick={() => push('settings')} data-open-settings />
        </>
      }
      maxW={1200}
    >
      {/* greeting */}
      <section className="pb-6 pt-3 sm:pt-6">
        <motion.h1
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring.sheet}
          className="text-[2.5rem] font-bold leading-[1.02] tracking-[-0.04em] text-ink sm:text-[3.4rem]"
        >
          {greeting(date.getHours())}
          <span className="text-ink3">.</span>
        </motion.h1>
        <div className="mt-3 flex min-h-[1.6em] items-center gap-2.5">
          <Dot status={link === 'linked' ? (c.waiting || miaQs ? 'waiting' : c.working ? 'working' : 'done') : 'exited'} size={9} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={sentence}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="text-[1.12rem] font-medium tracking-[-0.015em] text-ink2 sm:text-[1.3rem]"
              data-home-sentence
            >
              {sentence}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <motion.button {...tap} onClick={() => openSheet('launch')} className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[0.9rem] font-semibold text-page" data-home-launch>
            <Icon name="launch" size={16} strokeWidth={2.2} />
            Launch
          </motion.button>
          <motion.button {...tap} onClick={() => startVoice()} className="flex h-11 items-center gap-2 rounded-full bg-fill px-5 text-[0.9rem] font-semibold text-ink">
            <Icon name="mic" size={16} strokeWidth={2.2} />
            Talk to Mia
          </motion.button>
          <motion.button {...tap} onClick={() => openSheet('research')} className="hidden h-11 items-center gap-2 rounded-full bg-fill px-5 text-[0.9rem] font-semibold text-ink sm:flex">
            <Icon name="research" size={16} strokeWidth={2.2} />
            Research
          </motion.button>
        </div>
      </section>

      {/* waiting on you */}
      {shownItems.length > 0 && (
        <section className="pb-7" data-needs={shownItems.length}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[1.15rem] font-bold tracking-[-0.02em] text-ink">Needs you</h2>
            <span className="v-num text-[0.95rem] font-semibold text-warn">{shownItems.length}</span>
          </div>
          <LayoutGroup>
            <div className={`grid items-start gap-3 ${xl ? 'grid-cols-3' : wide ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <AnimatePresence initial={false} mode="popLayout">
                {shown.map((it, i) => (
                  <motion.div
                    key={it.key}
                    layout={!reduce}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.layout, delay: Math.min(i, 6) * 0.03 } }}
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
              <button onClick={() => setAll((v) => !v)} className="text-[0.86rem] font-semibold text-ink2 hover:text-ink">
                {all ? 'Show less' : `Show ${shownItems.length - MAX} more`}
              </button>
            )}
            {olderQs > 0 && (
              <button onClick={() => setTab('mia')} data-older-questions={olderQs} className="text-[0.86rem] font-semibold text-ink3 hover:text-ink2">
                {olderQs} older question{olderQs === 1 ? '' : 's'} in Mia’s chat →
              </button>
            )}
          </div>
        </section>
      )}

      {/* places */}
      <section>
        <h2 className="mb-3 text-[1.15rem] font-bold tracking-[-0.02em] text-ink">Places</h2>
        <div className={`grid gap-3 ${xl ? 'grid-cols-4' : wide ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <Tile id="tile-mia" label="Mia" icon="mia" i={0} onClick={() => setTab('mia')} className="col-span-2" tone="bg-accent/15 text-accent" badge={unread || null}>
            <span className="flex items-center gap-2 text-[0.78rem] font-semibold text-ink3">
              <Dot status={mia?.online ? 'working' : mia?.enabled ? 'waiting' : 'done'} size={7} pulse={false} />
              {!mia ? 'Not set up' : mia.online ? 'Online' : mia.enabled ? 'Offline' : 'Off'}
              {lastMia && <span className="font-medium">· {new Date(Date.parse(lastMia.at) || 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
            </span>
            <span className="mt-1.5 line-clamp-3 text-[1rem] font-medium leading-snug tracking-[-0.01em] text-ink">
              {lastMia ? voiceText(lastMia.text).text : 'Tell Mia what you need — she hands it to an agent and tells you when it’s done.'}
            </span>
          </Tile>
          <Tile id="tile-agents" label="Agents" icon="agents" i={1} onClick={() => setTab('agents')} badge={c.waiting || null}>
            <Big>
              {c.working}
              <span className="text-[1.1rem] font-semibold text-ink3">/{agents.length}</span>
            </Big>
            <Sub>working now</Sub>
            <span className="mt-auto pt-2">
              <Sparkline data={tps} width={160} height={30} tone={c.working ? 'accent' : 'neutral'} className="w-full" />
            </span>
          </Tile>
          <Tile id="tile-tasks" label="Tasks" icon="tasks" i={2} onClick={() => focusTask(null)}>
            <Big>{tasks.length}</Big>
            <Sub>{running ? running.title : 'nothing in flight'}</Sub>
          </Tile>
          <Tile id="tile-library" label="Library" icon="library" i={3} onClick={() => setTab('library')}>
            <Big>{(docs || []).length}</Big>
            <Sub>{recentDoc ? recentDoc.title : 'documents'}</Sub>
          </Tile>
          <Tile id="tile-insights" label="Insights" icon="overview" i={4} onClick={zoomTo('insights', {})}>
            <Big>
              <Ticker value={s.tokensPerSec ?? 0} format={(n) => String(Math.round(n))} />
              <span className="ml-1 text-[0.9rem] font-semibold text-ink3">tok/s</span>
            </Big>
            <Sub>
              <Ticker value={s.totalCost ?? 0} format={fmtMoney} /> · {fmtTokens(s.totalTokens ?? 0)} tokens
            </Sub>
          </Tile>
          <Tile id="tile-hq" label="HQ" icon="hq" i={5} onClick={zoomTo('hq', {})}>
            <Big className="text-[1.3rem]">Companies</Big>
            <Sub>and channels</Sub>
          </Tile>
          {worst && (
            <Tile id="tile-usage" label="Claude usage" icon="gauge" i={6} onClick={zoomTo('insights', {})}>
              <Big className={levelOf(worst.pct) === 'crit' ? '!text-crit' : levelOf(worst.pct) === 'warn' ? '!text-warn' : ''}>{Math.round(worst.pct)}%</Big>
              <Sub>{worst.label}</Sub>
              <span className="mt-auto block h-1.5 overflow-hidden rounded-full bg-fill2">
                <motion.span
                  className={`block h-full rounded-full ${levelOf(worst.pct) === 'crit' ? 'bg-crit' : levelOf(worst.pct) === 'warn' ? 'bg-warn' : 'bg-accent'}`}
                  initial={false}
                  animate={{ width: `${Math.min(100, worst.pct)}%` }}
                  transition={spring.gentle}
                />
              </span>
            </Tile>
          )}
        </div>
      </section>
    </Page>
  );
}
