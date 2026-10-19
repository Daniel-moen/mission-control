import { useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { spring, fadeUp, reduced } from '../../lib/motion.js';
import {
  useChannels, useChannelsSync, useChannelsView, refreshChannels, channelAction, useActionBusy,
  describe, streak, weekProgress, fmtAgo, fmtNum, fmtTime,
} from '../../lib/channels.js';
import IconButton from '../../ui/IconButton.jsx';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import Segmented from '../../ui/Segmented.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Spinner from '../../ui/Spinner.jsx';
import Sheet from '../../ui/Sheet.jsx';
import { CheckpointBar, Ring, Counter, RelayImg, RelayVideo, AreaChart, Bars, Stat } from './parts.jsx';

// Channels (task 0260): every YouTube channel Mia runs, each video's progress as checkpoints, what's next,
// controls that go to Mia (never straight to YouTube), and public analytics. Data: lib/channels.js polls what
// Channels HQ on the Mac pushed to the relay. A CHROMELESS window: the header row is ours.

const TABS = [
  { value: 'channels', label: 'Channels', icon: 'video' },
  { value: 'pipeline', label: 'Pipeline', icon: 'tasks' },
  { value: 'analytics', label: 'Analytics', icon: 'overview' },
];
const STATUS = { live: ['Live', 'bg-accent/15 text-accent'], 'setting-up': ['Not created yet', 'bg-warn/15 text-warn'], planned: ['Planned', 'bg-white/[0.08] text-ink2'] };
const RI = 'raw-incident';
const perDayFallback = (c) => (c.key === RI ? 2 : 1); // Raw Incident's own routine: 2 Shorts a day

function SyncChip({ view }) {
  const error = useChannels((s) => s.error);
  const loading = useChannels((s) => s.loading);
  const pushed = view?.at;
  const stats = view?.stats_status?.last_snapshot;
  const stale = pushed && Date.now() - Date.parse(pushed) > 10 * 60e3;
  const label = error && !view ? 'Offline' : stats ? `Public stats, updated ${new Date(stats).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })}` : pushed ? `Mac ${fmtAgo(pushed)}` : 'Waiting for the Mac';
  return (
    <button onClick={() => refreshChannels()} data-sync
      title={error || (pushed ? `Channels HQ pushed ${new Date(pushed).toLocaleString()}` : '')}
      className={`pill glass-soft glass-soft-hover inline-flex max-w-full items-center gap-1.5 px-2.5 py-1 text-[11.5px] ${error || stale ? 'text-warn' : 'text-ink2'}`}>
      {loading ? <Spinner size={10} /> : <span className={`h-1.5 w-1.5 flex-none rounded-full ${error || stale ? 'bg-warn' : 'bg-accent'}`} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Logo({ c, size = 44 }) {
  const initials = (c.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <div className="grid flex-none place-items-center rounded-xl bg-white/[0.08] font-semibold text-ink2" style={{ width: size, height: size, fontSize: size / 2.8 }}>{initials}</div>;
}

function LogoBox({ c, size = 44 }) {
  return (
    <div className="flex-none overflow-hidden rounded-xl ring-1 ring-white/10" style={{ width: size, height: size }}>
      {c.logo ? <RelayImg media={c.logo} className="h-full w-full" /> : <Logo c={c} size={size} />}
    </div>
  );
}

function StatusPill({ c }) {
  const [label, cls] = STATUS[c.status] || STATUS.planned;
  return <span className={`pill inline-flex h-6 items-center px-2.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

function Thumb({ v, className = '' }) {
  const vertical = v.kind === 'short';
  const poster = vertical && v.video ? { media: v.video, size: 'poster' } : v.thumbnail ? { media: v.thumbnail, size: 'thumb' } : null;
  return (
    <div className={`relative flex-none overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06] ${vertical ? 'aspect-[9/16] w-[46px]' : 'aspect-video w-[96px]'} ${className}`}>
      {poster ? <RelayImg media={poster.media} size={poster.size} className="h-full w-full" /> : <div className="grid h-full place-items-center text-ink3"><Icon name="video" size={16} /></div>}
    </div>
  );
}

// ---- one channel card on the overview ------------------------------------------------------------------------
function ChannelCard({ c, onOpen, i }) {
  const reduce = useReducedMotion();
  const n = c.numbers || {};
  const cad = n.cadence || {};
  const wk = weekProgress(cad, perDayFallback(c));
  const st = streak(cad, perDayFallback(c));
  const making = c.videos.filter((v) => !['public', 'uploaded', 'scheduled'].includes(v.stage));
  const next = making.sort((a, b) => b.checkpoints.findIndex((x) => x.current) - a.checkpoints.findIndex((x) => x.current))[0];
  return (
    <motion.button
      layout
      {...(reduce ? reduced(fadeUp) : fadeUp)}
      transition={{ ...spring.smooth, delay: i * 0.04 }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      onClick={() => onOpen(c.key)}
      data-channel={c.key}
      className="glass rounded-xl3 flex flex-col gap-3 p-4 text-left"
    >
      <div className="flex items-start gap-3">
        <LogoBox c={c} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold tracking-tight text-ink">{c.name}</div>
          <div className="line-clamp-2 text-[12px] leading-snug text-ink3">{c.niche || c.tagline || ''}</div>
        </div>
        <StatusPill c={c} />
      </div>
      <div className="flex items-center gap-3.5">
        <Ring value={wk.posted} max={wk.target} size={68} sub={wk.started ? `of ${wk.target}` : 'week 1'} label="Shorts this week" />
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">
          <Stat label="Streak" value={<span className="inline-flex items-center gap-1"><Counter value={st} />{st > 0 && <span aria-hidden>🔥</span>}</span>} sub={st === 1 ? 'day' : 'days'} />
          <Stat label="7 days" value={<Counter value={n.views_7d ?? 0} format={fmtNum} />} sub="views" />
          <Stat label="Shorts" value={<Counter value={n.shorts?.public ?? 0} />} sub={`${n.shorts?.ready ?? 0} ready`} />
        </div>
      </div>
      <div className="text-[11.5px] text-ink3">
        {cad.planned
          ? cad.started ? `Week ${cad.week} · plan ${cad.today_target}/day · today ${cad.today_posted} of ${cad.today_target}` : 'Plan: 1/day week 1 → 2/day weeks 2–3 → 3/day from week 4'
          : `Own routine: 1 long + 2 Shorts a day · today ${cad.today_posted ?? 0} Shorts`}
      </div>
      {next ? (
        <div className="rounded-xl bg-white/[0.035] p-2.5">
          <div className="mb-2 flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{next.title}</span>
            <span className="flex-none text-ink3">{making.length > 1 ? `+${making.length - 1}` : ''}</span>
          </div>
          <CheckpointBar checkpoints={next.checkpoints} compact delay={0.15 + i * 0.04} />
          <div className="mt-2 truncate text-[11.5px] text-ink2"><span className="text-ink3">Next:</span> {cap(next.next_step)}</div>
        </div>
      ) : (
        <div className="rounded-xl bg-white/[0.035] p-2.5 text-[12px] text-ink3">{c.status !== 'live' && c.setup ? 'Setup sheet ready: create the channel on YouTube' : 'Nothing in production'}</div>
      )}
    </motion.button>
  );
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// ---- overview -----------------------------------------------------------------------------------------------------
function Overview({ view, onOpen, onVideo }) {
  const [showParked, setShowParked] = useState(false);
  const [allNeeds, setAllNeeds] = useState(false);
  const a = view.across || {};
  const today = view.active.reduce((s, c) => s + (c.numbers?.cadence?.today_posted || 0), 0);
  const dd = a.double_down;
  return (
    <div className="flex flex-col gap-4">
      <motion.div {...fadeUp} className="glass rounded-xl3 grid grid-cols-2 gap-4 p-4 sm:grid-cols-4" data-across>
        <Stat label="Views · 7 days" value={<Counter value={a.total?.views_7d ?? 0} format={fmtNum} />} sub="all channels" />
        <Stat label="Subscribers" value={<Counter value={a.total?.subscribers ?? 0} format={fmtNum} />} sub={`${view.active.length} active channels`} />
        <Stat label="Shorts today" value={<Counter value={today} />} sub="posted, all channels" />
        <Stat label="Published" value={<Counter value={a.total?.published ?? 0} />} sub="videos + Shorts" />
      </motion.div>
      {dd && (
        <motion.button {...fadeUp} onClick={() => onOpen(dd.channel)} data-double-down
          className="rounded-xl3 flex items-center gap-3 border border-accent/25 bg-accent/[0.08] p-3.5 text-left">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-accent/20 text-accent"><Icon name="bolt" size={17} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold text-ink">Double down on {dd.name}</span>
            <span className="block text-[12px] text-ink2">{fmtNum(dd.median_7d)} median views per Short over the last 7 days ({dd.shorts_7d} Shorts). The best of all channels.</span>
          </span>
          <Icon name="back" size={16} className="rotate-180 text-ink3" />
        </motion.button>
      )}
      {(view.needs || []).length > 0 && (
        <div className="grid gap-2 md:grid-cols-2" data-needs>
          {view.needs.slice(0, 4).map((n, i) => (
            <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.04 }} key={n.title}
              className={`glass-soft items-start gap-2.5 rounded-xl2 p-3 ${i >= 2 && !allNeeds ? 'hidden md:flex' : 'flex'} ${n.video ? 'cursor-pointer' : ''}`} onClick={() => n.video && onVideo(n.video)}>
              <span className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-warn/15 text-warn"><Icon name="alert" size={13} /></span>
              <span className="min-w-0"><span className="block text-[13px] font-medium text-ink">{n.title}</span><span className="line-clamp-2 block text-[12px] text-ink3">{n.detail}</span></span>
            </motion.div>
          ))}
          {view.needs.length > 2 && !allNeeds && (
            <button onClick={() => setAllNeeds(true)} className="px-1 text-left text-[12.5px] font-medium text-accent md:hidden" data-more-needs>
              Show {Math.min(4, view.needs.length) - 2} more
            </button>
          )}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-active>
        {view.active.map((c, i) => <ChannelCard key={c.key} c={c} i={i} onOpen={onOpen} />)}
        {(view.lineup_pending || []).map((l, i) => (
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 + i * 0.04 }} key={l.niche}
            className="rounded-xl3 flex flex-col justify-center gap-1.5 border border-dashed border-white/15 p-4" data-starting>
            <span className="pill w-max bg-white/[0.06] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink3">Starting · task {l.task}</span>
            <span className="text-[14px] font-semibold text-ink">{l.niche}</span>
            <span className="text-[12px] text-ink3">Format proof: {l.proof}. Shows up here with its first status.json.</span>
          </motion.div>
        ))}
      </div>
      {view.parked.length > 0 && (
        <div className="glass-soft rounded-xl3" data-parked>
          <button onClick={() => setShowParked((x) => !x)} className="flex w-full items-center gap-2 px-4 py-3 text-left" aria-expanded={showParked}>
            <Icon name="pause" size={15} className="text-ink3" />
            <span className="flex-1 text-[13px] font-medium text-ink2">Parked · {view.parked.length} channels</span>
            <span className="text-[11.5px] text-ink3">kept, no more work</span>
            <motion.span animate={{ rotate: showParked ? 90 : 0 }} transition={spring.snappy}><Icon name="back" size={15} className="rotate-180 text-ink3" /></motion.span>
          </button>
          <AnimatePresence initial={false}>
            {showParked && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
                <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
                  {view.parked.map((c) => (
                    <button key={c.key} onClick={() => onOpen(c.key)} className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] p-2 text-left hover:bg-white/[0.06]">
                      <LogoBox c={c} size={32} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-ink2">{c.name}</span><span className="block truncate text-[11px] text-ink3">{c.niche || ''}</span></span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ---- a video row with its checkpoints -------------------------------------------------------------------------------
function VideoRow({ v, c, onVideo, i = 0, showChannel }) {
  const reduce = useReducedMotion();
  return (
    <motion.button {...(reduce ? reduced(fadeUp) : fadeUp)} transition={{ ...fadeUp.transition, delay: Math.min(i, 12) * 0.03 }}
      onClick={() => onVideo(v.id)} data-video={v.id}
      className="glass-soft glass-soft-hover flex w-full items-center gap-3 rounded-xl2 p-3 text-left">
      <Thumb v={v} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{v.live_title || v.title}</span>
          {v.kind === 'short' && <span className="pill flex-none bg-white/[0.07] px-1.5 text-[10px] font-semibold uppercase text-ink3">Short</span>}
          {v.stats?.views != null && <span className="tnum flex-none text-[12px] text-ink2">{fmtNum(v.stats.views)} {v.stats.views === 1 ? 'view' : 'views'}</span>}
        </div>
        {showChannel && <div className="truncate text-[11.5px] text-ink3">{c?.name}</div>}
        <div className="mt-2.5"><CheckpointBar checkpoints={v.checkpoints} compact delay={0.1 + Math.min(i, 12) * 0.03} /></div>
        <div className="mt-1.5 truncate text-[11.5px] text-ink2"><span className="text-ink3">Next:</span> {cap(v.next_step)}</div>
      </div>
    </motion.button>
  );
}

function sortVideos(vs) {
  const order = (v) => v.checkpoints.findIndex((x) => x.current);
  return [...vs].sort((a, b) => {
    const pa = a.stage === 'public', pb = b.stage === 'public';
    if (pa !== pb) return pa ? 1 : -1;
    if (pa) return String(b.published_at || '').localeCompare(String(a.published_at || ''));
    return order(b) - order(a) || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
}

function Pipeline({ view, onVideo }) {
  const [filter, setFilter] = useState('making');
  const vids = view.active.flatMap((c) => c.videos);
  const shown = sortVideos(vids.filter((v) => (filter === 'making' ? v.stage !== 'public' : filter === 'public' ? v.stage === 'public' : true)));
  return (
    <div className="flex flex-col gap-3">
      <Segmented value={filter} onChange={setFilter} options={[
        { value: 'making', label: 'In progress', count: vids.filter((v) => v.stage !== 'public').length },
        { value: 'public', label: 'Public', count: vids.filter((v) => v.stage === 'public').length },
        { value: 'all', label: 'All', count: vids.length },
      ]} />
      {shown.length ? shown.slice(0, 80).map((v, i) => <VideoRow key={v.id} v={v} i={i} c={view.byKey.get(v.channel)} onVideo={onVideo} showChannel />)
        : <EmptyState icon="video" title="Nothing here" hint="Videos show up as soon as a channel's folder has them." />}
    </div>
  );
}

// ---- channel page -------------------------------------------------------------------------------------------------
function ChannelPage({ view, c, onBack, onVideo }) {
  const n = c.numbers || {};
  const cad = n.cadence || {};
  const wk = weekProgress(cad, perDayFallback(c));
  const st = streak(cad, perDayFallback(c));
  const [confirm, setConfirm] = useState(null);
  const paused = (view.actions || []).find((a) => a.channel === c.key && /^(pause|resume)_channel$/.test(a.action));
  const isPaused = paused?.action === 'pause_channel';
  const acts = (view.actions || []).filter((a) => a.channel === c.key).slice(0, 6);
  const vids = sortVideos(c.videos);
  return (
    <div className="flex flex-col gap-4" data-channel-page={c.key}>
      <motion.div {...fadeUp} className="glass rounded-xl3 flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <IconButton icon="back" label="All channels" size="sm" variant="glass" onClick={onBack} />
          <LogoBox c={c} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-semibold tracking-tight text-ink">{c.name}</div>
            <div className="text-[12.5px] text-ink3">{[c.niche, c.language, c.voice && `Voice: ${c.voice}`].filter(Boolean).join(' · ')}</div>
          </div>
          <StatusPill c={c} />
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <Ring value={wk.posted} max={wk.target} size={88} stroke={8} sub={wk.started ? `of ${wk.target} this week` : 'not started'} label="Shorts this week" />
          <div className="grid min-w-[240px] flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Streak" value={<span className="inline-flex items-center gap-1"><Counter value={st} />{st > 0 && <span aria-hidden>🔥</span>}</span>} sub="days on target" />
            <Stat label="Views 7d" value={<Counter value={n.views_7d ?? 0} format={fmtNum} />} sub={n.views_7d_partial ? 'since tracking began' : 'public'} />
            <Stat label="Subscribers" value={<Counter value={n.subscribers ?? 0} format={fmtNum} />} sub={c.status === 'live' ? 'public count' : 'not on YouTube yet'} />
            <Stat label="Shorts" value={<Counter value={n.shorts?.public ?? 0} />} sub={`${n.shorts?.ready ?? 0} ready · ${n.shorts?.in_progress ?? 0} making`} />
          </div>
        </div>
        <div className="text-[12px] text-ink3">
          {cad.planned ? (cad.started ? `Week ${cad.week} of the plan: ${cad.today_target} a day, posted ${cad.today_posted} today. ` : 'Plan: 1 a day in week 1, 2 a day in weeks 2–3, 3 a day from week 4. ') : 'Own routine: one long video at 19:30 plus two Shorts a day. '}
          Post in US daytime (06:00–22:00 ET = {cad.window_sast || '12:00–04:00'} SAST), spaced out.
        </div>
        <div className="flex flex-wrap gap-2" data-channel-controls>
          <ActionButton a={{ action: 'make_next_10', channel: c.key }} c={c} icon="sparkles" variant="accent">Make the next 10</ActionButton>
          <ActionButton a={{ action: isPaused ? 'resume_channel' : 'pause_channel', channel: c.key }} c={c} icon={isPaused ? 'play' : 'pause'}
            confirm={!isPaused && { title: `Pause ${c.name}?`, body: 'Mia stops making and posting for this channel until you resume it.', cta: 'Pause channel' }} onConfirm={setConfirm}>
            {isPaused ? 'Resume channel' : 'Pause channel'}
          </ActionButton>
          {c.setup && c.status !== 'live' && <span className="pill inline-flex items-center gap-1.5 bg-warn/12 px-3 text-[12px] text-warn">Setup sheet ready on the Mac</span>}
        </div>
      </motion.div>
      <div className="flex flex-col gap-2">
        {vids.length ? vids.map((v, i) => <VideoRow key={v.id} v={v} i={i} c={c} onVideo={onVideo} />)
          : <EmptyState icon="video" title="No videos yet" hint="Tap Make the next 10 and Mia starts the batch." />}
      </div>
      {acts.length > 0 && <ActionList actions={acts} view={view} />}
      <ConfirmSheet confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function ActionList({ actions, view }) {
  return (
    <div className="glass-soft rounded-xl3 p-3" data-actions>
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink3">Requests to Mia</div>
      {actions.map((a) => (
        <div key={a.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 text-[12.5px]">
          <ActionStatus status={a.status} />
          <span className="min-w-0 flex-1 truncate text-ink2">{describe(a, view.byKey.get(a.channel)?.name)}</span>
          <span className="flex-none text-[11px] text-ink3">{fmtAgo(a.updated_at || a.at)}</span>
        </div>
      ))}
    </div>
  );
}

function ActionStatus({ status }) {
  const map = { queued: ['Queued', 'bg-white/[0.08] text-ink2', 'clock'], seen: ['Seen', 'bg-white/[0.08] text-ink2', 'watch'], done: ['Done', 'bg-accent/15 text-accent', 'check'], failed: ['Failed', 'bg-crit/15 text-crit', 'alert'] };
  const [label, cls, ic] = map[status] || map.queued;
  return (
    <motion.span layout key={status} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.snappy}
      className={`pill inline-flex h-6 flex-none items-center gap-1 px-2 text-[11px] font-semibold ${cls}`} data-status={status}>
      <Icon name={ic} size={11} />{label}
    </motion.span>
  );
}

function ActionButton({ a, c, children, icon, variant = 'secondary', confirm, onConfirm, size = 'sm', extra }) {
  const busy = useActionBusy(a);
  const run = () => channelAction({ ...a, ...(extra || {}) }, c?.name);
  return (
    <Button size={size} variant={variant} icon={icon} loading={busy} data-action={a.action}
      onClick={() => (confirm ? onConfirm({ ...confirm, run }) : run())}>
      {children}
    </Button>
  );
}

function ConfirmSheet({ confirm, onClose }) {
  return (
    <Sheet open={!!confirm} onClose={onClose} title={confirm?.title} size="sm"
      footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={confirm?.danger ? 'warn' : 'accent'} data-confirm onClick={() => { confirm.run(); onClose(); }}>{confirm?.cta || 'Confirm'}</Button></div>}>
      <p className="text-[13.5px] leading-relaxed text-ink2">{confirm?.body}</p>
    </Sheet>
  );
}

// ---- video sheet: player, checkpoints, numbers, controls -----------------------------------------------------------------
function slotOptions(c) {
  const out = [];
  const now = new Date();
  const sast = (d, h, m) => {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 2, m));
    return s;
  };
  const hours = c.key === RI ? [[19, 30]] : [[13, 0], [17, 0], [21, 0]];
  for (let day = 0; day < 4 && out.length < 6; day += 1) {
    const d = new Date(now.getTime() + day * 864e5);
    for (const [h, m] of hours) {
      const t = sast(d, h, m);
      if (t > now) out.push(t);
    }
  }
  return out.slice(0, 6).map((t) => ({ iso: `${t.toISOString().slice(0, 16)}Z`, label: fmtTime(t.toISOString()) }));
}

function VideoSheet({ view, id, onClose }) {
  const v = id ? view.video(id) : null;
  const c = v ? view.byKey.get(v.channel) : null;
  const [mode, setMode] = useState(null); // reject | schedule | title | publish
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [slot, setSlot] = useState('');
  const acts = v ? (view.actions || []).filter((a) => a.video === v.id) : [];
  const base = v ? { channel: v.channel, video: v.id, label: v.title } : {};
  const close = () => { setMode(null); setNote(''); setTitle(''); setSlot(''); onClose(); };
  const send = async (a) => { const ok = await channelAction({ ...base, ...a }, c?.name); if (ok) setMode(null); };
  const slots = c ? slotOptions(c) : [];
  return (
    <Sheet open={!!v} onClose={close} title={v ? (v.kind === 'short' ? 'Short' : 'Video') : ''} size="lg">
      {v && (
        <div className="flex flex-col gap-4" data-video-sheet={v.id}>
          <div className={`grid gap-4 ${v.kind === 'short' ? 'sm:grid-cols-[minmax(0,240px)_1fr]' : ''}`}>
            <RelayVideo media={v.video} vertical={v.kind === 'short'}
              poster={v.kind === 'short' && v.video ? { media: v.video, size: 'poster' } : v.thumbnail ? { media: v.thumbnail, size: 'thumb' } : null} />
            <div className="flex min-w-0 flex-col gap-3">
              <div>
                <div className="text-[12px] text-ink3">{c?.name}{v.duration ? ` · ${Math.round(v.duration)} s` : ''}{v.language ? ` · ${v.language}` : ''}</div>
                <div className="text-[18px] font-semibold leading-snug tracking-tight text-ink">{v.live_title || v.title}</div>
              </div>
              <div className="pt-4"><CheckpointBar checkpoints={v.checkpoints} /></div>
              <div className="rounded-xl bg-white/[0.04] px-3 py-2.5 text-[13px]"><span className="text-ink3">Next: </span><span className="font-medium text-ink">{cap(v.next_step)}</span></div>
              {v.stats?.views != null && (
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Views" value={<Counter value={v.stats.views} format={fmtNum} />} sub={v.published_at ? `public ${fmtAgo(v.published_at)}` : ''} />
                  <Stat label="Likes" value={<Counter value={v.stats.likes ?? 0} />} />
                  <Stat label="Comments" value={<Counter value={v.stats.comments ?? 0} />} />
                </div>
              )}
              {(v.series || []).length > 1 && <AreaChart points={v.series.map(([t, n]) => [t, n])} height={110} label="Views over time" fmtX={(t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} />}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className={`pill inline-flex h-6 items-center gap-1 px-2.5 font-semibold ${v.qa?.status === 'fail' ? 'bg-crit/15 text-crit' : v.qa?.status === 'warn' ? 'bg-warn/15 text-warn' : v.qa?.status === 'pass' ? 'bg-accent/15 text-accent' : 'bg-white/[0.08] text-ink2'}`}>
              <Icon name="shield" size={12} />{v.qa?.label}
            </span>
            {v.upload?.url && <a href={v.upload.url} target="_blank" rel="noopener" className="pill inline-flex h-6 items-center gap-1 bg-white/[0.08] px-2.5 text-ink2 hover:text-ink"><Icon name="external" size={12} />YouTube</a>}
            {v.scheduled_at && <span className="text-ink3">Scheduled {fmtTime(v.scheduled_at)}</span>}
            {v.visibility_mismatch && <span className="text-warn">{v.visibility_mismatch}</span>}
          </div>
          {(v.qa?.detail || []).length > 0 && <ul className="list-disc pl-5 text-[12px] leading-relaxed text-ink3">{v.qa.detail.slice(0, 4).map((d) => <li key={d}>{d}</li>)}</ul>}

          <div className="glass-soft rounded-xl3 p-3" data-controls>
            <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink3">
              Controls <span className="font-normal normal-case tracking-normal">· each one is a request to Mia; nothing goes to YouTube from here</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton a={{ action: 'approve', ...base }} c={c} icon="check" variant="accent">Approve</ActionButton>
              <Button size="sm" icon="ban" onClick={() => setMode(mode === 'reject' ? null : 'reject')} data-action="reject">Reject</Button>
              <Button size="sm" icon="clock" onClick={() => setMode(mode === 'schedule' ? null : 'schedule')} data-action="schedule">Schedule</Button>
              <Button size="sm" icon="upload" variant="warn" onClick={() => setMode('publish')} data-action="publish_now">Publish now</Button>
              <ActionButton a={{ action: 'regen_thumbnail', ...base }} c={c} icon="refresh">Regenerate thumbnail</ActionButton>
              <Button size="sm" icon="edit" onClick={() => { setTitle(v.live_title || v.title); setMode(mode === 'title' ? null : 'title'); }} data-action="change_title">Change title</Button>
            </div>
            <AnimatePresence initial={false}>
              {mode === 'reject' && (
                <Expand key="reject">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What's wrong? Mia fixes it or drops it." data-reject-note
                    className="w-full rounded-xl border border-glass-line bg-white/[0.04] px-3 py-2 text-[13px] text-ink outline-none focus:border-glass-line2" />
                  <div className="mt-2 flex justify-end"><Button size="sm" variant="warn" disabled={!note.trim()} onClick={() => send({ action: 'reject', note: note.trim() })} data-send-reject>Send reject</Button></div>
                </Expand>
              )}
              {mode === 'schedule' && (
                <Expand key="schedule">
                  <div className="mb-2 text-[12px] text-ink3">{c?.key === RI ? 'Raw Incident publishes at 19:30 SAST.' : `US daytime, spaced out (${c?.numbers?.cadence?.window_sast || '12:00–04:00'} SAST).`}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {slots.map((s) => (
                      <button key={s.iso} onClick={() => setSlot(s.iso)} data-slot={s.iso}
                        className={`pill h-8 px-3 text-[12.5px] transition-colors ${slot === s.iso ? 'bg-ink text-bg' : 'glass-soft text-ink2 hover:text-ink'}`}>{s.label}</button>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end"><Button size="sm" variant="accent" disabled={!slot} onClick={() => send({ action: 'schedule', slot })} data-send-schedule>Ask Mia to schedule</Button></div>
                </Expand>
              )}
              {mode === 'title' && (
                <Expand key="title">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} data-title-input
                    className="h-10 w-full rounded-xl border border-glass-line bg-white/[0.04] px-3 text-[13.5px] text-ink outline-none focus:border-glass-line2" />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-ink3"><span>{title.length}/100</span>
                    <Button size="sm" variant="accent" disabled={!title.trim() || title.trim() === v.title} onClick={() => send({ action: 'change_title', title: title.trim() })} data-send-title>Ask Mia to retitle</Button></div>
                </Expand>
              )}
            </AnimatePresence>
          </div>
          {acts.length > 0 && <ActionList actions={acts} view={view} />}
          <Sheet open={mode === 'publish'} onClose={() => setMode(null)} title="Publish now?" size="sm"
            footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              <Button variant="warn" icon="upload" data-confirm onClick={() => send({ action: 'publish_now', confirmed: true })}>Ask Mia to publish</Button></div>}>
            <p className="text-[13.5px] leading-relaxed text-ink2">
              “{v.live_title || v.title}” goes public on {c?.name} as soon as Mia picks this up. That can't be taken back quietly: viewers and YouTube see it at once.
              {c?.key === RI ? ' One long video a day, at least 20 h apart: Mia checks before she does it.' : ''}
            </p>
          </Sheet>
        </div>
      )}
    </Sheet>
  );
}

function Expand({ children }) {
  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
      <div className="pt-3">{children}</div>
    </motion.div>
  );
}

// ---- analytics ------------------------------------------------------------------------------------------------------
function Analytics({ view, onVideo }) {
  const rows = (view.stats || []).filter((s) => !s.empty);
  const [key, setKey] = useState(rows.find((s) => s.active)?.channel || rows[0]?.channel);
  const s = rows.find((x) => x.channel === key);
  const a = view.across || {};
  const day = (d) => new Date(`${d}T12:00:00+02:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <div className="flex flex-col gap-4" data-analytics>
      <div className="glass rounded-xl3 grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="All channels · 7 days" value={<Counter value={a.total?.views_7d ?? 0} format={fmtNum} />} sub="views" />
        <Stat label="28 days" value={<Counter value={a.total?.views_28d ?? 0} format={fmtNum} />} sub="views" />
        <Stat label="Lifetime" value={<Counter value={a.total?.lifetime ?? 0} format={fmtNum} />} sub="public views" />
        <Stat label="Double down on" value={<span className="text-[17px]">{a.double_down?.name || '—'}</span>} sub={a.double_down ? `${fmtNum(a.double_down.median_7d)} median / Short, 7 d` : a.rule} />
      </div>
      {rows.length > 1 && <Segmented value={key} onChange={setKey} options={rows.map((r) => ({ value: r.channel, label: r.name }))} />}
      {!s ? <EmptyState icon="overview" title="No public numbers yet" hint="Analytics start with a channel's first public video." /> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Views per day" sub="Last 28 days, all videos">
              <AreaChart points={s.daily} label={`Views per day, ${s.name}`} fmtX={day} />
            </Card>
            <Card title="Views per Short" sub="Oldest to newest; tap a bar">
              <Bars items={(s.shorts?.per_short || []).map((r) => ({ id: r.id, value: r.views, label: r.title }))} label={`Views per Short, ${s.name}`} onPick={(x) => onVideo(x.id)} />
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <Card title="Top 5 Shorts" sub="By public views">
              <div className="flex flex-col">
                {(s.shorts?.top5 || []).map((r, i) => (
                  <button key={r.id} onClick={() => onVideo(r.id)} className="flex items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-white/[0.04]" data-top={i + 1}>
                    <span className="tnum w-5 text-center text-[13px] font-semibold text-ink3">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{r.title}</span>
                    <span className="tnum text-[13px] font-semibold text-ink">{fmtNum(r.views)}</span>
                  </button>
                ))}
                {!(s.shorts?.top5 || []).length && <p className="py-4 text-[12.5px] text-ink3">No public Shorts yet.</p>}
              </div>
            </Card>
            <Card title="First 24 hours" sub="Views a Short had 24 h after going public">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Latest 5, average" value={fmtNum(s.shorts?.first24_recent_avg)} />
                <Stat label="Channel median" value={fmtNum(s.shorts?.first24_median)} sub={`${s.shorts?.first24_count || 0} Shorts measured`} />
              </div>
              <FirstDayVerdict sh={s.shorts} />
              <div className="mt-4"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink3">Subscribers over time</div>
                {(s.shorts?.subs || []).length > 1 ? <AreaChart points={s.shorts.subs} height={90} label="Subscribers" fmtX={(t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} />
                  : <div className="text-[12.5px] text-ink2">{(s.shorts?.subs || [])[0] ? `${fmtNum(s.shorts.subs[0][1])} today; the curve builds every 45 minutes.` : 'Not public yet.'}</div>}
              </div>
            </Card>
          </div>
          {s.channel === RI && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Shorts vs long-form" sub="Lifetime public views">
                <SplitBar split={s.split} />
              </Card>
              <Card title="Retitles and thumbnail swaps" sub="Public views per hour, 48 h before vs after">
                <div className="flex flex-col gap-2">
                  {(s.changes || []).slice(0, 5).map((x) => {
                    const pct = x.before_vph && x.after_vph != null ? Math.round(((x.after_vph - x.before_vph) / x.before_vph) * 100) : null;
                    return (
                      <div key={`${x.video}${x.at}${x.kind}`} className="rounded-lg bg-white/[0.035] p-2.5 text-[12.5px]">
                        <div className="text-ink3">{x.kind === 'title' ? 'Retitle' : 'New thumbnail'} · {fmtTime(x.at)}</div>
                        {x.kind === 'title' ? <><div className="truncate text-ink3 line-through">{x.old}</div><div className="truncate font-medium text-ink">{x.new}</div></> : <div className="truncate font-medium text-ink">{x.title}</div>}
                        <div className="tnum mt-1 text-ink2">{x.was_public === false ? 'Changed before it went public' : `${x.before_vph ?? '—'} → ${x.after_vph ?? '—'} views/h`}
                          {pct != null && <span className={`ml-2 font-semibold ${pct >= 0 ? 'text-accent' : 'text-crit'}`}>{pct >= 0 ? '+' : ''}{pct}%</span>}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          )}
        </>
      )}
      <div className="text-center text-[11px] text-ink3">Public stats only (yt-dlp, no login){view.stats_status?.last_snapshot ? `, updated ${fmtTime(view.stats_status.last_snapshot)}` : ''}. Studio-only numbers come later.</div>
    </div>
  );
}

function FirstDayVerdict({ sh }) {
  const avg = sh?.first24_recent_avg, med = sh?.first24_median, n = sh?.first24_count || 0;
  if (avg == null || !med || n < 4) {
    return <div className="mt-3 text-[12px] text-ink3">Too few Shorts measured to compare yet (needs 4 that have been public a day).</div>;
  }
  const d = (avg - med) / med;
  if (Math.abs(d) < 0.1) return <div className="mt-3 text-[12.5px] text-ink2">Recent Shorts start about as usual.</div>;
  return <div className={`mt-3 text-[12.5px] ${d > 0 ? 'text-accent' : 'text-warn'}`}>Recent Shorts start {Math.round(Math.abs(d) * 100)}% {d > 0 ? 'stronger' : 'weaker'} than usual.</div>;
}

function SplitBar({ split }) {
  const L = split?.long?.views || 0, S = split?.short?.views || 0, t = L + S || 1;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Long-form" value={fmtNum(L)} sub={`${split?.long?.count || 0} videos · ${fmtNum(split?.long?.avg)} avg`} />
        <Stat label="Shorts" value={fmtNum(S)} sub={`${split?.short?.count || 0} Shorts · ${fmtNum(split?.short?.avg)} avg`} />
      </div>
      <div className="mt-3 flex h-3 gap-[2px] overflow-hidden rounded-md" role="img" aria-label={`Long-form ${Math.round((L / t) * 100)}%, Shorts ${Math.round((S / t) * 100)}%`}>
        <motion.span className="h-full" style={{ background: 'var(--color-s1)' }} initial={{ flexGrow: 0 }} animate={{ flexGrow: L || 0.001 }} transition={spring.gentle} />
        <motion.span className="h-full" style={{ background: 'var(--color-s3)' }} initial={{ flexGrow: 0 }} animate={{ flexGrow: S || 0.001 }} transition={spring.gentle} />
      </div>
      <div className="mt-2 flex gap-4 text-[11.5px] text-ink3">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--color-s1)' }} />Long-form {Math.round((L / t) * 100)}%</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--color-s3)' }} />Shorts {Math.round((S / t) * 100)}%</span>
      </div>
    </div>
  );
}

function Card({ title, sub, children }) {
  return (
    <motion.div {...fadeUp} className="glass rounded-xl3 min-w-0 p-4">
      <div className="mb-3"><div className="text-[14px] font-semibold tracking-tight text-ink">{title}</div>{sub && <div className="text-[11.5px] text-ink3">{sub}</div>}</div>
      {children}
    </motion.div>
  );
}

// ---- the view ---------------------------------------------------------------------------------------------------------
// `embedded`: HQ's Channels section (task 0290) — HQ owns the title and the
// close button, so only the tabs and the sync chip remain here.
export default function Channels({ onClose, channelKey, onChannel, embedded = false }) {
  useChannelsSync();
  const view = useChannelsView();
  const error = useChannels((s) => s.error);
  const [tab, setTab] = useState('channels');
  const [videoId, setVideoId] = useState(null);
  const ch = channelKey && view ? view.byKey.get(channelKey) : null;
  const body = useMemo(() => {
    if (!view) return null;
    if (ch) return <ChannelPage view={view} c={ch} onBack={() => onChannel(null)} onVideo={setVideoId} />;
    if (tab === 'pipeline') return <Pipeline view={view} onVideo={setVideoId} />;
    if (tab === 'analytics') return <Analytics view={view} onVideo={setVideoId} />;
    return <Overview view={view} onOpen={onChannel} onVideo={setVideoId} />;
  }, [view, ch, tab, onChannel]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-view="channels">
      {embedded ? (
        <div className="flex flex-none items-center gap-2 px-4 pb-3 sm:px-5">
          {!ch && <Segmented value={tab} onChange={setTab} options={TABS.map((t) => (t.value === 'channels' ? { ...t, label: 'Overview' } : t))} />}
          <div className="min-w-0 flex-1 truncate"><SyncChip view={view} /></div>
        </div>
      ) : (
        <>
          <div className="flex flex-none items-center gap-2 px-4 pb-3 pt-4 sm:px-5">
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Channels</h1>
            <div className="min-w-0 flex-1"><SyncChip view={view} /></div>
            <IconButton icon="close" label="Close Channels" size="sm" variant="glass" onClick={onClose} />
          </div>
          {!ch && (
            <div className="flex-none px-4 pb-3 sm:px-5"><Segmented value={tab} onChange={setTab} options={TABS} /></div>
          )}
        </>
      )}
      <div className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-28 sm:px-5">
        {view ? <AnimatePresence mode="wait"><motion.div key={ch ? ch.key : tab} {...fadeUp}>{body}</motion.div></AnimatePresence> : (
          error ? <EmptyState icon="alert" title="Channels isn't reachable" hint={`${error}. Channels HQ on the Mac pushes here once its relay sync is on.`} action={<Button size="sm" icon="retry" onClick={() => refreshChannels()}>Try again</Button>} />
            : <div className="grid place-items-center py-20"><Spinner size={20} /></div>
        )}
      </div>
      {view && <VideoSheet view={view} id={videoId} onClose={() => setVideoId(null)} />}
    </div>
  );
}
