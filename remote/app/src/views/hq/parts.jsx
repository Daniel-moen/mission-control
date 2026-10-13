import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { spring, press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import Segmented from '../../ui/Segmented.jsx';
import { LEVELS, levelOf, fmtWhen } from '../../lib/hqModel.js';
import { hqControl, useBusy } from '../../lib/hq.js';

// Small pieces shared by the HQ board and a company's page (task 0199).

// ---- health -------------------------------------------------------------------
// Colour only where it means something: green up, amber slow/stale, red down;
// unknown and unmonitored stay neutral.
export const HEALTH = {
  up: { dot: 'bg-accent', text: 'text-accent', chip: 'bg-accent/12 text-accent border border-accent/25', word: 'Up' },
  slow: { dot: 'bg-warn', text: 'text-warn', chip: 'bg-warn/14 text-warn border border-warn/30', word: 'Slow' },
  stale: { dot: 'bg-warn/70', text: 'text-warn', chip: 'bg-warn/10 text-warn border border-warn/25', word: 'Stale' },
  down: { dot: 'bg-crit', text: 'text-crit', chip: 'bg-crit/14 text-crit border border-crit/30', word: 'Down' },
  unknown: { dot: 'bg-ink3', text: 'text-ink3', chip: 'glass-soft text-ink2', word: 'Unchecked' },
  none: { dot: 'bg-white/20', text: 'text-ink3', chip: 'glass-soft text-ink3', word: 'Not monitored' },
};
export const healthTone = (s) => HEALTH[s] || HEALTH.unknown;

export function HealthDot({ status, size = 8 }) {
  const t = healthTone(status);
  return (
    <span className="relative flex flex-none" style={{ width: size, height: size }}>
      {status === 'down' && <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${t.dot} opacity-50`} />}
      <span className={`relative inline-flex h-full w-full rounded-full ${t.dot}`} />
    </span>
  );
}

export function HealthChip({ health, className = '' }) {
  const t = healthTone(health.status);
  return (
    <span
      data-health={health.status}
      title={health.label}
      className={`pill inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[11.5px] font-medium leading-none ${t.chip} ${className}`}
    >
      <HealthDot status={health.status} size={6} />
      {t.word}
    </span>
  );
}

// ---- photos ---------------------------------------------------------------------
// registry companies[].photo: a bundled file ("hq/klear.jpg") or an https URL.
// No photo, or one that fails, falls back to a quiet graphite wash.
export function photoSrc(photo) {
  if (!photo || typeof photo !== 'string') return '';
  if (/^https:\/\//.test(photo)) return photo;
  return `/${photo.replace(/^\/+/, '')}`;
}

export function Photo({ src, className = '', children }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  return (
    <div className={`relative overflow-hidden bg-[radial-gradient(120%_120%_at_20%_0%,#2a2a30_0%,#141417_60%)] ${className}`}>
      {src && !bad && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBad(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {/* The lower half goes near-black so white type always reads. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/25 to-black/80" />
      {children}
    </div>
  );
}

// ---- numbers ----------------------------------------------------------------------
export function Trend({ trend }) {
  if (!trend || trend.dir === 'flat') return null;
  const tone = trend.good == null ? 'text-ink3' : trend.good ? 'text-accent' : 'text-crit';
  const pct = trend.pct != null && Number.isFinite(trend.pct) ? `${Math.abs(trend.pct) >= 10 ? Math.round(Math.abs(trend.pct)) : Math.abs(trend.pct).toFixed(1)}%` : '';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${tone}`}>
      <Icon name={trend.dir === 'up' ? 'trendUp' : 'trendDown'} size={12} strokeWidth={2} />
      {pct}
    </span>
  );
}

// A shape, not a scale (see Insights): normalise the window so a series that
// barely moves still shows its shape; a flat one gets no line at all.
export function shapeOf(values, points = 30) {
  const d = (values || []).filter((v) => Number.isFinite(v)).slice(-points);
  if (d.length < 2) return null;
  const min = Math.min(...d);
  const max = Math.max(...d);
  if (!(max > min)) return null;
  return d.map((v) => ((v - min) / (max - min)) * 100);
}

// One number with its label and trend. `big` is the company page's tile.
export function Num({ n, big = false }) {
  const shape = big ? shapeOf(n.spark) : null;
  return (
    <div data-num={n.key} className={big ? 'glass-soft rounded-xl2 relative overflow-hidden p-3' : 'min-w-0'}>
      <div className="truncate text-[11px] text-ink3">{n.label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`tnum truncate font-semibold tracking-tight text-ink ${big ? 'text-[22px]' : 'text-[15px]'}`}>{n.value}</span>
        <Trend trend={n.trend} />
      </div>
      {shape && (
        <Sparkline
          data={shape}
          width={140}
          height={30}
          tone={n.trend?.good === false ? 'crit' : n.trend?.good ? 'ok' : 'neutral'}
          className="mt-1.5 h-[30px] w-full"
        />
      )}
    </div>
  );
}

// ---- autonomy ---------------------------------------------------------------------
const LEVEL_TONE = ['text-ink3', 'text-ink2', 'text-ink', 'text-mgr'];
export function LevelChip({ level, syncing }) {
  const l = levelOf(level);
  return (
    <span
      data-level={l.value}
      className={`pill glass-soft inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 text-[11px] font-medium leading-none ${LEVEL_TONE[l.value]}`}
      title={l.hint}
    >
      <Icon name={l.key} size={11.5} />
      {l.short}
      {syncing && <span className="anim-pulse ml-0.5 h-1 w-1 rounded-full bg-ink3" title="Syncing to the Mac" />}
    </span>
  );
}

// The four levels, with a one-tap undo for ten seconds after a change (the
// undo is just the previous level sent the same way, so Mia hears it too).
export function LevelPicker({ project, registry }) {
  const busy = useBusy({ action: 'level', project: project.id });
  const [undo, setUndo] = useState(null); // previous level
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = async (lv, isUndo = false) => {
    if (lv === project.autonomy || busy) return;
    const prev = project.autonomy;
    const okd = await hqControl({ action: 'level', project: project.id, level: lv }, registry);
    clearTimeout(timer.current);
    if (okd && !isUndo) {
      setUndo(prev);
      timer.current = setTimeout(() => setUndo(null), 10000);
    } else setUndo(null);
  };
  const cur = levelOf(project.autonomy);
  return (
    <div data-levels={project.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={LEVELS.map((l) => ({ value: l.value, label: l.short, icon: l.key }))}
          value={project.autonomy}
          onChange={(v) => pick(v)}
          className={busy ? 'opacity-60' : ''}
        />
        {undo != null && (
          <motion.button
            {...press}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={spring.snappy}
            onClick={() => pick(undo, true)}
            data-undo={project.id}
            className="pill glass-soft glass-soft-hover inline-flex h-8 items-center gap-1.5 px-3 text-[12.5px] font-medium text-ink"
          >
            <Icon name="undo" size={14} />
            Undo
          </motion.button>
        )}
      </div>
      <div className="mt-1.5 text-[12px] text-ink3">
        <span className="text-ink2">{cur.label}:</span> {cur.hint}
        {project.autonomy === 3 && ' Never money, new contacts, deleting, publishing or legal.'}
      </div>
    </div>
  );
}

// ---- activity feed ------------------------------------------------------------------
const KIND = {
  found: { icon: 'search', tone: 'text-warn', word: 'Found' },
  fixed: { icon: 'fix', tone: 'text-accent', word: 'Fixed' },
  shipped: { icon: 'check', tone: 'text-accent', word: 'Shipped' },
  failed: { icon: 'alert', tone: 'text-crit', word: 'Failed' },
  health: { icon: 'overview', tone: 'text-ink2', word: 'Health' },
  control: { icon: 'settings', tone: 'text-ink3', word: 'Control' },
  scout: { icon: 'scout', tone: 'text-mgr', word: 'Scout' },
  note: { icon: 'note', tone: 'text-ink2', word: 'Note' },
};
export const kindOf = (k) => KIND[k] || KIND.note;

export function FeedList({ items, projectName, onOpenTask, empty = 'Nothing yet.' }) {
  if (!items.length) return <div className="px-1 py-4 text-[12.5px] text-ink3">{empty}</div>;
  const now = Date.now();
  return (
    <ul className="divide-y divide-white/[0.06]" data-feed>
      {items.map((it) => {
        const k = kindOf(it.kind);
        const body = (
          <>
            <span className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-white/[0.06] ${k.tone}`}>
              <Icon name={k.icon} size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug text-ink">{it.text}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink3">
                <span className={k.tone}>{k.word}</span>
                {projectName && it.project && <span>{projectName(it.project)}</span>}
                {it.task && <span className="font-mono">#{it.task}</span>}
                {it.by && it.by !== 'mia' && <span>by {it.by === 'daniel' ? 'you' : it.by}</span>}
                <span>{fmtWhen(it.at, now)}</span>
              </span>
            </span>
          </>
        );
        return (
          <li key={it.id} data-feed-item={it.kind}>
            {it.task && onOpenTask ? (
              <button onClick={() => onOpenTask(it.task)} className="flex w-full items-start gap-2.5 py-2.5 text-left hover:bg-white/[0.03]">
                {body}
              </button>
            ) : (
              <div className="flex items-start gap-2.5 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const FEED_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'found', label: 'Found' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'shipped', label: 'Shipped' },
];
export function filterFeed(items, f) {
  if (f === 'all') return items;
  if (f === 'found') return items.filter((i) => i.kind === 'found' || i.kind === 'scout' || i.kind === 'health');
  return items.filter((i) => i.kind === f);
}

export function SectionTitle({ children, right }) {
  return (
    <div className="mb-2 mt-6 flex items-center gap-3 px-1">
      <h3 className="flex-1 text-[13px] font-semibold tracking-tight text-ink2">{children}</h3>
      {right}
    </div>
  );
}
