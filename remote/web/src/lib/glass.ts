// Shared state for the Liquid Glass layer (v6.2):
//  - one scene clock, so the backdrop shader and the glass lenses that refract
//    it show the exact same moment of the flowing light
//  - the photo's slow drift, computed here (not a CSS animation) so the lens
//    shader can sample the photo at the same place the page shows it
//  - the light: an angle that slowly orbits, bent toward the finger/pointer and
//    (when allowed) toward the way the device is tilted
//  - the registry of floating "lens" controls (dock, top pills, composer…) the
//    WebGL layer draws refraction + specular rims for
//  - the 'calm' switch: no shaders, no drift, no moving light

import { create } from 'zustand';

// ---- calm -----------------------------------------------------------------
const CALM_KEY = 'mc6_calm';
const TILT_KEY = 'mc6_tilt';
export const useGlassPrefs = create<{ calm: boolean; tilt: boolean; gl: boolean }>(() => ({ calm: false, tilt: false, gl: false }));

export function initGlassPrefs() {
  if (typeof window === 'undefined') return;
  const v = localStorage.getItem(CALM_KEY);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const calm = v === null ? reduce : v === '1';
  const tilt = localStorage.getItem(TILT_KEY) === '1';
  useGlassPrefs.setState({ calm, tilt });
  document.documentElement.classList.toggle('calm', calm);
  if (tilt) startTilt(false);
}
export function setCalm(calm: boolean) {
  localStorage.setItem(CALM_KEY, calm ? '1' : '0');
  useGlassPrefs.setState({ calm });
  document.documentElement.classList.toggle('calm', calm);
}
export function setGlActive(gl: boolean) {
  useGlassPrefs.setState({ gl });
  document.documentElement.classList.toggle('gl-lens', gl);
}

// ---- clock & drift -----------------------------------------------------------
export const T0 = typeof performance !== 'undefined' ? performance.now() - ((Date.now() / 1000) % 9000) * 1000 : 0;
export const sceneTime = (now = performance.now()) => (now - T0) / 1000;

// Photo drift: 90 s each way, ease-in-out, scale 1.04→1.12, translate ±1.3 %.
export function drift(t: number): { s: number; tx: number; ty: number } {
  if (useGlassPrefs.getState().calm) return { s: 1.06, tx: 0, ty: 0 };
  const ph = (t / 90) % 2;
  const u = ph < 1 ? ph : 2 - ph;
  const e = u * u * (3 - 2 * u);
  return { s: 1.04 + 0.08 * e, tx: -1.2 + 2.6 * e, ty: -0.8 + 1.8 * e };
}

// Activity (agents working) speeds the liquid light up a little.
export const energy = { target: 0, value: 0 };

// ---- light ---------------------------------------------------------------------
// angle in radians, 0 = light from the right, PI/2 = from below (screen coords)
export const light = { angle: -2.3, px: -1, py: -1, pointerAt: 0, tiltX: 0, tiltY: 0, tiltAt: 0 };

if (typeof window !== 'undefined') {
  const onPtr = (e: PointerEvent) => {
    light.px = e.clientX;
    light.py = e.clientY;
    light.pointerAt = performance.now();
  };
  window.addEventListener('pointermove', onPtr, { passive: true });
  window.addEventListener('pointerdown', onPtr, { passive: true });
}

function onTilt(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  // relative to holding the phone at ~45° upright
  light.tiltX = Math.max(-1, Math.min(1, e.gamma / 35));
  light.tiltY = Math.max(-1, Math.min(1, (e.beta - 45) / 35));
  light.tiltAt = performance.now();
}
let tiltOn = false;
export async function startTilt(ask: boolean): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
  const DOE = DeviceOrientationEvent as any;
  if (typeof DOE.requestPermission === 'function') {
    if (!ask) {
      // iOS: permission must come from a tap; try once on the next tap
      const once = () => { startTilt(true); window.removeEventListener('pointerup', once); };
      window.addEventListener('pointerup', once);
      return false;
    }
    try {
      if ((await DOE.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  if (!tiltOn) window.addEventListener('deviceorientation', onTilt, { passive: true });
  tiltOn = true;
  return true;
}
export async function setTilt(on: boolean) {
  localStorage.setItem(TILT_KEY, on ? '1' : '0');
  useGlassPrefs.setState({ tilt: on });
  if (on) {
    const ok = await startTilt(true);
    if (!ok) useGlassPrefs.setState({ tilt: false });
  } else if (tiltOn) {
    window.removeEventListener('deviceorientation', onTilt);
    tiltOn = false;
  }
}

// Where the light comes from right now (unit vector, screen coords, y down).
let smooth = { x: -0.66, y: -0.75 };
export function lightDir(now: number, w: number, h: number) {
  const calm = useGlassPrefs.getState().calm;
  // base: a slow orbit around the top-left
  const base = calm ? -2.3 : -2.3 + 0.55 * Math.sin(now / 9000) + 0.25 * Math.sin(now / 3700);
  let x = Math.cos(base);
  let y = Math.sin(base);
  if (!calm && now - light.tiltAt < 1500) {
    x = x * 0.4 - light.tiltX;
    y = y * 0.4 - light.tiltY;
  } else if (!calm && light.px >= 0 && now - light.pointerAt < 4000) {
    // light comes from the finger/pointer, seen from the middle of the screen
    const k = Math.max(0, 1 - (now - light.pointerAt - 2500) / 1500);
    x = x * (1 - k) + ((light.px - w / 2) / (w / 2)) * k;
    y = y * (1 - k) + ((light.py - h / 2) / (h / 2)) * k;
  }
  const l = Math.hypot(x, y) || 1;
  smooth = { x: smooth.x + (x / l - smooth.x) * 0.08, y: smooth.y + (y / l - smooth.y) * 0.08 };
  const m = Math.hypot(smooth.x, smooth.y) || 1;
  return { x: smooth.x / m, y: smooth.y / m };
}

// ---- lens registry -------------------------------------------------------------
export interface Lens { el: HTMLElement; press: number; pressAt: number; radius: number }
export const lenses = new Set<Lens>();
export function registerLens(el: HTMLElement): Lens {
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 24;
  const l: Lens = { el, press: 0, pressAt: 0, radius: r };
  lenses.add(l);
  return l;
}
export function unregisterLens(l: Lens) {
  lenses.delete(l);
}

// ---- adaptive tint ------------------------------------------------------------------
// A tiny luminance map of the photo (filled by the lens layer once the photo
// is loaded) so each control can tell whether what's behind it is light or dark.
export const lumMap = { w: 0, h: 0, data: null as Float32Array | null };

// ---- the scene, as the lens layer needs to re-create it ------------------------------
// Tint over the photo (must match .scene-tint in globals.css):
//   radial 120% 80% at 50% 0%: alpha A0 → A1 at 70%;  linear top→bottom: B0 → B1
export const TINT = { photo: [0.03, 0.3, 0.06, 0.38], gradient: [0, 0, 0.26, 0.7] };
export const scene = { mode: 'photo' as 'photo' | 'gradient', img: null as HTMLImageElement | null, v: 0 };
export function setScenePhoto(img: HTMLImageElement | null, mode: 'photo' | 'gradient') {
  scene.img = img;
  scene.mode = mode;
  scene.v++;
  if (img) {
    // 32×32 luminance map for adaptive tint
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d', { willReadFrequently: true });
    if (!x) return;
    x.drawImage(img, 0, 0, 32, 32);
    try {
      const d = x.getImageData(0, 0, 32, 32).data;
      const out = new Float32Array(32 * 32);
      for (let i = 0; i < out.length; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      lumMap.w = lumMap.h = 32;
      lumMap.data = out;
    } catch {
      /* tainted */
    }
  }
}

// Screen (CSS px) → photo uv, matching `.scene-photo` (inset -6 %, cover, drift transform).
export function photoMap(t: number, W: number, H: number): [number, number, number, number] {
  const img = scene.img;
  if (!img || !img.naturalWidth) return [0, 0, 0, 0];
  const { s, tx, ty } = drift(t);
  const EW = W * 1.12, EH = H * 1.12, elx = -0.06 * W, ely = -0.06 * H;
  const k = Math.max(EW / img.naturalWidth, EH / img.naturalHeight);
  const offx = (EW - img.naturalWidth * k) / 2, offy = (EH - img.naturalHeight * k) / 2;
  const Cx = W / 2, Cy = H / 2, Tx = (tx / 100) * EW, Ty = (ty / 100) * EH;
  // local = (p - C)/s + C - T ; uv = (local - el - off) / (k*I)
  const ax = 1 / s / (k * img.naturalWidth), ay = 1 / s / (k * img.naturalHeight);
  const bx = (-Cx / s + Cx - Tx - elx - offx) / (k * img.naturalWidth);
  const by = (-Cy / s + Cy - Ty - ely - offy) / (k * img.naturalHeight);
  return [ax, ay, bx, by];
}
export function photoTransform(t: number) {
  const { s, tx, ty } = drift(t);
  return `scale(${s}) translate3d(${tx}%, ${ty}%, 0)`;
}
