'use client';
// Small live graphics: sparklines, progress rings, agent orbs, activity bars.
// All SVG/CSS (crisp at any DPR), transform/opacity animation only.

import { motion } from 'motion/react';
import { useId, useMemo, type ReactNode } from 'react';

// Smooth path through points (Catmull-Rom → cubic Bézier).
export function smoothPath(pts: [number, number][]) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export const TONES: Record<string, [string, string]> = {
  green: ['#7dffa0', '#32d74b'],
  amber: ['#ffd58a', '#ffb340'],
  violet: ['#e2c6ff', '#bf8cff'],
  rose: ['#ffc2cf', '#ff8fa3'],
  ember: ['#ffd2a8', '#ff9a5a'],
  white: ['#ffffff', 'rgba(255,255,255,.7)'],
  red: ['#ffb3ad', '#ff6961'],
};

export function Sparkline({ data, width = 120, height = 32, tone = 'green', fill = true, live = true, min }: { data: number[]; width?: number; height?: number; tone?: string; fill?: boolean; live?: boolean; min?: number }) {
  const id = useId().replace(/:/g, '');
  const [c1, c2] = TONES[tone] || TONES.white;
  const { line, area, last } = useMemo(() => {
    const d = data.length ? data : [0, 0];
    const lo = min ?? Math.min(...d);
    const hi = Math.max(...d, lo + 1e-6);
    const pad = 3;
    const pts: [number, number][] = d.map((v, i) => [pad + (i / Math.max(1, d.length - 1)) * (width - pad * 2), pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2)]);
    if (pts.length === 1) pts.push([width - pad, pts[0][1]]);
    const line = smoothPath(pts);
    return { line, area: `${line} L${width - pad},${height} L${pad},${height} Z`, last: pts[pts.length - 1] };
  }, [data, width, height, min]);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ overflow: 'visible', display: 'block' }}>
      <defs>
        <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c2} stopOpacity=".38" />
          <stop offset="1" stopColor={c2} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`l${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={c2} stopOpacity=".25" />
          <stop offset=".7" stopColor={c2} />
          <stop offset="1" stopColor={c1} />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#f${id})`} /> : null}
      <path className="line" d={line} stroke={`url(#l${id})`} />
      {live && last ? (
        <>
          <circle className="pulse-dot" cx={last[0]} cy={last[1]} r="2.4" fill={c1} />
          <circle cx={last[0]} cy={last[1]} r="2.3" fill={c1} />
        </>
      ) : null}
    </svg>
  );
}

export function ProgressRing({ value, size = 44, stroke = 4, tone = 'green', children, spin = false }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode; spin?: boolean }) {
  const id = useId().replace(/:/g, '');
  const [c1, c2] = TONES[tone] || TONES.white;
  const r = size / 2 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', display: 'block' }} aria-hidden>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1} />
            <stop offset="1" stopColor={c2} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,.25)" strokeWidth={stroke * 0.4} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#g${id})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        {spin ? (
          <circle className="orb-swirl" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c1} strokeOpacity=".55" strokeWidth={stroke * 0.6} strokeLinecap="round" strokeDasharray={`${c * 0.06} ${c}`} style={{ transformOrigin: 'center' }} />
        ) : null}
      </svg>
      {children ? <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>{children}</div> : null}
    </div>
  );
}

// A small glass sphere per agent, tinted by model family; a caustic swirl
// turns inside it while the agent works.
const ORB: Record<string, [string, string, string]> = {
  opus: ['#f3e0ff', '#b48cff', '#3d2366'],
  fable: ['#ffe6c8', '#ff9f5a', '#5a2a14'],
  sonnet: ['#ffe0e8', '#ff8fa3', '#5a1f2c'],
  haiku: ['#e8ffd8', '#8cdc78', '#1f4a1a'],
  other: ['#f0eef2', '#a8a3ad', '#2e2b31'],
};
export function AgentOrb({ model, size = 38, working = false, state, seed = '' }: { model?: string; size?: number; working?: boolean; state?: string; seed?: string }) {
  const s = String(model || '').toLowerCase();
  // No model reported (interactive sessions): a stable tint from the name.
  const hashed = (['opus', 'fable', 'sonnet', 'haiku'] as const)[[...seed].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % 4];
  const fam = (['opus', 'fable', 'sonnet', 'haiku'].find((f) => s.includes(f)) || (seed ? hashed : 'other')) as keyof typeof ORB;
  const [hi, mid, lo] = ORB[fam];
  const dim = state === 'exited' || state === 'idle';
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size, borderRadius: '50%', position: 'relative', flex: 'none', overflow: 'hidden',
        background: `radial-gradient(circle at 32% 28%, ${hi} 0%, ${mid} 45%, ${lo} 100%)`,
        boxShadow: `inset 0 -${size / 7}px ${size / 3.5}px rgba(0,0,0,.45), inset 0 1px 2px rgba(255,255,255,.6), 0 ${size / 6}px ${size / 2.5}px -${size / 6}px rgba(0,0,0,.65)`,
        filter: dim ? 'grayscale(.8) brightness(.7)' : undefined,
      }}
    >
      <div className={`orb-swirl ${working ? 'fast' : ''}`} style={{ position: 'absolute', inset: '-20%', background: `conic-gradient(from 0deg, transparent, ${hi}55, transparent 40%, ${mid}66, transparent 75%)`, mixBlendMode: 'overlay', opacity: working ? 1 : 0.35 }} />
      <div style={{ position: 'absolute', left: '20%', top: '12%', width: '38%', height: '24%', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,255,255,.9), transparent)' }} />
      <div style={{ position: 'absolute', left: '30%', bottom: '8%', width: '44%', height: '16%', borderRadius: '50%', background: `radial-gradient(closest-side, ${hi}88, transparent)` }} />
    </div>
  );
}

// Live activity: a little equaliser whose energy follows tokens/sec.
export function ActivityBars({ level = 0, tone = 'green', n = 5 }: { level?: number; tone?: string; n?: number }) {
  const [, c2] = TONES[tone] || TONES.white;
  const l = Math.max(0.08, Math.min(1, level));
  return (
    <span className="bars" style={{ color: c2, display: 'inline-flex', alignItems: 'flex-end', height: 14 }} aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <motion.i
          key={i}
          style={{ height: 14 }}
          animate={{ scaleY: [0.2, l * (0.5 + ((i * 37) % 10) / 20), 0.25 + l * 0.3, l, 0.2] }}
          transition={{ duration: 1.2 + i * 0.17, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
    </span>
  );
}
