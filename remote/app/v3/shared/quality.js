import { create } from 'zustand';
import { hasWebGL } from './gl.js';

// How much the v3 directions may spend: `reduce` (system/Settings reduced
// motion → no ambient animation, transitions become fades), `low` (no WebGL,
// Save-Data, a 2-core device, a battery under 20% and not charging, or
// ?q=low) → static shader frames / CSS fallbacks. ?q=low|high forces it.

const reduceMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const force = new URLSearchParams(location.search).get('q');
const readMotion = () => {
  try {
    return localStorage.getItem('mc.v2.motion') === 'reduce';
  } catch {
    return false;
  }
};

export const useQuality = create(() => ({
  reduce: !!reduceMQ?.matches || readMotion(),
  gl: hasWebGL(),
  battery: null, // { level, charging } where the browser says (not Safari)
  low: force === 'low',
}));

function resolve() {
  const s = useQuality.getState();
  const b = s.battery;
  const weakBattery = !!b && !b.charging && b.level < 0.2;
  const low =
    force === 'low' || (force !== 'high' && (!s.gl || !!navigator.connection?.saveData || (navigator.hardwareConcurrency || 8) <= 2 || weakBattery));
  useQuality.setState({ low, reduce: !!reduceMQ?.matches || readMotion() });
}

export function initQuality() {
  resolve();
  reduceMQ?.addEventListener?.('change', resolve);
  navigator.getBattery?.().then((bat) => {
    const up = () => {
      useQuality.setState({ battery: { level: bat.level, charging: bat.charging } });
      resolve();
    };
    up();
    bat.addEventListener('levelchange', up);
    bat.addEventListener('chargingchange', up);
  }).catch(() => {});
}
