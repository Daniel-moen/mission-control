import { useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, fmtInt, fmtTokens, fmtMem, agentName, agentStatus, sparkOf } from '../../src/lib/store.js';
import { fmtMoney } from '../../src/lib/format.js';
import Ticker from '../../src/ui/Ticker.jsx';
import Sparkline from '../../src/ui/Sparkline.jsx';
import { push } from '../lib/nav.js';
import { spring } from '../lib/motion.js';
import { useSize } from '../ui/hooks.js';
import { Dot, Empty, Segmented } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';

// Insights: how the fleet is burning, live. One big chart you can switch
// between rate, spend and active agents; the headline numbers; where the
// tokens go; who's spending; the machine; and the running activity feed
// (virtualised — it grows all day).

const SERIES = {
  tps: { label: 'Tokens / sec', pick: (h) => h.tps, fmt: (n) => `${Math.round(n)}` },
  cost: { label: 'Spend', pick: (h) => h.cost, fmt: fmtMoney },
  active: { label: 'Active agents', pick: (h) => h.active, fmt: (n) => `${Math.round(n)}` },
};

function Chart({ data, fmt = String, height = 200 }) {
  const box = useRef(null);
  const { w } = useSize(box);
  const [hover, setHover] = useState(null);
  const pts = useMemo(() => {
    if (data.length < 2 || !w) return null;
    const max = Math.max(...data, 1e-9);
    const min = Math.min(...data, 0);
    const span = max - min || 1;
    const P = 6;
    return data.map((v, i) => [(w * i) / (data.length - 1), P + (height - 2 * P) * (1 - (v - min) / span)]);
  }, [data, w, height]);
  const line = pts ? 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') : '';
  const area = pts ? `${line} L${w},${height} L0,${height} Z` : '';
  const h = hover != null && pts ? pts[hover] : null;
  return (
    <div
      ref={box}
      className="relative w-full touch-pan-y"
      style={{ height }}
      onPointerMove={(e) => {
        if (!pts) return;
        const r = e.currentTarget.getBoundingClientRect();
        setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))));
      }}
      onPointerLeave={() => setHover(null)}
      data-chart
    >
      {pts ? (
        <svg width={w} height={height} className="block overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="v2-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} stroke="var(--v-hair)" strokeWidth="1" />
          ))}
          <path d={area} fill="url(#v2-area)" />
          <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {h && (
            <>
              <line x1={h[0]} x2={h[0]} y1="0" y2={height} stroke="var(--v-hair2)" strokeWidth="1" />
              <circle cx={h[0]} cy={h[1]} r="4.5" fill="var(--color-accent)" stroke="var(--v-card)" strokeWidth="2" />
            </>
          )}
          {!h && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.5" fill="var(--color-accent)" />}
        </svg>
      ) : (
        <div className="grid h-full place-items-center text-[0.84rem] text-ink3">Collecting samples…</div>
      )}
      {h && <div className="pointer-events-none absolute -top-1 right-0 rounded-full bg-ink px-2.5 py-1 text-[0.72rem] font-bold text-page v-num">{fmt(data[hover])}</div>}
    </div>
  );
}

function Metric({ label, children, sub, tone = '' }) {
  return (
    <div className="v-card px-4 py-3.5">
      <div className="text-[0.76rem] font-semibold text-ink3">{label}</div>
      <div className={`v-num mt-1 text-[1.6rem] font-bold leading-tight tracking-[-0.03em] ${tone || 'text-ink'}`}>{children}</div>
      {sub && <div className="mt-0.5 truncate text-[0.74rem] text-ink3">{sub}</div>}
    </div>
  );
}

function Bar({ label, value, sub }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  const tone = pct > 0.9 ? 'bg-crit' : pct > 0.75 ? 'bg-warn' : 'bg-accent';
  return (
    <div>
      <div className="flex items-baseline gap-2 text-[0.82rem]">
        <span className="font-semibold text-ink2">{label}</span>
        <span className="v-num ml-auto font-bold text-ink">{Math.round(pct * 100)}%</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-fill2">
        <motion.div className={`h-full rounded-full ${tone}`} initial={false} animate={{ width: `${pct * 100}%` }} transition={spring.gentle} />
      </div>
      {sub && <div className="mt-1 text-[0.72rem] text-ink3">{sub}</div>}
    </div>
  );
}

function Feed({ activity }) {
  const box = useRef(null);
  const rows = useMemo(() => [...activity].reverse(), [activity]);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => 52, overscan: 8 });
  if (!rows.length) return <div className="px-4 py-8 text-center text-[0.84rem] text-ink3">Activity appears here as agents work.</div>;
  return (
    <div ref={box} className="v-scroll h-[360px]" data-feed>
      <div className="relative" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((it) => {
          const e = rows[it.index];
          return (
            <button
              key={it.key}
              ref={v.measureElement}
              data-index={it.index}
              onClick={() => push('agent', { id: e.id })}
              className="absolute left-0 top-0 flex w-full items-baseline gap-3 px-4 py-2.5 text-left hover:bg-fill"
              style={{ transform: `translateY(${it.start}px)` }}
            >
              <span className="v-num w-14 flex-none text-[0.72rem] text-ink3">{new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
              <span className="min-w-0 flex-1">
                <span className="text-[0.82rem] font-semibold text-ink">{e.who}</span>
                <span className="ml-2 break-words text-[0.82rem] text-ink2">{e.text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function Insights() {
  const { s, agents, history, system, activity } = useMC(
    useShallow((st) => ({ s: st.summary || {}, agents: st.agents, history: st.history, system: st.system, activity: st.activity })),
  );
  const [series, setSeries] = useState('tps');
  const c = counts(agents);
  const data = useMemo(() => history.map(SERIES[series].pick), [history, series]);
  const mix = [
    { key: 'output', label: 'Output', color: 'var(--color-s1)', v: s.outputTokens ?? 0 },
    { key: 'cacheRead', label: 'Cache read', color: 'var(--color-s3)', v: s.cacheReadTokens ?? 0 },
    { key: 'input', label: 'Fresh input', color: 'var(--color-s2)', v: s.inputTokens ?? 0 },
    { key: 'cacheWrite', label: 'Cache write', color: 'var(--color-s4)', v: s.cacheCreateTokens ?? 0 },
  ];
  const mixTotal = mix.reduce((a, p) => a + p.v, 0);
  const cacheDen = (s.cacheReadTokens ?? 0) + (s.inputTokens ?? 0) + (s.cacheCreateTokens ?? 0);
  const hit = cacheDen ? (s.cacheReadTokens ?? 0) / cacheDen : 0;
  const top = useMemo(() => [...agents].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 8), [agents]);
  const topMax = Math.max(1, ...top.map((a) => a.tokens ?? 0));
  const load = agents.reduce(
    (acc, a) => (typeof a.cpu === 'number' ? { cpu: acc.cpu + a.cpu, mem: acc.mem + (a.mem || 0), n: acc.n + 1 } : acc),
    { cpu: 0, mem: 0, n: 0 },
  );
  const has = agents.length > 0 || history.length > 1;

  return (
    <Page title="Insights" subtitle="Live, from the fleet snapshot" maxW={1200}>
      {!has ? (
        <Empty icon="overview" title="Nothing to chart yet" hint="Numbers appear as soon as agents are running." />
      ) : (
        <div className="flex flex-col gap-4 pb-6" data-insights>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Burn" tone={(s.tokensPerSec ?? 0) > 0 ? 'text-accent' : ''} sub="tokens per second">
              <Ticker value={s.tokensPerSec ?? 0} format={(n) => String(Math.round(n))} />
            </Metric>
            <Metric label="Spend" sub="this session">
              <Ticker value={s.totalCost ?? 0} format={fmtMoney} />
            </Metric>
            <Metric label="Tokens" sub={`${Math.round(hit * 100)}% from cache`}>
              <Ticker value={s.totalTokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />
            </Metric>
            <Metric label="Agents" sub={`${c.waiting} need you · ${c.done} done`}>
              {c.working}
              <span className="text-[1rem] text-ink3">/{agents.length}</span>
            </Metric>
          </div>

          <section className="v-card p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.05rem] font-bold tracking-[-0.02em] text-ink">{SERIES[series].label}</h2>
              <span className="v-num text-[0.86rem] font-semibold text-ink3">{data.length ? SERIES[series].fmt(data[data.length - 1]) : ''}</span>
              <Segmented
                className="ml-auto"
                size="sm"
                value={series}
                onChange={setSeries}
                options={[
                  { value: 'tps', label: 'Rate' },
                  { value: 'cost', label: 'Spend' },
                  { value: 'active', label: 'Active' },
                ]}
              />
            </div>
            <Chart data={data} fmt={SERIES[series].fmt} />
            <div className="mt-2 text-[0.72rem] text-ink3">Last {Math.max(1, Math.round(history.length / 60))} min · one sample per snapshot</div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="v-card p-4 sm:p-5">
              <h2 className="mb-3 text-[1.05rem] font-bold tracking-[-0.02em] text-ink">Where tokens go</h2>
              <div className="flex h-3 overflow-hidden rounded-full bg-fill2">
                {mix.map((p) => (
                  <motion.div key={p.key} initial={false} animate={{ width: `${mixTotal ? (p.v / mixTotal) * 100 : 0}%` }} transition={spring.gentle} style={{ background: p.color }} />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {mix.map((p) => (
                  <div key={p.key} className="flex items-center gap-2 text-[0.82rem]">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                    <span className="text-ink2">{p.label}</span>
                    <span className="v-num ml-auto font-semibold text-ink">{fmtTokens(p.v)}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="v-card flex flex-col gap-3.5 p-4 sm:p-5">
              <h2 className="text-[1.05rem] font-bold tracking-[-0.02em] text-ink">Machine</h2>
              {system ? (
                <>
                  <Bar label="Host CPU" value={(system.cpu ?? 0) / 100} sub={`${system.cores ?? '—'} cores`} />
                  {system.memTotalMB ? <Bar label="Host memory" value={(system.memUsedMB ?? 0) / system.memTotalMB} sub={`${fmtMem(system.memUsedMB)} of ${fmtMem(system.memTotalMB)}`} /> : null}
                </>
              ) : (
                <div className="text-[0.84rem] text-ink3">The Mac isn’t reporting host load.</div>
              )}
              {load.n > 0 && <Bar label="Agents CPU" value={(system?.cores ? load.cpu / system.cores : load.cpu) / 100} sub={`${load.cpu.toFixed(0)}% across ${load.n} process${load.n === 1 ? '' : 'es'}`} />}
            </section>
          </div>

          <section className="v-card overflow-hidden">
            <h2 className="px-4 pb-2 pt-4 text-[1.05rem] font-bold tracking-[-0.02em] text-ink sm:px-5">Who’s spending</h2>
            {top.map((a, i) => (
              <button key={a.id} onClick={() => push('agent', { id: a.id })} className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-fill sm:px-5 ${i < top.length - 1 ? 'v-hair-b' : ''}`} data-spender={a.id}>
                <Dot status={agentStatus(a)} size={8} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9rem] font-semibold text-ink">{agentName(a)}</span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-fill2">
                    <motion.span className="block h-full rounded-full bg-accent/70" initial={false} animate={{ width: `${((a.tokens ?? 0) / topMax) * 100}%` }} transition={spring.gentle} />
                  </span>
                </span>
                <Sparkline data={sparkOf(a.id).slice(-24)} width={70} height={22} tone={agentStatus(a) === 'working' ? 'accent' : 'neutral'} className="hidden sm:block" />
                <span className="v-num w-16 flex-none text-right text-[0.82rem] font-semibold text-ink">{fmtTokens(a.tokens ?? 0)}</span>
                <span className="v-num w-16 flex-none text-right text-[0.82rem] text-ink3">{fmtMoney(a.cost ?? 0)}</span>
              </button>
            ))}
          </section>

          <section className="v-card overflow-hidden">
            <h2 className="px-4 pb-2 pt-4 text-[1.05rem] font-bold tracking-[-0.02em] text-ink sm:px-5">
              Activity <span className="v-num text-[0.86rem] font-semibold text-ink3">{fmtInt(activity.length)}</span>
            </h2>
            <Feed activity={activity} />
          </section>
        </div>
      )}
    </Page>
  );
}
