import { useMemo } from 'react';
import { useMC, agentName, fmtTokens } from '../../lib/store.js';
import StatusDot from '../../ui/StatusDot.jsx';
import { Section, Head } from './parts.jsx';

// Subagent fan-out across the whole fleet: who spawned what, and what it is
// costing. Running first, heaviest first within each group; finished ones past
// the cap collapse into a footer count so a long session doesn't bury the live
// ones. Tapping a row opens the PARENT — a subagent has no session of its own.
export default function Subagents({ onOpen }) {
  const agents = useMC((s) => s.agents);

  const { rows, active, tokens, shown } = useMemo(() => {
    const all = [];
    for (const a of agents) for (const s of a.subagents || []) all.push({ s, a });
    all.sort(
      (x, y) =>
        (y.s.status === 'active') - (x.s.status === 'active') || (y.s.tokens ?? 0) - (x.s.tokens ?? 0),
    );
    const act = all.filter((r) => r.s.status === 'active').length;
    return {
      rows: all,
      active: act,
      tokens: all.reduce((t, r) => t + (r.s.tokens ?? 0), 0),
      shown: all.slice(0, Math.max(10, act)),
    };
  }, [agents]);

  if (!rows.length) return null;

  const meta = `${active ? `${active} running · ` : ''}${rows.length} total · ${fmtTokens(tokens)}`;

  return (
    <Section className="overflow-hidden">
      <Head title="Subagents" meta={meta} className="px-4 py-3 sm:px-5" />
      <div className="border-t border-glass-line">
        {shown.map(({ s, a }) => {
          const on = s.status === 'active';
          return (
            <button
              key={a.id + s.id}
              onClick={() => onOpen?.(a.id)}
              className="flex w-full items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-white/[0.07] sm:px-5"
            >
              <StatusDot status={on ? 'working' : 'done'} size={8} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={`truncate text-[13px] font-medium ${on ? 'text-ink' : 'text-ink2'}`}>{s.desc}</span>
                  <span className="flex-none text-[11px] text-ink3">{agentName(a)}</span>
                </span>
                <span className="block truncate text-[11.5px] leading-snug text-ink3">
                  {on ? s.activity || '—' : 'Done'}
                  {s.agentType && s.agentType !== 'general-purpose' ? ` · ${s.agentType}` : ''}
                </span>
              </span>
              {s.tokens ? <span className="tnum flex-none text-[12px] text-ink3">{fmtTokens(s.tokens)}</span> : null}
            </button>
          );
        })}
      </div>
      {rows.length > shown.length && (
        <div className="border-t border-glass-line px-4 py-2 text-[11.5px] text-ink3 sm:px-5">
          +{rows.length - shown.length} more finished
        </div>
      )}
    </Section>
  );
}
