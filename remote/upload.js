// File uploads for Mia — Daniel hands her a document from the panel.
//
// The panel POSTs one file per request (raw body, never multipart) to /upload.
// The relay streams it to a private temp file, checks the size and that the
// bytes really are the kind the extension claims, and tells the Mac:
//
//   relay → host  {type:"upload", id, key, name, mime, size, sha256, caption?, batch?, batchId?, at}
//   host  → relay GET /upload/<id>  (Bearer MC_TOKEN + X-MC-Key: <key>) → the bytes
//   host  → relay {type:"uploadDone", id, ok, path?, detail?}
//
// The key is a one-off secret that only the host ever sees (the frame is never
// fanned out to viewers), so even another holder of the panel token can't read
// an upload back. The temp file is deleted the moment the host answers
// uploadDone, when the TTL runs out, or at boot. Nothing is ever public.
//
// Mac offline when the upload starts → 503 before a byte is stored. Mac drops
// mid-delivery → the upload waits (TTL, default 15 min) and is re-offered when
// the host reconnects. The POST itself waits up to DELIVER_WAIT_MS for the
// Mac's uploadDone, so the panel can say "delivered"; after that it answers
// 202 {queued:true}. A host that doesn't advertise the "upload" capability in
// its snapshot (an older Mac app) gets a clear 501 instead of a silent queue.
//
// HTTP (token auth, like /api):
//   POST /upload   body = the file; headers:
//                    X-MC-Name     original file name (encodeURIComponent)
//                    X-MC-Caption  optional note for Mia (encodeURIComponent)
//                    X-MC-Batch    optional "n/N" + X-MC-Batch-Id, when several files go together
//                  → 200 {ok, delivered:true, id, path, name, mime, size}
//                  → 202 {ok, queued:true, id, …}   Mac didn't confirm in time; it will get it on reconnect
//                  → 4xx/5xx {ok:false, error}
//   GET  /upload   → {ok, maxBytes, types:[ext…]}  what the panel may send
//   GET  /upload/<id>  host only (needs X-MC-Key)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;

// Extension → { mime, sniff }. The extension picks the type; the bytes must
// agree with it (sniff). Anything not listed is refused.
const zip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const ole = (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const starts = (sig) => (b) => b.length >= sig.length && b.subarray(0, sig.length).equals(Buffer.from(sig));
const ascii = (at, s) => (b) => b.length >= at + s.length && b.subarray(at, at + s.length).toString('latin1') === s;
const ftyp = (b) => ascii(4, 'ftyp')(b);
const riff = (kind) => (b) => ascii(0, 'RIFF')(b) && ascii(8, kind)(b);
const mp3 = (b) => ascii(0, 'ID3')(b) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
const aac = (b) => mp3(b) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0);
const TEXT = 'text'; // no signature: must be valid UTF-8 without NUL bytes (checked on the whole file)

const TYPES = {
  pdf: { mime: 'application/pdf', sniff: ascii(0, '%PDF') },
  png: { mime: 'image/png', sniff: starts([0x89, 0x50, 0x4e, 0x47]) },
  jpg: { mime: 'image/jpeg', sniff: starts([0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', sniff: starts([0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', sniff: ascii(0, 'GIF8') },
  webp: { mime: 'image/webp', sniff: riff('WEBP') },
  heic: { mime: 'image/heic', sniff: ftyp },
  heif: { mime: 'image/heif', sniff: ftyp },
  tif: { mime: 'image/tiff', sniff: (b) => ascii(0, 'II*\0')(b) || ascii(0, 'MM\0*')(b) },
  tiff: { mime: 'image/tiff', sniff: (b) => ascii(0, 'II*\0')(b) || ascii(0, 'MM\0*')(b) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sniff: zip },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sniff: zip },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sniff: zip },
  doc: { mime: 'application/msword', sniff: ole },
  xls: { mime: 'application/vnd.ms-excel', sniff: ole },
  ppt: { mime: 'application/vnd.ms-powerpoint', sniff: ole },
  odt: { mime: 'application/vnd.oasis.opendocument.text', sniff: zip },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', sniff: zip },
  pages: { mime: 'application/vnd.apple.pages', sniff: zip },
  numbers: { mime: 'application/vnd.apple.numbers', sniff: zip },
  key: { mime: 'application/vnd.apple.keynote', sniff: zip },
  rtf: { mime: 'application/rtf', sniff: ascii(0, '{\\rtf') },
  txt: { mime: 'text/plain', sniff: TEXT },
  md: { mime: 'text/markdown', sniff: TEXT },
  csv: { mime: 'text/csv', sniff: TEXT },
  tsv: { mime: 'text/tab-separated-values', sniff: TEXT },
  json: { mime: 'application/json', sniff: TEXT },
  mp3: { mime: 'audio/mpeg', sniff: mp3 },
  m4a: { mime: 'audio/mp4', sniff: ftyp },
  aac: { mime: 'audio/aac', sniff: aac },
  wav: { mime: 'audio/wav', sniff: riff('WAVE') },
  aif: { mime: 'audio/aiff', sniff: ascii(0, 'FORM') },
  aiff: { mime: 'audio/aiff', sniff: ascii(0, 'FORM') },
  caf: { mime: 'audio/x-caf', sniff: ascii(0, 'caff') },
  flac: { mime: 'audio/flac', sniff: ascii(0, 'fLaC') },
  ogg: { mime: 'audio/ogg', sniff: ascii(0, 'OggS') },
  oga: { mime: 'audio/ogg', sniff: ascii(0, 'OggS') },
  opus: { mime: 'audio/ogg', sniff: ascii(0, 'OggS') },
  webm: { mime: 'audio/webm', sniff: starts([0x1a, 0x45, 0xdf, 0xa3]) },
};

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// What the Mac will turn into a file name — the relay only needs it printable.
function cleanName(raw) {
  let n = String(raw || '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\s]+/, '');
  if (n.length > 180) {
    const e = extOf(n);
    n = n.slice(0, 170 - e.length).trim() + (e ? `.${e}` : '');
  }
  return n;
}

function header(req, name, max) {
  const raw = req.headers[name];
  if (typeof raw !== 'string' || !raw) return '';
  let v;
  try { v = decodeURIComponent(raw); } catch { v = raw; }
  return v.replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function validUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function createUpload({ tokenOk, sendToHost, hostOnline, hostCanUpload = () => true, env = process.env, log = console } = {}) {
  const maxBytes = Math.max(1, Number(env.UPLOAD_MAX_MB) || 50) * MB;
  const maxPendingBytes = Math.max(1, Number(env.UPLOAD_MAX_PENDING_MB) || 300) * MB;
  const ttlMs = Number(env.UPLOAD_TTL_MS) || Math.max(1, Number(env.UPLOAD_TTL_MIN) || 15) * 60 * 1000;
  const deliverWaitMs = Number(env.UPLOAD_WAIT_MS) || 60000;
  const dir = env.UPLOAD_TMP || path.join(os.tmpdir(), 'mc-uploads');

  // Anything left from a previous process is orphaned (its key died with it).
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const pending = new Map(); // id → { meta, key, file, expires, waiters: [] }
  let receiving = 0; // bytes of uploads still streaming in

  const pendingBytes = () => [...pending.values()].reduce((n, p) => n + p.meta.size, 0) + receiving;

  function drop(id, why) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    fs.rm(p.file, { force: true }, () => {});
    for (const w of p.waiters.splice(0)) w({ ok: false, error: why });
    log.log(`upload ${id} purged (${why})`);
  }

  // TTL sweep: an upload the Mac never collected is deleted, not kept.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) drop(id, 'expired before the Mac collected it');
  }, Math.min(30000, Math.max(250, ttlMs / 4)));
  sweep.unref?.();

  function offer(p) {
    sendToHost({ type: 'upload', ...p.meta, key: p.key });
  }

  // The host (re)connected: offer it everything still waiting.
  function onHostConnect() {
    for (const p of pending.values()) offer(p);
  }

  // host → relay {type:"uploadDone", id, ok, path?, detail?}. Returns true if
  // the frame was ours (so the caller doesn't fan it out).
  function onHostFrame(frame) {
    if (!frame || frame.type !== 'uploadDone') return false;
    const id = String(frame.id || '');
    const p = pending.get(id);
    if (!p) return true;
    pending.delete(id);
    fs.rm(p.file, { force: true }, () => {});
    const result = frame.ok
      ? { ok: true, delivered: true, id, path: String(frame.path || ''), name: p.meta.name, mime: p.meta.mime, size: p.meta.size }
      : { ok: false, error: String(frame.detail || 'the Mac could not save the file').slice(0, 300) };
    for (const w of p.waiters.splice(0)) w(result);
    log.log(`upload ${id} ${frame.ok ? 'delivered' : 'refused by the Mac'} — relay copy deleted`);
    return true;
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function authed(req, url) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    return tokenOk(bearer || url.searchParams.get('token') || '');
  }

  // Refuse without storing anything. The body is drained so the client reads
  // the reason instead of a reset — except an oversize one, where the socket
  // is closed so it stops sending.
  function refuse(req, res, status, error, { close = false } = {}) {
    if (close) res.setHeader('connection', 'close');
    json(res, status, { ok: false, error });
    req.resume();
  }

  function receive(req, file, limit) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, { mode: 0o600 });
      const hash = crypto.createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      let failed = false;
      const settle = () => { receiving -= size; }; // this upload no longer counts as in flight
      const fail = (e) => {
        if (failed) return;
        failed = true;
        settle();
        out.destroy();
        fs.rm(file, { force: true }, () => {});
        reject(e);
      };
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        receiving += c.length;
        if (size > limit) {
          fail(Object.assign(new Error('too large'), { status: 413 }));
          req.unpipe(out);
          req.resume();
          return;
        }
        if (head.length < 64) head = Buffer.concat([head, c.subarray(0, 64 - head.length)]);
        hash.update(c);
      });
      req.on('error', fail);
      req.on('aborted', () => fail(Object.assign(new Error('aborted'), { status: 400 })));
      out.on('error', fail);
      out.on('finish', () => {
        if (failed) return;
        const total = size;
        settle();
        resolve({ size: total, head, sha256: hash.digest('hex') });
      });
      req.pipe(out);
    });
  }

  async function post(req, res) {
    const name = cleanName(header(req, 'x-mc-name', 400));
    const ext = extOf(name);
    const type = TYPES[ext];
    if (!name) return refuse(req, res, 400, 'Send the file name in X-MC-Name');
    if (!type) return refuse(req, res, 415, `.${ext || '?'} files aren't accepted — send PDF, images, Office/iWork docs, text/CSV or audio`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return refuse(req, res, 413, `Too large — the limit is ${maxBytes / MB} MB per file`, { close: true });
    }
    if (!hostOnline()) return refuse(req, res, 503, 'The Mac is offline — try again when it’s back');
    if (!hostCanUpload()) return refuse(req, res, 501, 'The Mac app is too old to receive files — rebuild Mission Control on the Mac');
    if (pendingBytes() + (declared || 0) > maxPendingBytes) {
      return refuse(req, res, 503, 'Too many files are waiting for the Mac — try again shortly');
    }

    const id = `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const file = path.join(dir, id);
    let got;
    try {
      got = await receive(req, file, maxBytes);
    } catch (e) {
      if (res.headersSent) return undefined;
      if (e.status === 413) return refuse(req, res, 413, `Too large — the limit is ${maxBytes / MB} MB per file`, { close: true });
      return json(res, 400, { ok: false, error: 'The upload was interrupted' });
    }
    const reject = (status, error) => {
      fs.rm(file, { force: true }, () => {});
      return json(res, status, { ok: false, error });
    };
    if (!got.size) return reject(400, 'The file is empty');
    if (type.sniff === TEXT) {
      if (!validUtf8Text(fs.readFileSync(file))) return reject(415, `That doesn't look like a .${ext} text file`);
    } else if (!type.sniff(got.head)) {
      return reject(415, `That doesn't look like a real .${ext} file`);
    }

    const meta = {
      id,
      name,
      mime: type.mime,
      size: got.size,
      sha256: got.sha256,
      at: new Date().toISOString(),
    };
    const caption = header(req, 'x-mc-caption', 2000);
    if (caption) meta.caption = caption;
    const batch = header(req, 'x-mc-batch', 16);
    if (/^\d{1,3}\/\d{1,3}$/.test(batch)) {
      meta.batch = batch;
      const bid = header(req, 'x-mc-batch-id', 64).replace(/[^\w-]/g, '');
      if (bid) meta.batchId = bid;
    }
    const p = { meta, key: crypto.randomBytes(24).toString('hex'), file, expires: Date.now() + ttlMs, waiters: [] };
    pending.set(id, p);
    log.log(`upload ${id}: ${name} (${meta.mime}, ${got.size} B) → offering to the Mac`);

    const done = new Promise((resolve) => p.waiters.push(resolve));
    if (hostOnline()) offer(p);
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), deliverWaitMs));
    const result = await Promise.race([done, timer]);
    if (!result) {
      return json(res, 202, {
        ok: true, queued: true, id, name, mime: meta.mime, size: meta.size,
        detail: `The Mac hasn't collected it yet — it will when it reconnects (kept ${Math.round(ttlMs / 60000)} min)`,
      });
    }
    return json(res, result.ok ? 200 : 502, result);
  }

  // The host pulls the bytes. Needs the token AND the per-upload key.
  function get(req, res, id) {
    const p = pending.get(id);
    const key = Buffer.from(String(req.headers['x-mc-key'] || ''));
    const want = p ? Buffer.from(p.key) : null;
    if (!p || key.length !== want.length || !crypto.timingSafeEqual(key, want)) {
      return json(res, 404, { ok: false, error: 'no such upload' });
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': p.meta.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(p.file).pipe(res);
    return undefined;
  }

  async function handle(req, res, url) {
    if (!authed(req, url)) return refuse(req, res, 401, 'unauthorized', { close: true });
    const route = url.pathname.replace(/\/+$/, '');
    if (route === '/upload' && req.method === 'POST') return post(req, res);
    if (route === '/upload' && req.method === 'GET') {
      return json(res, 200, { ok: true, maxBytes, types: Object.keys(TYPES) });
    }
    const m = /^\/upload\/(u_[\w]+)$/.exec(route);
    if (m && req.method === 'GET') return get(req, res, m[1]);
    return json(res, 404, { ok: false, error: `no route ${req.method} ${route}` });
  }

  return {
    handle,
    onHostFrame,
    onHostConnect,
    info: () => ({ pending: pending.size, maxMB: maxBytes / MB, ttlMin: +(ttlMs / 60000).toFixed(2) }),
    close: () => clearInterval(sweep),
  };
}

module.exports = { createUpload, TYPES, extOf, cleanName };
