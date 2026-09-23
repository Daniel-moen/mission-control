// Web Push for Mia (docs/mia.md §8–9), from the panel's side.
//
//   1. main.jsx registers /sw.js on every load (public/sw.js — shows pushes,
//      routes a tap to #mia).
//   2. The bell in the Mia header calls enablePush(): ask for Notification
//      permission (inside the tap — iOS refuses it otherwise), fetch the relay's
//      VAPID public key from GET /push/key (falling back to the snapshot's
//      mia.pushKey), subscribe the service worker's PushManager, and POST the
//      subscription to /push/subscribe. Both relay calls carry the same token the
//      WebSocket uses, as `Authorization: Bearer`.
//   3. Every later load with permission already granted re-runs step 2 silently,
//      so a relay redeploy (fresh key, empty subscription store) heals itself.
//      A subscription minted under an old key is dropped and re-made.
//
// iOS only exposes PushManager to a Home Screen web app (display: standalone,
// see public/manifest.json), so in plain Safari the state is 'install'.

import { useMC, getMC, toast } from './store.js';

const set = (push) => useMC.setState({ push });

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () =>
  navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

// 'ok' | 'install' (iOS outside a Home Screen app) | 'unsupported'
export function pushCapability() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'install' : 'unsupported';
  if (!window.isSecureContext) return 'unsupported';
  return 'ok';
}

function initialState() {
  const cap = pushCapability();
  if (cap !== 'ok') return cap;
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' ? 'working' : 'idle';
}

let regPromise = null;
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      regPromise = null;
      throw err;
    });
    // A notification tap on an already-open panel: the worker focuses the
    // window and posts the route here rather than reloading it.
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'mc-open') {
        const h = String(d.url || '#mia').split('#')[1] ?? 'mia';
        if (location.hash.replace(/^#/, '') !== h) location.hash = h;
      }
    });
  }
  return regPromise;
}

function authed(path, init = {}) {
  const token = getMC().token;
  return fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

async function vapidKey() {
  try {
    const r = await authed('/push/key');
    if (r.ok) {
      const j = await r.json();
      if (j && j.key) return String(j.key);
    }
  } catch {
    /* relay unreachable or predates push — try the snapshot */
  }
  const k = getMC().mia?.pushKey;
  if (k) return k;
  throw new Error('The relay has no push key yet');
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameKey(sub, bytes) {
  const cur = sub.options && sub.options.applicationServerKey;
  if (!cur) return true; // browser won't say — trust it
  const a = new Uint8Array(cur);
  if (a.length !== bytes.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
  return true;
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || isIOS() ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : 'Browser';
  return `${kind}${standalone() ? ' (Home Screen)' : ''}`;
}

// A push service that never answers (some desktop builds, flaky networks)
// must not leave the bell spinning forever.
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

async function subscribeAndPost() {
  await registerServiceWorker();
  const reg = await withTimeout(navigator.serviceWorker.ready, 10000, 'Service worker');
  const key = b64urlToBytes(await vapidKey());
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    // The relay's key changed (redeploy without pinned VAPID env) — the old
    // subscription can never be delivered to again.
    try { await sub.unsubscribe(); } catch {}
    sub = null;
  }
  if (!sub)
    sub = await withTimeout(
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
      20000,
      'Push subscription',
    );
  const r = await authed('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ ...sub.toJSON(), label: deviceLabel() }),
  });
  if (!r.ok) {
    let why = `HTTP ${r.status}`;
    try { why = (await r.json()).error || why; } catch {}
    throw new Error(why);
  }
}

// The bell. Must be called straight from the tap handler: the permission
// request is the first thing it does, before any await.
export async function enablePush() {
  const cap = pushCapability();
  if (cap !== 'ok') {
    set(cap);
    toast(cap === 'install' ? 'Add Mission Control to your Home Screen first — iOS only allows notifications there' : 'This browser can’t receive notifications');
    return false;
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = Notification.permission;
    }
  }
  if (perm !== 'granted') {
    set(perm === 'denied' ? 'denied' : 'idle');
    if (perm === 'denied') toast('Notifications are blocked — allow them in Settings for this app');
    return false;
  }
  set('working');
  try {
    await subscribeAndPost();
    set('on');
    toast('Notifications on');
    return true;
  } catch (err) {
    set('error');
    toast(`Couldn’t turn on notifications — ${err?.message || 'unknown error'}`);
    return false;
  }
}

// Quiet re-subscribe on load / token change when permission was granted before.
let quietRun = null;
function resubscribeQuietly() {
  if (pushCapability() !== 'ok' || Notification.permission !== 'granted') return;
  const mc = getMC();
  if (!mc.token || mc.needsToken || quietRun) return;
  set('working');
  quietRun = subscribeAndPost()
    .then(() => set('on'))
    .catch(() => set('error'))
    .finally(() => {
      quietRun = null;
    });
}

export function initPush() {
  set(initialState());
  const reg = registerServiceWorker();
  if (reg) reg.catch(() => {}); // no SW (dev over plain http, private mode) — push just stays off
  resubscribeQuietly();
  useMC.subscribe((s, prev) => {
    if (s.token && (s.token !== prev.token || (prev.needsToken && !s.needsToken))) resubscribeQuietly();
  });
}
