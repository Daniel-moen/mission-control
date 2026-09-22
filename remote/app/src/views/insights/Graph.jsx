import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useMC, fmtInt, clockOf } from '../../lib/store.js';
import { fmtMoney } from '../../lib/format.js';
import { ease } from '../../lib/motion.js';
import Segmented from '../../ui/Segmented.jsx';
import { Section, Head } from './parts.jsx';

// Fleet telemetry over time. ONE live series at a time (Burn / Spend / Active)
// picked by the toggle, so the chart never needs a legend — the control names
// what is plotted, and a single-series legend box would only restate the title.
// Area + line, a recessive 8 % grid, and a crosshair that snaps to the nearest
// sample with a value readout.
const METRICS = {
  burn: {
    label: 'Burn',
    unit: 'tok/s',
    color: 'var(--color-s1)',
    pick: (s) => s.tps ?? 0,
    fmt: (v) => fmtInt(Math.round(v)),
    tick: (v) => fmtInt(Math.round(v)),
    floor: 1,
  },
  spend: {
    label: 'Spend',
    unit: 'USD',
    color: 'var(--color-s3)',
    pick: (s) => s.cost ?? 0,
    fmt: (v) => fmtMoney(v),
    tick: (v) => '$' + (v >= 10 ? v.toFixed(0) : v.toFixed(2)),
    floor: 0.01,
  },
  active: {
    label: 'Active',
    unit: 'agents',
    color: 'var(--color-s4)',
    pick: (s) => s.active ?? 0,
    fmt: (v) => fmtInt(Math.round(v)),
    tick: (v) => fmtInt(Math.round(v)),
    floor: 1,
  },
};

const OPTIONS = Object.entries(METRICS).map(([value, m]) => ({ value, label: m.label }));

const H = 188;
// The left gutter only has to fit the widest y-tick, so a phone doesn't pay a
// desktop's worth of it.
const padL = (w) => (w < 420 ? 36 : 52);
const PAD = { t: 18, r: 14, b: 24 };

// Axis ticks land on round numbers. Snap the STEP (not the top) to 1/2/2.5/5/10
// × a power of ten, then stack it — that is what makes the labels read
// 0 / 100 / 200 / 300 instead of 0 / 167 / 333 / 500.
function niceScale(v, floor, lines = 3) {
  const raw = Math.max(v, floor) / lines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.max(step * lines, Math.ceil(Math.max(v, floor) / step) * step);
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

function useWidth(ref) {
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = (px) => setW(Math.max(220, Math.round(px)));
    apply(el.clientWidth || 640);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => apply(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export default function Graph() {
  const history = useMC((s) => s.history);
  const [metric, setMetric] = useState('burn');
  const [hover, setHover] = useState(-1);
  const box = useRef(null);
  const w = useWidth(box);
  const reduce = useReducedMotion();

  const M = METRICS[metric];
  const L = padL(w);
  const samples = useMemo(() => history.slice(-180), [history]);

  const geom = useMemo(() => {
    const n = samples.length;
    if (n < 2) return null;
    const plotW = Math.max(1, w - L - PAD.r);
    const plotH = H - PAD.t - PAD.b;
    const vals = samples.map(M.pick);
    const { top: max, ticks } = niceScale(Math.max(...vals, 0), M.floor);
    const x = (i) => L + plotW * (i / (n - 1));
    const y = (v) => PAD.t + plotH * (1 - (max ? v / max : 0));
    const pts = vals.map((v, i) => [x(i), y(v)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const base = (PAD.t + plotH).toFixed(1);
    return {
      pts,
      vals,
      max,
      ticks,
      y,
      n,
      plotW,
      plotH,
      base: PAD.t + plotH,
      line: d,
      area: `M${pts[0][0].toFixed(1)},${base} ${d.slice(1)} L${pts[n - 1][0].toFixed(1)},${base} Z`,
    };
  }, [samples, w, L, M]);

  // The line draws itself in ONCE per series — on mount, and again when the
  // reader switches metric (a new series, so a new draw reads as an answer to
  // the tap). It must NOT re-draw on every 1 Hz sample: that is a strobe.
  const drawn = useRef('');
  const first = drawn.current !== metric;
  if (geom) drawn.current = metric;

  const onMove = useCallback(
    (e) => {
      const g = geom;
      if (!g) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const px = ((e.clientX - rect.left) / rect.width) * w;
      const i = Math.round(((px - L) / g.plotW) * (g.n - 1));
      setHover(Math.max(0, Math.min(g.n - 1, i)));
    },
    [geom, w, L],
  );

  const cur = samples.length ? samples[samples.length - 1] : null;
  const shown = hover >= 0 && geom ? samples[hover] : cur;

  return (
    <Section className="p-4 sm:p-5">
      {/* On a phone the toggle takes its own row — squeezed beside the figure
          it collides with the value and stops looking like a control. */}
      <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <Head title={`${M.label} over time`} />
          {/* the figure wears ink, never the series colour — the key beside it
              carries identity */}
          <div className="mt-1.5 flex items-baseline gap-2 text-[26px] leading-none font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 flex-none self-center rounded-[3px]" style={{ background: M.color }} />
            <span className="tnum">{shown ? M.fmt(M.pick(shown)) : '—'}</span>
            <span className="text-[12px] font-normal text-ink3">{M.unit}</span>
          </div>
        </div>
        <Segmented
          className="flex-none self-start"
          options={OPTIONS}
          value={metric}
          onChange={(v) => {
            setMetric(v);
            setHover(-1);
          }}
        />
      </div>

      <div ref={box} className="relative">
        {geom ? (
          <>
            <svg
              viewBox={`0 0 ${w} ${H}`}
              width="100%"
              height={H}
              className="block"
              role="img"
              aria-label={`${M.label} over time, currently ${M.fmt(M.pick(cur || { }))} ${M.unit}`}
              // pan-y keeps the page scrollable on a phone while a horizontal
              // drag scrubs the crosshair.
              style={{ touchAction: 'pan-y' }}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(-1)}
              onPointerCancel={() => setHover(-1)}
            >
              <defs>
                <linearGradient id={`mc-graph-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  {/* a wash, never a block — the line carries the value */}
                  <stop offset="0%" stopColor={M.color} stopOpacity="0.17" />
                  <stop offset="100%" stopColor={M.color} stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* grid: hairline, solid, 8 % white — recessive by construction */}
              {geom.ticks.map((t) => {
                const y = geom.y(t);
                return (
                  <g key={t}>
                    <line
                      x1={L}
                      x2={w - PAD.r}
                      y1={y}
                      y2={y}
                      stroke="rgba(255,255,255,.08)"
                      strokeWidth="1"
                      shapeRendering="crispEdges"
                    />
                    <text
                      x={L - 10}
                      y={y + 3.5}
                      textAnchor="end"
                      fontSize="11"
                      fill="var(--color-ink3)"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {M.tick(t)}
                    </text>
                  </g>
                );
              })}

              <motion.path
                d={geom.area}
                fill={`url(#mc-graph-${metric})`}
                initial={first && !reduce ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, ease: ease.out }}
              />
              <motion.path
                d={geom.line}
                fill="none"
                stroke={M.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                initial={first && !reduce ? { pathLength: 0 } : false}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.65, ease: ease.out }}
              />
              {/* the end marker carries a surface ring so it stays legible
                  where it crosses the line or the grid */}
              <circle
                cx={geom.pts[geom.n - 1][0]}
                cy={geom.pts[geom.n - 1][1]}
                r="4"
                fill={M.color}
                stroke="rgba(12,12,14,.9)"
                strokeWidth="2"
              />

              {hover >= 0 && (
                <g>
                  <line
                    x1={geom.pts[hover][0]}
                    x2={geom.pts[hover][0]}
                    y1={PAD.t}
                    y2={geom.base}
                    stroke="rgba(255,255,255,.22)"
                    strokeWidth="1"
                  />
                  <circle
                    cx={geom.pts[hover][0]}
                    cy={geom.pts[hover][1]}
                    r="4.5"
                    fill={M.color}
                    stroke="rgba(12,12,14,.9)"
                    strokeWidth="2"
                  />
                </g>
              )}

              {/* time axis: just the ends — the crosshair carries the rest */}
              <text x={L} y={H - 7} fontSize="11" fill="var(--color-ink3)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {clockOf(samples[0].t)}
              </text>
              <text
                x={w - PAD.r}
                y={H - 7}
                textAnchor="end"
                fontSize="11"
                fill="var(--color-ink3)"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {clockOf(samples[geom.n - 1].t)}
              </text>
            </svg>

            {hover >= 0 && (
              <div
                className="pointer-events-none absolute rounded-xl2 border border-glass-line px-2.5 py-1.5 backdrop-blur-xl"
                style={{
                  left: `clamp(0px, ${(geom.pts[hover][0] / w) * 100}% - 52px, calc(100% - 112px))`,
                  // flip to the empty half so the readout never sits on the
                  // curve it is describing
                  top: geom.pts[hover][1] < PAD.t + geom.plotH / 2 ? `${geom.base - 48}px` : `${PAD.t}px`,
                  background: 'rgba(14,14,18,.92)',
                  boxShadow: 'var(--shadow-2)',
                }}
              >
                <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                  <span className="h-[2px] w-3 flex-none rounded-full" style={{ background: M.color }} />
                  <span className="tnum">{M.fmt(M.pick(samples[hover]))}</span>
                  <span className="text-[11px] font-normal text-ink3">{M.unit}</span>
                </div>
                <div className="tnum mt-0.5 text-[11px] text-ink3">{clockOf(samples[hover].t)}</div>
              </div>
            )}
          </>
        ) : (
          <div className="grid place-items-center" style={{ height: H }}>
            <span className="flex items-center gap-2 text-[13px] text-ink3">
              <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
              Collecting telemetry…
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}
