import { push } from './nav.js';
import { preload } from '../shell/pages.js';

// Push a page that grows out of the element you tapped (iOS zoom transition).
// The element carries data-zoom="<id>" so the page can fly back into it.
export function zoomPush(el, name, params = {}) {
  preload(name);
  const host = el?.closest?.('[data-stack]');
  if (!el || !host) return push(name, params);
  const b = el.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const origin = { left: b.left - h.left, top: b.top - h.top, width: b.width, height: b.height };
  return push(name, { ...params, zoomId: el.dataset.zoom || '' }, { origin });
}

// onClick helper: <button data-zoom="doc:x" onClick={zoomTo('doc', { id })}>
export const zoomTo = (name, params) => (e) => zoomPush(e.currentTarget, name, params);
