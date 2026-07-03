// Mission Control remote relay.
//
// One Mac (the "host", i.e. the Mission Control menu bar app) connects out to
// this server and streams fleet snapshots; any number of "viewers" (the iPad
// web panel) connect in, see the live snapshot, and send commands (reply /
// broadcast / kill) that are relayed back to the host. The Mac never has to
// accept inbound connections.
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
// HTTP: serve the panel + a health check.

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      host: host !== null,
      viewers: viewers.size,
    }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(INDEX);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------------------------------------------------------------------------
// WebSocket relay.

const wss = new WebSocketServer({ noServer: true });

let host = null;            // the Mac's socket (at most one)
let lastSnapshot = null;    // most recent snapshot JSON string, for late joiners
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
  ws.on('pong', () => { ws.isAlive = true; });

  if (ws.role === 'host') {
    if (host && host !== ws) host.close(4000, 'replaced by a newer host');
    host = ws;
    console.log('host connected');
    tellHostViewerCount();
    tellViewersHostState();

    ws.on('message', (data) => {
      const text = data.toString();
      let type;
      try { type = JSON.parse(text).type; } catch { return; }
      if (type === 'snapshot') lastSnapshot = text;
      fanOutToViewers(text);   // snapshots and acks both go to every viewer
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
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const allowed = ['reply', 'broadcast', 'kill', 'launch'];
    if (!allowed.includes(msg.type)) return;
    if (!host) {
      sendTo(ws, { type: 'ack', ok: false, cmd: msg.type, detail: 'Mac is offline' });
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
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`mission-control relay on :${PORT}`));
