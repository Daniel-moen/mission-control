import { useEffect, useRef, useState } from 'react';
import { motion, animate, useReducedMotion, AnimatePresence } from 'motion/react';
import { spring, ease } from '../../lib/motion.js';
import { mediaUrl, fmtNum, fmtTime } from '../../lib/channels.js';
import Icon from '../../ui/Icon.jsx';

const SHORT_LABEL = { uploaded: 'Upload', scheduled: 'Sched.', visuals: 'Visuals' };

// ---- checkpoint progress bar --------------------------------------------------------------------------------
// Idea → Script → Voice → Visuals → Render → QA → Ready → Uploaded → Scheduled → Public. The track fills up to the
// current checkpoint with one smooth spring, the dots light in sequence, and the current one pulses. Hover (or
// tap) a dot for when it was reached and the file that proves it.
export function CheckpointBar({ checkpoints = [], compact = false, delay = 0 }) {
  const reduce = useReducedMotion();
  const [tip, setTip] = useState(null);
  const n = checkpoints.length;
  const cur = Math.max(0, checkpoints.findIndex((c) => c.current));
  const frac = n > 1 ? cur / (n - 1) : 0;
  const dot = compact ? 9 : 13;
  return (
    <div className="relative select-none" data-checkpoints={checkpoints[cur]?.key}>
      <div className="relative" style={{ height: dot + 4 }}>
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.09]" style={{ left: dot / 2, right: dot / 2 }} />
        <motion.div
          className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-accent"
          style={{ left: dot / 2, originX: 0, width: `calc(100% - ${dot}px)` }}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: frac }}
          transition={reduce ? { duration: 0 } : { ...spring.gentle, delay }}
        />
        <div className="absolute inset-0 flex items-center justify-between">
          {checkpoints.map((c, i) => {
            const state = c.current ? 'current' : c.done ? 'done' : 'todo';
            return (
              <button
                key={c.key}
                type="button"
                data-cp={c.key}
                data-state={state}
                aria-label={`${c.label}: ${state === 'todo' ? 'not yet' : c.at ? fmtTime(c.at) : 'done'}`}
                onMouseEnter={() => setTip(i)}
                onMouseLeave={() => setTip((t) => (t === i ? null : t))}
                onClick={(e) => { e.stopPropagation(); setTip((t) => (t === i ? null : i)); }}
                className="relative grid place-items-center"
                style={{ width: dot + 8, height: dot + 8, margin: -4 }}
              >
                <motion.span
                  className={`block rounded-full ${state === 'todo' ? 'bg-[#2a2a30] ring-1 ring-white/15' : 'bg-accent'} ${state === 'current' && !reduce ? 'ch-pulse' : ''}`}
                  style={{ width: dot, height: dot }}
                  initial={reduce ? false : { scale: 0.4, opacity: 0.4 }}
                  animate={{ scale: state === 'current' ? 1.18 : 1, opacity: 1 }}
                  transition={reduce ? { duration: 0 } : { ...spring.snappy, delay: delay + (state === 'todo' ? 0.05 : i * 0.045) }}
                >
                  {state === 'done' && !compact && <Icon name="check" size={9} strokeWidth={3} className="m-auto block h-full text-accent-ink" />}
                </motion.span>
              </button>
            );
          })}
        </div>
      </div>
      {!compact && (
        <div className="mt-1.5 flex justify-between text-[10px] leading-tight text-ink3">
          {checkpoints.map((c) => (
            <span key={c.key} className={`w-0 flex-1 truncate text-center first:text-left last:text-right ${c.current ? 'font-semibold text-ink' : ''}`}>
              {SHORT_LABEL[c.key] || c.label}
            </span>
          ))}
        </div>
      )}
      <AnimatePresence>
        {tip != null && checkpoints[tip] && (
          <motion.div
            key={tip}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: ease.out }}
            className="glass-strong pointer-events-none absolute z-20 w-max max-w-[240px] rounded-xl px-2.5 py-1.5 text-[11.5px] leading-snug shadow-2"
            style={{ left: `${(tip / Math.max(1, n - 1)) * 100}%`, bottom: compact ? 18 : 34, transform: 'translateX(-50%)' }}
            data-tip
          >
            <div className="font-semibold text-ink">{checkpoints[tip].label}</div>
            <div className="text-ink2">
              {checkpoints[tip].done || checkpoints[tip].current ? (checkpoints[tip].at ? fmtTime(checkpoints[tip].at) : 'Done') : 'Not yet'}
            </div>
            {checkpoints[tip].file && <div className="truncate font-mono text-[10.5px] text-ink3">{checkpoints[tip].file}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- ring: the week's posting target ---------------------------------------------------------------------------
export function Ring({ value = 0, max = 1, size = 64, stroke = 6, label, sub }) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="relative flex-none" style={{ width: size, height: size }} role="img" aria-label={`${value} of ${max}${label ? ` ${label}` : ''}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-accent)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - frac) }}
          transition={reduce ? { duration: 0 } : { ...spring.gentle, delay: 0.1 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <div>
          <div className="tnum text-[15px] font-semibold text-ink"><Counter value={value} /></div>
          {sub && <div className="mt-0.5 text-[9.5px] text-ink3">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- a number that rolls to its new value -------------------------------------------------------------------
export function Counter({ value, format = (n) => String(Math.round(n)) }) {
  const reduce = useReducedMotion();
  const el = useRef(null);
  const prev = useRef(value ?? 0);
  useEffect(() => {
    if (value == null || !el.current) return;
    const from = prev.current ?? 0;
    prev.current = value;
    if (reduce || from === value) {
      el.current.textContent = format(value);
      return;
    }
    const c = animate(from, value, { ...spring.gentle, onUpdate: (v) => { if (el.current) el.current.textContent = format(v); } });
    return () => c.stop();
  }, [value, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={el} className="tnum">{value == null ? '—' : format(prev.current ?? value)}</span>;
}

export const fmtCount = (n) => fmtNum(n);

// ---- media through the relay (the Mac uploads on demand: 202 until it has) ------------------------------------
export function RelayImg({ media, size = 'thumb', alt = '', className = '', fallback = 'video' }) {
  const [n, setN] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = media ? `${mediaUrl(media, size)}${n ? `&r=${n}` : ''}` : '';
  useEffect(() => { setN(0); setFailed(false); setLoaded(false); }, [media?.id, size]);
  const placeholder = <div className={`grid place-items-center bg-white/[0.04] text-ink3 ${className}`}><Icon name={fallback} size={18} /></div>;
  if (!media || failed) return placeholder;
  // A 202 means the relay asked the Mac for it: keep the quiet placeholder and try again in a moment.
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {!loaded && <div className="absolute inset-0 grid place-items-center bg-white/[0.04] text-ink3"><Icon name={fallback} size={18} /></div>}
      <img
        key={n}
        src={src}
        alt={alt}
        loading="lazy"
        className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setLoaded(true)}
        onError={() => (n < 8 ? setTimeout(() => setN((x) => x + 1), 2500 + n * 1500) : setFailed(true))}
      />
    </div>
  );
}

export function RelayVideo({ media, poster, vertical }) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [play, setPlay] = useState(false);
  const url = mediaUrl(media, 'full');
  useEffect(() => {
    setReady(false); setErr('');
    if (!play || !media) return;
    let alive = true;
    (async () => {
      for (let i = 0; i < 60 && alive; i += 1) {
        try {
          const r = await fetch(url, { headers: { Range: 'bytes=0-1' } });
          if (r.status === 206 || r.status === 200) { if (alive) setReady(true); return; }
          if (r.status !== 202) { if (alive) setErr(`The relay said ${r.status}`); return; }
        } catch (e) {
          if (alive) setErr('Relay unreachable');
          return;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (alive) setErr('The Mac did not send it in time');
    })();
    return () => { alive = false; };
  }, [play, url]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = `relative overflow-hidden rounded-2xl bg-black ${vertical ? 'mx-auto aspect-[9/16] max-h-[62dvh]' : 'aspect-video w-full'}`;
  if (!media) return <div className={`${box} grid place-items-center text-[13px] text-ink3`}>No video file yet</div>;
  if (!play || !ready) {
    return (
      <button type="button" className={`${box} group block w-full`} onClick={() => setPlay(true)} aria-label="Play" data-play>
        {poster && <RelayImg media={poster.media} size={poster.size} className="absolute inset-0 h-full w-full opacity-80" />}
        <span className="absolute inset-0 grid place-items-center">
          <motion.span whileTap={{ scale: 0.94 }} className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-black shadow-2 transition-transform group-hover:scale-105">
            {play && !err ? <span className="ch-spin h-6 w-6 rounded-full border-2 border-black/20 border-t-black" /> : <Icon name="play" size={26} />}
          </motion.span>
        </span>
        {play && !err && <span className="absolute inset-x-0 bottom-3 text-center text-[12px] text-white/80">Fetching from the Mac…</span>}
        {err && <span className="absolute inset-x-0 bottom-3 text-center text-[12px] text-warn">{err}</span>}
      </button>
    );
  }
  return (
    <div className={box}>
      <video src={url} controls autoPlay playsInline className="h-full w-full" />
    </div>
  );
}

// ---- charts (one series each: no legend box, the title names it) ---------------------------------------------------
export function AreaChart({ points = [], height = 150, label, color = 'var(--color-accent)', fmtX }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const known = points.filter((p) => p[1] != null);
  if (known.length < 2) return <p className="py-6 text-center text-[12.5px] text-ink3">Not enough snapshots yet. The curve fills in every 45 minutes.</p>;
  const W = 600, H = height, L = 36, R = 8, T = 10, B = 22;
  const max = niceMax(Math.max(...known.map((p) => p[1])));
  const sx = (i) => L + (i / Math.max(1, points.length - 1)) * (W - L - R);
  const sy = (v) => H - B - (v / max) * (H - T - B);
  const path = points.map((p, i) => (p[1] == null ? null : `${sx(i).toFixed(1)},${sy(p[1]).toFixed(1)}`)).filter(Boolean);
  const d = `M${path.join('L')}`;
  const area = `${d}L${sx(points.length - 1)},${sy(0)}L${sx(0)},${sy(0)}Z`;
  const onMove = (e) => {
    const r = box.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((x - L) / (W - L - R)) * (points.length - 1))));
    setHover(points[i][1] == null ? null : i);
  };
  return (
    <div className="relative" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={label}>
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="rgba(255,255,255,0.07)" />
            <text x={L - 6} y={sy(v) + 3.5} textAnchor="end" className="tnum fill-ink3 text-[10px]">{fmtNum(v)}</text>
          </g>
        ))}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i, k) => (
          <text key={k} x={sx(i)} y={H - 5} textAnchor={['start', 'middle', 'end'][k]} className="fill-ink3 text-[10px]">{fmtX ? fmtX(points[i][0]) : points[i][0]}</text>
        ))}
        <motion.path d={area} fill={color} fillOpacity={0.14} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} />
        <motion.path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? { duration: 0 } : { duration: 0.9, ease: ease.out }} />
        {hover != null && (
          <g>
            <line x1={sx(hover)} x2={sx(hover)} y1={T} y2={H - B} stroke="rgba(255,255,255,0.25)" />
            <circle cx={sx(hover)} cy={sy(points[hover][1])} r={4.5} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="glass-strong tnum pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg px-2 py-1 text-[11.5px] text-ink"
          style={{ left: `${(sx(hover) / W) * 100}%`, top: `${(sy(points[hover][1]) / H) * 100}%` }}>
          {fmtNum(points[hover][1])} · {fmtX ? fmtX(points[hover][0]) : points[hover][0]}
        </div>
      )}
    </div>
  );
}

export function Bars({ items = [], height = 150, label, color = 'var(--color-s2)', onPick }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState(null);
  if (!items.length) return <p className="py-6 text-center text-[12.5px] text-ink3">No public Shorts yet.</p>;
  const W = 600, H = height, L = 36, R = 8, T = 10, B = 8;
  const max = niceMax(Math.max(1, ...items.map((x) => x.value || 0)));
  const bw = (W - L - R) / items.length;
  const sy = (v) => H - B - (v / max) * (H - T - B);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={label}>
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="rgba(255,255,255,0.07)" />
            <text x={L - 6} y={sy(v) + 3.5} textAnchor="end" className="tnum fill-ink3 text-[10px]">{fmtNum(v)}</text>
          </g>
        ))}
        {items.map((x, i) => {
          const w = Math.max(2, Math.min(36, bw - 3));
          const xx = L + i * bw + (bw - w) / 2;
          const h = Math.max(1, sy(0) - sy(x.value || 0));
          return (
            <g key={x.id || i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(x)} className="cursor-pointer">
              <motion.rect x={xx} width={w} rx={Math.min(4, w / 2)} fill={color} opacity={hover == null || hover === i ? 1 : 0.55}
                initial={reduce ? false : { y: sy(0), height: 0 }} animate={{ y: sy(0) - h, height: h }}
                transition={reduce ? { duration: 0 } : { ...spring.smooth, delay: i * 0.02 }} />
              <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="glass-strong pointer-events-none absolute -translate-x-1/2 rounded-lg px-2 py-1 text-[11.5px] text-ink"
          style={{ left: `${((L + hover * bw + bw / 2) / W) * 100}%`, top: 0, maxWidth: 260 }}>
          <div className="tnum font-semibold">{fmtNum(items[hover].value)} views</div>
          <div className="truncate text-ink2">{items[hover].label}</div>
        </div>
      )}
    </div>
  );
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink3">{label}</div>
      <div className={`tnum mt-0.5 text-[22px] font-semibold tracking-tight ${tone || 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-[11.5px] text-ink3">{sub}</div>}
    </div>
  );
}
