import { useEffect, useRef, useState } from 'react';
import { animate, motionValue } from 'motion/react';
import { hasWebGL } from '../v2/lens/gl.js';
import { fallbackCanvas } from '../v2/lens/scene.js';
import { initBackdrop, useBackdrop } from '../v2/lens/backdrop.js';
import { useTilt, tiltX, tiltY, lightX, lightY, touching } from '../v2/lens/tilt.js';
import { useLensMode } from '../v2/lens/mode.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { useNav, navOpts } from '../v2/lib/nav.js';
import { useQuality } from '../v3/shared/quality.js';
import { createScene, photoTexture, MAX } from './lens.js';
import { installScrollSync, scrollGate } from '../v2/lens/scrollsync.js';
import { lights, tick } from './ambient.js';

// v5.3 (task 0502): v5's scene with v5.3's shader (lens.js — the moving
// light inside the scene, highlights that answer scroll). Below, as in v5:
//
// v5 (task 0483): v4's Lens scene (0448/0458 — the refracting glass shader,
// v4/shared/lens.js) under v1's structure. The photograph fills the screen;
// every top-level pane — a window, the dock, Home's cards and figures, the
// top bar's pills — is drawn by the shader as real glass (a convex rim that
// bends the photo, a frosted body, the light catching the edge). Panes
// inside a window are CSS glass on that glass (v5.css), and anything that
// floats over content (sheets, menus, the toast) is CSS glass with a real
// backdrop blur: a shader pane must never have DOM content scroll under it.
// Lite (reduced motion / low power / chosen) or no WebGL: no shader — the
// photo as an <img> and CSS glass everywhere, same shapes, same tints.

export const PANES = '.v5-win, [data-lens], .v5-home .v-card, [data-v5-dock]';
export const AMBER = '[data-amber]';
export const NO = '[data-no-lens], [role="dialog"], [data-sheet], .v-menu, [data-toast], [data-conn]';

// Something is open over Home → the photo racks focus and dims a touch.
// v5.2 (task 0491, chat first) keeps the photo sharp behind its glass, so the
// panes have something to bend; only a full-screen overlay racks focus.
function useFocused() {
  return useNav((s) => (navOpts.chatFirst ? !!s.overlay : s.tab !== 'home' || s.stacks.home.length > 1 || !!s.overlay));
}

// Daylight photos for the light theme (bg/light/, as in v4). ?bg=11|12 pins one.
const LIGHT = ['11.jpg', '12.jpg'];
function lightSrc(pick) {
  if (pick.url) return pick.url;
  const pin = new URLSearchParams(location.search).get('bg');
  if (pin && LIGHT.includes(`${pin}.jpg`)) return `/bg/light/${pin}.jpg`;
  return `/bg/light/${LIGHT[(new Date().getDate() + new Date().getHours()) % LIGHT.length]}`;
}
function useSceneSrc() {
  const dark = usePrefs((s) => s.dark);
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

export default function Scene() {
  const ref = useRef(null);
  // lite (reduced motion, low power, or chosen in Settings) or a weak GPU
  // (no WebGL, 2 cores, ?q=low): CSS glass over a still photo
  const lite = usePrefs((s) => s.lite);
  const low = useQuality((s) => s.low);
  const reduce = usePrefs((s) => s.reduce);
  const dark = usePrefs((s) => s.dark);
  const src = useSceneSrc();
  const focused = useFocused();
  const [gl] = useState(hasWebGL);
  const on = gl && !low && !lite;
  const api = useRef(null);
  const [ready, setReady] = useState(false);
  // a lost WebGL context (iOS drops them under memory pressure) rebuilds the scene
  const [gen, setGen] = useState(0);
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
    document.documentElement.dataset.glass = on ? 'full' : 'lite';
    useLensMode.setState({ gl: on });
  }, [on]);

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
    const canvas = ref.current;
    const lost = (e) => e.preventDefault();
    const restored = () => setGen((g) => g + 1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    s.texture('u_tex', fallbackCanvas(document.documentElement.dataset.theme !== 'light'), 0);
    // no type plane in v5 (v1's Home sets its greeting in the DOM) — a blank one
    const blank = document.createElement('canvas');
    blank.width = blank.height = 2;
    s.texture('u_type', blank, 1);
    s.set('u_typeOff', [0, 0]);
    const rects = new Float32Array(MAX * 4);
    const meta = new Float32Array(MAX * 4);
    const dyn = new Float32Array(MAX * 4); // per pane: velocity x/y (px per 60 Hz frame), opacity, growth
    const glow = { t: 0 };
    let live = new Set();
    let booted = false;
    let drawn = new Set();
    installScrollSync();
    // how fast anything is scrolling (px per frame, signed, smoothed)
    const flow = { raw: 0, v: 0 };
    const tops = new WeakMap();
    const onScroll = (e) => {
      const el = e.target === document ? document.scrollingElement : e.target;
      if (!el || el.scrollTop == null) return;
      const was = tops.get(el);
      tops.set(el, el.scrollTop);
      if (was != null) flow.raw += el.scrollTop - was;
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // the shader's pane fades in over the hand-over from CSS glass (task 0503;
    // v53.css melts the CSS glass over the same 260 ms) instead of one frame
    const IN_MS = 260;
    const amb = new Float32Array(12);
    // frost blur is a mip bias, i.e. in canvas px: hold it in CSS px (lens.js)
    const refPx = Math.min(devicePixelRatio || 1, 1.5);
    const ambC = new Float32Array(12);
    s.setFrame((t, dt) => {
      // the moving light and the scroll's lean, before anything else
      tick(dt);
      const fr0 = Math.min(4, Math.max(0.25, dt / 16.7));
      flow.v += (flow.raw / fr0 - flow.v) * 0.25;
      flow.raw = 0;
      const L3 = lights(innerWidth, innerHeight, document.documentElement.dataset.theme !== 'light');
      for (let j = 0; j < 3; j++) {
        amb.set(L3[j].slice(0, 4), j * 4);
        ambC.set([...L3[j].slice(4, 7), 0], j * 4);
      }
      s.set('u_amb', amb);
      s.set('u_ambC', ambC);
      s.set('u_flow', Math.max(-1, Math.min(1, flow.v / 24)));
      s.set('u_lodK', Math.max(0, Math.log2((s.stats.dpr * s.stats.scale) / refPx)));
      window.__flow = flow.v;
      const fr = Math.min(4, Math.max(0.25, dt / 16.7));
      const H = innerHeight;
      const W = innerWidth;
      const els = document.querySelectorAll(PANES);
      const now = new Set();
      const drawnNow = new Set();
      let n = 0;
      let scrolled = 0;
      for (let i = 0; i < els.length && n < MAX; i++) {
        const el = els[i];
        if (el.__lensNo === undefined) el.__lensNo = !!el.closest(NO) || !!el.parentElement?.closest(PANES);
        if (el.__lensNo) continue;
        // v5.2: a pane flying over other glass, or a sheet over the chat, is CSS glass for now
        if (el.closest('[data-lens-off]')) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < -30 || r.top > H + 30 || r.right < -30 || r.left > W + 30 || r.width < 8 || r.height < 8) continue;
        // a pane inside a moving scroller shows its CSS glass (scrollsync.js)
        const f = scrollGate(el, t, dt);
        const op = opacityOf(el) * f;
        if (op < 0.02) {
          if (f < 0.02) scrolled++;
          continue;
        }
        // a page's window newly handed to the shader fades in (not one drawn
        // last frame; not the bar, the composer or the lens, which never hand over)
        let fin = 1;
        if (el.classList.contains('v5-win')) {
          if (!drawn.has(el)) el.__lensIn = booted ? 0 : 1;
          fin = el.__lensIn = Math.min(1, el.__lensIn + Math.max(dt, 1) / IN_MS);
          drawnNow.add(el);
        }
        dyn[n * 4 + 2] = op * fin * fin * (3 - 2 * fin);
        // data-lens-bleed: a full-screen pane (0503's chat) reaches past the
        // screen's edges, so its rim — the bend and the bright line — is off it
        const bl = el.dataset.lensBleed ? +el.dataset.lensBleed : 0;
        rects[n * 4] = r.left - bl;
        rects[n * 4 + 1] = r.top - bl;
        rects[n * 4 + 2] = r.width + 2 * bl;
        rects[n * 4 + 3] = r.height + 2 * bl;
        // data-lens-r: a radius that changes (0503's full-bleed chat is square)
        if (el.dataset.lensR) el.__lensR = +el.dataset.lensR;
        else if (el.__lensR === undefined) el.__lensR = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 22;
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
        // its CSS glass steps aside once the shader's is most of the way back
        if (f >= 0.5) now.add(el);
        n++;
      }
      window.__lensScrolled = scrolled;
      for (const el of live) if (!now.has(el)) (el.classList.remove('lens-live'), delete el.__lensV);
      drawn = drawnNow;
      booted = true;
      for (const el of now) if (!live.has(el)) el.classList.add('lens-live');
      live = now;

      // at the adaptive floor (a struggling GPU) the rim skips its RGB split
      s.set('u_q', s.stats.scale > 0.6 ? 1 : 0);
      set(s, rects, meta, dyn, n, glow, 0, flow.v);
    });
    // pre-warm: draw once now, so the program is compiled and the textures
    // are on the GPU before anything is shown (the canvas is still at 0 opacity)
    s.draw();
    s.start();
    window.__lens = s.stats;
    window.__lensLive = () => live.size;
    return () => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      window.removeEventListener('scroll', onScroll, { capture: true });
      for (const el of live) el.classList.remove('lens-live');
      s.destroy();
      api.current = null;
    };
  }, [on, gen]);

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
      // at the canvas's device resolution (task 0503), not CSS px
      const px = Math.max(1, s.stats.dpr || 1);
      const tex = photoTexture(img, innerWidth, innerHeight, px);
      s.texture('u_tex', tex, 0);
      s.draw();
      window.__lensTex = [tex.width, tex.height];
      setReady(true);
    };
    // decoded off the main thread before the upload, so it never janks a frame
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(load);
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
  }, [on, src, dark, gen]);

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

function set(s, rects, meta, dyn, n, glow, typeA, flow = 0) {
  s.set('u_rects', rects);
  s.set('u_meta', meta);
  s.set('u_dyn', dyn);
  s.set('u_count', n);
  glow.t += ((touching.get() ? 1 : 0) - glow.t) * 0.12;
  s.set('u_touch', glow.t);
  // the light leans against the scroll: rims sweep as content moves under them
  s.set('u_light', [lightX.get(), lightY.get() - Math.max(-220, Math.min(220, flow * 9))]);

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
