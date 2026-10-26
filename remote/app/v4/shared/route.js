import { useEffect, useSyncExternalStore } from 'react';

// v4 (task 0446): what's open lives in the hash — #mia, #agent/<id>,
// #doc/<id>, #need/<id>, #task/<id>, #tasks, #pulse — so a reload, a push to
// /#mia, Mia's `mia panel open-…` and the browser's Back all land the same
// way in every direction. Each direction decides what "open" looks like.
const sub = (f) => {
  window.addEventListener('hashchange', f);
  return () => window.removeEventListener('hashchange', f);
};
const read = () => location.hash.replace(/^#/, '');
export const parse = (h) => {
  const [kind = '', ...rest] = decodeURIComponent(h || '').split('/');
  return { kind, id: rest.join('/') };
};
export function useRoute() {
  const h = useSyncExternalStore(sub, read, () => '');
  return parse(h);
}
export const routeKey = (kind, id) => (id ? `${kind}/${id}` : kind);

export function openRoute(kind, id) {
  const h = routeKey(kind, id);
  if (read() === h) return;
  // Opening on top of something already open replaces it, so one Back always
  // returns to the entry screen.
  if (read() && history.state?.v4) history.replaceState({ v4: true }, '', `#${encodeURI(h)}`);
  else history.pushState({ v4: true }, '', `#${encodeURI(h)}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
export function closeRoute() {
  if (!read()) return;
  if (history.state?.v4) {
    history.back();
    setTimeout(() => {
      if (read()) strip();
    }, 220);
  } else strip();
}
function strip() {
  history.replaceState(null, '', location.pathname + location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
// Esc closes whatever is open (iPad with a keyboard).
export function useEscCloses() {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && closeRoute();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
}
