import { useEffect, useSyncExternalStore } from 'react';

// v3 (task 0445): two screens per direction — Home and Mia — kept in the
// hash (#mia), so a reload, a push to /#mia or the Back gesture all work.
const sub = (f) => {
  window.addEventListener('hashchange', f);
  return () => window.removeEventListener('hashchange', f);
};
const get = () => (location.hash.replace(/^#/, '').split('/')[0] === 'mia' ? 'mia' : 'home');
export const useScreen = () => useSyncExternalStore(sub, get, () => 'home');
export function go(screen) {
  if (get() === screen) return;
  if (screen === 'mia') return void (location.hash = 'mia');
  const strip = () => {
    if (get() !== 'mia') return;
    history.replaceState(null, '', location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  // A real Back when we pushed #mia ourselves (so the browser's Back and
  // ours agree); if that didn't land on Home (Next's router may own the
  // entry), just drop the hash.
  if (history.state?.v3mia) {
    history.back();
    setTimeout(strip, 180);
  } else strip();
}
// Pushing #mia: remember we did, so "home" can be a real Back.
export function useHashMarks() {
  useEffect(() => {
    const f = () => {
      if (get() === 'mia' && !history.state?.v3mia) history.replaceState({ v3mia: true }, '', location.href);
    };
    f();
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
}
