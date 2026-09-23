// Mission Control service worker — Web Push for Mia (docs/mia.md §9).
// No fetch handler and no caching on purpose: the panel is a live view of the
// Mac and must never be served stale. This worker only shows pushes and routes
// a tap back into the panel at #mia.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Mia';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/#mia' },
  };
  if (data.tag) {
    options.tag = String(data.tag);
    options.renotify = true; // a newer message under the same tag should still buzz
  }
  if (data.urgent) options.requireInteraction = true;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/#mia';
  const target = new URL(raw, self.location.origin);
  if (target.origin !== self.location.origin) target.href = new URL('/#mia', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const mine = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (mine) {
        // Route inside the running panel (no reload, the socket stays up).
        mine.postMessage({ type: 'mc-open', url: target.hash || '#mia' });
        try {
          return await mine.focus();
        } catch {
          return undefined;
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
