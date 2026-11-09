// Web Push, same flow as the classic panel: the shared /sw.js (scope /),
// VAPID key from GET /push/key, subscription to POST /push/subscribe. A device
// that already allowed notifications re-subscribes quietly on every load, so
// pushes keep working whichever panel opened last.
import { getMC, toast } from './store';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;

export function pushState(): string {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'install' : 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : Notification.permission === 'granted' ? 'working' : 'idle';
}

const authed = (path: string, init: RequestInit = {}) =>
  fetch(path, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', Authorization: `Bearer ${getMC().token}` } });

function b64(s: string) {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribe() {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  let key = '';
  try {
    const r = await authed('/push/key');
    if (r.ok) key = (await r.json()).key || '';
  } catch {}
  key = key || getMC().mia?.pushKey || '';
  if (!key) throw new Error('The relay has no push key yet');
  const bytes = b64(key);
  let sub = await reg.pushManager.getSubscription();
  const cur = sub?.options?.applicationServerKey;
  if (sub && cur && new Uint8Array(cur).join() !== bytes.join()) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  const kind = /iPhone/.test(navigator.userAgent) ? 'iPhone' : isIOS() ? 'iPad' : 'Browser';
  const r = await authed('/push/subscribe', { method: 'POST', body: JSON.stringify({ ...sub.toJSON(), label: `${kind}${standalone() ? ' (Home Screen)' : ''} · v6` }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function enablePush(): Promise<string> {
  const st = pushState();
  if (st === 'unsupported' || st === 'install') return st;
  const perm = Notification.permission === 'default' ? await Notification.requestPermission().catch(() => Notification.permission) : Notification.permission;
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'idle';
  try {
    await subscribe();
    toast('Notifications on');
    return 'working';
  } catch (e: any) {
    toast(`Couldn’t turn on notifications: ${e?.message || 'unknown error'}`);
    return 'idle';
  }
}

export function resubscribeQuietly() {
  if (pushState() === 'working' && getMC().token) subscribe().catch(() => {});
}
