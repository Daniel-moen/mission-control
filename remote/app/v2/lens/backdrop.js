import { create } from 'zustand';

// Lens (task 0445): which photograph the scene is built on. Shared with v1
// (same localStorage key and event), so a pick in either front end holds in
// both: { file } pins one of the bundled photos, { url } any image, nothing =
// follow the time of day. `dim` darkens it (0…0.6).

const LS_KEY = 'mc.backdrop';
export const read = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {};
  } catch {
    return {};
  }
};

export function toneNow(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

export const useBackdrop = create(() => ({ pick: read(), list: [], src: '' }));

let manifest = null;
// ?bg=NN pins a photo for this visit (screenshots, demos) — read at load,
// before the token handling tidies the address bar.
const pinned = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('bg') : null;
function resolveSrc() {
  const { pick } = useBackdrop.getState();
  if (pinned) return `/bg/${pinned.padStart(2, '0')}.jpg`;
  if (pick.url) return pick.url;
  const list = manifest || [];
  if (pick.file && list.some((e) => e.file === pick.file)) return `/bg/${pick.file}`;
  if (!list.length) return '';
  const pool = list.filter((e) => e.tone === toneNow());
  const set = pool.length ? pool : list;
  // Stable within the hour, so a reload doesn't reshuffle the scene.
  const k = new Date().getHours() + new Date().getDate() * 24;
  return `/bg/${set[k % set.length].file}`;
}
const update = () => useBackdrop.setState({ src: resolveSrc() });

export function initBackdrop() {
  fetch('/bg/manifest.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => {
      manifest = Array.isArray(list) ? list : [];
      useBackdrop.setState({ list: manifest });
      update();
    })
    .catch(() => update());
  const sync = () => {
    useBackdrop.setState({ pick: read() });
    update();
  };
  window.addEventListener('mc:backdrop', sync);
  window.addEventListener('storage', (e) => e.key === LS_KEY && sync());
  // The tone changes through the day: re-pick on the hour.
  setInterval(() => !useBackdrop.getState().pick.file && !useBackdrop.getState().pick.url && update(), 10 * 60e3);
  update();
}

export function setBackdrop(patch) {
  const next = { ...read(), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new CustomEvent('mc:backdrop'));
}
