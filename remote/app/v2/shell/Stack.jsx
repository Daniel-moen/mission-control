import { Activity, createContext, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useDragControls, useMotionValue, useTransform } from 'motion/react';
import { useNav, pop } from '../lib/nav.js';
import { usePrefs } from '../lib/prefs.js';
import { spring } from '../lib/motion.js';
import { useSize } from '../ui/hooks.js';
import { pageFor, PageSkeleton } from './pages.js';
import Boundary from '../ui/Boundary.jsx';

// One tab's page stack, rendered as layers.
//
//   push  the new page slides in from the right edge while the page under it
//         drifts left and dims (a "zoom" push instead grows out of the card
//         you tapped — Library docs, agents, Home tiles);
//   pop   the reverse, and it is interactive: drag from the left edge and
//         the page follows your finger; let go past a third (or flick) and
//         it leaves, otherwise it springs back. Velocity carries through.
//
// Only the top two layers paint. Deeper ones sit inside <Activity hidden>:
// state and DOM kept (Back is instant), effects paused (no watch leases, no
// 1 Hz re-renders for pages nobody can see).

export const PageCtx = createContext({ route: null, active: true, depth: 0, back: () => {}, close: null });
export const usePage = () => useContext(PageCtx);

const EDGE = 26; // px of left edge that starts a back-swipe

function useLayers(stack) {
  const [layers, setLayers] = useState(() => stack.map((r) => ({ r, state: 'still' })));
  useLayoutEffect(() => {
    setLayers((prev) => {
      const byKey = new Map(prev.map((l) => [l.r.key, l]));
      const keys = new Set(stack.map((r) => r.key));
      const out = stack.map((r) => {
        const had = byKey.get(r.key);
        return had ? { ...had, r, state: had.state === 'leave' ? 'still' : had.state } : { r, state: 'enter' };
      });
      // Popped pages leave from the top; only the topmost animates out.
      const leaving = prev.filter((l) => !keys.has(l.r.key));
      if (leaving.length) out.push({ ...leaving[leaving.length - 1], state: 'leave' });
      return out;
    });
  }, [stack]);
  const settle = (key, gone) =>
    setLayers((prev) => (gone ? prev.filter((l) => l.r.key !== key) : prev.map((l) => (l.r.key === key ? { ...l, state: 'still' } : l))));
  return [layers, settle];
}

export default function Stack({ tab, active, onClose = null, closeDepth = 0, frozen = null }) {
  // v5.2 (task 0491): a closing pane keeps drawing the stack it had (frozen)
  const live = useNav((s) => s.stacks[tab]);
  const stack = frozen || live;
  const [layers, settle] = useLayers(stack);
  const box = useRef(null);
  const { w, h } = useSize(box);
  // How much the top page covers the one under it: 0 (gone) … 1 (fully on).
  const cover = useMotionValue(stack.length > 1 ? 1 : 0);
  const n = layers.length;

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden" data-stack={tab}>
      {layers.map((l, i) => {
        const top = i === n - 1;
        const under = i === n - 2;
        const shown = top || under;
        return (
          <Activity key={l.r.key} mode={shown ? 'visible' : 'hidden'}>
            <Layer
              layer={l}
              index={i}
              top={top}
              under={under}
              live={active && top && l.state !== 'leave'}
              depth={stack.findIndex((r) => r.key === l.r.key)}
              cover={cover}
              aboveZoom={!!layers[i + 1]?.r.origin}
              w={w || window.innerWidth}
              h={h || window.innerHeight}
              onClose={onClose}
              closeDepth={closeDepth}
              onSettled={settle}
            />
          </Activity>
        );
      })}
    </div>
  );
}

function Layer({ layer, index, top, under, live, depth, cover, aboveZoom, w, h, onSettled, onClose, closeDepth = 0 }) {
  const { r, state } = layer;
  const reduce = usePrefs((s) => s.reduce);
  const zoom = !!r.origin && !reduce;
  const root = index === 0;
  // Slide: x in px (0 = in place). Zoom: p 0 (the card) … 1 (full page).
  const x = useMotionValue(state === 'enter' && !root && !zoom && !reduce ? w : 0);
  const p = useMotionValue(state === 'enter' && zoom ? 0 : 1);
  const o = useMotionValue(state === 'enter' && reduce && !root ? 0 : 1);
  const drag = useDragControls();
  const origin = useRef(r.origin);

  // The top layer drives `cover` for the layer beneath it.
  useEffect(() => {
    if (!top) return undefined;
    const sync = () => cover.set(zoom ? p.get() * (1 - Math.min(1, x.get() / w)) : reduce ? o.get() : 1 - Math.min(1, x.get() / w));
    sync();
    const offs = [x.on('change', sync), p.on('change', sync), o.on('change', sync)];
    return () => offs.forEach((f) => f());
  }, [top, zoom, reduce, x, p, o, w, cover]);

  // Enter / leave.
  useEffect(() => {
    if (state === 'enter') {
      if (root) return onSettled(r.key, false);
      const a = reduce
        ? animate(o, 1, { duration: 0.18 })
        : zoom
          ? animate(p, 1, spring.sheet)
          : animate(x, 0, spring.page);
      a.then(() => onSettled(r.key, false));
      return () => a.stop();
    }
    if (state === 'leave') {
      let a;
      if (reduce) a = animate(o, 0, { duration: 0.16 });
      else if (zoom) {
        // Fly back into the card if it's still on screen, else just shrink away.
        const src = r.params?.zoomId ? document.querySelector(`[data-zoom="${CSS.escape(r.params.zoomId)}"]`) : null;
        if (src) {
          const b = src.getBoundingClientRect();
          const host = src.closest('[data-stack]')?.getBoundingClientRect() || { left: 0, top: 0 };
          origin.current = { left: b.left - host.left, top: b.top - host.top, width: b.width, height: b.height };
        }
        a = animate(p, 0, spring.sheet);
      } else a = animate(x, w, { ...spring.page, velocity: x.getVelocity() });
      a.then(() => onSettled(r.key, true));
      return () => a.stop();
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ---- the layer beneath: drift left and dim as the top covers it ---------
  // (Under a zoomed page it recedes in depth instead of sliding sideways.)
  const underX = useTransform(cover, (c) => (under && !reduce && !aboveZoom ? -0.24 * w * c : 0));
  const underScale = useTransform(cover, (c) => (under && !reduce && aboveZoom ? 1 - 0.05 * c : 1));
  // Lens: pages are clear glass over the scene, so the covered page must
  // leave, not dim — it fades out as it drifts back.
  const underO = useTransform(cover, (c) => (under ? 1 - Math.min(1, c * 1.15) : 1));

  // ---- zoom geometry --------------------------------------------------------
  const clip = useTransform([p, x], ([v, dx]) => {
    if (!zoom) return 'none';
    const g = origin.current || { left: w * 0.1, top: h * 0.3, width: w * 0.8, height: h * 0.2 };
    const k = 1 - v;
    const t = g.top * k;
    const l = g.left * k;
    const rr = (w - g.left - g.width) * k;
    const b = (h - g.top - g.height) * k;
    const rad = 24 * k + Math.min(1, dx / w) * 60;
    return `inset(${t}px ${rr}px ${b}px ${l}px round ${rad}px)`;
  });
  const zScale = useTransform(x, (dx) => (zoom ? 1 - Math.min(1, dx / w) * 0.22 : 1));
  const zFade = useTransform(p, [0, 0.55, 1], [0, 0.9, 1]);

  const back = () => pop();
  // A back-swipe starts near the left edge and only once the finger moves
  // sideways — a tap there (the Back button) stays a tap.
  const onPointerDownCapture = (e) => {
    if (root || !top || state === 'leave' || e.button > 0) return;
    const host = e.currentTarget.getBoundingClientRect();
    if (e.clientX - host.left > EDGE) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const dy = Math.abs(ev.clientY - y0);
      if (dx > 8 && dx > dy * 1.2) {
        done();
        drag.start(ev);
      } else if (dy > 12 || dx < -8) done();
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };
  const onDragEnd = (_, info) => {
    if (info.offset.x > w * 0.33 || info.velocity.x > 600) back();
    else animate(x, 0, { ...spring.page, velocity: info.velocity.x });
  };

  // v5.2 (task 0491): a pane over the chat closes from its first page too (closeDepth 1)
  const ctx = { route: r, active: live, depth, back, close: depth <= closeDepth ? onClose : null };
  const Page = pageFor(r.name);

  return (
    <motion.div
      className="absolute inset-0 overflow-hidden"
      style={{
        x: top || state !== 'still' ? x : underX,
        scale: zoom ? zScale : underScale,
        opacity: under && state === 'still' ? underO : o,
        clipPath: zoom ? clip : undefined,
        zIndex: index,
        pointerEvents: top && state !== 'leave' ? 'auto' : 'none',
        transformOrigin: '50% 50%',
      }}
      drag={!root && top ? 'x' : false}
      dragListener={false}
      dragControls={drag}
      dragConstraints={{ left: 0, right: w }}
      dragElastic={{ left: 0, right: 0 }}
      dragMomentum={false}
      onDragEnd={onDragEnd}
      onPointerDownCapture={onPointerDownCapture}
      inert={!top || state === 'leave' ? true : undefined}
      data-page={r.name}
      data-top={top ? 'true' : 'false'}
    >
      <motion.div className="flex h-full w-full flex-col" style={{ opacity: zoom ? zFade : 1 }}>
        <PageCtx.Provider value={ctx}>
          <Boundary>
            <Suspense fallback={<PageSkeleton />}>
              <Page route={r} params={r.params || {}} />
            </Suspense>
          </Boundary>
        </PageCtx.Provider>
      </motion.div>
    </motion.div>
  );
}
