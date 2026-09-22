import { useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ease } from '../lib/motion.js';

const TONE = {
  accent: 'var(--color-accent)',
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  crit: 'var(--color-crit)',
  mgr: 'var(--color-mgr)',
  neutral: 'var(--color-ink3)',
};

// Inline sparkline: soft area + line + an end dot at "now". It draws itself in
// ONCE on mount (pathLength 0→1); after that the path just morphs, because a
// line that re-draws every 1 Hz snapshot is a strobe, not a chart.
export default function Sparkline({ data = [], width = 120, height = 34, tone = 'accent', className = '' }) {
  const drawn = useRef(false);
  const color = TONE[tone] || TONE.accent;

  const pts = useMemo(() => {
    const d = (data || []).slice(-24);
    if (d.length < 2) return null;
    const P = 3;
    const max = Math.max(...d, 1);
    const p = d.map((v, i) => [
      P + (width - 2 * P) * (i / (d.length - 1)),
      height - P - (height - 2 * P) * ((v || 0) / max),
    ]);
    const line = p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
    return {
      line: 'M' + line.replace(/ /g, ' L'),
      area: `M${P},${height} L${line.replace(/ /g, ' L')} L${p[p.length - 1][0].toFixed(1)},${height} Z`,
      end: p[p.length - 1],
    };
  }, [data, width, height]);

  const reduce = useReducedMotion();
  const first = !drawn.current;
  if (pts) drawn.current = true;

  if (!pts) return <svg width={width} height={height} className={className} aria-hidden="true" />;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={className} aria-hidden="true">
      <path d={pts.area} fill={color} opacity="0.1" />
      <motion.path
        d={pts.line}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
        initial={first && !reduce ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.6, ease: ease.out }}
      />
      <circle cx={pts.end[0]} cy={pts.end[1]} r="2.6" fill={color} />
    </svg>
  );
}
