// Mission Control remote relay.
//
// One Mac (the "host", i.e. the Mission Control menu bar app) connects out to
// this server and streams fleet snapshots; any number of "viewers" (the iPad
// web panel) connect in, see the live snapshot, and send commands (reply /
// broadcast / kill / launch) that are relayed back to the host. The Mac never
// has to accept inbound connections.
//
// The relay is deliberately dumb: it never parses a command's payload, only its
// `type`. The document-library traffic (doc* frames for the markdown library
// under ~/.mission-control/library, plus one-shot `research` launches) rides the
// same viewer→host channel — the relay just has to allowlist those types and
// hand them through. Bodies come back as `doc`/`docSearchResult` frames folded
// into the same host→viewer fan-out as snapshots and acks.
//
// The panel is a built React SPA in ./dist (see `npm run build`). This server
// serves those static assets plus a /health check, and runs the WebSocket relay.
//
// Mia (docs/mia.md §8): the mia* viewer commands are allowlisted like the rest,
// and the snapshot's `mia` block rides through untouched. The one exception to
// "dumb pipe" is Web Push (push.js): host `push` frames are consumed here and
// turned into notifications, never fanned out to viewers, and the host is told
// the VAPID public key (`pushKey`) on connect.
//
// HTTP fallback (api.js: /api/v1/snapshot, /cmd, /screens): some networks
// block WebSocket upgrades outright, so the panel can fall back to polling the
// relay over plain HTTPS. Pollers that identify themselves (X-MC-Client) count
// as viewers toward the host, exactly like a socket viewer, so the Mac keeps
// capturing screens for them.
//
// Talk mode (stt.js): POST /stt turns a recorded utterance into text — a
// whisper.cpp binary baked into the image (local only — never OpenAI).
// The text goes to Mia as a normal miaSend; nothing about it touches the host.
//
// Realtime voice (realtime.js): POST /realtime/session mints an ephemeral
// OpenAI Realtime client secret so the panel can speak to OpenAI over WebRTC
// directly; OPENAI_API_KEY never leaves this process. The one SDP exchange
// goes through /realtime/calls/:id so the relay can watch the call (usage)
// and hang it up (watchdog). A durable per-day tally (Railway volume) and a
// daily $ cap, shown on /health and in the panel's Settings.
//
// Announcement voice (tts.js): POST /tts turns a spoken announcement into
// audio made ON THE MAC (Chatterbox Turbo, Kokoro fallback; task 0287): the
// relay sends the host {type:"tts", id, text} and serves the {type:"ttsDone"}
// audio it answers with — consumed here, never fanned out. Per-text cache,
// length cap and daily character cap; tallied on /health and in Settings.
//
// Wake word: GET /wake/model.tar.gz serves the small Vosk model the panel
// runs in the browser to hear "Hey Mia". Detection is entirely on-device.
//
// Uploads (upload.js): POST /upload hands Mia a file from the panel. The relay
// validates it, offers it to the Mac ({type:"upload"}), the Mac pulls the bytes
// with a one-off key and answers {type:"uploadDone"} — which is consumed here,
// not fanned out — and the relay's temp copy is deleted. Nothing is public.
//
// Auth: every WebSocket connection must present the shared MC_TOKEN.

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createApi } = require('./api');
const { createThumbs } = require('./thumbs');
const { createPush } = require('./push');
const { createStt } = require('./stt');
const { createRealtime } = require('./realtime');
const { createTts } = require('./tts');
const { createUpload } = require('./upload');
const { createDocAssets } = require('./docassets');
const { createDocPages } = require('./docpages');
const { createChannels } = require('./channels');
const { createPhone } = require('./phone');

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.MC_TOKEN || '';

if (!TOKEN) {
  console.error('MC_TOKEN is not set — refusing to start without auth.');
  process.exit(1);
}

function tokenOk(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const push = createPush({ tokenOk });
const stt = createStt({ tokenOk });
const realtime = createRealtime({ tokenOk });
// The Mac says it can take files by listing "upload" in its snapshot's caps
// (and speak announcements with "tts"); an older app gets a clear refusal
// instead of a silent queue.
let hostCaps = [];
const tts = createTts({
  tokenOk,
  sendToHost: (obj) => {
    if (!host || host.readyState !== host.OPEN) return false;
    sendTo(host, obj);
    return true;
  },
  hostOnline: () => host !== null,
  hostCanSpeak: () => hostCaps.includes('tts'),
});
const upload = createUpload({
  tokenOk,
  sendToHost: (obj) => sendTo(host, obj),
  hostOnline: () => host !== null,
  hostCanUpload: () => hostCaps.includes('upload'),
});
// Mia phones Daniel (phone.js, task 0621): Twilio rings him, OpenAI Realtime
// (SIP) is the voice, the relay runs the call's tools. Dark without its keys.
const phone = createPhone({
  tokenOk,
  sendToHost: (obj) => {
    if (!host || host.readyState !== host.OPEN) return false;
    sendTo(host, obj);
    return true;
  },
  hostOnline: () => host !== null,
  latestSnapshot: () => lastSnapshot,
  showOnPanel: (frame) => {
    if (!panelCandidates()[0]) return { ok: false, detail: 'No panel is open — ask Daniel to open Mission Control.' };
    routePanel(frame);
    return { ok: true };
  },
});
// A redeploy sends SIGTERM: write the realtime tally (open calls included)
// and any pending TTS tally before going, so the next process can settle them.
process.on('SIGTERM', () => {
  realtime.close();
  tts.close();
  upload.close();
  phone.close();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// HTTP: serve the built SPA + a health check.

const DIST = path.join(__dirname, 'dist');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('WARNING: dist/index.html is missing — run `npm run build`. The relay still works; the panel will 404 until the SPA is built.');
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// The live panel build (dist/version.json, written by vite.config.mjs).
let buildCache = { at: 0, id: '' };
function panelBuild() {
  if (Date.now() - buildCache.at < 10000) return buildCache.id;
  let id = '';
  try {
    id = JSON.parse(fs.readFileSync(path.join(DIST, 'version.json'), 'utf8')).build || '';
  } catch {}
  buildCache = { at: Date.now(), id };
  return id;
}

// Text assets go out gzipped when the browser asks (every browser does) — the
// panel's JS is several hundred KB raw, a third of that compressed, which is
// most of a phone's first load (task 0444). Hashed files never change, so
// their compressed bytes are kept; the HTML is small and compressed per hit.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.map']);
const gzCache = new Map(); // filePath → Buffer (immutable files only)
const GZ_CACHE_MAX = 64;
function serveFile(res, filePath, { immutable = false, req = null } = {}) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    };
    const gzip = req && COMPRESSIBLE.has(ext) && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) {
      const send = (out) => {
        headers['content-encoding'] = 'gzip';
        headers.vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(out);
      };
      const hit = immutable ? gzCache.get(filePath) : null;
      if (hit) return send(hit);
      // Off the event loop: the wake-word model is megabytes, and the relay's
      // sockets must not stall while it compresses.
      zlib.gzip(buf, { level: 9 }, (zerr, out) => {
        if (zerr) {
          res.writeHead(200, headers);
          return res.end(buf);
        }
        if (immutable) {
          if (gzCache.size >= GZ_CACHE_MAX) gzCache.delete(gzCache.keys().next().value);
          gzCache.set(filePath, out);
        }
        send(out);
      });
      return;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad path');
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, host: host !== null, viewers: viewers.size, pollers: pollers.size, pushSubscriptions: push.count(), stt: stt.info().provider, realtime: realtime.info(), tts: tts.info(), uploads: upload.info(), docAssets: docAssets.info().bytes, docPages: docPages.info().bytes, channels: channels.info(), phone: phone.info(), panelBuild: panelBuild(), viewerBuilds: [...viewers].map((v) => v.build || 'legacy') }));
    return;
  }

  // HTML pages in the Library: the token-auth API, and the sandboxed page
  // itself under a per-page capability — see docpages.js.
  if (url.pathname.startsWith('/api/v1/doc-pages/')) {
    docPages.handleApi(req, res, url).catch((err) => {
      console.error('doc-pages error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }
  if (url.pathname.startsWith('/p/')) {
    try {
      docPages.handlePublic(req, res, url);
    } catch (err) {
      console.error('doc-page error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
    return;
  }

  // Images for Library docs (token-auth, pushed by `mc-doc attach`) — see docassets.js.
  if (url.pathname.startsWith('/api/v1/doc-assets/')) {
    docAssets.handle(req, res, url).catch((err) => {
      console.error('doc-assets error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Channels (task 0260): state + taps for the Channels view, media the Mac pushed — see channels.js.
  if (url.pathname === '/api/v1/channels' || url.pathname.startsWith('/api/v1/channels/')) {
    channels.handle(req, res, url).catch((err) => {
      if (!res.headersSent) res.writeHead(err.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.status ? err.message : 'internal error' }));
      if (!err.status) console.error('channels error:', err);
    });
    return;
  }

  // REST API for machine callers (OpenClaw etc.) — see api.js.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    api.handle(req, res, url).catch((err) => {
      console.error('api error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Web Push subscription management (token-auth) — see push.js.
  if (pathname.startsWith('/push/')) {
    push.handle(req, res, url).catch((err) => {
      console.error('push error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Speech-to-text for the Mia view's talk mode (token-auth) — see stt.js.
  if (pathname === '/stt') {
    stt.handle(req, res, url).catch((err) => {
      console.error('stt error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Ephemeral OpenAI Realtime sessions + usage tally (token-auth) — see realtime.js.
  if (pathname === '/realtime' || pathname.startsWith('/realtime/')) {
    realtime.handle(req, res, url).catch((err) => {
      console.error('realtime error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Announcements in Mia's voice, made on the Mac (token-auth) — see tts.js.
  if (pathname === '/tts') {
    tts.handle(req, res, url).catch((err) => {
      console.error('tts error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Phone calls from Mia (token-auth + signed provider webhooks) — see phone.js.
  if (pathname === '/phone' || pathname.startsWith('/phone/')) {
    phone.handle(req, res, url).catch((err) => {
      console.error('phone error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // Files for Mia from the panel (token-auth) — see upload.js.
  if (pathname === '/upload' || pathname.startsWith('/upload/')) {
    upload.handle(req, res, url).catch((err) => {
      console.error('upload error:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
    return;
  }

  // The on-device wake word's speech model (lib/wake.js in the panel). Public
  // like the rest of the static panel; audio never comes here, only the model
  // goes out. Versioned by file name, so it caches forever.
  if (pathname === '/wake/model.tar.gz') {
    const file = process.env.WAKE_MODEL || '';
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('wake word model not installed (set WAKE_MODEL)');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': fs.statSync(file).size,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // Hashed, fingerprinted assets — safe to cache forever (v1's /assets/, and
  // v2's Next.js chunks under /v2/_next/static/ — task 0444).
  if (pathname.startsWith('/assets/') || pathname.startsWith('/v2/_next/static/')) {
    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(DIST, rel);
    if (file.startsWith(DIST)) return serveFile(res, file, { immutable: true, req });
  }

  // Panel v6 (task 0612): Next.js static export at /v6 (remote/web → dist/v6.html
  // + dist/v6/_next). Hashed chunks cache forever; the page itself never does.
  if (pathname === '/v6' || pathname === '/v6/') return serveFile(res, path.join(DIST, 'v6.html'));
  // The classic panel (v1) stays reachable at /classic since v6 took / (task 0622).
  if (pathname === '/classic' || pathname === '/classic/') return serveFile(res, path.join(DIST, 'index.html'), { req });
  if (pathname.startsWith('/v6/_next/static/')) {
    const file = path.join(DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(DIST)) return serveFile(res, file, { immutable: true });
  }

  // A concrete file at the web root (e.g. /favicon.svg, /manifest).
  if (pathname !== '/' && !pathname.endsWith('/')) {
    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(DIST, rel);
    if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(res, file, { req });
    }
  }

  // The v3, v4 and v5 designs (tasks 0445, 0446, 0483) also live at their own
  // paths; so does v5.2, the chat-first panel (task 0491), at /v52, and v5.3 (task 0502) at /v53.
  const v3 = /^\/(v[34][abc]|v5[23]?)\/?$/.exec(pathname);
  if (v3 && fs.existsSync(path.join(DIST, `${v3[1]}.html`))) return serveFile(res, path.join(DIST, `${v3[1]}.html`), { req });

  // SPA fallback — every other route renders the app shell: the device's
  // pick of the front ends (task 0444, see uiFor).
  const ui = uiFor(req, url, res);
  serveFile(res, path.join(DIST, ui === 'v1' ? 'index.html' : `${ui}.html`), { req });
});

// A/B of the panel (task 0444). Since task 0622 panel v6 is the default at /
// (and every SPA route, so push deep links like /#task/0612 land in v6); the
// classic panel (v1, index.html) lives at /classic. A device can still pin
// another front end by opening ?ui=<name> (?ui=v6 goes back to the default):
// that sets the mc_ui2 cookie. The old mc_ui cookie from the v2–v5.3 A/B is
// ignored on purpose, so devices that once picked v5.3 also get v6 now.
// v3a/v3b/v3c are the three design directions of task 0445 (Home + Mia only).
// v4a/v4b/v4c are the three structural directions of task 0446; v5 (task 0483)
// is v1's structure in v4's Lens glass.
const UIS = new Set(['v1', 'classic', 'v6', 'v2', 'v3a', 'v3b', 'v3c', 'v4a', 'v4b', 'v4c', 'v5', 'v52', 'v53']);
const DEFAULT_UI = 'v6';
function uiFor(req, url, res) {
  const built = (ui) => {
    if (ui === 'classic' || ui === 'v1') return 'v1';
    if (fs.existsSync(path.join(DIST, `${ui}.html`))) return ui;
    return ui === DEFAULT_UI ? 'v1' : built(DEFAULT_UI);
  };
  const q = url.searchParams.get('ui');
  if (UIS.has(q)) {
    res.setHeader('set-cookie', q === DEFAULT_UI
      ? 'mc_ui2=; Path=/; Max-Age=0; SameSite=Lax'
      : `mc_ui2=${q}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return built(q);
  }
  const want = /(?:^|;\s*)mc_ui2=(v1|classic|v2|v5[23]?|v[34][abc])(?:;|$)/.exec(req.headers.cookie || '');
  return built(want ? want[1] : DEFAULT_UI);
}

// ---------------------------------------------------------------------------
// WebSocket relay.

// permessage-deflate is negotiated per-connection: browsers (the panel) opt in
// and get compressed 1 Hz JSON snapshots — a big win on cellular — while the
// Mac's URLSession simply doesn't negotiate it and stays uncompressed.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 1024 },
});

let host = null; // the Mac's socket (at most one)
let lastSnapshot = null; // most recent snapshot JSON string, for late joiners
let lastSnapshotAt = 0; // when it arrived (ms) — lets pollers judge freshness
let snapshotSeq = 0; // bumps per host snapshot — lets pollers skip repeats
const viewers = new Set();

// HTTP pollers (panels on the fallback transport), keyed by their X-MC-Client
// id → last time they polled. They count as viewers while fresh.
const pollers = new Map();
const POLLER_TTL_MS = 10000;

// Viewer→host frame types the relay will forward — shared by the socket path
// and POST /api/v1/cmd so the two can never drift apart.
const ALLOWED_VIEWER_TYPES = [
  'reply', 'broadcast', 'kill', 'launch', 'key', 'watch',
  'docGet', 'docSave', 'docCreate', 'docDelete', 'docMeta', 'docSearch', 'research',
  // Legacy plan* aliases: an old cached panel may still send these, and the
  // host handles them as doc* equivalents.
  'planGet', 'planSave', 'planCreate', 'planDelete',
  // Mia, the persistent assistant (docs/mia.md §8).
  'miaSend', 'miaAnswer', 'miaDismiss', 'miaQuestionAge', 'miaRead', 'miaTaskAdd', 'miaTaskCancel', 'miaTaskSet',
  'miaStart', 'miaStop', 'miaRestart', 'miaSetModel', 'miaSchedule', 'miaPushTest',
  // tars trigger on the Mac (the bridge calls 127.0.0.1:8421 with its own Keychain token).
  'tars.run', 'tars.status',
];

// ---------------------------------------------------------------------------
// Mia → panel commands (`mia panel …`, docs/mia.md §8.2). The host sends
// {type:'panel', id, action, arg?, heading?}; exactly ONE panel gets it: the
// most recently active one (visible beats hidden, then the latest tap/key,
// then the newest connection). Navigation only — anything off the allow-list
// is dropped here as well as on the Mac and in the panel.
const PANEL_ACTIONS = ['open-doc', 'open-task', 'open-agent', 'view', 'open-url', 'search', 'scroll-to',
  'scroll', 'highlight', 'show-url', 'show-doc', 'close'];
const PANEL_SCROLLS = ['up', 'down', 'top', 'bottom'];
// hq too: `mia panel view hq` (scripts/mia, panelCommands.js) was dropped here (fixed in 0483)
const PANEL_VIEWS = ['home', 'hq', 'fleet', 'library', 'mia', 'insights', 'settings'];
const pollerPresence = new Map(); // poller id → { activeAt, visible }
const pollerInbox = new Map(); // poller id → panel frames waiting for its next poll
let primaryKey = null; // 'ws:<n>' | 'poll:<id>' — who gets panel commands (and speaks announcements)
let wsSeq = 0;

function cleanPanelFrame(f) {
  if (!f || !PANEL_ACTIONS.includes(f.action)) return null;
  const s = (v, n) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, n) : '');
  const out = { type: 'panel', id: s(f.id, 40) || `p_${Date.now()}`, action: f.action, arg: s(f.arg, 2000) };
  const heading = s(f.heading, 200);
  if (heading) out.heading = heading;
  if (f.action === 'view' && !PANEL_VIEWS.includes(out.arg)) return null;
  if ((f.action === 'open-url' || f.action === 'show-url') && !/^https:\/\/[^\s]+$/i.test(out.arg)) return null;
  if (f.action === 'scroll' && !PANEL_SCROLLS.includes(out.arg)) return null;
  if (f.action !== 'view' && f.action !== 'close' && !out.arg) return null;
  return out;
}

function panelCandidates() {
  const out = [];
  for (const v of viewers) {
    if (v.readyState === v.OPEN) out.push({ key: `ws:${v.seq}`, ws: v, visible: v.visible !== false, activeAt: v.activeAt || 0, since: v.connectedAt || 0 });
  }
  const cutoff = Date.now() - POLLER_TTL_MS;
  for (const [id, at] of pollers) {
    if (at < cutoff) continue;
    const p = pollerPresence.get(id) || {};
    out.push({ key: `poll:${id}`, poller: id, visible: p.visible !== false, activeAt: p.activeAt || 0, since: p.since || at });
  }
  out.sort((a, b) => (b.visible - a.visible) || (b.activeAt - a.activeAt) || (b.since - a.since));
  return out;
}

// Tell socket panels whether they're the one Mia talks to; pollers read it
// off their snapshot response.
function refreshPrimary() {
  const best = panelCandidates()[0] || null;
  const key = best ? best.key : null;
  if (key === primaryKey) return;
  primaryKey = key;
  for (const v of viewers) sendTo(v, { type: 'panelFocus', primary: `ws:${v.seq}` === key });
}

function routePanel(frame) {
  const f = cleanPanelFrame(frame);
  const result = (ok, detail) =>
    sendTo(host, { type: 'panelResult', id: frame.id || '', ok, action: frame.action || '', arg: typeof frame.arg === 'string' ? frame.arg.slice(0, 200) : '', detail });
  if (!f) return result(false, 'not an allowed panel command');
  const target = panelCandidates()[0];
  if (!target) return result(false, 'no panel is open');
  if (target.ws) sendTo(target.ws, f);
  else {
    const q = pollerInbox.get(target.poller) || [];
    q.push({ ...f, queuedAt: Date.now() });
    pollerInbox.set(target.poller, q.slice(-10));
  }
  console.log(`panel ${f.action} → ${target.key}`);
}

// What a panel reports back after running a command → the Mac (Mia).
function panelDone(msg) {
  sendTo(host, {
    type: 'panelResult',
    id: String(msg.id || '').slice(0, 40),
    ok: !!msg.ok,
    action: PANEL_ACTIONS.includes(msg.action) ? msg.action : '',
    arg: String(msg.arg || '').slice(0, 200),
    detail: String(msg.detail || '').slice(0, 300),
    // Success Mia should still hear about (show-url fell back to a card, a
    // fuzzy match landed somewhere other than what she asked for).
    tell: msg.tell === true,
  });
}

// Listing thumbnails (thumbs.js): the disk cache lives on the Railway volume;
// without one (a local run) it goes to the OS temp dir, never the repo.
const thumbs = createThumbs({
  dir:
    process.env.THUMB_CACHE ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'thumb-cache') : undefined),
  maxBytes: (Number(process.env.THUMB_CACHE_MB) || 200) * 1024 * 1024,
});

// Library doc images (docassets.js): on the Railway volume, like the thumb
// cache; a local run uses the OS temp dir.
const docAssets = createDocAssets({
  tokenOk,
  dir:
    process.env.DOC_ASSETS ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'doc-assets') : undefined),
  maxTotalBytes: (Number(process.env.DOC_ASSETS_MB) || 2048) * 1024 * 1024,
});
// Channels (channels.js, task 0260): the Mac's Channels HQ view + Daniel's queued taps + cached media.
const channels = createChannels({ tokenOk });
// Library pages (docpages.js): HTML next to the doc assets, served sandboxed
// under /p/<capability>/… — never with the panel's token.
const docPages = createDocPages({
  tokenOk,
  secret: TOKEN,
  dir: process.env.DOC_PAGES || path.join(path.dirname(docAssets.root), 'doc-pages'),
  assetsRoot: docAssets.root,
  linkHours: Number(process.env.PAGE_LINK_HOURS) || 24 * 7,
});

const api = createApi({
  tokenOk,
  thumbs,
  hostOnline: () => host !== null,
  latestSnapshot: () => lastSnapshot,
  snapshotMeta: () => ({ seq: snapshotSeq, at: lastSnapshotAt }),
  sendToHost: (obj) => sendTo(host, obj),
  allowedTypes: ALLOWED_VIEWER_TYPES,
  notePresence: (id, { idleMs, visible }) => {
    const p = pollerPresence.get(id) || { since: Date.now() };
    if (Number.isFinite(idleMs) && idleMs >= 0) p.activeAt = Math.max(p.activeAt || 0, Date.now() - idleMs);
    if (typeof visible === 'boolean') p.visible = visible;
    pollerPresence.set(id, p);
    refreshPrimary();
  },
  pollerExtras: (id) => {
    const q = pollerInbox.get(id);
    pollerInbox.delete(id);
    const fresh = (q || []).filter((f) => Date.now() - f.queuedAt < 30000).map(({ queuedAt, ...f }) => f);
    return { primary: primaryKey === `poll:${id}`, panel: fresh };
  },
  onPanelDone: panelDone,
  notePoller: (id) => {
    const fresh = !pollers.has(id);
    pollers.set(id, Date.now());
    if (fresh) {
      console.log(`poller connected (${pollers.size})`);
      tellHostViewerCount();
    }
  },
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  // Twilio Media Streams for a phone call (phone.js checks the per-call key).
  if (url.pathname === '/phone/stream') return phone.handleUpgrade(req, socket, head);
  if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'viewer';
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = role;
    ws.isAlive = true;
    wss.emit('connection', ws, req);
  });
});

function sendTo(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function fanOutToViewers(text) {
  for (const v of viewers) {
    if (v.readyState === v.OPEN) v.send(text);
  }
}

function tellHostViewerCount() {
  sendTo(host, { type: 'viewers', count: viewers.size + pollers.size });
}

// Expire pollers that stopped polling (tab closed, switched back to the socket).
setInterval(() => {
  const cutoff = Date.now() - POLLER_TTL_MS;
  let changed = false;
  for (const [id, at] of pollers) {
    if (at < cutoff) {
      pollers.delete(id);
      pollerPresence.delete(id);
      pollerInbox.delete(id);
      changed = true;
    }
  }
  if (changed) refreshPrimary();
  if (changed) {
    console.log(`poller gone (${pollers.size})`);
    tellHostViewerCount();
  }
}, 2500);

function tellViewersHostState() {
  const msg = JSON.stringify({ type: 'hostState', online: host !== null });
  fanOutToViewers(msg);
}

// Viewer heartbeat. While the Mac is up, snapshots reach viewers ~1/s and
// double as a liveness signal; while it is down nothing would, and a viewer
// can't tell "Mac offline" from "my socket died in my pocket" (iOS resumes a
// suspended web app with a socket that reports open but never delivers, and
// never fires close). Restating hostState every 10s keeps a healthy socket
// audibly alive, so the panel's silence watchdog only ever redials dead ones.
setInterval(() => {
  if (host === null && viewers.size) tellViewersHostState();
}, 10000);

wss.on('connection', (ws, req) => {
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  if (ws.role === 'host') {
    if (host && host !== ws) host.close(4000, 'replaced by a newer host');
    host = ws;
    console.log('host connected');
    tellHostViewerCount();
    tellViewersHostState();
    sendTo(ws, { type: 'pushKey', key: push.publicKey });
    upload.onHostConnect(); // re-offer anything the last connection didn't collect

    ws.on('message', (data) => {
      const text = data.toString();
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      if (frame.type === 'push') {
        // Mia notifications → Web Push. Viewers already get the message via
        // the snapshot, so this frame stops here.
        push.send(frame).catch((err) => console.error('push send error:', err));
        return;
      }
      if (frame.type === 'panel') {
        // Mia → one panel, never fanned out (see routePanel).
        routePanel(frame);
        return;
      }
      if (frame.type === 'ttsDone') {
        // Announcement audio the Mac made — relay-local, never fanned out.
        tts.onHostFrame(frame);
        return;
      }
      if (frame.type === 'uploadDone') {
        // The Mac saved (or refused) an upload — relay-local, never fanned out.
        upload.onHostFrame(frame);
        return;
      }
      if (frame.type === 'snapshot') {
        hostCaps = Array.isArray(frame.caps) ? frame.caps : [];
        lastSnapshot = text;
        lastSnapshotAt = Date.now();
        snapshotSeq += 1;
      }
      api.onHostFrame(frame); // settle any pending REST requests
      fanOutToViewers(text); // snapshots and acks both go to every viewer
    });

    ws.on('close', () => {
      if (host === ws) {
        host = null;
        hostCaps = [];
        tts.onHostGone();
        console.log('host disconnected');
        tellViewersHostState();
      }
    });
    return;
  }

  // Viewer.
  ws.seq = ++wsSeq;
  ws.connectedAt = Date.now();
  // Which panel build this is (task 0126) — /health lists them, so a stale
  // installed PWA shows up. Panels from before the build id send nothing.
  ws.build = String(new URL(req.url, 'http://x').searchParams.get('build') || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'legacy';
  viewers.add(ws);
  console.log(`viewer connected (${viewers.size})`);
  sendTo(ws, { type: 'hostState', online: host !== null });
  if (lastSnapshot) ws.send(lastSnapshot);
  tellHostViewerCount();
  primaryKey = null; // re-announce to everyone, the newcomer included
  refreshPrimary();

  ws.on('message', (data) => {
    const text = data.toString();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    // Relay-local: presence (who Mia's panel commands go to) and the result of
    // one. Neither needs the Mac online to be accepted.
    if (msg.type === 'viewerActive') {
      if (msg.visible !== false) ws.activeAt = Date.now();
      ws.visible = msg.visible !== false;
      refreshPrimary();
      return;
    }
    if (msg.type === 'panelDone') {
      panelDone(msg);
      return;
    }
    if (!ALLOWED_VIEWER_TYPES.includes(msg.type)) return;
    if (!host) {
      // 'watch' is a ~3s lease heartbeat, not a user action — drop it silently
      // instead of spamming the viewer with offline acks.
      if (msg.type !== 'watch') {
        sendTo(ws, { type: 'ack', ok: false, cmd: msg.type, detail: 'Mac is offline' });
      }
      return;
    }
    sendTo(host, msg);
  });

  ws.on('close', () => {
    viewers.delete(ws);
    console.log(`viewer disconnected (${viewers.size})`);
    tellHostViewerCount();
    refreshPrimary();
  });
});

// Reap dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`mission-control relay on :${PORT}`));
