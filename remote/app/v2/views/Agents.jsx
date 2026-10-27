import { memo, useMemo, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, agentStatus, agentName, fmtInt, groupFleets, fleetMembers, fleetProgress, sparkOf, isMiaAgent, statusLabel, counts } from '../../src/lib/store.js';
import { useUsage, liveWindows, levelOf, fmtReset } from '../../src/lib/usage.js';
import Sparkline from '../../src/ui/Sparkline.jsx';
import { openSheet, openOverlay, push } from '../lib/nav.js';
import { zoomTo } from '../lib/zoom.js';
import { usePrefs } from '../lib/prefs.js';
import { spring } from '../lib/motion.js';
import { useWide } from '../ui/hooks.js';
import { Dot, Empty, Icon, IconBtn, SearchField } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';

// The fleet. Who needs you comes first and wears amber; managers lead their
// workers; everyone else by urgency. On an iPad, a grid of cards with each
// agent's live burn; on a phone, a calm list. Status changes re-sort with a
// glide. Tapping an agent grows its workspace out of the card.

const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };
const TONE = { working: 'text-accent', waiting: 'text-warn', exited: 'text-crit', done: 'text-ink3' };

const AgentCard = memo(function AgentCard({ a, grid, at }) {
  const reduce = usePrefs((s) => s.reduce);
  const st = agentStatus(a);
  const subs = (a.subagents || []).filter((s) => s.status === 'active').length;
  void at; // re-render with the snapshot (the sparkline reads a module map)
  const line = st === 'waiting' ? a.activity || 'Waiting for your input' : st === 'exited' ? 'Process exited' : a.activity || '—';
  const meta = [a.name && a.folder ? a.folder : null, a.branch].filter(Boolean).join(' · ');
  return (
    <motion.button
      layout={reduce ? false : 'position'}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={spring.layout}
      whileTap={{ scale: 0.975 }}
      onClick={zoomTo('agent', { id: a.id })}
      data-zoom={`agent:${a.id}`}
      data-agent={a.id}
      data-status={st}
      className={`relative w-full text-left ${grid ? 'v-tile flex min-h-[156px] flex-col p-4' : 'flex items-center gap-3.5 rounded-[18px] px-3.5 py-3 hover:bg-fill'} ${
        st === 'waiting' ? (grid ? '!border-warn/40' : 'bg-warn/[0.07]') : ''
      }`}
    >
      {grid ? (
        <>
          <span className="flex items-center gap-2">
            <Dot status={st} size={9} />
            <span className={`text-[0.74rem] font-semibold ${TONE[st]}`}>{statusLabel(st)}</span>
            {a.isManager && <span className="rounded-md bg-mgr/15 px-1.5 py-0.5 text-[0.66rem] font-bold text-mgr">MGR</span>}
            {subs > 0 && <span className="v-num rounded-md bg-fill px-1.5 py-0.5 font-mono text-[0.66rem] font-semibold text-ink2">⑂{subs}</span>}
            {st === 'working' && (a.tokensPerSec ?? 0) > 0 && <span className="v-num ml-auto text-[0.74rem] font-semibold text-ink3">{fmtInt(Math.round(a.tokensPerSec))} t/s</span>}
          </span>
          <span className="mt-2.5 block truncate text-[1.05rem] font-bold tracking-[-0.02em] text-ink">{agentName(a)}</span>
          <span className={`mt-1 line-clamp-2 text-[0.84rem] leading-snug ${st === 'waiting' ? 'text-warn' : 'text-ink2'}`}>{line}</span>
          <span className="mt-auto flex items-end gap-2 pt-3">
            <span className="min-w-0 flex-1 truncate text-[0.72rem] text-ink3">{meta}</span>
            <Sparkline data={sparkOf(a.id).slice(-24)} width={84} height={24} tone={st === 'working' ? 'accent' : 'neutral'} />
          </span>
        </>
      ) : (
        <>
          <Dot status={st} size={10} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className={`truncate text-[0.98rem] font-semibold tracking-[-0.01em] ${a.isManager ? 'text-mgr' : st === 'done' || st === 'exited' ? 'text-ink2' : 'text-ink'}`}>{agentName(a)}</span>
              {a.isManager && <span className="flex-none text-[0.62rem] font-bold text-mgr">MGR</span>}
              {subs > 0 && <span className="v-num flex-none font-mono text-[0.66rem] font-semibold text-ink3">⑂{subs}</span>}
            </span>
            <span className={`block truncate text-[0.82rem] ${st === 'waiting' ? 'text-warn' : 'text-ink3'}`}>{line}</span>
            {meta && <span className="block truncate text-[0.72rem] text-ink3/80">{meta}</span>}
          </span>
          {st === 'working' && (a.tokensPerSec ?? 0) > 0 ? (
            <span className="v-num flex-none text-[0.74rem] font-semibold text-ink3">{fmtInt(Math.round(a.tokensPerSec))} t/s</span>
          ) : st === 'waiting' ? (
            <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-warn/20 text-[0.72rem] font-bold text-warn">!</span>
          ) : null}
          <Icon name="chevronRight" size={16} className="flex-none text-ink3" />
        </>
      )}
    </motion.button>
  );
});

// v5.1 (task 0486): Fleet shows usage as one quiet row — the window
// that's closest to its limit — and the full breakdown lives in Insights.
function UsageRow() {
  const now = useMC((s) => s.now);
  const usage = useUsage((s) => s.usage);
  const ws = liveWindows(usage, now || Date.now());
  if (!ws.length) return null;
  const w = [...ws].sort((a, b) => b.pct - a.pct)[0];
  const lv = levelOf(w.pct);
  const c = lv === 'crit' ? 'bg-crit' : lv === 'warn' ? 'bg-warn' : 'bg-accent';
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={() => push('insights', {})}
      className="v-card flex w-full items-center gap-3 px-4 py-3 text-left"
      data-usage
      data-usage-window={w.key}
      data-level={lv}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-[0.84rem]">
          <span className="font-semibold text-ink2">Claude usage · {w.label}</span>
          <span className={`v-num ml-auto font-bold ${lv === 'ok' ? 'text-ink' : lv === 'warn' ? 'text-warn' : 'text-crit'}`}>{Math.round(w.pct)}%</span>
        </span>
        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-fill2">
          <motion.span className={`block h-full rounded-full ${c}`} initial={false} animate={{ width: `${Math.min(100, w.pct)}%` }} transition={spring.gentle} />
        </span>
        <span className="mt-1 block truncate text-[0.72rem] text-ink3">{w.reset ? 'reset since the last reading' : fmtReset(w.resetsAt, now || Date.now())}</span>
      </span>
      <Icon name="chevronRight" size={16} className="flex-none text-ink3" />
    </motion.button>
  );
}

function Usage() {
  const now = useMC((s) => s.now);
  const usage = useUsage((s) => s.usage);
  const missing = useUsage((s) => s.missing);
  const ws = liveWindows(usage, now || Date.now()).slice(0, 3);
  if (!ws.length) {
    return missing ? null : <div className="v-card px-4 py-3 text-[0.8rem] text-ink3">Claude usage: waiting for the Mac — `mia usage sync` pushes it every 5 minutes.</div>;
  }
  return (
    <div className="v-card grid grid-cols-2 gap-x-5 gap-y-3 px-4 py-3.5" data-usage>
      {ws.map((w) => {
        const lv = levelOf(w.pct);
        const c = lv === 'crit' ? 'bg-crit' : lv === 'warn' ? 'bg-warn' : 'bg-accent';
        return (
          <div key={w.key} className="min-w-0" data-usage-window={w.key} data-level={lv}>
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[0.8rem] font-semibold text-ink2">{w.label}</span>
              <span className={`v-num ml-auto text-[0.95rem] font-bold ${lv === 'ok' ? 'text-ink' : lv === 'warn' ? 'text-warn' : 'text-crit'}`}>{Math.round(w.pct)}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill2">
              <motion.div className={`h-full rounded-full ${c}`} initial={false} animate={{ width: `${Math.min(100, w.pct)}%` }} transition={spring.gentle} />
            </div>
            <div className="mt-1 truncate text-[0.7rem] text-ink3">{w.reset ? 'reset since the last reading' : fmtReset(w.resetsAt, now || Date.now())}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Agents({ v5 = false }) {
  const { agents, fleetList, at } = useMC(useShallow((s) => ({ agents: s.agents, fleetList: s.fleets, at: s.lastSnapshotAt })));
  const wide = useWide(700);
  const [q, setQ] = useState('');
  const match = (a) => {
    const s = q.trim().toLowerCase();
    return !s || [agentName(a), a.folder, a.branch, a.activity].some((v) => String(v || '').toLowerCase().includes(s));
  };
  const grouped = useMemo(() => {
    const { groups, solo } = groupFleets(agents, fleetList);
    const fleets = [];
    const singles = [...solo];
    for (const g of groups) {
      if (fleetMembers(g).length >= 2) fleets.push(g);
      else singles.push(...fleetMembers(g));
    }
    singles.sort((x, y) => (ORDER[agentStatus(x)] ?? 9) - (ORDER[agentStatus(y)] ?? 9));
    return { fleets, singles };
  }, [agents, fleetList]);
  const fleets = grouped.fleets.filter((g) => fleetMembers(g).some(match));
  const singles = grouped.singles.filter(match);
  const c = counts(agents);
  const waiting = agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a)).length;
  const fleetTitle = (g) => g.fleet?.title || (g.manager && agentName(g.manager)) || g.fleet?.dir?.split('/').filter(Boolean).pop() || 'Fleet';
  const list = (as) => (
    <div className={wide ? 'grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3' : 'flex flex-col gap-0.5'}>
      <AnimatePresence initial={false} mode="popLayout">
        {as.map((a) => (
          <AgentCard key={a.id} a={a} grid={wide} at={at} />
        ))}
      </AnimatePresence>
    </div>
  );

  return (
    <Page
      title={v5 ? 'Fleet' : 'Agents'}
      subtitle={agents.length ? `${c.working} working${waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''} · ${agents.length} total` : 'No agents running'}
      actions={
        <>
          <IconBtn icon="terminal" label="All terminals" tone="ghost" onClick={() => openOverlay('console', { id: null })} data-all-terminals />
          <IconBtn icon="plus" label="Launch" tone="primary" onClick={() => openSheet('launch')} data-agents-launch />
        </>
      }
      toolbar={agents.length > 6 ? <SearchField value={q} onChange={setQ} placeholder="Search agents" /> : null}
    >
      <div className="flex flex-col gap-6" data-agents>
        {v5 ? <UsageRow /> : <Usage />}
        {!fleets.length && !singles.length ? (
          <Empty
            icon="agents"
            title={agents.length ? 'No matches' : 'No agents running'}
            hint={agents.length ? 'Try a different search.' : 'Launch one — it appears here the moment it starts.'}
            action={!agents.length && <button onClick={() => openSheet('launch')} className="h-11 rounded-full bg-ink px-5 text-[0.9rem] font-semibold text-page">Launch an agent</button>}
          />
        ) : (
          <LayoutGroup>
            {fleets.map((g) => {
              const prog = fleetProgress(g);
              return (
                <section key={g.id} data-fleet={g.id}>
                  <div className="mb-2.5 flex items-baseline gap-2 px-1">
                    <span className="truncate text-[0.92rem] font-bold text-mgr">{fleetTitle(g)}</span>
                    {prog && <span className="v-num ml-auto text-[0.8rem] font-semibold text-ink3">{prog.done}/{prog.total} done</span>}
                  </div>
                  {list([g.manager, ...g.workers].filter(Boolean).filter(match))}
                </section>
              );
            })}
            {singles.length > 0 && (
              <section>
                {fleets.length > 0 && <div className="mb-2.5 px-1 text-[0.92rem] font-bold text-ink2">Agents</div>}
                {list(singles)}
              </section>
            )}
          </LayoutGroup>
        )}
      </div>
    </Page>
  );
}
