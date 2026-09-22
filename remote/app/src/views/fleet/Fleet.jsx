import { useMemo, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import {
  useMC, agentStatus, agentName, fmtInt, groupFleets, fleetMembers, fleetProgress,
} from '../../lib/store.js';
import { TONE } from '../../lib/tone.js';
import { spring, press } from '../../lib/motion.js';
import StatusDot from '../../ui/StatusDot.jsx';
import Icon from '../../ui/Icon.jsx';

// The agent roster — the app's spine. A compact, scannable list (not cards):
// agents needing you sort first and wear amber, fleets group with their
// workers indented under a violet header, everyone else follows by urgency.
// Rows carry `layout`, so a status change re-sorts the list with a glide
// instead of a jump-cut.

const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };

function Row({ a, indent, selected, onSelect }) {
  const st = agentStatus(a);
  const t = TONE[st] || TONE.done;
  const subs = (a.subagents || []).filter((s) => s.status === 'active').length;
  const meta = [a.name && a.folder ? a.folder : null, a.branch].filter(Boolean).join(' · ');

  return (
    <motion.button
      layout="position"
      {...press}
      onClick={() => onSelect?.(a.id)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
      transition={spring.smooth}
      className={`group relative flex w-full items-center gap-3 rounded-xl2 px-3 py-2.5 text-left transition-colors ${
        indent ? 'ml-4 w-[calc(100%-16px)]' : ''
      } ${
        selected
          ? 'bg-white/[0.12]'
          : st === 'waiting'
            ? 'bg-warn/[0.09] hover:bg-warn/[0.14]'
            : 'hover:bg-white/[0.07]'
      }`}
    >
      {selected && (
        <motion.span
          layoutId="fleet-sel"
          transition={spring.snappy}
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-ink"
        />
      )}
      <StatusDot status={st} size={8} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span
            className={`truncate text-[13.5px] font-medium ${
              a.isManager ? 'text-mgr' : st === 'done' || st === 'exited' ? 'text-ink2' : 'text-ink'
            }`}
          >
            {agentName(a)}
          </span>
          {a.isManager && (
            <span className="flex-none text-[9.5px] font-semibold tracking-wide text-mgr/80">MGR</span>
          )}
          {subs > 0 && (
            <span
              className="glass-soft flex-none rounded px-1 font-mono text-[9.5px] font-semibold text-ink2"
              title={`${subs} subagent${subs > 1 ? 's' : ''} running`}
            >
              ⑂{subs}
            </span>
          )}
        </span>
        <span className={`block truncate text-[11.5px] leading-tight ${st === 'waiting' ? 'text-warn' : 'text-ink3'}`}>
          {st === 'waiting'
            ? a.activity || 'Waiting for your input'
            : st === 'exited'
              ? 'Process exited'
              : a.activity || '—'}
        </span>
        {meta && <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-ink3/70">{meta}</span>}
      </span>
      {st === 'working' && (a.tokensPerSec ?? 0) > 0 ? (
        <span className="flex-none font-mono text-[10.5px] tnum text-ink3">
          {fmtInt(Math.round(a.tokensPerSec))}
          <span className="opacity-60"> t/s</span>
        </span>
      ) : st === 'waiting' ? (
        <span className="grid h-5 w-5 flex-none place-items-center rounded-full bg-warn/20 text-[10px] font-bold text-warn">
          !
        </span>
      ) : null}
      <Icon name="chevronRight" size={14} className={`flex-none ${t.text} opacity-0 transition-opacity group-hover:opacity-40`} />
    </motion.button>
  );
}

export default function Fleet({ selectedId = null, onSelect }) {
  const { agents, fleetList } = useMC(
    useShallow((s) => ({ agents: s.agents, fleetList: s.fleets })),
  );
  const [q, setQ] = useState('');

  const match = (a) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [agentName(a), a.folder, a.branch, a.activity].some((v) => String(v || '').toLowerCase().includes(s));
  };

  // Fleets with ≥2 members keep their grouping; smaller "fleets" fold into the
  // flat list. Solo agents sort by how much they need a human.
  const grouped = useMemo(() => {
    const { groups, solo } = groupFleets(agents, fleetList);
    const fleets = [];
    const singles = [...solo];
    for (const g of groups) {
      if (fleetMembers(g).length >= 2) fleets.push(g);
      else singles.push(...fleetMembers(g));
    }
    singles.sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9));
    return { fleets, singles };
  }, [agents, fleetList]);

  const fleets = grouped.fleets.filter((g) => fleetMembers(g).some(match));
  const singles = grouped.singles.filter(match);
  const empty = !fleets.length && !singles.length;

  const fleetTitle = (g) =>
    g.fleet?.title || (g.manager && agentName(g.manager)) || g.fleet?.dir?.split('/').filter(Boolean).pop() || 'Fleet';

  return (
    <div className="flex min-h-0 flex-col px-2 pb-4 pt-2">
      {agents.length > 6 && (
        <div className="relative px-1 pb-2">
          <Icon name="search" size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-[60%] text-ink3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search agents…"
            className="glass-soft h-9 w-full rounded-xl2 pl-9 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-glass-line2"
          />
        </div>
      )}

      {empty && (
        <div className="px-4 py-10 text-center">
          <div className="text-[13.5px] font-medium text-ink2">{agents.length ? 'No matches' : 'No agents running'}</div>
          <div className="mt-1 text-[12px] text-ink3">
            {agents.length ? 'Try a different search.' : 'Launch one — it appears here automatically.'}
          </div>
        </div>
      )}

      <LayoutGroup id="fleet">
        {fleets.map((g) => {
          const prog = fleetProgress(g);
          return (
            <div key={g.id}>
              <div className="mt-2 mb-1 flex items-baseline gap-2 px-3 pt-1">
                <span className="truncate text-[11px] font-semibold tracking-wide text-mgr">{fleetTitle(g)}</span>
                {prog && (
                  <span className="ml-auto flex-none font-mono text-[10px] tnum text-ink3">
                    {prog.done}/{prog.total}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                <AnimatePresence initial={false}>
                  {g.manager && (
                    <Row key={g.manager.id} a={g.manager} indent={false} selected={g.manager.id === selectedId} onSelect={onSelect} />
                  )}
                  {g.workers.map((w) => (
                    <Row key={w.id} a={w} indent selected={w.id === selectedId} onSelect={onSelect} />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          );
        })}

        {singles.length > 0 && (
          <>
            {fleets.length > 0 && (
              <div className="mt-3 mb-1 px-3 pt-1 text-[11px] font-semibold tracking-wide text-ink3">Agents</div>
            )}
            <div className={`flex flex-col gap-0.5 ${fleets.length ? '' : 'mt-1'}`}>
              <AnimatePresence initial={false}>
                {singles.map((a) => (
                  <Row key={a.id} a={a} indent={false} selected={a.id === selectedId} onSelect={onSelect} />
                ))}
              </AnimatePresence>
            </div>
          </>
        )}
      </LayoutGroup>
    </div>
  );
}
