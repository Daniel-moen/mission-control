import { motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, fmtInt, fmtTokens } from '../../lib/store.js';
import { fmtAge, fmtMoney } from '../../lib/format.js';
import Ticker from '../../ui/Ticker.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import IconButton from '../../ui/IconButton.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Graph from './Graph.jsx';
import TokenMix from './TokenMix.jsx';
import MachineHealth from './MachineHealth.jsx';
import AgentTable from './AgentTable.jsx';
import Subagents from './Subagents.jsx';
import ActivityFeed from './ActivityFeed.jsx';
import { cardCls, cascade, useSectionIn } from './parts.jsx';

// INSIGHTS — the telemetry window. Order of importance, top to bottom:
// headline numbers → burn over time → token economics + machine health →
// per-agent leaderboard → subagent fan-out → the live event stream.
//
// What needs YOU is deliberately NOT here any more: Home's attention cards own
// that, and duplicating them would split the one place you answer an agent.
//
// This is a CHROMELESS window (shell/Window renders no header when it gets no
// title), so the header row below is ours: title, a data-age chip, and the ×.

// ---- link state → the chip beside the title --------------------------------
function AgeChip() {
  const link = useMC((s) => s.link);
  const at = useMC((s) => s.lastSnapshotAt);
  const now = useMC((s) => s.now); // 1 Hz — this is what makes the age tick

  const age = at ? fmtAge(Math.max(0, now - at)) : null;
  const tone =
    link === 'linked'
      ? { dot: 'bg-accent', text: 'text-ink2' }
      : link === 'relay'
        ? { dot: 'bg-warn', text: 'text-warn' }
        : { dot: 'bg-ink3', text: 'text-ink3' };
  const label =
    link === 'linked' ? (age === 'live' ? 'Live' : `${age} ago`) : link === 'relay' ? 'Mac offline' : 'Reconnecting…';

  return (
    <span className={`pill glass-soft inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] ${tone.text}`}>
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot}`} />
      {label}
    </span>
  );
}

// A tile sparkline is a SHAPE, not a scale — there is no axis beside it. The
// shared Sparkline draws against `Math.max(...data, 1)` from a zero baseline,
// which flattens any series that either never reaches 1 (dollars) or barely
// moves off its own mean (cumulative cost, agent count). Normalising the window
// to 0…100 keeps the shape and makes it legible; a series that never moves has
// no shape to show, so it gets no sparkline at all rather than a line pinned to
// the top that would read as "at maximum".
function trend(values, points = 24) {
  const d = values.slice(-points);
  if (d.length < 2) return null;
  const min = Math.min(...d);
  const max = Math.max(...d);
  if (!(max > min)) return null;
  return d.map((v) => ((v - min) / (max - min)) * 100);
}

// ---- headline tiles ---------------------------------------------------------
function Tile({ label, value, unit, sub, warn, live, spark, tone = 'neutral' }) {
  return (
    <motion.div variants={useSectionIn()} className={`${cardCls} relative overflow-hidden p-4`}>
      <div className="flex items-center gap-2">
        <span className="label">{label}</span>
        {live && <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 text-[28px] leading-none font-semibold tracking-tight text-ink">
        {value}
        {unit && <span className="text-[13px] font-normal text-ink3">{unit}</span>}
      </div>
      <div className={`mt-2 truncate text-[12px] ${warn ? 'text-warn' : 'text-ink3'}`}>{sub}</div>
      {spark && spark.length > 1 && (
        <div className="pointer-events-none absolute right-3 bottom-3 hidden opacity-80 sm:block">
          <Sparkline data={spark} width={104} height={28} tone={tone} />
        </div>
      )}
    </motion.div>
  );
}

function Tiles() {
  const s = useMC((st) => st.summary) || {};
  const total = useMC((st) => st.agents.length);
  const c = useMC(useShallow((st) => counts(st.agents)));
  const tps = useMC((st) => st.tps);
  const history = useMC((st) => st.history);

  // Spend velocity: $/hr over the rolling history window. Under 30s of samples
  // the extrapolation is noise, so we say nothing rather than something wrong.
  let spendRate = null;
  if (history.length >= 2) {
    const dt = history[history.length - 1].t - history[0].t;
    if (dt >= 30_000) spendRate = Math.max(0, ((history[history.length - 1].cost - history[0].cost) / dt) * 3_600_000);
  }

  const totalTokens = s.totalTokens ?? 0;
  const outputShare = totalTokens ? Math.round((100 * (s.outputTokens ?? 0)) / totalTokens) : null;

  const costSpark = trend(history.map((h) => h.cost));
  const fleetSpark = trend(history.map((h) => h.active));

  return (
    // Variants only propagate through motion components, so the grid itself is
    // one — a plain <div> here would cut the cascade off at the tiles.
    <motion.div variants={cascade} className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile
        label="Burn"
        value={<Ticker value={s.tokensPerSec ?? 0} format={(n) => fmtInt(Math.round(n))} />}
        unit="tok/s"
        sub="fleet output rate"
        live={(s.tokensPerSec ?? 0) > 0}
        spark={tps}
        tone="accent"
      />
      <Tile
        label="Spend"
        value={<Ticker value={s.totalCost ?? 0} format={fmtMoney} />}
        sub={spendRate === null ? 'this session' : `${fmtMoney(spendRate)}/hr right now`}
        spark={costSpark}
      />
      <Tile
        label="Tokens"
        value={<Ticker value={totalTokens} format={fmtTokens} />}
        sub={
          outputShare === null ? 'session total' : `${outputShare}% output · ${fmtInt(s.totalTurns ?? 0)} turns`
        }
      />
      <Tile
        label="Fleet"
        value={<Ticker value={c.working} />}
        unit={`/ ${total}`}
        sub={c.waiting ? `${c.waiting} need${c.waiting === 1 ? 's' : ''} you` : 'agents working'}
        warn={c.waiting > 0}
        live={c.working > 0}
        spark={fleetSpark}
      />
    </motion.div>
  );
}

export default function Insights({ onOpen, onClose }) {
  const hasData = useMC(
    (s) => s.agents.length > 0 || s.history.length > 1 || ((s.summary && s.summary.total) ?? 0) > 0,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-[1200px] flex-none items-center gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
        <h2 className="text-[19px] font-semibold tracking-tight text-ink">Insights</h2>
        <AgeChip />
        {onClose && (
          <IconButton className="ml-auto" icon="close" label="Close insights" size="sm" variant="glass" onClick={onClose} />
        )}
      </header>

      <div className="noscroll min-h-0 flex-1 overflow-y-auto">
        {hasData ? (
          <motion.div
            variants={cascade}
            initial="hidden"
            animate="show"
            // The phone dock floats OVER this full-screen sheet, so the last
            // card needs room to clear it (plus the home indicator).
            className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-8"
          >
            <Tiles />

            <Graph />

            <motion.div variants={cascade} className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <TokenMix />
              <MachineHealth />
            </motion.div>

            <AgentTable onOpen={onOpen} />
            <Subagents onOpen={onOpen} />
            <ActivityFeed onOpen={onOpen} />
          </motion.div>
        ) : (
          <EmptyState
            icon="overview"
            title="Nothing to show yet"
            hint="Launch an agent and this window lights up with live burn, spend and machine load."
          />
        )}
      </div>
    </div>
  );
}
