import { useMemo } from 'react';
import { useMC, agentStatus, agentName, statusLabel, fmtInt, fmtTokens, fmtMem, sparkOf } from '../../lib/store.js';
import { fmtMoney } from '../../lib/format.js';
import { useMedia } from '../../lib/hooks.js';
import StatusDot from '../../ui/StatusDot.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import { Section, Head } from './parts.jsx';

// Every session, heaviest first — the leaderboard that answers "what is this
// costing me, and which one is doing the work". A row opens that agent.
//
// `share` is the row's tokens against the heaviest row, drawn as a short bar
// so the distribution reads at a glance without a second chart.

const th = 'label px-3 py-2 font-medium whitespace-nowrap';
const td = 'px-3 tnum text-[12.5px] whitespace-nowrap';

function useBoard() {
  const agents = useMC((s) => s.agents);
  // sparkOf() is a module Map outside the store; `lastSnapshotAt` is what
  // guarantees this recomputes once per snapshot so the traces stay live.
  const at = useMC((s) => s.lastSnapshotAt);
  return useMemo(() => {
    const rows = [...agents].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
    const top = Math.max(...rows.map((a) => a.tokens ?? 0), 1);
    // sparkOf() hands back the LIVE array, which the store pushes into in
    // place — pass that reference straight down and Sparkline's memo never
    // sees a change and never draws. Copy it so each snapshot is a new series.
    return rows.map((a) => ({ a, share: (100 * (a.tokens ?? 0)) / top, spark: sparkOf(a.id).slice() }));
  }, [agents, at]);
}

function ShareBar({ pct }) {
  return (
    <span className="block h-[4px] w-16 overflow-hidden rounded-full bg-white/[0.08]">
      <span
        className="block h-full rounded-full bg-accent/60 transition-[width] duration-700"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export default function AgentTable({ onOpen }) {
  const board = useBoard();
  const wide = useMedia('(min-width: 640px)');
  if (!board.length) return null;

  return (
    <Section className="overflow-hidden">
      <Head title="Agents" meta={board.length} className="px-4 py-3 sm:px-5" />

      {wide ? (
        <div className="noscroll overflow-x-auto border-t border-glass-line">
          <table className="w-full min-w-[740px] border-collapse text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className={`${th} w-[34%] pl-5`}>Agent</th>
                <th className={th}>Share</th>
                <th className={th}>Burn</th>
                <th className={`${th} text-right`}>tok/s</th>
                <th className={`${th} text-right`}>Tokens</th>
                <th className={`${th} text-right`}>Cost</th>
                <th className={`${th} text-right`}>CPU</th>
                <th className={`${th} pr-5 text-right`}>Mem</th>
              </tr>
            </thead>
            <tbody>
              {board.map(({ a, share, spark }) => {
                const st = agentStatus(a);
                const burning = (a.tokensPerSec ?? 0) > 0;
                return (
                  <tr
                    key={a.id}
                    onClick={() => onOpen?.(a.id)}
                    className="h-10 cursor-pointer border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.07]"
                  >
                    <td className="py-0 pr-3 pl-5">
                      <div className="flex items-center gap-2.5">
                        <StatusDot status={st} size={8} />
                        <span
                          className={`min-w-0 truncate text-[13px] font-medium ${
                            a.isManager ? 'text-mgr' : st === 'done' ? 'text-ink2' : 'text-ink'
                          }`}
                        >
                          {agentName(a)}
                        </span>
                        <span className="flex-none text-[11.5px] whitespace-nowrap text-ink3">
                          {statusLabel(st)}
                          {a.branch ? ` · ${a.branch}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className={td}>
                      <ShareBar pct={share} />
                    </td>
                    <td className="px-3">
                      <Sparkline data={spark} width={88} height={22} tone={burning ? 'accent' : 'neutral'} />
                    </td>
                    <td className={`${td} text-right ${burning ? 'text-accent' : 'text-ink3'}`}>
                      {fmtInt(Math.round(a.tokensPerSec ?? 0))}
                    </td>
                    <td className={`${td} text-right text-ink2`}>{fmtTokens(a.tokens)}</td>
                    <td className={`${td} text-right text-ink2`}>{fmtMoney(a.cost)}</td>
                    <td className={`${td} text-right text-ink3`}>
                      {typeof a.cpu === 'number' ? `${a.cpu.toFixed(0)}%` : '—'}
                    </td>
                    <td className={`${td} pr-5 text-right text-ink3`}>
                      {typeof a.mem === 'number' ? fmtMem(a.mem) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        // Phone: the same data as a compact list — a horizontally scrolling
        // eight-column table on a 390px screen is not a table, it's a maze.
        <div className="border-t border-glass-line">
          {board.map(({ a, share, spark }) => {
            const st = agentStatus(a);
            const burning = (a.tokensPerSec ?? 0) > 0;
            return (
              <button
                key={a.id}
                onClick={() => onOpen?.(a.id)}
                className="flex w-full items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 text-left transition-colors last:border-0 active:bg-white/[0.07]"
              >
                {/* the dot belongs to the NAME, so it rides the first line */}
                <StatusDot status={st} size={8} className="mt-[6px] self-start" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className={`truncate text-[13px] font-medium ${a.isManager ? 'text-mgr' : 'text-ink'}`}
                    >
                      {agentName(a)}
                    </span>
                    <span className="flex-none text-[11px] text-ink3">{statusLabel(st)}</span>
                  </span>
                  <span className="tnum mt-0.5 flex items-center gap-2 text-[11.5px] text-ink3">
                    <span className={burning ? 'text-accent' : ''}>
                      {fmtInt(Math.round(a.tokensPerSec ?? 0))} tok/s
                    </span>
                    <span>·</span>
                    <span>{fmtTokens(a.tokens)}</span>
                    <span>·</span>
                    <span>{fmtMoney(a.cost)}</span>
                  </span>
                  <span className="mt-1.5 block">
                    <ShareBar pct={share} />
                  </span>
                </span>
                <Sparkline data={spark} width={64} height={24} tone={burning ? 'accent' : 'neutral'} />
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}
