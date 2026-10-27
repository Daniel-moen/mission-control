import { useEffect, useRef, useState } from 'react';
import { animate, motionValue } from 'motion/react';
import { hasWebGL } from '../../v2/lens/gl.js';
import { photoCanvas, fallbackCanvas } from '../../v2/lens/scene.js';
import { initBackdrop, useBackdrop } from '../../v2/lens/backdrop.js';
import { useTilt, tiltX, tiltY, lightX, lightY, touching } from '../../v2/lens/tilt.js';
import { useQuality } from '../../v3/shared/quality.js';
import { createScene, typeCanvas, MAX, PANES, AMBER, NO } from './lens.js';
import { useTheme } from './theme.js';
import { useRoute } from './route.js';
import { installScrollSync, scrollGate } from '../../v2/lens/scrollsync.js';

// v4 (task 0448): Lens's scene under every v4 direction (see lens.js). Mounted
// once per direction, under everything. Per moment it decides:
//   • focus: with nothing open the scene is open (sharp photo, the clock);
//     while something is open full-screen it racks focus off the photo and
//     dims it a little — the photo stays visible
//   • which panes are glass: PANES on screen, the first MAX of them; each
//     frame their rects (post-transform, post-scroll) and opacity feed the
//     shader. The ones it draws get .lens-live (their CSS glass steps aside);
//     the rest keep CSS glass, so nothing is ever left bare
//   • the clock: wherever the direction put <LensClock>, read from the DOM
//     each frame and set into the photo by the shader
//   • lite (reduced motion or low power): no shader — the photo as an <img>,
//     pre-blurred once (tiny canvas, scaled up) while something is open, and
//     CSS glass without backdrop-filter

// Daylight photos for the light theme (bg/light/, not in the shared
// manifest, so v1–v3's rotation is untouched). ?bg=11|12 pins one.
const LIGHT = ['11.jpg', '12.jpg'];
function lightSrc(pick) {
  if (pick.url) return pick.url;
  const pin = new URLSearchParams(location.search).get('bg');
  if (pin && LIGHT.includes(`${pin}.jpg`)) return `/bg/light/${pin}.jpg`;
  return `/bg/light/${LIGHT[(new Date().getDate() + new Date().getHours()) % LIGHT.length]}`;
}
export function useSceneSrc() {
  const dark = useTheme((s) => s.theme) === 'dark';
  const src = useBackdrop((s) => s.src);
  const pick = useBackdrop((s) => s.pick);
  return dark ? src : lightSrc(pick);
}

const dofV = motionValue(0);
const dimV = motionValue(0.15);

function opacityOf(el) {
  let o = 1;
  for (let n = el, i = 0; n && i < 40; n = n.parentElement, i++) {
    const v = n.style?.opacity;
    if (v !== '' && v != null) o *= parseFloat(v);
    if (o < 0.01) return 0;
  }
  return o;
}

const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

// The giant clock + date. Takes its space in the layout; in GL mode the DOM
// text is hidden and the shader sets the same glyphs into the photo (so the
// glass panes refract it), otherwise the DOM text shows.
export function LensClock({ className = '' }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`lens-clock ${className}`} data-lens-clock aria-label={`${fmtTime(now)}, ${fmtDate(now)}`}>
      <div className="lens-clock-time" aria-hidden="true">
        {fmtTime(now)}
        <i className="lens-base" />
      </div>
      <div className="lens-clock-date" aria-hidden="true">
        {fmtDate(now)}
        <i className="lens-base" />
      </div>
    </div>
  );
}

// Where the clock's glyphs are, in CSS px (null when there's no clock).
function clockSpec() {
  const el = document.querySelector('[data-lens-clock]');
  if (!el) return null;
  const part = (sel) => {
    const p = el.querySelector(sel);
    const b = p?.querySelector('.lens-base');
    if (!p || !b) return null;
    const r = p.getBoundingClientRect();
    if (r.width < 4) return null;
    if (p.__fs === undefined || p.__fsW !== innerWidth) {
      p.__fs = parseFloat(getComputedStyle(p).fontSize) || 16;
      p.__fsW = innerWidth;
    }
    return { x: r.left, y: b.getBoundingClientRect().top, size: p.__fs };
  };
  return { el, t: part('.lens-clock-time'), d: part('.lens-clock-date') };
}

export default function Scene() {
  const ref = useRef(null);
  const low = useQuality((s) => s.low);
  const reduce = useQuality((s) => s.reduce);
  const theme = useTheme((s) => s.theme);
  const dark = theme === 'dark';
  const src = useSceneSrc();
  const focused = !!useRoute().kind;
  const [gl] = useState(hasWebGL);
  const on = gl && !low && !reduce;
  const api = useRef(null);
  const [ready, setReady] = useState(false);
  useTilt();

  useEffect(() => {
    initBackdrop();
  }, []);
  useEffect(() => {
    const sp = reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 110, damping: 22 };
    animate(dofV, focused ? 3.4 : 0, sp);
    animate(dimV, focused ? 0.35 : 0.15, sp);
  }, [focused, reduce]);
  useEffect(() => {
    document.documentElement.dataset.glass = low || reduce ? 'lite' : 'full';
  }, [low, reduce]);

  // ---- the shader -----------------------------------------------------------
  useEffect(() => {
    const mode = (m) => (document.documentElement.dataset.lensmode = m ? 'gl' : 'css');
    mode(on);
    if (!on || !ref.current) return undefined;
    let s;
    try {
      s = createScene(ref.current);
    } catch (e) {
      console.warn('lens: shader unavailable', e);
      mode(false);
      return undefined;
    }
    if (!s.ok) {
      mode(false);
      return undefined;
    }
    api.current = s;
    s.texture('u_tex', fallbackCanvas(document.documentElement.dataset.theme !== 'light'), 0);
    const rects = new Float32Array(MAX * 4);
    const meta = new Float32Array(MAX * 4);
    const dyn = new Float32Array(MAX * 4); // per pane: velocity x/y (px per 60 Hz frame), opacity, growth
    const glow = { t: 0 };
    const type = { key: '', a: 0, ox: 0, oy: 0 };
    let live = new Set();
    installScrollSync();
    s.setFrame((t, dt) => {
      const fr = Math.min(4, Math.max(0.25, dt / 16.7));
      const H = innerHeight;
      const W = innerWidth;
      const els = document.querySelectorAll(PANES);
      const now = new Set();
      let n = 0;
      for (let i = 0; i < els.length && n < MAX; i++) {
        const el = els[i];
        if (el.__lensNo === undefined) el.__lensNo = !!el.closest(NO) || !!el.parentElement?.closest(PANES);
        if (el.__lensNo) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < -30 || r.top > H + 30 || r.right < -30 || r.left > W + 30 || r.width < 8 || r.height < 8) continue;
        const f = scrollGate(el, t, dt);
        const op = opacityOf(el) * f;
        if (op < 0.02) continue;
        dyn[n * 4 + 2] = op;
        rects[n * 4] = r.left;
        rects[n * 4 + 1] = r.top;
        rects[n * 4 + 2] = r.width;
        rects[n * 4 + 3] = r.height;
        if (el.__lensR === undefined) el.__lensR = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 22;
        // a pane scaled by its ancestors (Atlas's map) keeps its proportions
        const k = el.offsetWidth ? r.width / el.offsetWidth : 1;
        meta[n * 4] = Math.min(el.__lensR * k, r.height / 2, r.width / 2);
        meta[n * 4 + 1] = +(el.dataset.frost || 0);
        meta[n * 4 + 2] = el.matches(AMBER) ? 1 : 0;
        meta[n * 4 + 3] = +(el.dataset.depth || 0.6);
        // how the pane is moving (drag, fly-in, open): the bend leans
        // against it, and a growing pane magnifies a little more
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const v = el.__lensV || (el.__lensV = { x: cx, y: cy, w: r.width, vx: 0, vy: 0, vs: 0 });
        const cl = (x, m) => Math.max(-m, Math.min(m, x));
        v.vx += (cl((cx - v.x) / fr, 60) - v.vx) * 0.35;
        v.vy += (cl((cy - v.y) / fr, 60) - v.vy) * 0.35;
        v.vs += (cl((r.width - v.w) / Math.max(v.w, 1) / fr * 8, 1) - v.vs) * 0.35;
        v.x = cx;
        v.y = cy;
        v.w = r.width;
        dyn[n * 4] = v.vx;
        dyn[n * 4 + 1] = v.vy;
        dyn[n * 4 + 3] = v.vs;
        if (f >= 0.5) now.add(el); // scrolling: its CSS glass shows (scrollsync.js)
        n++;
      }
      for (const el of live) if (!now.has(el)) (el.classList.remove('lens-live'), delete el.__lensV);
      for (const el of now) if (!live.has(el)) el.classList.add('lens-live');
      live = now;

      // the clock: redraw the type plane only when it moved or the minute turned
      const c = clockSpec();
      const d = new Date();
      if (c && (c.t || c.d)) {
        const o = c.t || c.d;
        const rel = (q) => (q ? `${Math.round(q.x - o.x)},${Math.round(q.y - o.y)},${q.size}` : '');
        const key = `${fmtTime(d)}|${W}x${H}|${rel(c.t)}|${rel(c.d)}`;
        if (key !== type.key) {
          type.key = key;
          type.ox = o.x;
          type.oy = o.y;
          s.texture('u_type', typeCanvas(W, H, { time: fmtTime(d), date: fmtDate(d), t: c.t, d: c.d }), 1);
        }
        s.set('u_typeOff', [o.x - type.ox, o.y - type.oy]);
      }
      const want = c ? opacityOf(c.el) : 0;
      type.a += (want - type.a) * 0.18;

      // at the adaptive floor (a struggling GPU) the rim skips its RGB split
      s.set('u_q', s.stats.scale > 0.6 ? 1 : 0);
      set(s, rects, meta, dyn, n, glow, type.a);
    });
    s.start();
    window.__lens = s.stats;
    return () => {
      for (const el of live) el.classList.remove('lens-live');
      s.destroy();
      api.current = null;
    };
  }, [on]);

  // the photograph
  useEffect(() => {
    const s = api.current;
    if (!on || !s) return undefined;
    if (!src) {
      s.texture('u_tex', fallbackCanvas(dark), 0);
      const t = setTimeout(() => setReady(true), 400);
      return () => clearTimeout(t);
    }
    let dead = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const load = () => {
      if (dead || !img.naturalWidth) return;
      s.texture('u_tex', photoCanvas(img, innerWidth, innerHeight), 0);
      setReady(true);
    };
    img.onload = load;
    img.onerror = () => {
      if (dead) return;
      s.texture('u_tex', fallbackCanvas(dark), 0);
      setReady(true);
    };
    img.src = src;
    const onResize = () => img.complete && load();
    window.addEventListener('resize', onResize);
    return () => {
      dead = true;
      window.removeEventListener('resize', onResize);
    };
  }, [on, src, dark]);

  return (
    <div className="lens-scene" aria-hidden="true">
      {on ? (
        <canvas ref={ref} className="lens-canvas" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.7s ease' }} />
      ) : (
        <LiteScene src={src} focused={focused} dark={dark} />
      )}
    </div>
  );
}

function set(s, rects, meta, dyn, n, glow, typeA) {
  s.set('u_rects', rects);
  s.set('u_meta', meta);
  s.set('u_dyn', dyn);
  s.set('u_count', n);
  glow.t += ((touching.get() ? 1 : 0) - glow.t) * 0.12;
  s.set('u_touch', glow.t);
  s.set('u_light', [lightX.get(), lightY.get()]);
  s.set('u_tilt', [tiltX.get(), tiltY.get()]);
  s.set('u_dof', dofV.get());
  s.set('u_dim', dimV.get());
  s.set('u_typeA', typeA);
  s.set('u_theme', document.documentElement.dataset.theme === 'light' ? 1 : 0);
}

// Lite: the photo sharp, and a blur that costs nothing while something is
// open — drawn once into a tiny canvas and scaled up (bilinear = soft).
function LiteScene({ src, focused, dark }) {
  const [blur, setBlur] = useState('');
  useEffect(() => {
    if (!src) return undefined;
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = Math.round((48 * img.height) / img.width);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try {
        setBlur(c.toDataURL('image/jpeg', 0.8));
      } catch {
        setBlur('');
      }
    };
    img.src = src;
    return () => {
      dead = true;
    };
  }, [src]);
  return (
    <>
      {src && <img src={src} alt="" className="lens-lite-photo" style={{ opacity: focused ? 0 : 1 }} />}
      {blur && <img src={blur} alt="" className="lens-lite-blur" style={{ opacity: focused ? 1 : 0 }} />}
      <div className={`lens-lite-scrim ${dark ? '' : 'light'} ${focused ? '' : 'open'}`} />
    </>
  );
}
