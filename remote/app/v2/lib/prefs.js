import { create } from 'zustand';

// This device's v2 preferences — theme, motion, and which front end it runs.
// All local (localStorage); nothing goes to the relay.

const LS_THEME = 'mc.v2.theme'; // 'system' | 'light' | 'dark' (next-v2/app/layout.jsx reads it before paint)
const LS_MOTION = 'mc.v2.motion'; // 'system' | 'reduce'
const LS_UI = 'mc.ui'; // 'v1' | 'v2' (both front ends' HTML read it)
const LS_GLASS = 'mc.v2.glass'; // 'auto' | 'full' | 'lite' — Lens glass quality

const read = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode — this visit only */
  }
};

const darkMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const reduceMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export const usePrefs = create(() => ({
  theme: read(LS_THEME, 'system'),
  motion: read(LS_MOTION, 'system'),
  glass: read(LS_GLASS, 'auto'),
  dark: true, // resolved
  reduce: !!reduceMQ?.matches, // resolved
  // Lens: render the cheap glass (static frosted scene, no shader panes, no
  // backdrop blur) — chosen, or on reduced motion / low power (resolved).
  lite: false,
  battery: null,
}));

function resolve() {
  const { theme, motion } = usePrefs.getState();
  const dark = theme === 'dark' || (theme === 'system' && (darkMQ ? darkMQ.matches : true));
  const reduce = motion === 'reduce' || !!reduceMQ?.matches;
  const { glass, battery } = usePrefs.getState();
  const weak = !!battery && !battery.charging && battery.level < 0.2;
  const lowPower = !!navigator.connection?.saveData || (navigator.hardwareConcurrency || 8) <= 2 || weak;
  const lite = glass === 'lite' || (glass === 'auto' && (reduce || lowPower));
  const root = document.documentElement;
  root.dataset.glass = lite ? 'lite' : 'full';
  root.dataset.theme = dark ? 'dark' : 'light';
  // The status bar / Safari chrome follows the page, not the OS.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.setAttribute('content', dark ? '#08080a' : '#e9e7e2');
    m.removeAttribute('media');
  }
  usePrefs.setState({ dark, reduce, lite });
}

export function initPrefs() {
  document.documentElement.classList.add('v2');
  resolve();
  darkMQ?.addEventListener?.('change', resolve);
  reduceMQ?.addEventListener?.('change', resolve);
  // Battery (where the browser tells — not Safari): under 20% and not
  // charging counts as low power.
  navigator.getBattery?.()
    .then((b) => {
      const up = () => {
        usePrefs.setState({ battery: { level: b.level, charging: b.charging } });
        resolve();
      };
      up();
      b.addEventListener('levelchange', up);
      b.addEventListener('chargingchange', up);
    })
    .catch(() => {});
}

export function setGlass(glass) {
  write(LS_GLASS, glass);
  usePrefs.setState({ glass });
  resolve();
}

export function setTheme(theme) {
  write(LS_THEME, theme);
  usePrefs.setState({ theme });
  resolve();
}

export function setMotionPref(motion) {
  write(LS_MOTION, motion);
  usePrefs.setState({ motion });
  resolve();
}

// Flip this device to the other front end. The relay serves the one the
// mc_ui cookie names at the same URL, so the hash (where you are) carries over.
export function switchUi(ui) {
  write(LS_UI, ui);
  document.cookie = `mc_ui=${ui}; path=/; max-age=31536000; samesite=lax`;
  location.replace(`/?ui=${ui}${location.hash}`);
}
