// Channels on the relay (task 0260): the meeting point between the Channels view in the panel and Channels HQ
// on the Mac (~/channels-hq, :8090). Same shape as Jarvis HQ (jarvis.js): the Mac pushes, the panel reads, and
// Daniel's taps wait in a queue until the Mac takes them.
//
//   PUT  /api/v1/channels/state {state, applied[]}   the Mac (channels-hq sync) pushes the panel's view; the
//                                                    action ids it took leave the queue
//   GET  /api/v1/channels                            the panel reads it, plus the taps still queued here
//   POST /api/v1/channels/action {action, channel, video?, note?, slot?, title?, label?, told?, confirmed?}
//                                                    the panel queues one request for Mia
//   GET  /api/v1/channels/actions                    the Mac pulls the queue + the media the panel is waiting for
//   GET  /api/v1/channels/media/<id>?size=thumb|poster|full   a picture / poster / mp4 the Mac uploaded (Range
//                                                    requests, so a Short seeks); 202 + queued for the Mac when
//                                                    it isn't here yet
//   PUT  /api/v1/channels/media/<id>?size=…          the Mac uploads one (raw bytes)
//
// Requests only: nothing here (or on the Mac side) publishes or uploads to YouTube. Mia does that, after Daniel's
// tap reaches her. Auth: the shared token, Bearer or ?token= (media elements can't send headers).
// Storage: channels.json (state + queue) and channels-media/ on the Railway volume; a local run uses the OS
// temp dir. Media is an LRU cache with a total cap (CHANNELS_MEDIA_MB, default 1024).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { dataFile } = require('./datafile');

const MB = 1024 * 1024;
const ACTIONS = new Set(['approve', 'reject', 'make_next_10', 'pause_channel', 'resume_channel', 'schedule',
  'publish_now', 'regen_thumbnail', 'change_title']);
const NEEDS_VIDEO = new Set(['approve', 'reject', 'schedule', 'publish_now', 'regen_thumbnail', 'change_title']);
const SIZES = new Set(['thumb', 'poster', 'full']);
const TYPES = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 4).toString('latin1') === '\x89PNG',
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'video/mp4': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/quicktime': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
};
const MAX_STATE_BYTES = 4 * MB;
const MAX_MEDIA_BYTES = 80 * MB;
const MAX_PENDING = 200;
const MAX_WANTED = 60;

function createChannels({ tokenOk, file, dir, maxTotalBytes = (Number(process.env.CHANNELS_MEDIA_MB) || 1024) * MB, log = console } = {}) {
  const store = file || dataFile('channels.json', { override: process.env.CHANNELS_STORE, tag: 'channels', log });
  const root = path.resolve(
    dir || process.env.CHANNELS_MEDIA ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'channels-media') : path.join(os.tmpdir(), 'mc-channels-media'))
  );
  fs.mkdirSync(root, { recursive: true });
  let data = { state: null, receivedAt: 0, queue: [] };
  try {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    if (d && typeof d === 'object') data = { state: d.state || null, receivedAt: Number(d.receivedAt) || 0, queue: Array.isArray(d.queue) ? d.queue : [] };
  } catch {}
  const wanted = new Map(); // `${id}:${size}` → {id, size, at}

  function save() {
    try {
      fs.mkdirSync(path.dirname(store), { recursive: true });
      const tmp = `${store}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, store);
    } catch (e) {
      log.warn(`channels: could not save ${store}: ${e.message}`);
    }
  }

  const str = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

  function cleanAction(b) {
    if (!b || typeof b !== 'object') return 'body must be a JSON object';
    const action = str(b.action, 24);
    if (!ACTIONS.has(action)) return `action must be one of ${[...ACTIONS].join(', ')}`;
    const a = { action, channel: str(b.channel, 80), video: str(b.video, 200), note: str(b.note, 600),
      slot: str(b.slot, 40), title: str(b.title, 140), label: str(b.label, 200), told: b.told === true };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(a.channel)) return 'channel missing or malformed';
    if (NEEDS_VIDEO.has(action) && !a.video) return 'video is required for this action';
    if (action === 'reject' && !a.note) return 'a reject needs a note';
    if (action === 'change_title' && !a.title) return 'change_title needs the new title';
    if (action === 'schedule' && !a.slot) return 'schedule needs a slot';
    if (action === 'publish_now' && b.confirmed !== true) return 'publish_now needs confirmed: true';
    return a;
  }

  // ---- media cache -----------------------------------------------------------------------------------
  const ID_RE = /^[A-Za-z0-9_-]{8,700}$/;
  const keyFile = (id, size) => path.join(root, crypto.createHash('sha256').update(`${id}:${size}`).digest('hex'));
  function readMeta(f) {
    try { return JSON.parse(fs.readFileSync(`${f}.json`, 'utf8')); } catch { return null; }
  }
  function evict() {
    let files;
    try { files = fs.readdirSync(root).filter((n) => /^[0-9a-f]{64}$/.test(n)); } catch { return; }
    const list = files.map((n) => { const p = path.join(root, n); const s = fs.statSync(p); return { p, size: s.size, t: s.mtimeMs }; });
    let total = list.reduce((a, x) => a + x.size, 0);
    list.sort((a, b) => a.t - b.t);
    for (const x of list) {
      if (total <= maxTotalBytes) break;
      try { fs.unlinkSync(x.p); fs.unlinkSync(`${x.p}.json`); } catch {}
      total -= x.size;
    }
  }
  function info() {
    let bytes = 0;
    try { for (const n of fs.readdirSync(root)) bytes += fs.statSync(path.join(root, n)).size; } catch {}
    return { bytes, receivedAt: data.receivedAt || null, queued: data.queue.length, wanted: wanted.size };
  }

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
  function readRaw(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req, max) {
    const raw = await readRaw(req, max);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  function serveMedia(req, res, f, meta) {
    const size = fs.statSync(f).size;
    const now = new Date();
    try { fs.utimesSync(f, now, now); } catch {} // LRU: a read keeps it
    const head = { 'content-type': meta.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=600',
      'x-content-type-options': 'nosniff', etag: `"${meta.sha}"` };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  }

  async function handle(req, res, url) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenOk(bearer) && !tokenOk(url.searchParams.get('token') || '')) return json(res, 401, { ok: false, error: 'unauthorized' });
    const rest = url.pathname.replace(/^\/api\/v1\/channels\/?/, '').split('/').filter(Boolean);
    const m = req.method;

    if (rest.length === 0 && m === 'GET') {
      return json(res, 200, { ok: true, state: data.state, receivedAt: data.receivedAt || null, pending: data.queue });
    }
    if (rest[0] === 'state' && rest.length === 1 && m === 'PUT') {
      const body = await readJson(req, MAX_STATE_BYTES);
      if (!body.state || typeof body.state !== 'object') return json(res, 400, { ok: false, error: 'state needs a state object' });
      const applied = new Set(Array.isArray(body.applied) ? body.applied.map(String) : []);
      data.queue = data.queue.filter((a) => !applied.has(a.id));
      data.state = body.state;
      data.receivedAt = Date.now();
      save();
      return json(res, 200, { ok: true, queued: data.queue.length });
    }
    if (rest[0] === 'actions' && rest.length === 1 && m === 'GET') {
      return json(res, 200, { ok: true, actions: data.queue, wanted: [...wanted.values()] });
    }
    if (rest[0] === 'action' && rest.length === 1 && m === 'POST') {
      const a = cleanAction(await readJson(req, 64 * 1024));
      if (typeof a === 'string') return json(res, 400, { ok: false, error: a });
      a.id = `a_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${crypto.randomBytes(2).toString('hex')}`;
      a.at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      a.status = 'queued';
      data.queue.push(a);
      if (data.queue.length > MAX_PENDING) data.queue = data.queue.slice(-MAX_PENDING);
      save();
      return json(res, 200, { ok: true, action: a, pending: data.queue });
    }
    if (rest[0] === 'media' && rest.length === 2) {
      const id = rest[1];
      const size = url.searchParams.get('size') || 'full';
      if (!ID_RE.test(id) || !SIZES.has(size)) return json(res, 400, { ok: false, error: 'bad media id or size' });
      const f = keyFile(id, size);
      if (m === 'GET' || m === 'HEAD') {
        const meta = fs.existsSync(f) ? readMeta(f) : null;
        if (meta) return serveMedia(req, res, f, meta);
        if (wanted.size < MAX_WANTED) wanted.set(`${id}:${size}`, { id, size, at: Date.now() });
        res.setHeader('retry-after', '5');
        return json(res, 202, { ok: false, pending: true, error: 'asked the Mac for it; try again in a few seconds' });
      }
      if (m === 'PUT') {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim();
        if (!TYPES[type]) return json(res, 415, { ok: false, error: 'jpeg, png, webp or mp4 only' });
        const buf = await readRaw(req, MAX_MEDIA_BYTES);
        if (!TYPES[type](buf)) return json(res, 415, { ok: false, error: 'the bytes are not what the content type says' });
        const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        fs.writeFileSync(`${f}.tmp`, buf);
        fs.renameSync(`${f}.tmp`, f);
        fs.writeFileSync(`${f}.json`, JSON.stringify({ type, sha, bytes: buf.length }));
        wanted.delete(`${id}:${size}`);
        evict();
        return json(res, 200, { ok: true, bytes: buf.length, sha });
      }
    }
    return json(res, 404, { ok: false, error: `no channels route ${m} ${url.pathname}` });
  }

  return { handle, info, file: store, root, _data: () => data, _wanted: wanted };
}

module.exports = { createChannels };
