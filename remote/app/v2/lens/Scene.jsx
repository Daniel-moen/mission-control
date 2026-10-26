import { useEffect, useRef, useState } from 'react';
import { useLensMode, clockLayout } from './mode.js';
import { animate, motionValue } from 'motion/react';
import { useNav } from '../lib/nav.js';
import { usePrefs } from '../lib/prefs.js';
import { createScene, photoCanvas, fallbackCanvas, typeCanvas, MAX } from './scene.js';
import { useBackdrop } from './backdrop.js';
import { useTilt, tiltX, tiltY, lightX, lightY, touching } from './tilt.js';
import { hasWebGL } from './gl.js';

// Lens (task 0445): the scene behind the whole app (see scene.js). Mounted
// once at the root, under everything. It decides, per moment:
//   • depth of field + dimming: Home's root is the open scene (sharp photo,
//     the time); every other page racks focus off it and darkens it so text
//     reads on any photograph; an overlay pulls focus further
//   • which panes are glass: [data-lens], .v-card, .v-tile on screen, the
//     first MAX of them; each frame their rects (post-transform, post-scroll)
//     and opacity (through every animating ancestor) feed the shader. The
//     ones it draws get .lens-live (their CSS glass steps aside); the rest
//     keep CSS glass — so nothing is ever left bare
//   • lite glass (reduced motion, low power, or chosen in Settings): no
//     shader at all — a pre-blurred photo (drawn once, tiny, upscaled: blur
//     for free) under CSS smoked glass with no backdrop-filter

export const SEL = '[data-lens], .v-card, .v-tile';
const NO = '[role="dialog"], [data-no-lens], [data-sheet], .v-bar';

const dofV = motionValue(0);
const dimV = motionValue(0.2);
const typeV = motionValue(1);
export const sceneState = { dof: dofV, dim: dimV, type: typeV };

function useFocus() {
  const homeRoot = useNav((s) => s.tab === 'home' && s.stacks.home.length === 1 && !s.overlay);
  const overlay = useNav((s) => !!s.overlay);
  const reduce = usePrefs((s) => s.reduce);
  useEffect(() => {
    const sp = reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 110, damping: 22 };
    animate(dofV, homeRoot ? 0 : overlay ? 4.2 : 3.2, sp);
    animate(dimV, homeRoot ? 0.18 : 1, sp);
    animate(typeV, homeRoot ? 1 : 0, reduce ? { duration: 0.15 } : { duration: homeRoot ? 0.6 : 0.25 });
  }, [homeRoot, overlay, reduce]);
  return homeRoot;
}

// Effective opacity of an element: the product of every inline opacity on
// the way up (tab fades, page pushes, zoom fades all write inline styles).
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
  const lite = usePrefs((s) => s.lite);
  const dark = usePrefs((s) => s.dark);
  const src = useBackdrop((s) => s.src);
  const dimPick = useBackdrop((s) => s.pick.dim);
  const [gl] = useState(hasWebGL);
  const homeRoot = useFocus();
  useTilt();
  const on = gl && !lite;
  const api = useRef(null);
  // the canvas fades in once its photograph is on the GPU
  const [ready, setReady] = useState(false);

  // ---- the shader -----------------------------------------------------------
  useEffect(() => {
    const mode = (gl2) => {
      document.documentElement.dataset.lensmode = gl2 ? 'gl' : 'css';
      useLensMode.setState({ gl: gl2 });
    };
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
    s.texture('u_tex', fallbackCanvas(true), 0);
    const rects = new Float32Array(MAX * 4);
    const meta = new Float32Array(MAX * 4);
    const alpha = new Float32Array(MAX);
    const glow = { t: 0 };
    let live = new Set();
    s.setFrame((_now, _dt, set) => {
      const H = innerHeight;
      const W = innerWidth;
      const els = document.querySelectorAll(SEL);
      const now = new Set();
      let n = 0;
      for (let i = 0; i < els.length && n < MAX; i++) {
        const el = els[i];
        if (el.__lensNo === undefined) el.__lensNo = !!el.closest(NO) || !!el.parentElement?.closest(SEL);
        if (el.__lensNo) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < -30 || r.top > H + 30 || r.right < -30 || r.left > W + 30 || r.width < 8 || r.height < 8) continue;
        const op = opacityOf(el);
        if (op < 0.02) continue;
        alpha[n] = op;
        rects[n * 4] = r.left;
        rects[n * 4 + 1] = r.top;
        rects[n * 4 + 2] = r.width;
        rects[n * 4 + 3] = r.height;
        if (el.__lensR === undefined) el.__lensR = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 20;
        meta[n * 4] = Math.min(el.__lensR, r.height / 2, r.width / 2);
        meta[n * 4 + 1] = +(el.dataset.frost || 0);
        meta[n * 4 + 2] = el.dataset.amber ? 1 : 0;
        meta[n * 4 + 3] = +(el.dataset.depth || 0.6);
        now.add(el);
        n++;
      }
      // .lens-live only changes on the frames a pane joins or leaves.
      for (const el of live) if (!now.has(el)) el.classList.remove('lens-live');
      for (const el of now) if (!live.has(el)) el.classList.add('lens-live');
      live = now;
      set('u_rects', rects);
      set('u_meta', meta);
      set('u_alpha', alpha, '1fv');
      set('u_count', n);
      glow.t += ((touching.get() ? 1 : 0) - glow.t) * 0.12;
      set('u_touch', glow.t);
      set('u_light', [lightX.get(), lightY.get()]);
      set('u_tilt', [tiltX.get(), tiltY.get()]);
      set('u_dof', dofV.get());
      set('u_dim', Math.min(1, dimV.get() + (api.current?.extraDim || 0)));
      set('u_typeA', typeV.get());
      set('u_theme', document.documentElement.dataset.theme === 'light' ? 1 : 0);
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
      const t = setTimeout(() => setReady(true), 400); // the manifest may still be on its way
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

  // the user's own dimming of the photo
  useEffect(() => {
    if (api.current) api.current.extraDim = typeof dimPick === 'number' ? Math.max(0, dimPick - 0.2) : 0;
  }, [dimPick, on]);

  // the time, set huge (redrawn on the minute and on resize)
  useEffect(() => {
    const s = api.current;
    if (!on || !s) return undefined;
    const draw = () => {
      const d = new Date();
      s.texture('u_type', typeCanvas(innerWidth, innerHeight, {
        time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
        layout: clockLayout(),
      }), 1);
    };
    draw();
    document.fonts?.ready.then(draw);
    const t = setInterval(draw, 10000);
    window.addEventListener('resize', draw);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', draw);
    };
  }, [on]);

  return (
    <div className="lens-scene" aria-hidden="true">
      {on ? <canvas ref={ref} className="lens-canvas" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.7s ease' }} /> : <LiteScene src={src} homeRoot={homeRoot} dark={dark} />}
    </div>
  );
}

// Lite: the photo sharp on Home, and a blur that costs nothing elsewhere —
// drawn once into a tiny canvas and scaled up (bilinear = soft).
function LiteScene({ src, homeRoot, dark }) {
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
      {src && <img src={src} alt="" className="lens-lite-photo" style={{ opacity: homeRoot ? 1 : 0 }} />}
      {blur && <img src={blur} alt="" className="lens-lite-blur" style={{ opacity: homeRoot ? 0 : 1 }} />}
      <div className={`lens-lite-scrim ${dark ? '' : 'light'} ${homeRoot ? 'home' : ''}`} />
    </>
  );
}
