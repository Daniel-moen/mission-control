// Self-update for installed panels (task 0126). An iPad/phone Home Screen app
// stays in memory for days and never re-requests index.html, so a deploy
// didn't reach it: Daniel kept running the bundle from before Library images,
// which pointed <img> at the panel's own /assets/x.jpg (a 404) instead of the
// relay's doc-asset store. Now the bundle knows its build id (vite.config.mjs),
// asks /version.json now and then, and when a newer build is live it reloads
// at a moment nobody notices:
//   - the app comes back to the foreground (it was hidden — nothing to lose);
//   - or it's on screen but untouched for a minute.
// Never while typing (a focused field) or in a voice talk session.
import { getTalk } from './talkSession.js';

/* global __MC_BUILD__ */
export const BUILD = typeof __MC_BUILD__ !== 'undefined' ? __MC_BUILD__ : 'dev';

const CHECK_EVERY_MS = 5 * 60000;
const MIN_GAP_MS = 15000;
const IDLE_MS = 60000;

let newer = '';
let lastCheck = 0;
let lastTouch = Date.now();
let started = false;

function busy() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
  try {
    if (getTalk().on) return true;
  } catch {}
  return false;
}

function reloadIfQuiet(force = false) {
  if (!newer || document.visibilityState === 'hidden' || busy()) return;
  if (!force && Date.now() - lastTouch < IDLE_MS) return;
  newer = '';
  location.reload();
}

// Ask the relay which build is live. Cheap (a tiny no-store JSON file).
export async function checkForUpdate({ returning = false } = {}) {
  if (BUILD === 'dev') return;
  if (newer) return reloadIfQuiet(returning);
  if (Date.now() - lastCheck < MIN_GAP_MS) return;
  lastCheck = Date.now();
  try {
    const r = await fetch('/version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && typeof j.build === 'string' && j.build && j.build !== BUILD) {
      newer = j.build;
      reloadIfQuiet(returning);
    }
  } catch {}
}

export function initUpdates() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const touch = () => (lastTouch = Date.now());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate({ returning: true });
  });
  window.addEventListener('pageshow', (e) => e.persisted && checkForUpdate({ returning: true }));
  setInterval(() => checkForUpdate(), CHECK_EVERY_MS);
  setInterval(() => reloadIfQuiet(), 15000);
  setTimeout(() => checkForUpdate(), 5000);
}
