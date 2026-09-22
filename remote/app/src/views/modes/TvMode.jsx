import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  useMC,
  counts,
  agentStatus,
  statusLabel,
  agentName,
  attentionList,
  groupFleets,
  fmtTokens,
  fmtInt,
  clockOf,
} from '../../lib/store.js';
import { useAgents, useLink, useNow, useWakeLock } from '../../lib/hooks.js';
import { TONE } from '../../lib/tone.js';
import ModeBackdrop from './ModeBackdrop.jsx';

// TV mode — the ambient wall display. Opened via #tv (Settings → TV mode, or
// just append #tv to the URL on the TV's browser). It is the Home scene with
// the volume turned down: a thin clock, ONE honest sentence about the fleet,
// a constellation of agent chips, and a whisper of recent activity. No
// controls, no cursor, no chrome — a room presence, not a workstation.
//
// Sizing: the root sets font-size from vw and EVERYTHING inside is em-based,
// so the composition holds from a 1080p TV to a 4K panel.
//
// The backdrop is a photograph now, so legibility is the whole job: an extra
// scrim sits between the photo and the type, and every figure is white or a
// status colour — nothing mid-grey on top of a mid-grey forest.

const MAX_CHIPS = 12;

// One sentence about the fleet, in the order a human would ask: is the Mac
// there → does anyone need me → is anything running → what happened.
function fleetSentence({ link, agents, items, c }) {
  if (link === 'offline') return 'Reconnecting to the relay';
  if (link === 'relay') return 'Your Mac is offline';
  if (items.length === 1) {
    const it = items[0];
    return it.kind === 'exited'
      ? `${agentName(it.agent)} exited unexpectedly`
      : `${agentName(it.agent)} is asking a question`;
  }
  if (items.length > 1) {
    return c.working
      ? `${c.working} working · ${items.length} need you`
      : `${items.length} agents need you`;
  }
  if (c.working) return `${c.working} agent${c.working === 1 ? '' : 's'} working · nothing waiting`;
  if (!agents.length) return 'No agents running';
  return `All quiet — ${c.done} finished, nothing waiting`;
}

// A single agent, as small as it can be and still say everything: what state,
// who, what it is doing, how fast, how far.
function AgentChip({ a, waiting }) {
  const st = agentStatus(a);
  const todos = a.todos || [];
  const done = todos.filter((t) => t.status === 'completed').length;
  const pct = todos.length ? (100 * done) / todos.length : 0;
  const tps = Math.round(a.tokensPerSec ?? 0);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={
        waiting
          ? { opacity: 1, y: 0, borderColor: ['rgba(240,180,41,.30)', 'rgba(240,180,41,.75)', 'rgba(240,180,41,.30)'] }
          : { opacity: 1, y: 0 }
      }
      exit={{ opacity: 0, y: -4 }}
      transition={
        waiting
          ? { borderColor: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }, default: { duration: 0.4 } }
          : { duration: 0.4 }
      }
      className={`relative w-[15em] overflow-hidden rounded-[0.85em] border px-[1.05em] pt-[0.85em] pb-[0.9em] ${
        waiting ? 'border-warn/45 bg-warn/[0.08]' : 'border-glass-line bg-black/35'
      }`}
    >
      <div className="flex items-center gap-[0.6em]">
        <span className="relative flex h-[0.5em] w-[0.5em] flex-none">
          {st === 'working' && (
            <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" />
          )}
          <span className={`relative inline-flex h-[0.5em] w-[0.5em] rounded-full ${TONE[st].dot}`} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.95em] font-semibold tracking-tight text-white">
          {agentName(a)}
        </span>
        {tps > 0 ? (
          <span className="tnum flex-none font-mono text-[0.6em] text-accent">{fmtInt(tps)} t/s</span>
        ) : (
          <span className={`flex-none text-[0.6em] font-medium ${TONE[st].text}`}>{statusLabel(st)}</span>
        )}
      </div>
      <div className={`mt-[0.35em] truncate text-[0.7em] ${waiting ? 'text-warn/90' : 'text-white/55'}`}>
        {st === 'exited' ? 'Process exited' : a.activity || '—'}
      </div>
      {/* the 2px thread of progress — the only chrome a chip gets */}
      <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/10">
        <motion.div
          className={`h-full ${st === 'waiting' ? 'bg-warn' : 'bg-accent'}`}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </div>
    </motion.div>
  );
}

export default function TvMode({ onClose }) {
  const agents = useAgents();
  const screens = useMC((s) => s.screens);
  const summary = useMC((s) => s.summary);
  const fleets = useMC((s) => s.fleets);
  const activity = useMC((s) => s.activity);
  const link = useLink();
  const now = useNow();
  const reduce = useReducedMotion();

  const c = useMemo(() => counts(agents), [agents]);
  const items = useMemo(() => attentionList(agents), [agents, screens]);
  const sentence = fleetSentence({ link, agents, items, c });

  // ---- clock ----
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dateLine = d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });

  const linkInfo =
    link === 'linked'
      ? { word: 'Live', cls: 'text-white/70', dot: 'bg-ok' }
      : link === 'relay'
        ? { word: 'Mac offline', cls: 'text-warn', dot: 'bg-warn' }
        : { word: 'Reconnecting', cls: 'text-crit', dot: 'bg-crit' };

  // ---- the constellation: fleets cluster, solos float ----
  // Needs-you first, then working — a big fleet still has to fit one wall.
  const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };
  const { groups, solo, overflow } = useMemo(() => {
    const sorted = [...agents].sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9));
    const shown = sorted.slice(0, MAX_CHIPS);
    const g = groupFleets(shown, fleets);
    return {
      groups: g.groups.filter((x) => (x.manager ? 1 : 0) + x.workers.length >= 2),
      solo: [...g.solo, ...g.groups.filter((x) => (x.manager ? 1 : 0) + x.workers.length < 2).flatMap((x) => (x.manager ? [x.manager, ...x.workers] : x.workers))],
      overflow: Math.max(0, sorted.length - shown.length),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, fleets]);

  const recent = useMemo(() => [...activity].slice(-4).reverse(), [activity]);

  // ---- controls: hidden until the pointer moves; the cursor sleeps with them ----
  const [showUi, setShowUi] = useState(false);
  const hideTimer = useRef(null);
  function poke() {
    setShowUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowUi(false), 3200);
  }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  // Keep the TV awake while the display is up — best effort, Safari may decline.
  useWakeLock(true);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(hideTimer.current);
    };
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-[75] overflow-hidden ${showUi ? '' : 'cursor-none [&_*]:cursor-none'}`}
      onPointerMove={poke}
      role="presentation"
    >
      {/* The photo, on its own opaque base — a takeover shows nothing of the
          app underneath. Then a legibility layer: the picture is beautiful and
          completely unhelpful behind 60px of thin white type, so the wall gets
          an extra scrim, darkest where the headline sits. */}
      <ModeBackdrop extra={0.12} />
      <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_45%,rgba(0,0,0,.6),transparent_75%)]" />
      <div className="absolute inset-x-0 top-0 h-[24%] bg-gradient-to-b from-black/55 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[26%] bg-gradient-to-t from-black/60 to-transparent" />

      {/* everything scales off this font-size; the slow orbit guards OLEDs */}
      <motion.div
        animate={reduce ? undefined : { x: [0, 5, -4, -5, 0], y: [0, -4, 5, -5, 0] }}
        transition={reduce ? undefined : { duration: 480, repeat: Infinity, ease: 'easeInOut' }}
        className="relative flex h-full flex-col"
        style={{ fontSize: 'clamp(11px, 1.05vw, 30px)' }}
      >
        {/* ---- header: clock left, link right ------------------------------- */}
        {/* Everything lives on the left: the top-right corner is reserved for
            the pointer-revealed ✕/⛶, which must never land on live text. */}
        <header className="flex-none px-[3.2em] pt-[2.4em]">
          <div className="text-[0.85em] font-medium tracking-tight text-white/65">{dateLine}</div>
          <div className="tnum mt-[0.25em] text-[3.9em] font-light leading-none tracking-tight text-white">{hm}</div>
          <div className={`mt-[0.7em] flex items-center gap-[0.55em] text-[0.75em] font-medium ${linkInfo.cls}`}>
            <span className="relative flex h-[0.45em] w-[0.45em]">
              {link !== 'linked' && (
                <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${linkInfo.dot} opacity-60`} />
              )}
              <span className={`relative inline-flex h-[0.45em] w-[0.45em] rounded-full ${linkInfo.dot}`} />
            </span>
            {linkInfo.word}
          </div>
        </header>

        {/* ---- centre: the sentence, then the constellation ----------------- */}
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[2.2em] px-[3.2em] py-[1.2em]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={sentence}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
              className={`max-w-[26em] text-center text-[2.9em] font-semibold leading-[1.1] tracking-tight ${
                items.length ? 'text-warn' : 'text-white'
              }`}
            >
              {sentence}
            </motion.h1>
          </AnimatePresence>

          {(groups.length > 0 || solo.length > 0) && (
            <div className="flex max-w-[76em] flex-wrap items-start justify-center gap-[1.1em]">
              {groups.map((g) => {
                const members = g.manager ? [g.manager, ...g.workers] : g.workers;
                return (
                  <div
                    key={g.id}
                    className="rounded-[1.1em] border border-mgr/30 px-[0.8em] pb-[0.8em] pt-[0.55em]"
                  >
                    <div className="mb-[0.55em] flex items-center gap-[0.5em] px-[0.2em]">
                      <span className="h-[0.32em] w-[0.32em] rounded-full bg-mgr" />
                      <span className="truncate text-[0.68em] font-medium tracking-tight text-mgr">
                        {g.fleet?.title || g.fleet?.name || g.fleet?.mission || 'Fleet'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-[0.7em]">
                      {members.map((a) => (
                        <AgentChip key={a.id} a={a} waiting={agentStatus(a) === 'waiting'} />
                      ))}
                    </div>
                  </div>
                );
              })}
              {solo.map((a) => (
                <AgentChip key={a.id} a={a} waiting={agentStatus(a) === 'waiting'} />
              ))}
              {overflow > 0 && (
                <div className="grid w-[8em] place-items-center rounded-[0.85em] border border-glass-line px-[1em] py-[1.1em] text-[0.72em] text-white/55">
                  +{overflow} more
                </div>
              )}
            </div>
          )}
        </main>

        {/* ---- footer: whispers left, figures right ------------------------- */}
        <footer className="flex flex-none items-end justify-between gap-[3em] px-[3.2em] pb-[2.2em]">
          <div className="min-w-0 flex-1">
            {recent.length > 0 && (
              <div className="space-y-[0.5em]">
                {recent.map((r, i) => (
                  <div
                    key={`${r.t}-${r.id}-${i}`}
                    className="truncate font-mono text-[0.64em] text-white/60"
                    style={{ opacity: 1 - i * 0.22 }}
                  >
                    <span className="text-white/35">{clockOf(r.t).slice(0, 5)}</span>{' '}
                    <span className="text-white/80">{r.who}</span> <span className="text-white/30">·</span> {r.text}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="tnum flex flex-none items-baseline gap-[2.4em] font-mono text-[0.68em] text-white/55">
            <span>
              <span className="text-white/85">{fmtInt(Math.round(summary.tokensPerSec ?? 0))}</span> tok/s
            </span>
            <span>
              <span className="text-white/85">${(summary.totalCost ?? 0).toFixed(2)}</span> spent
            </span>
            <span>
              <span className="text-white/85">{fmtTokens(summary.totalTokens ?? 0)}</span> tokens
            </span>
            <span>
              <span className="text-white/85">{c.working}</span>/{agents.length} working
            </span>
          </div>
        </footer>
      </motion.div>

      {/* pointer-revealed controls */}
      <div
        className={`absolute right-5 top-5 z-10 flex gap-2 transition-opacity duration-500 ${
          showUi ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <button
          onClick={fullscreen}
          aria-label="Toggle fullscreen"
          className="grid h-11 w-11 place-items-center rounded-full border border-glass-line bg-white/[0.08] text-[18px] text-white/70 backdrop-blur-xl transition-colors hover:text-white"
        >
          ⛶
        </button>
        <button
          onClick={onClose}
          aria-label="Exit TV mode"
          className="grid h-11 w-11 place-items-center rounded-full border border-glass-line bg-white/[0.08] text-[18px] text-white/70 backdrop-blur-xl transition-colors hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
