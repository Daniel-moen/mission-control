import { motion } from 'motion/react';
import { spring, press } from '../../lib/motion.js';
import { useNow } from '../../lib/hooks.js';
import { useUsage, liveWindows, worstWindow, levelOf, fmtReset, WARN, CRIT } from '../../lib/usage.js';
import Icon from '../../ui/Icon.jsx';

// Claude subscription usage (task 0290): the 5-hour session and weekly limits
// as Claude Code's /usage reports them, read on the Mac and passed on by the
// relay (lib/usage.js). Green under 80%, amber from 80%, red from 95%.

const COLOR = { ok: 'var(--color-accent)', warn: 'var(--color-warn)', crit: 'var(--color-crit)' };

function Bar({ w, now }) {
  const lv = levelOf(w.pct);
  const c = COLOR[lv];
  return (
    <div className="min-w-0" data-usage-window={w.key} data-level={lv}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="truncate text-[12px] font-medium text-ink2">{w.label}</span>
        <span className={`ml-auto flex-none text-[13px] font-semibold tnum ${lv === 'ok' ? 'text-ink' : lv === 'warn' ? 'text-warn' : 'text-crit'}`}>
          {Math.round(w.pct)}%
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full" style={{ background: `color-mix(in oklab, ${c} 16%, transparent)` }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: c }}
          initial={false}
          animate={{ width: `${Math.min(100, w.pct)}%` }}
          transition={spring.gentle}
        />
        {/* the 80% line Mia starts throttling at */}
        <span className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${WARN}%` }} />
      </div>
      <div className="mt-1 truncate text-[10.5px] text-ink3">{w.reset ? 'reset since the last reading' : fmtReset(w.resetsAt, now)}</div>
    </div>
  );
}

export function UsageCard({ className = '' }) {
  const now = useNow();
  const usage = useUsage((s) => s.usage);
  const missing = useUsage((s) => s.missing);
  const t = now || Date.now();
  const ws = liveWindows(usage, t).slice(0, 3);
  const worst = worstWindow(usage, t);
  const lv = worst ? levelOf(worst.pct) : 'ok';
  const at = Date.parse(usage?.at || '');
  const ageMin = Number.isFinite(at) ? Math.round((t - at) / 60000) : null;
  const old = usage?.stale || (ageMin != null && ageMin > 20);

  return (
    <section data-usage={lv} className={`glass-soft rounded-xl2 px-3 py-2.5 ${className}`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon name="gauge" size={14} className="text-ink3" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">Claude usage</span>
        {lv !== 'ok' && (
          <span className={`pill px-2 py-0.5 text-[10.5px] font-semibold ${lv === 'crit' ? 'bg-crit/20 text-crit' : 'bg-warn/20 text-warn'}`}>
            {lv === 'crit' ? 'Near the limit' : 'Over 80%'}
          </span>
        )}
        <span className="ml-auto truncate text-[10.5px] text-ink3" title={usage?.error || ''}>
          {!usage ? '' : old ? `stale · ${ageMin != null ? `${ageMin}m ago` : ''}` : ageMin != null ? (ageMin < 1 ? 'just now' : `${ageMin}m ago`) : ''}
        </span>
      </div>
      {ws.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {ws.map((w) => (
            <Bar key={w.key} w={w} now={t} />
          ))}
        </div>
      ) : (
        <div className="text-[12px] leading-snug text-ink3">
          {missing ? 'This relay has no usage yet — deploy the 0290 relay.' : 'Waiting for the Mac — `mia usage sync` pushes it every 5 minutes.'}
        </div>
      )}
    </section>
  );
}

// A small warning pill for the top bar once any limit passes 80%.
export function UsagePill({ onClick }) {
  const now = useNow();
  const usage = useUsage((s) => s.usage);
  const w = worstWindow(usage, now || Date.now());
  if (!w || w.pct < WARN) return null;
  const crit = w.pct >= CRIT;
  return (
    <motion.button
      {...press}
      onClick={onClick}
      data-usage-pill={crit ? 'crit' : 'warn'}
      title={`${w.label}: ${Math.round(w.pct)}% used · ${fmtReset(w.resetsAt, now || Date.now())}`}
      aria-label={`Claude usage ${Math.round(w.pct)}% of ${w.label}`}
      className={`pill inline-flex h-8 flex-none items-center gap-1.5 px-2.5 text-[12px] font-semibold tnum ${crit ? 'bg-crit/20 text-crit' : 'bg-warn/15 text-warn'}`}
    >
      <Icon name="gauge" size={13} />
      {Math.round(w.pct)}%
      <span className="hidden font-medium opacity-80 sm:inline">{w.key === 'session' ? 'session' : 'week'}</span>
    </motion.button>
  );
}
