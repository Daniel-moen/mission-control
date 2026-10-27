import { useEffect, useRef } from 'react';
import { animate, motion, motionValue, useTransform, LayoutGroup } from 'motion/react';
import { useMC, miaOpenQuestions, agentStatus, isMiaAgent, reconnectNow } from '../src/lib/store.js';
import { useNav, goView, push, openSheet } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring, tap } from '../v2/lib/motion.js';
import { Icon } from '../v2/ui/kit.jsx';
import { setSide, toggleSide, endPeek, openPalette, paneOpenOf } from './state.js';

// The side panel (task 0491). Daniel asked for it in so many words — "a side
// panel that accesses the other things" — but not a grey nav column: it is
// a floating pane of glass that slides in over (iPhone) or beside (iPad
// landscape) the chat. Swipe in from the left edge, the button in the chat's
// header, or ⌘\ on a keyboard. It follows the finger both ways (drag it shut,
// rubber-bands past open), and every spring keeps the velocity it was let go
// with — interruptible at any point.
//
// What's in it: the chat itself, then Home, Tasks, Fleet, Library, HQ,
// Insights and Settings — each opens in the pane next to the chat, the chat
// stays alive. Search (⌘K) and Launch at the foot.

export const sideX = motionValue(-400); // the panel's offset; 0 = open
export const SIDE_GAP = 12;

// Over the chat: Insights, HQ, Settings and Tasks are pages stacked on the
// chat (Back/close returns to it). Home, Fleet and Library are places with
// their own stacks (a doc you opened is still there next time).
export function place(key) {
  if (key === 'chat' || key === 'mia') return goView('mia');
  if (key === 'home' || key === 'fleet' || key === 'library') return goView(key);
  goView('mia');
  if (key === 'channels') return push('hq', { section: 'channels' });
  return push(key, {});
}

// Which item is lit: where the pane is (or the chat, when it's closed).
export function activeOf(s) {
  if (!paneOpenOf(s)) return 'chat';
  if (s.tab === 'agents') return 'fleet';
  if (s.tab === 'library') return 'library';
  if (s.tab === 'home') return 'home';
  const n = s.stacks.mia[1]?.name;
  return { hq: 'hq', insights: 'insights', settings: 'settings', tasks: 'tasks', task: 'tasks', doc: 'library', agent: 'fleet' }[n] || 'chat';
}

const ITEMS = [
  { key: 'chat', label: 'Chat with Mia', icon: 'mia' },
  { key: 'home', label: 'Home', icon: 'sparkles' },
  { key: 'tasks', label: 'Tasks', icon: 'tasks' },
  { key: 'fleet', label: 'Fleet', icon: 'agents' },
  { key: 'library', label: 'Library', icon: 'library' },
  { key: 'hq', label: 'HQ', icon: 'hq' },
  { key: 'insights', label: 'Insights', icon: 'gauge' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

const LINK = { linked: ['bg-accent', 'Live'], relay: ['bg-warn', 'Mac offline'], offline: ['bg-ink3', 'Reconnecting…'] };

export default function Side({ width, shown, pinned, wide }) {
  const reduce = usePrefs((s) => s.reduce);
  const active = useNav(activeOf);
  const link = useMC((s) => s.link);
  const now = useMC((s) => s.now);
  const qs = useMC((s) => miaOpenQuestions(s.mia, s.miaLocal).length);
  const live = useMC((s) => (s.mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length);
  const waiting = useMC((s) => s.agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a)).length);
  const working = useMC((s) => s.agents.filter((a) => agentStatus(a) === 'working' && !isMiaAgent(a)).length);
  const box = useRef(null);
  const closed = -(width + SIDE_GAP + 24);
  const scrim = useTransform(sideX, [closed, 0], [0, 1]);
  const badges = { chat: qs ? [qs, 'warn'] : null, tasks: live ? [live, 'accent'] : null, fleet: waiting ? [waiting, 'warn'] : working ? [working, 'accent'] : null };

  // open / close on a spring that keeps the finger's velocity
  useEffect(() => {
    const el = box.current;
    el?.setAttribute('data-lens-off', '');
    const a = animate(sideX, shown ? 0 : closed, reduce ? { duration: 0.18 } : { ...spring.sheet, velocity: sideX.getVelocity() });
    a.then(() => {
      // shader glass only when it's still and pinned beside the chat (nothing scrolls under it)
      if (pinned && shown) el?.removeAttribute('data-lens-off');
    });
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, closed, reduce, pinned]);

  const go = (key) => {
    if (!wide) setSide(false, { remember: false });
    else if (!pinned) endPeek();
    place(key);
  };
  const L = LINK[link] || LINK.offline;
  const d = new Date(now || Date.now());

  return (
    <>
      {!pinned && (
        <motion.div className="fixed inset-0 z-[60] bg-black/30" style={{ opacity: scrim, pointerEvents: shown ? 'auto' : 'none' }} onClick={() => setSide(false, { remember: false })} data-side-scrim aria-hidden="true" />
      )}
      <motion.aside
        ref={box}
        className="v52-side fixed z-[61] flex flex-col"
        style={{ x: sideX, width, left: SIDE_GAP, top: `calc(env(safe-area-inset-top) + ${SIDE_GAP}px)`, bottom: SIDE_GAP }}
        drag="x"
        dragConstraints={{ left: closed, right: 0 }}
        dragElastic={{ left: 0, right: 0.12 }}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          const shut = info.offset.x < -width * 0.3 || info.velocity.x < -500;
          if (shut) setSide(false, { remember: !!pinned });
          else animate(sideX, 0, { ...spring.sheet, velocity: info.velocity.x });
        }}
        aria-label="Mission Control"
        aria-hidden={shown ? undefined : 'true'}
        inert={shown ? undefined : true}
        data-lens={pinned ? '' : undefined}
        data-depth="0.5"
        data-side={shown ? (pinned ? 'pinned' : 'over') : 'closed'}
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-5">
          <div className="min-w-0 flex-1">
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-ink3">{d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</div>
            <div className="truncate text-[1.35rem] font-bold tracking-[-0.025em] text-ink">Mission Control</div>
          </div>
          <motion.button {...tap} onClick={() => setSide(false)} aria-label="Hide the side panel — ⌘\" title="Hide — ⌘\" className="grid h-9 w-9 flex-none place-items-center rounded-full text-ink2 hover:bg-fill hover:text-ink" data-side-close>
            <Icon name="paneLeftClose" size={18} />
          </motion.button>
        </div>
        <button onClick={() => link !== 'linked' && reconnectNow()} className="mx-5 mb-3 flex w-fit items-center gap-2 rounded-full bg-fill px-3 py-1 text-[0.74rem] font-semibold text-ink2" data-side-link={link}>
          <span className={`h-2 w-2 rounded-full ${L[0]} ${link === 'linked' ? '' : 'v-breathe'}`} />
          {L[1]}
        </button>
        <LayoutGroup id="v52-side">
          <nav className="v-scroll min-h-0 flex-1 px-2.5" aria-label="Places">
            {ITEMS.map((it, i) => {
              const on = active === it.key;
              const b = badges[it.key];
              return (
                <motion.button
                  {...tap}
                  key={it.key}
                  onClick={() => go(it.key)}
                  initial={false}
                  animate={shown && !reduce ? { opacity: 1, x: 0, transition: { ...spring.snappy, delay: 0.03 + i * 0.022 } } : { opacity: shown ? 1 : 0, x: shown || reduce ? 0 : -14 }}
                  aria-current={on ? 'page' : undefined}
                  className={`relative flex h-12 w-full items-center gap-3 rounded-[16px] px-2.5 text-left text-[0.98rem] font-semibold ${on ? 'text-ink' : 'text-ink2 hover:text-ink'} ${i === 0 ? 'mb-2' : ''}`}
                  data-side-item={it.key}
                >
                  {on && <motion.span layoutId="v52-side-pill" transition={spring.snappy} className="v52-side-pill absolute inset-0 rounded-[16px]" />}
                  <span className={`relative grid h-8 w-8 flex-none place-items-center rounded-[10px] ${on ? 'bg-accent text-accent-ink' : 'bg-fill'}`}>
                    <Icon name={it.icon} size={17} strokeWidth={on ? 2.2 : 1.9} />
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{it.label}</span>
                  {b && (
                    <span className={`v-num relative grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[0.68rem] font-bold ${b[1] === 'warn' ? 'bg-warn text-[#241a02]' : 'bg-accent/20 text-accent'}`} data-side-badge={it.key}>
                      {b[0] > 99 ? '99+' : b[0]}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </nav>
        </LayoutGroup>
        <div className="flex gap-2 p-3">
          <motion.button {...tap} onClick={() => (!wide && setSide(false, { remember: false }), openPalette())} className="v52-side-foot flex h-11 flex-1 items-center gap-2 rounded-full px-4 text-[0.86rem] font-semibold text-ink2" data-side-palette>
            <Icon name="search" size={16} />
            <span className="flex-1 text-left">Search</span>
            <span className="text-[0.72rem] text-ink3">⌘K</span>
          </motion.button>
          <motion.button {...tap} onClick={() => (!wide && setSide(false, { remember: false }), openSheet('launch'))} aria-label="Launch an agent" title="Launch an agent — ⌘L" className="v52-side-foot grid h-11 w-11 flex-none place-items-center rounded-full text-ink2" data-side-launch>
            <Icon name="launch" size={17} />
          </motion.button>
        </div>
      </motion.aside>
    </>
  );
}

// Swipe in from the left edge of the chat (iOS's edge pan): the panel follows
// the finger, rubber-bands past fully open, and opens or springs back on
// release by distance and speed. From the right edge: the pane you closed
// last comes back.
export function useEdgeSwipes({ width, onReopen }) {
  useEffect(() => {
    const EDGE = 24;
    const down = (e) => {
      if (e.button > 0 || e.pointerType === 'mouse') return;
      if (!e.target.closest?.('[data-v52-stage]') || e.target.closest('textarea, input, [data-msg-menu]')) return;
      const left = e.clientX < EDGE;
      const right = e.clientX > innerWidth - EDGE;
      if (!left && !right) return;
      if (left && document.querySelector('[data-side]')?.dataset.side !== 'closed') return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const closed = -(width + SIDE_GAP + 24);
      let on = false;
      let lastX = x0;
      let lastT = performance.now();
      let v = 0;
      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!on) {
          if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) return done();
          if (Math.abs(dx) < 10) return undefined;
          on = true;
        }
        const t = performance.now();
        v = ((ev.clientX - lastX) / Math.max(1, t - lastT)) * 1000;
        lastX = ev.clientX;
        lastT = t;
        if (left) {
          const raw = closed + dx;
          sideX.set(raw > 0 ? 40 * (1 - 1 / (raw / 40 + 1)) : raw);
        }
        return undefined;
      };
      const done = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        if (!on || !ev) return;
        const dx = ev.clientX - x0;
        if (left) {
          if (dx > width * 0.35 || v > 500) toggleSide(false);
          else animate(sideX, closed, { ...spring.sheet, velocity: v });
        } else if (dx < -60 || v < -500) onReopen?.();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [width, onReopen]);
}
