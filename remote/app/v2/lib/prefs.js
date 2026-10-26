import { create } from 'zustand';

// This device's v2 preferences — theme, motion, and which front end it runs.
// All local (localStorage); nothing goes to the relay.

const LS_THEME = 'mc.v2.theme'; // 'system' | 'light' | 'dark' (next-v2/app/layout.jsx reads it before paint)
const LS_MOTION = 'mc.v2.motion'; // 'system' | 'reduce'
const LS_UI = 'mc.ui'; // 'v1' | 'v2' (both front ends' HTML read it)

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
  dark: true, // resolved
  reduce: !!reduceMQ?.matches, // resolved
}));

function resolve() {
  const { theme, motion } = usePrefs.getState();
  const dark = theme === 'dark' || (theme === 'system' && (darkMQ ? darkMQ.matches : true));
  const reduce = motion === 'reduce' || !!reduceMQ?.matches;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  // The status bar / Safari chrome follows the page, not the OS.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.setAttribute('content', dark ? '#0b0b0d' : '#f4f3ef');
    m.removeAttribute('media');
  }
  usePrefs.setState({ dark, reduce });
}

export function initPrefs() {
  document.documentElement.classList.add('v2');
  resolve();
  darkMQ?.addEventListener?.('change', resolve);
  reduceMQ?.addEventListener?.('change', resolve);
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
