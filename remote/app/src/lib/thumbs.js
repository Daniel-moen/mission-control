// Listing photos and external images in rendered docs (task 0070). md.js marks
// them: <button class="md-thumb" data-thumb="<page>"> in front of a listing
// link, <img class="md-img" data-img="<url>"> for ![](…). This fills them in
// through the relay (thumbs.js on the server), which fetches, shrinks where it
// can, and caches for a week.
//
// Loading: only what's near the screen (IntersectionObserver), at most 4
// requests at a time, each photo once per page load (a blob: URL cache shared
// by the Library reader and the viewer). A page with no photo → the button
// goes and the plain link stays, exactly as before.
//
// Tapping a photo opens the show-url viewer on the listing's card with its
// gallery; a long press (or the link text) opens the page itself.
import { useEffect } from 'react';
import { getMC } from './store.js';
import { showUrl } from './panelCommands.js';

const CONCURRENCY = 4;
const LONG_PRESS_MS = 550;
const CACHE_MAX = 250;

const cache = new Map(); // endpoint url → blob: URL, or '' for "no photo"
const inflight = new Map();
const waiting = [];
let running = 0;

function pump() {
  while (running < CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    running += 1;
    job()
      .catch(() => {})
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function remember(key, v) {
  cache.set(key, v);
  while (cache.size > CACHE_MAX) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    if (old) URL.revokeObjectURL(old);
  }
}

// A blob: URL for this endpoint, '' when there's nothing to show.
export function loadImage(endpoint) {
  if (cache.has(endpoint)) return Promise.resolve(cache.get(endpoint));
  if (inflight.has(endpoint)) return inflight.get(endpoint);
  const p = new Promise((resolve) => {
    waiting.push(async () => {
      let out = '';
      try {
        const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${getMC().token}` } });
        if (r.status === 200 && /^image\//.test(r.headers.get('content-type') || '')) out = URL.createObjectURL(await r.blob());
        // Transient trouble (relay down, 5xx) isn't remembered: next open tries again.
        if (out || r.status === 204 || r.status === 400 || r.status === 404) remember(endpoint, out);
      } catch {}
      resolve(out);
    });
    pump();
  }).finally(() => inflight.delete(endpoint));
  inflight.set(endpoint, p);
  return p;
}

export const thumbEndpoint = (page) => `/api/v1/thumb?url=${encodeURIComponent(page)}`;
export const imgEndpoint = (src) => `/api/v1/img?url=${encodeURIComponent(src)}`;

function fill(el) {
  if (el.dataset.state) return;
  el.dataset.state = 'loading';
  if (el.classList.contains('md-thumb')) {
    loadImage(thumbEndpoint(el.dataset.thumb)).then((src) => {
      if (!el.isConnected) return;
      if (!src) {
        el.remove(); // no photo: the plain link, as before
        return;
      }
      const img = el.querySelector('img');
      img.onload = () => (el.dataset.state = 'ok');
      img.onerror = () => el.remove();
      img.src = src;
    });
  } else {
    const orig = el.dataset.img;
    loadImage(imgEndpoint(orig)).then((src) => {
      if (!el.isConnected) return;
      el.dataset.state = src ? 'ok' : 'failed';
      el.src = src || orig; // the relay couldn't: let the browser try the original
    });
  }
}

function openOut(url) {
  try {
    window.open(url, '_blank', 'noopener');
  } catch {}
}

// Wire up one rendered doc. `root` is the <article> element — held in state
// via a callback ref, because the reader mounts it late (AnimatePresence
// mode="wait"); `html` re-runs the wiring when the content changes.
export function useDocImages(root, html) {
  useEffect(() => {
    if (!root) return;
    const els = [...root.querySelectorAll('.md-thumb[data-thumb], img.md-img[data-img]')];
    // Watched against the doc's own scroller (a viewport root would clip at
    // its edge and ignore the margin), by table row — a photo in a far-right
    // column sits outside the table's sideways scroll, but its row is on
    // screen, so it loads with the row.
    let io = null;
    if (els.length) {
      const targets = new Map(); // observed element → the photos it brings in
      for (const el of els) {
        const t = el.closest('tr') || el;
        targets.set(t, [...(targets.get(t) || []), el]);
      }
      if (typeof IntersectionObserver === 'undefined') els.forEach(fill);
      else {
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              io.unobserve(e.target);
              (targets.get(e.target) || []).forEach(fill);
            }
          },
          { root: root.closest('[data-reader]'), rootMargin: '500px 0px' }
        );
        targets.forEach((_, t) => io.observe(t));
      }
    }

    // Tap → the listing's card; long press → the page itself.
    let press = null;
    const down = (e) => {
      const b = e.target.closest?.('.md-thumb');
      if (!b || !root.contains(b)) return;
      const url = b.dataset.thumb;
      const x = e.clientX;
      const y = e.clientY;
      press = { b, x, y, fired: false, timer: setTimeout(() => {
        press.fired = true;
        openOut(url);
      }, LONG_PRESS_MS) };
    };
    const move = (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
        clearTimeout(press.timer);
        press = { ...press, moved: true };
      }
    };
    const up = () => press && clearTimeout(press.timer);
    const click = (e) => {
      const b = e.target.closest?.('.md-thumb');
      if (!b || !root.contains(b)) return;
      e.preventDefault();
      e.stopPropagation();
      const p = press;
      press = null;
      if (p && p.b === b && (p.fired || p.moved)) return;
      showUrl(b.dataset.thumb, { byYou: true });
    };
    const menu = (e) => e.target.closest?.('.md-thumb') && e.preventDefault();
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('click', click);
    root.addEventListener('contextmenu', menu);
    return () => {
      io?.disconnect();
      if (press) clearTimeout(press.timer);
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      root.removeEventListener('click', click);
      root.removeEventListener('contextmenu', menu);
    };
  }, [root, html]);
}
