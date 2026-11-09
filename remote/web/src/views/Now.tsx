'use client';
// Now: the one screen that answers "what is my team doing, and what do they
// need from me?" — Mia up top with a composer, the questions waiting on Daniel
// (answerable in place), the flow of tasks, and every agent working right now.

import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import { crew, flow, spendToday, taskCards, isMiaAgent, agentState, money } from '@/lib/model';
import { useMC } from '@/lib/store';
import { go, open } from '@/lib/nav';
import { parsePrompt } from '@/lib/screen';
import { AgentAskCard, Composer, CrewTile, FlowStrip, QuestionCard, TaskCardView } from './parts';
import { Glass, Icon, LiveText, Num, listItem, spring } from '@/ui/kit';
import { MiaMark } from './MiaMark';
import { ProgressRing, Sparkline } from '@/ui/charts';

function greeting(h: number) {
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function TopBar({ title }: { title?: string }) {
  const now = useMC((s) => s.now);
  const link = useMC((s) => s.link);
  const usage = useMC((s) => s.usage);
  const d = new Date(now);
  const week = usage?.windows?.find((w) => w.key === 'weekly') || usage?.windows?.[0];
  return (
    <div className="row" style={{ alignItems: 'flex-start', marginBottom: 18 }}>
      <div className="grow">
        <div className="eyebrow" suppressHydrationWarning>
          {d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        {title ? (
          <h1 className="title-xl" style={{ margin: '2px 0 0' }}>{title}</h1>
        ) : (
          <div className="num" style={{ fontSize: 'clamp(46px, 11vw, 76px)', fontWeight: 200, letterSpacing: '-0.04em', lineHeight: 1 }} suppressHydrationWarning>
            {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        {week && typeof week.pct === 'number' ? (
          <Glass lens radius={999} as="button" style={{ height: 38, padding: '0 12px 0 8px', display: 'flex', alignItems: 'center', gap: 7 }} onClick={() => go('fleet')} aria-label="Plan usage">
            <ProgressRing value={week.pct / 100} size={22} stroke={3} tone={week.pct >= 80 ? 'red' : week.pct >= 60 ? 'amber' : 'white'} />
            <span className="tiny num" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{Math.round(week.pct)}%</span>
          </Glass>
        ) : null}
        <Glass lens radius={999} style={{ height: 38, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 7 }} data-link={link}>
          <span className={`dot ${link === 'linked' ? 'green' : link === 'relay' ? 'amber' : 'red'}`} style={{ width: 7, height: 7 }} />
          <span className="tiny" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{link === 'linked' ? 'Live' : link === 'relay' ? 'Mac offline' : 'Offline'}</span>
        </Glass>
        <Glass lens as="button" radius={999} className="icon-btn" style={{ width: 38, height: 38 }} onClick={() => open({ kind: 'settings' })} aria-label="Settings">
          <Icon name="settings" size={19} />
        </Glass>
      </div>
    </div>
  );
}

export function Ring({ pct, size = 20 }: { pct: number; size?: number }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  const tone = pct >= 80 ? 'var(--red)' : pct >= 60 ? 'var(--amber)' : 'var(--ink)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="2.6" />
      <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="2.6" strokeLinecap="round" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - Math.min(100, pct) / 100) }} transition={spring} />
    </svg>
  );
}

function HeroSpark() {
  const spark = useMC((s) => s.spark);
  if (spark.length < 3) return null;
  return (
    <span className="row" style={{ gap: 6 }}>
      <Sparkline data={spark.slice(-40)} width={90} height={20} tone="ember" min={0} />
      <span className="tiny num">{Math.round(spark[spark.length - 1])} tok/s</span>
    </span>
  );
}

export function useAttention() {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const agents = useMC((s) => s.agents);
  const screens = useMC((s) => s.screens);
  return useMemo(() => {
    const qs = (mia?.pendingQuestions || []).filter((q) => q.questionId && !(q.questionId in local.answered) && !(q.questionId in local.dismissed));
    const asks = agents.filter((a) => {
      if (isMiaAgent(a, mia)) return false;
      const st = agentState(a);
      if (st === 'exited') return true;
      if (st !== 'waiting') return false;
      return !!parsePrompt(screens[a.id]?.text || a.screen || '');
    });
    return { qs, asks };
  }, [mia, local, agents, screens]);
}

export function Now() {
  const mia = useMC((s) => s.mia);
  const agents = useMC((s) => s.agents);
  const nowMs = useMC((s) => s.now);
  const { qs, asks } = useAttention();
  const cards = useMemo(() => taskCards(mia), [mia]);
  const lanes = useMemo(() => flow(cards), [cards]);
  const team = useMemo(() => crew(agents, mia), [agents, mia]);
  const spend = useMemo(() => spendToday(mia, nowMs), [mia, Math.floor(nowMs / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const hourAgo = nowMs - 3600e3;
  const recentQs = qs.filter((q) => !q.askedAt || Date.parse(q.askedAt) >= hourAgo);
  const olderQs = qs.length - recentQs.length;
  const dayStart = new Date(new Date(nowMs).toDateString()).getTime();
  const doneToday = lanes.done.filter((c) => (c.finishedAt || c.updatedAt) >= dayStart);
  const counts = { queued: lanes.queued.length, running: lanes.running.length, checking: lanes.checking.length, done: doneToday.length };
  const working = team.filter((m) => m.state === 'working' || m.state === 'paused').length;
  const lastMia = [...(mia?.messages || [])].reverse().find((m) => m.from === 'mia' && m.kind !== 'question');
  const h = new Date(nowMs).getHours();

  const parts: string[] = [];
  parts.push(working ? `${working} agent${working === 1 ? ' is' : 's are'} working` : 'Nobody is working right now');
  if (recentQs.length + asks.length) parts.push(`${recentQs.length + asks.length} thing${recentQs.length + asks.length === 1 ? '' : 's'} need${recentQs.length + asks.length === 1 ? 's' : ''} you`);
  const sentence = `${parts.join(', ')}.`;

  return (
    <div className="wrap">
      <TopBar />
      {/* Mia */}
      <Glass variant="deep" radius={32} style={{ padding: 'clamp(18px, 3.5vw, 26px)' }} data-hero>
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <MiaMark size={58} state={!mia ? 'off' : !mia.online ? 'off' : working ? 'busy' : 'idle'} level={Math.min(1, working / 4)} />
          <div className="grow">
            <div className="eyebrow" suppressHydrationWarning>{greeting(h)}, Daniel</div>
            <div className="title-l" style={{ marginTop: 2 }}>{sentence}</div>
            <div className="row small" style={{ marginTop: 6, gap: 14, flexWrap: 'wrap' }}>
              <span>Mia {mia?.online ? 'online' : mia ? 'offline' : 'not connected'}</span>
              <span className="num"><Num value={spend.total} format={(n) => money(n)} /> today · {spend.runs} run{spend.runs === 1 ? '' : 's'}</span>
              {mia?.jobs?.budget?.paused ? <span className="chip amber">Opus paused near limit</span> : null}
              <HeroSpark />
            </div>
          </div>
        </div>
        {lastMia ? (
          <button className="well" style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 16, padding: '11px 14px', borderRadius: 18 }} onClick={() => go('mia')}>
            <div className="tiny" style={{ marginBottom: 3 }}>Mia said</div>
            <div className="small clamp2" style={{ color: 'var(--ink)' }}>{lastMia.text}</div>
          </button>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <Composer />
        </div>
      </Glass>

      {/* Needs you */}
      <AnimatePresence initial={false}>
        {recentQs.length + asks.length > 0 ? (
          <motion.section key="needs" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <div className="section-h">
              <h2>Needs you</h2>
              {olderQs > 0 ? <button className="small" onClick={() => go('mia')}>{olderQs} older in Mia</button> : null}
            </div>
            <div className="grid cols-auto">
              <AnimatePresence mode="popLayout" initial={false}>
                {recentQs.map((q) => (
                  <motion.div key={q.questionId} layout {...listItem} transition={spring}>
                    <QuestionCard q={q} scope="now" />
                  </motion.div>
                ))}
                {asks.map((a) => (
                  <motion.div key={a.id} layout {...listItem} transition={spring}>
                    <AgentAskCard agent={a} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.section>
        ) : olderQs > 0 ? (
          <motion.button key="older" className="small" style={{ margin: '14px 4px 0' }} onClick={() => go('mia')} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {olderQs} older question{olderQs === 1 ? '' : 's'} waiting in Mia →
          </motion.button>
        ) : null}
      </AnimatePresence>

      {/* Flow */}
      <div className="section-h">
        <h2>Flow</h2>
        <button className="small" onClick={() => go('tasks')}>All tasks</button>
      </div>
      <FlowStrip counts={counts} />

      {/* Crew */}
      <div className="section-h">
        <h2>Working now</h2>
        <span className="small num">{team.length ? `${team.length} agent${team.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {team.length ? (
        <motion.div layout className="grid cols-auto">
          <AnimatePresence mode="popLayout" initial={false}>
            {team.map((m) => (
              <motion.div key={m.key} layout {...listItem} transition={spring}>
                <CrewTile m={m} scope="now" />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <Glass variant="thin" radius={24} style={{ padding: 22 }}>
          <div className="row gap12">
            <Icon name="sparkle" size={22} />
            <div className="grow">
              <div className="title-s">All quiet</div>
              <div className="small">Give Mia something to do above, or press the wave to talk.</div>
            </div>
          </div>
        </Glass>
      )}

      {/* Recently finished */}
      {lanes.done.length ? (
        <>
          <div className="section-h">
            <h2>Just finished</h2>
            <button className="small" onClick={() => go('tasks')}>History</button>
          </div>
          <div className="grid cols-auto">
            {lanes.done.slice(0, 4).map((c) => (
              <TaskCardView key={c.id} card={c} scope="now" compact />
            ))}
          </div>
        </>
      ) : null}
      {mia && !mia.online && mia.enabled ? (
        <div className="small" style={{ marginTop: 24, textAlign: 'center' }}>
          <LiveText text="Mia is offline. Start her from Settings." />
        </div>
      ) : null}
    </div>
  );
}
