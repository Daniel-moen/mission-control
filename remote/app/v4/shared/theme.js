import { create } from 'zustand';

// v4 (task 0446): dark + light, following the system unless the device chose
// (same key as v2's Appearance setting). ?theme=light|dark forces it.
const KEY = 'mc.v2.theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const pick = () => {
  const f = new URLSearchParams(location.search).get('theme');
  if (f === 'light' || f === 'dark') return f;
  let t = 'system';
  try {
    t = localStorage.getItem(KEY) || 'system';
  } catch {}
  return t === 'system' ? (mq?.matches === false ? 'light' : 'dark') : t;
};
export const useTheme = create(() => ({ theme: 'dark' }));
function apply() {
  const theme = pick();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0b0d' : '#f2efe8');
  useTheme.setState({ theme });
}
export function initTheme() {
  apply();
  mq?.addEventListener?.('change', apply);
}
export function toggleTheme() {
  const next = useTheme.getState().theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  apply();
}
