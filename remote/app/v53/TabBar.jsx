import { useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { MessageCircle, House, ListTodo, LayoutGrid, BookOpen, Search } from 'lucide-react';
import { useMC, miaOpenQuestions, agentStatus, isMiaAgent } from '../src/lib/store.js';
import { useNav, goView, push } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import { openPalette, paneOpenOf, setMini } from './state.js';

// The tab bar (task 0502). Daniel: "go back to bottom bar". iOS 26's Liquid
// Glass tab bar, on the web:
//   • one floating capsule of glass at the foot, drawn by the Lens shader:
//     its rim bends the photo and the moving light behind it, the edge facing
//     the light (tilt, pointer, scroll) catches it
//   • the search button is its own circle beside it, as on iOS 26
//   • the active tab sits on a soft pill. Press and the LENS lifts out of
//     the bar: a clear, magnifying drop of glass (a second shader pane, so it
//     really refracts) that follows the finger across the tabs and settles
//     into the one you let go on
//   • scroll into something and the bar minimises to its active icon; the
//     composer slides down beside it (the bottom accessory). Scroll back, or
//     tap the small bar, and it grows back
// Everything is a motion value written straight to style — nothing re-renders
// per frame. Reduced motion: no lens, no morph, fades only.

export const TABS = [
  { key: 'chat', label: 'Chat', Glyph: MessageCircle },
  { key: 'home', label: 'Home', Glyph: House },
  { key: 'tasks', label: 'Tasks', Glyph: ListTodo },
  { key: 'fleet', label: 'Fleet', Glyph: LayoutGrid },
  { key: 'library', label: 'Library', Glyph: BookOpen },
];

// Where each place lives. Home, Fleet and Library are places with their own
// stacks (a doc you opened is still there next time); Tasks, HQ, Insights and
// Settings are pages stacked on the chat (closing returns to it).
export function place(key) {
  if (key === 'chat' || key === 'mia') return goView('mia');
  if (key === 'home' || key === 'fleet' || key === 'library') return goView(key);
  goView('mia');
  if (key === 'channels') return push('hq', { section: 'channels' });
  return push(key, {});
}

// Which tab is lit: where the pane is (or the chat, when it's closed). HQ,
// Insights and Settings live in the chat's ··· menu, so no tab lights for them.
export function activeOf(s) {
  if (!paneOpenOf(s)) return 'chat';
  if (s.tab === 'agents') return 'fleet';
  if (s.tab === 'library') return 'library';
  if (s.tab === 'home') return 'home';
  const n = s.stacks.mia[1]?.name;
  return { tasks: 'tasks', task: 'tasks', doc: 'library', agent: 'fleet' }[n] || '';
}

export const BAR_H = 58; // the capsule
export const MINI = 46; // minimised: one round button, the composer's height
const SEARCH = 58;
const GAP = 10;
const PAD = 4; // the pill's inset

function useBadges() {
  const qs = useMC((s) => miaOpenQuestions(s.mia, s.miaLocal).length);
  const live = useMC((s) => (s.mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length);
  const waiting = useMC((s) => s.agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a)).length);
  return { chat: qs ? ['dot', 'warn'] : null, tasks: live ? [live, ''] : null, fleet: waiting ? ['dot', 'warn'] : null };
}

function Row({ active, badges, slot, lens = false }) {
  return (
    <div className="v53-tabs" style={{ width: slot * TABS.length }} aria-hidden={lens || undefined}>
      {TABS.map((t) => {
        const on = active === t.key;
        const b = badges[t.key];
        return (
          <span key={t.key} className={`v53-tab ${on ? 'on' : ''}`} style={{ width: slot }}>
            <span className="relative">
              <t.Glyph size={21} strokeWidth={on || lens ? 2 : 1.7} />
              {b && !lens && (b[0] === 'dot' ? <i className={`v53-badge-dot ${b[1]}`} /> : <i className="v53-badge v-num">{b[0] > 99 ? '99+' : b[0]}</i>)}
            </span>
            <span className="v53-tab-label">{t.label}</span>
          </span>
        );
      })}
    </div>
  );
}

// A tab in the bar. While the lens is lifted, the tab under it steps back so
// only the lens's magnified copy shows (a drop of glass over it, not a double).
function TabButton({ i, slot, lensX, lift, children, style, ...rest }) {
  const o = useTransform(() => {
    const k = lift.get();
    if (k <= 0.01) return 1;
    const d = Math.abs(PAD + i * slot - lensX.get()) / slot; // 0 = right under the lens
    return 1 - k * Math.max(0, 1 - d * 1.15);
  });
  return (
    <motion.button type="button" {...rest} style={{ ...style, opacity: o }}>
      {children}
    </motion.button>
  );
}

// geo: { W, narrow, b0 (px from the bottom), zoneL, zoneR (motion values: the

// chat column's edges), contentW (fn: the composer's width in a zone) }
export default function TabBar({ geo, L, R, m, mini, hidden, chat }) {
  const reduce = usePrefs((s) => s.reduce);
  const active = useNav(activeOf);
  const badges = useBadges();
  const idx = TABS.findIndex((t) => t.key === active);
  const pad = geo.narrow ? 8 : 12;
  const slot = geo.narrow ? Math.min(64, Math.floor((geo.W - 2 * pad - SEARCH - GAP - 2 * PAD) / TABS.length)) : 72;
  const BW = slot * TABS.length + 2 * PAD;

  // ---- where the bar and the search circle sit (expanded ⇄ minimised) ---------
  const zone = (l, r) => ({ l, w: geo.W - l - r });
  const barX = useTransform(() => {
    const z = zone(L.get(), R.get());
    const expanded = z.l + (z.w - (BW + GAP + SEARCH)) / 2;
    const cw = Math.min(720, z.w - 2 * pad);
    const mini = z.l + (z.w - cw) / 2;
    const k = m.get();
    return expanded + (mini - expanded) * k;
  });
  const barW = useTransform(() => BW + (MINI - BW) * m.get());
  const barH = useTransform(() => BAR_H + (MINI - BAR_H) * m.get());
  const searchX = useTransform(() => {
    const z = zone(L.get(), R.get());
    const expanded = z.l + (z.w - (BW + GAP + SEARCH)) / 2 + BW + GAP;
    const cw = Math.min(720, z.w - 2 * pad);
    const mini = z.l + (z.w + cw) / 2 - MINI;
    return expanded + (mini - expanded) * m.get();
  });
  const searchS = useTransform(() => SEARCH + (MINI - SEARCH) * m.get());
  // on the chat the composer takes the row when minimised: the search circle steps aside
  const searchO = useTransform(() => (chat ? 1 - m.get() : 1));
  const fullO = useTransform(m, [0, 0.55], [1, 0]);
  const miniO = useTransform(m, [0.45, 1], [0, 1]);

  // ---- the resting pill ----------------------------------------------------------
  const pillX = useMotionValue(PAD + Math.max(0, idx) * slot);
  const pillO = useMotionValue(idx >= 0 ? 1 : 0);
  useEffect(() => {
    if (idx < 0) return void animate(pillO, 0, { duration: 0.15 });
    animate(pillO, 1, { duration: 0.15 });
    const a = animate(pillX, PAD + idx * slot, reduce ? { duration: 0 } : spring.snappy);
    return () => a.stop();
  }, [idx, slot, reduce, pillX, pillO]);

  // ---- the lens: lifts out of the bar under the finger ---------------------------
  const lensX = useMotionValue(0); // in the bar's own coordinates
  const lift = useMotionValue(0); // 0 resting → 1 lifted
  const [lifted, setLifted] = useState(false);
  const drag = useRef(null);
  const bar = useRef(null);
  const LENS_PAD = 10; // the lens is a little wider than a tab, a capsule
  const lensLeft = useTransform(() => barX.get() + lensX.get() - LENS_PAD);
  const lensScale = useTransform(lift, [0, 1], [0.86, 1.08]);
  const lensO = useTransform(lift, [0, 0.25, 1], [0, 1, 1]);
  const innerX = useTransform(() => -(lensX.get() - LENS_PAD));
  const innerOrigin = useTransform(() => `${lensX.get() + slot / 2}px 50%`);

  const slotAt = (clientX) => {
    const r = bar.current.getBoundingClientRect();
    return Math.max(0, Math.min(TABS.length - 1, Math.floor((clientX - r.left - PAD) / slot)));
  };
  const settle = (i) => {
    animate(lensX, PAD + i * slot, spring.snappy);
    animate(lift, 0, { ...spring.sheet, delay: 0.08 }).then(() => drag.current || setLifted(false));
  };
  const onPointerDown = (e) => {
    if (e.button > 0 || m.get() > 0.5) return;
    if (reduce) return;
    const i = slotAt(e.clientX);
    drag.current = { x0: e.clientX, i0: i, moved: false, id: e.pointerId };
    lensX.set(PAD + (idx >= 0 ? idx : i) * slot);
    setLifted(true);
    animate(lensX, PAD + i * slot, spring.snappy);
    animate(lift, 1, spring.snappy);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 8) return;
    if (!d.moved) {
      // a drag: the bar keeps the finger even if it leaves (a tap keeps its own click)
      try {
        bar.current.setPointerCapture(d.id);
      } catch {
        /* synthetic events */
      }
    }
    d.moved = true;

    const r = bar.current.getBoundingClientRect();
    const x = e.clientX - r.left - slot / 2;
    const lo = PAD;
    const hi = PAD + (TABS.length - 1) * slot;
    // rubber-band past the ends
    const band = (v) => (v < lo ? lo - 18 * (1 - 1 / ((lo - v) / 18 + 1)) : v > hi ? hi + 18 * (1 - 1 / ((v - hi) / 18 + 1)) : v);
    lensX.set(band(x));
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const i = slotAt(e.clientX);
    // a tap is the button's own click; a drag picks where it was let go
    if (d.moved && e.type === 'pointerup') {
      d.picked = true;
      skipClick.current = true;
      setTimeout(() => (skipClick.current = false), 400);
      go(TABS[i].key);
    }
    settle(e.type === 'pointerup' ? i : Math.max(0, idx));
  };
  const skipClick = useRef(false);

  const go = (key) => {
    setMini(false);
    place(key);
  };

  const onBar = (e) => {
    if (m.get() > 0.5) {
      e.preventDefault();
      setMini(false);
    }
  };

  const ActiveGlyph = (TABS[idx] || TABS[0]).Glyph;
  return (
    <>
      <motion.nav
        ref={bar}
        className="v53-bar"
        style={{ left: barX, width: barW, height: barH, bottom: geo.b0, opacity: hidden ? 0 : 1, pointerEvents: hidden ? 'none' : 'auto' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onBar}
        aria-label="Places"
        data-lens
        data-depth="0.9"
        data-v53-bar
        data-mini={mini ? "1" : "0"}
      >
        <motion.div className="absolute inset-y-0 left-0 flex items-center" style={{ opacity: fullO, paddingLeft: PAD, paddingRight: PAD }}>
          <motion.span className="v53-pill" style={{ x: pillX, width: slot, opacity: pillO, left: 0 }} data-tab-pill />
          <div className="v53-tabs relative" style={{ width: slot * TABS.length }}>
            {TABS.map((t) => {
              const on = active === t.key;
              const b = badges[t.key];
              return (
                <TabButton
                  key={t.key}
                  i={TABS.indexOf(t)}
                  slot={slot}
                  lensX={lensX}
                  lift={lift}
                  onClick={() => !skipClick.current && go(t.key)}
                  className={`v53-tab ${on ? 'on' : ''}`}
                  style={{ width: slot }}
                  aria-current={on ? 'page' : undefined}
                  aria-label={t.label}
                  data-tab={t.key}
                  tabIndex={mini ? -1 : 0}
                >
                  <span className="relative">
                    <t.Glyph size={21} strokeWidth={on ? 2 : 1.7} />
                    {b && (b[0] === 'dot' ? <i className={`v53-badge-dot ${b[1]}`} data-tab-badge={t.key} /> : <i className="v53-badge v-num" data-tab-badge={t.key}>{b[0] > 99 ? '99+' : b[0]}</i>)}
                  </span>
                  <span className="v53-tab-label">{t.label}</span>
                </TabButton>
              );
            })}
          </div>
        </motion.div>
        <motion.button type="button" className="v53-tab-mini" style={{ opacity: miniO, pointerEvents: 'none' }} aria-hidden="true" tabIndex={-1}>
          <ActiveGlyph size={20} strokeWidth={2} />
        </motion.button>
      </motion.nav>

      {lifted && (
        <motion.div
          className="v53-lens"
          style={{ left: lensLeft, width: slot + 2 * LENS_PAD, height: BAR_H + 6, bottom: geo.b0 - 3, opacity: lensO, scale: lensScale }}
          data-lens
          data-depth="1"
          data-frost="-2.6"
          data-tab-lens
          aria-hidden="true"
        >
          <motion.div className="absolute inset-y-0 left-0 flex items-center" style={{ x: innerX, paddingLeft: 0, transformOrigin: innerOrigin, scale: 1.12 }}>
            <Row active={active} badges={badges} slot={slot} lens />
          </motion.div>
        </motion.div>
      )}

      <motion.button
        type="button"
        onClick={openPalette}
        className="v53-search"
        style={{ left: searchX, width: searchS, height: searchS, bottom: geo.b0, opacity: hidden ? 0 : searchO, pointerEvents: hidden ? 'none' : 'auto' }}
        whileTap={reduce ? undefined : { scale: 0.92 }}
        aria-label="Search and commands — ⌘K"
        title="Search and commands — ⌘K"
        data-lens
        data-depth="0.9"
        data-bar-search
      >
        <Search size={21} strokeWidth={1.8} />
      </motion.button>
    </>
  );
}
