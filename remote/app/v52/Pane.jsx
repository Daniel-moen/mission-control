import { Activity, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useNav, goView, topOf } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import Stack from '../v2/shell/Stack.jsx';
import { paneOpenOf, takeOrigin, rememberPane } from './state.js';

// The pane (task 0491): wherever you go that isn't the chat — Home, Fleet,
// Library, a task, a doc, HQ, Settings — opens in ONE pane of Lens glass,
// and the chat stays alive beside it (iPad landscape: the pane on the right,
// the chat reflows to the left) or under it (iPhone / iPad portrait: the pane
// is a sheet, the chat recedes behind it and peeks out at the top).
//
//   open   from a card in the chat: the pane GROWS out of the card (shared
//          element: same place, same size, one spring to full). From the
//          side panel: it slides in from the right (iPad) or up (iPhone).
//   close  the X (or Back from a page stacked on the chat, Esc, ⌘[):
//          flies back into its card when the card is on screen, else slides
//          away. On iPhone, drag the sheet down by its top — it follows the
//          finger, rubber-bands upward, and keeps the throw's velocity.
//   inside the page stacks are v2's (push / pop / swipe-back), one per place.
//
// While it flies over the chat the pane is CSS glass (a real backdrop blur);
// at rest beside the chat the Lens shader draws it. Over the chat (a sheet)
// it stays CSS glass — the shader must never sit under scrolling DOM.

export function closePane() {
  const s = useNav.getState();
  if (!paneOpenOf(s)) return;
  rememberPane({ tab: s.tab, stack: s.stacks[s.tab] });
  goView('mia');
}

const TABS = ['home', 'agents', 'library', 'mia'];

function growKey(s) {
  const t = topOf(s);
  if (t?.name === 'task' || t?.name === 'doc' || t?.name === 'agent') return `${t.name}:${t.params?.id}`;
  return '';
}

function TabPane({ tab, active, frozen, n }) {
  const o = useMotionValue(1);
  const s = useMotionValue(1);
  const reduce = usePrefs((st) => st.reduce);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (!active) return;
    if (first.current) {
      first.current = false;
      return;
    }
    o.set(0);
    animate(o, 1, { duration: 0.2, ease: [0.25, 1, 0.5, 1] });
    if (!reduce) {
      s.set(0.975);
      animate(s, 1, spring.snappy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return (
    <motion.div className="absolute inset-0" style={{ opacity: o, scale: s }} data-tabpane={tab}>
      {/* the chat's stack starts afresh each time the pane opens (no slide-in inside a pane that's growing in) */}
      <Stack key={tab === 'mia' ? `mia:${n}` : tab} tab={tab} active={active} frozen={frozen} onClose={closePane} closeDepth={tab === 'mia' ? 1 : 0} />
    </motion.div>
  );
}

export default function Pane({ wide, rect, back }) {
  const open = useNav(paneOpenOf);
  const tab = useNav((s) => s.tab);
  const stacks = useNav((s) => s.stacks);
  const reduce = usePrefs((s) => s.reduce);
  const box = useRef(null);
  // what the pane shows: live while open; the last open picture while it leaves
  const [visible, setVisible] = useState(open);
  const snap = useRef(null);
  if (open) snap.current = { tab, stacks, grow: growKey(useNav.getState()) };
  const frozen = !open ? snap.current : null;
  const seenOpen = useRef(open);
  const openN = useRef(0);
  if (open && !seenOpen.current) openN.current += 1;
  seenOpen.current = open;
  const [mounted, setMounted] = useState(() => new Set(open ? [tab] : []));
  const shownTab = open ? tab : snap.current?.tab || 'mia';
  useEffect(() => {
    if (!mounted.has(shownTab)) setMounted(new Set([...mounted, shownTab]));
  }, [shownTab, mounted]);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sc = useMotionValue(1);
  const o = useMotionValue(open ? 1 : 0);
  // a sheet pulls the chat back behind it, as much as it covers
  useEffect(() => {
    if (wide) return back.set(0);
    const H = innerHeight || 800;
    const sync = () => back.set(o.get() * Math.max(0, 1 - y.get() / H));
    sync();
    const offs = [y.on('change', sync), o.on('change', sync)];
    return () => offs.forEach((f) => f());
  }, [wide, back, o, y]);

  // ---- open / close --------------------------------------------------------------
  const prev = useRef(open);
  useLayoutEffect(() => {
    if (prev.current === open) return undefined;
    prev.current = open;
    const el = box.current;
    if (!el) return undefined;
    el.setAttribute('data-lens-off', '');
    const settle = () => {
      if (wide && open) el.removeAttribute('data-lens-off');
    };
    const R = el.getBoundingClientRect();
    const runs = [];
    if (open) {
      setVisible(true);
      const g = !reduce && takeOrigin();
      if (reduce) {
        x.set(0), y.set(0), sc.set(1), o.set(0);
        runs.push(animate(o, 1, { duration: 0.18 }));
      } else if (g && R.width > 0) {
        // shared element: start exactly over the card, grow to the pane
        el.style.transformOrigin = '0 0';
        sc.set(Math.max(0.2, g.width / R.width));
        x.set(g.left - R.left);
        y.set(g.top - R.top);
        o.set(0);
        runs.push(animate(o, 1, { duration: 0.16 }), animate(sc, 1, spring.sheet), animate(x, 0, spring.sheet), animate(y, 0, spring.sheet));
      } else if (wide) {
        el.style.transformOrigin = '100% 50%';
        x.set(56), y.set(0), sc.set(0.97), o.set(0);
        runs.push(animate(o, 1, { duration: 0.2 }), animate(x, 0, spring.sheet), animate(sc, 1, spring.sheet));
      } else {
        el.style.transformOrigin = '50% 0';
        x.set(0), sc.set(1), o.set(1);
        y.set(R.height + 40);
        runs.push(animate(y, 0, { ...spring.sheet, velocity: 0 }));
      }
    } else {
      const key = snap.current?.grow;
      const card = key ? document.querySelector(`[data-v52-stage] [data-grow="${CSS.escape(key)}"]`) : null;
      const c = card?.getBoundingClientRect();
      const onScreen = c && c.bottom > 0 && c.top < innerHeight && c.width > 0;
      if (reduce) runs.push(animate(o, 0, { duration: 0.16 }));
      else if (onScreen && wide) {
        el.style.transformOrigin = '0 0';
        runs.push(animate(sc, Math.max(0.2, c.width / R.width), spring.sheet), animate(x, c.left - R.left, spring.sheet), animate(y, c.top - R.top, spring.sheet), animate(o, 0, { duration: 0.22, delay: 0.08 }));
      } else if (wide) runs.push(animate(x, 64, { ...spring.page, velocity: x.getVelocity() }), animate(o, 0, { duration: 0.2 }));
      else runs.push(animate(y, R.height + 40, { ...spring.page, velocity: y.getVelocity() }));
    }
    Promise.all(runs).then(() => {
      if (!prev.current) {
        setVisible(false);
        x.set(0), y.set(0), sc.set(1);
      } else settle();
    });
    return () => runs.forEach((a) => a.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // the pane at rest: shader glass beside the chat, CSS glass over it
  useEffect(() => {
    const el = box.current;
    if (!el || !open) return;
    if (wide) {
      const t = setTimeout(() => el.removeAttribute('data-lens-off'), 400);
      return () => clearTimeout(t);
    }
    el.setAttribute('data-lens-off', '');
    return undefined;
  }, [wide, open]);

  // ---- drag the sheet down by its top (iPhone, iPad portrait) ------------------------
  const onPointerDownCapture = (e) => {
    if (wide || !open || e.button > 0) return;
    const el = box.current;
    const r = el.getBoundingClientRect();
    if (e.clientY - r.top > 64 || e.target.closest('button, a, input, textarea, select')) return;
    const y0 = e.clientY;
    let on = false;
    let lastY = y0;
    let lastT = performance.now();
    let v = 0;
    const move = (ev) => {
      const dy = ev.clientY - y0;
      if (!on && Math.abs(dy) < 8) return;
      if (!on && Math.abs(ev.clientX - e.clientX) > Math.abs(dy)) return done();
      on = true;
      const t = performance.now();
      v = ((ev.clientY - lastY) / Math.max(1, t - lastT)) * 1000;
      lastY = ev.clientY;
      lastT = t;
      y.set(dy >= 0 ? dy : -30 * (1 - 1 / (-dy / 30 + 1)));
    };
    const done = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      if (!on || !ev) return;
      const dy = ev.clientY - y0;
      if (dy > 120 || v > 700) closePane();
      else animate(y, 0, { ...spring.sheet, velocity: v });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };

  const grab = useTransform(y, (v) => Math.min(1, 0.55 + v / 300));
  return (
    <motion.div
      ref={box}
      className={`v52-pane ${wide ? 'beside' : 'sheet'}`}
      style={{ ...rect, x, y, scale: sc, opacity: o, visibility: visible || open ? 'visible' : 'hidden' }}
      onPointerDownCapture={onPointerDownCapture}
      inert={open ? undefined : true}
      data-v52-pane={open ? 'open' : 'closed'}
      data-pane-tab={shownTab}
      data-lens-off=""
    >
      {!wide && <motion.span className="v52-grabber" style={{ opacity: grab }} aria-hidden="true" />}
      {TABS.filter((t) => mounted.has(t) || t === shownTab).map((t) => (
        <Activity key={t} mode={t === shownTab && (open || visible) ? 'visible' : 'hidden'}>
          <TabPane tab={t} n={openN.current} active={open && t === tab} frozen={frozen ? frozen.stacks[t] : null} />
        </Activity>
      ))}
    </motion.div>
  );
}
