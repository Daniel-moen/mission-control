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
// The panel is a built Svelte SPA in ./dist (see `npm run build`). This server
// serves those static assets plus a /health check, and runs the WebSocket relay.
//
// Auth: every WebSocket connection must present the shared MC_TOKEN.

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveFile(res, filePath, { immutable = false } = {}) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, host: host !== null, viewers: viewers.size }));
    return;
  }

  // Hashed, fingerprinted assets — safe to cache forever.
  if (pathname.startsWith('/assets/')) {
    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(DIST, rel);
    if (file.startsWith(DIST)) return serveFile(res, file, { immutable: true });
  }

  // A concrete file at the web root (e.g. /favicon.svg, /manifest).
  if (pathname !== '/' && !pathname.endsWith('/')) {
    const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(DIST, rel);
    if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(res, file);
    }
  }

  // SPA fallback — every other route renders the app shell.
  serveFile(res, path.join(DIST, 'index.html'));
});

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
const viewers = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
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
  sendTo(host, { type: 'viewers', count: viewers.size });
}

function tellViewersHostState() {
  const msg = JSON.stringify({ type: 'hostState', online: host !== null });
  fanOutToViewers(msg);
}

wss.on('connection', (ws) => {
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  if (ws.role === 'host') {
    if (host && host !== ws) host.close(4000, 'replaced by a newer host');
    host = ws;
    console.log('host connected');
    tellHostViewerCount();
    tellViewersHostState();

    ws.on('message', (data) => {
      const text = data.toString();
      let type;
      try {
        type = JSON.parse(text).type;
      } catch {
        return;
      }
      if (type === 'snapshot') lastSnapshot = text;
      fanOutToViewers(text); // snapshots and acks both go to every viewer
    });

    ws.on('close', () => {
      if (host === ws) {
        host = null;
        console.log('host disconnected');
        tellViewersHostState();
      }
    });
    return;
  }

  // Viewer.
  viewers.add(ws);
  console.log(`viewer connected (${viewers.size})`);
  sendTo(ws, { type: 'hostState', online: host !== null });
  if (lastSnapshot) ws.send(lastSnapshot);
  tellHostViewerCount();

  ws.on('message', (data) => {
    const text = data.toString();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const allowed = [
      'reply', 'broadcast', 'kill', 'launch', 'key', 'watch',
      'docGet', 'docSave', 'docCreate', 'docDelete', 'docMeta', 'docSearch', 'research',
      // Legacy plan* aliases: an old cached panel may still send these, and the
      // host handles them as doc* equivalents.
      'planGet', 'planSave', 'planCreate', 'planDelete',
    ];
    if (!allowed.includes(msg.type)) return;
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
