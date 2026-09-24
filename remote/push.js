// Web Push for Mia — the relay's only stateful feature.
//
// The Mac host sends `{type:"push", title, body, tag?, url?, urgent?}` frames;
// the relay turns each into a Web Push to every subscribed browser (the panel's
// service worker shows it). Viewers never see the frame itself — the message
// already reaches them through the snapshot's `mia` block.
//
// VAPID keys: env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT. If the
// pair is missing a fresh one is generated at boot and logged — every redeploy
// then invalidates existing subscriptions until the pair is pinned in env.
//
// Subscriptions: in memory, mirrored to PUSH_STORE (default
// push-subscriptions.json on the Railway volume, see datafile.js), so they
// survive a redeploy. The panel also re-subscribes on every load. Endpoints the
// push service reports gone (404/410) are dropped.
//
// HTTP (token auth, same as /api): GET /push/key, POST /push/subscribe,
// POST /push/unsubscribe.

'use strict';

const fs = require('fs');
const path = require('path');
const { dataFile } = require('./datafile');
const webpush = require('web-push'); // always called as webpush.x so tests can patch it

const MAX_SUBSCRIPTIONS = 100;
const MAX_BODY = 16 * 1024;
const TTL_SECONDS = 24 * 60 * 60;

function createPush({ tokenOk, env = process.env, log = console } = {}) {
  // ---------------------------------------------------------------------------
  // VAPID.

  let publicKey = env.VAPID_PUBLIC_KEY || '';
  let privateKey = env.VAPID_PRIVATE_KEY || '';
  const subject = env.VAPID_SUBJECT || 'mailto:mission-control@example.com';

  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    log.warn(
      [
        'push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — generated a pair for this process only.',
        'push: Set these on Railway (Variables) so phone subscriptions survive redeploys:',
        `push:   VAPID_PUBLIC_KEY=${publicKey}`,
        `push:   VAPID_PRIVATE_KEY=${privateKey}`,
        'push:   VAPID_SUBJECT=mailto:<your email>',
      ].join('\n')
    );
  }
  if (!env.VAPID_SUBJECT) {
    log.warn(`push: VAPID_SUBJECT is not set — using ${subject}. Apple's push service may reject it; set VAPID_SUBJECT=mailto:<your email>.`);
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  // ---------------------------------------------------------------------------
  // Subscription store.

  const storePath = dataFile('push-subscriptions.json', { override: env.PUSH_STORE, env, log, tag: 'push' });
  const subs = new Map(); // endpoint -> { endpoint, keys, label, addedAt }

  try {
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    for (const s of Array.isArray(saved) ? saved : []) {
      const clean = validSubscription(s);
      if (clean) subs.set(clean.endpoint, { ...clean, label: s.label || null, addedAt: s.addedAt || null });
    }
    log.log(`push: loaded ${subs.size} subscription(s) from ${storePath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`push: could not read ${storePath}: ${err.message}`);
  }

  function persist() {
    const tmp = `${storePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify([...subs.values()], null, 2));
      fs.renameSync(tmp, storePath);
    } catch (err) {
      log.warn(`push: could not write ${storePath}: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function validSubscription(s) {
    if (!s || typeof s !== 'object') return null;
    const { endpoint, keys } = s;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) return null;
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
    if (!keys.p256dh || !keys.auth) return null;
    return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  }

  function subscribe(body) {
    const clean = validSubscription(body);
    if (!clean) return false;
    subs.delete(clean.endpoint); // re-insert so Map order = recency
    subs.set(clean.endpoint, {
      ...clean,
      label: typeof body.label === 'string' ? body.label.slice(0, 120) : null,
      addedAt: new Date().toISOString(),
    });
    while (subs.size > MAX_SUBSCRIPTIONS) subs.delete(subs.keys().next().value);
    persist();
    return true;
  }

  function unsubscribe(endpoint) {
    const had = subs.delete(endpoint);
    if (had) persist();
    return had;
  }

  // ---------------------------------------------------------------------------
  // Sending.

  // `frame` is the host's push frame. Resolves to { sent, failed, dropped }.
  async function send(frame) {
    const payload = JSON.stringify({
      title: String(frame.title ?? 'Mission Control'),
      body: String(frame.body ?? ''),
      tag: frame.tag != null ? String(frame.tag) : null,
      url: frame.url != null ? String(frame.url) : null,
      urgent: !!frame.urgent,
    });
    const options = { TTL: TTL_SECONDS, urgency: frame.urgent ? 'high' : 'normal' };
    const targets = [...subs.values()];
    const results = await Promise.allSettled(
      targets.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, options))
    );
    let sent = 0;
    let failed = 0;
    let dropped = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { sent += 1; return; }
      const code = r.reason && r.reason.statusCode;
      if (code === 404 || code === 410) {
        subs.delete(targets[i].endpoint);
        dropped += 1;
      } else {
        failed += 1;
        log.warn(`push: send failed (${code || 'no status'}): ${(r.reason && r.reason.message) || r.reason}`);
      }
    });
    if (dropped) persist();
    log.log(`push: "${String(frame.title ?? '').slice(0, 60)}" → ${sent} sent, ${failed} failed, ${dropped} dropped`);
    return { sent, failed, dropped };
  }

  // ---------------------------------------------------------------------------
  // HTTP.

  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('body is not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res, url) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenOk(bearer) && !tokenOk(url.searchParams.get('token') || '')) {
      return json(res, 401, { ok: false, error: 'missing or bad token — send Authorization: Bearer <MC_TOKEN>' });
    }
    const route = url.pathname.replace(/\/+$/, '');
    const m = req.method;

    if (route === '/push/key' && m === 'GET') return json(res, 200, { ok: true, key: publicKey });

    if ((route === '/push/subscribe' || route === '/push/unsubscribe') && m === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }

      if (route === '/push/subscribe') {
        if (!subscribe(body)) {
          return json(res, 400, { ok: false, error: 'body must be a PushSubscription: {endpoint:"https://…", keys:{p256dh, auth}}' });
        }
        return json(res, 200, { ok: true, subscriptions: subs.size });
      }
      if (typeof body.endpoint !== 'string' || !body.endpoint) {
        return json(res, 400, { ok: false, error: 'endpoint is required' });
      }
      return json(res, 200, { ok: true, removed: unsubscribe(body.endpoint), subscriptions: subs.size });
    }

    return json(res, 404, { ok: false, error: `no route ${m} ${route}` });
  }

  return {
    publicKey,
    handle,
    send,
    subscribe,
    unsubscribe,
    count: () => subs.size,
  };
}

module.exports = { createPush };
