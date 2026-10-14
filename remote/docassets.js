'use strict';
// Images for Library docs (task 0124). A doc's pictures live next to it on the
// Mac (~/.mission-control/library/<stem>.assets/), and the markdown points at
// them relatively: ![alt](assets/photo.jpg). The relay can't reach the Mac's
// disk, so `mc-doc attach` / `mc-doc sync` push a copy here, and the panel
// reads it back:
//
//   GET    /api/v1/doc-assets/<stem>/                 → {ok, files:[{name, bytes, sha256, thumb}]}
//   GET    /api/v1/doc-assets/<stem>/<name>[?size=thumb]  → the image (thumb falls back to full;
//                                                     204 when neither exists, 404 without ?size)
//   HEAD   same                                       → headers only (ETag = sha256)
//   PUT    /api/v1/doc-assets/<stem>/<name>[?size=thumb]  body = the image bytes → {ok, sha256, bytes}
//   DELETE /api/v1/doc-assets/<stem>/<name>           → removes it (and its thumb)
//
// <stem> is the doc id without ".md". Auth is the same shared token as the
// rest of /api (Bearer, or ?token=). Safety:
//   - every path segment must match a strict name pattern (no dots up front,
//     no "..", no slashes once decoded), and the resolved file must sit inside
//     the store — checked again after resolving;
//   - raster images only (jpg/png/webp/gif/avif), and the bytes must match the
//     extension; SVG is refused (it can carry script);
//   - 12 MB per file, 400 files per doc, a total store cap (DOC_ASSETS_MB);
//   - served with nosniff and a sandboxing CSP, never as HTML.
//
// Storage: the Railway volume (doc-assets/), or a temp dir on a local run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const TYPES = {
  jpg: { mime: 'image/jpeg', sniff: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', sniff: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', sniff: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  gif: { mime: 'image/gif', sniff: (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8' },
  webp: { mime: 'image/webp', sniff: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  avif: { mime: 'image/avif', sniff: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1')) },
};

// A doc stem or file name: starts with a letter/digit, then letters, digits,
// dot, dash, underscore; never "..". File names also need an image extension.
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
function okStem(s) {
  return typeof s === 'string' && SEG.test(s) && !s.includes('..') && !/\.md$/i.test(s);
}
function okName(s) {
  if (typeof s !== 'string' || !SEG.test(s) || s.includes('..')) return false;
  const ext = s.slice(s.lastIndexOf('.') + 1).toLowerCase();
  return s.includes('.') && Object.prototype.hasOwnProperty.call(TYPES, ext);
}
const extOf = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

// Raw path → [stem, name] or an error. Works on the *undecoded* path so an
// encoded "/" (%2F) or "\" can't smuggle in a separator.
function parsePath(rawPath) {
  const prefix = '/api/v1/doc-assets/';
  if (!rawPath.startsWith(prefix)) return { error: 'not an asset path' };
  const parts = rawPath.slice(prefix.length).split('/');
  if (parts.length > 2) return { error: 'bad path' };
  let dec;
  try {
    dec = parts.map((p) => decodeURIComponent(p));
  } catch {
    return { error: 'bad path' };
  }
  if (dec.some((p) => /[/\\\0]/.test(p))) return { error: 'bad path' };
  const [stem, name = ''] = dec;
  if (!okStem(stem)) return { error: 'bad doc id' };
  if (name !== '' && !okName(name)) return { error: 'bad file name (letters, digits, . - _ and a jpg/png/webp/gif/avif extension)' };
  return { stem, name };
}

function createDocAssets({ tokenOk, dir, maxFileBytes = 12 * MB, maxFiles = 400, maxTotalBytes = 2048 * MB }) {
  const root = path.resolve(dir || path.join(os.tmpdir(), 'mc-doc-assets'));
  fs.mkdirSync(root, { recursive: true });

  // Running total, so the store cap doesn't need a full walk per upload.
  let total = 0;
  try {
    for (const d of fs.readdirSync(root)) {
      const walk = (p) => {
        for (const f of fs.readdirSync(p, { withFileTypes: true })) {
          const fp = path.join(p, f.name);
          if (f.isDirectory()) walk(fp);
          else if (f.isFile()) total += fs.statSync(fp).size;
        }
      };
      const dp = path.join(root, d);
      if (fs.statSync(dp).isDirectory()) walk(dp);
    }
  } catch {}

  // The file for (stem, name, thumb) — or null if it would leave the store.
  function fileFor(stem, name, thumb) {
    const p = thumb ? path.resolve(root, stem, '.thumbs', name) : path.resolve(root, stem, name);
    const base = path.resolve(root, stem) + path.sep;
    return p.startsWith(base) ? p : null;
  }

  const shaCache = new Map(); // file → {mtimeMs, size, sha}
  function shaOf(file, st) {
    const c = shaCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.sha;
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    shaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
    return sha;
  }

  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  // The body, up to `limit` bytes. Over the limit the rest is drained (not
  // kept) so the client gets a clean 413 instead of a reset socket.
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const tooBig = () => Object.assign(new Error('too large'), { status: 413 });
      const declared = Number(req.headers['content-length']);
      const chunks = [];
      let n = 0;
      let over = Number.isFinite(declared) && declared > limit;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) over = true;
        if (!over) chunks.push(c);
      });
      req.on('end', () => (over ? reject(tooBig()) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  function list(stem) {
    const d = path.join(root, stem);
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(d).filter(okName);
    } catch {}
    for (const name of names.sort()) {
      const f = path.join(d, name);
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const t = path.join(d, '.thumbs', name);
      let thumbSha = '';
      try {
        thumbSha = shaOf(t, fs.statSync(t));
      } catch {}
      out.push({ name, bytes: st.size, sha256: shaOf(f, st), thumb: thumbSha || null });
    }
    return out;
  }

  async function handle(req, res, url) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenOk(bearer) && !tokenOk(url.searchParams.get('token') || '')) {
      return json(res, 401, { ok: false, error: 'missing or bad token' });
    }
    const p = parsePath(url.pathname);
    if (p.error) return json(res, 400, { ok: false, error: p.error });
    const { stem, name } = p;
    const thumb = url.searchParams.get('size') === 'thumb';
    const m = req.method;

    if (!name) {
      if (m !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
      return json(res, 200, { ok: true, doc: stem, files: list(stem) });
    }

    const file = fileFor(stem, name, thumb);
    if (!file) return json(res, 400, { ok: false, error: 'bad path' });

    if (m === 'GET' || m === 'HEAD') {
      let f = file;
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        if (!thumb) return json(res, 404, { ok: false, error: 'no such asset' });
        f = fileFor(stem, name, false); // no thumb: the full image
        try {
          st = fs.statSync(f);
        } catch {
          // The panel's inline view asks with ?size=thumb: "nothing here" is
          // an answer (204, like /thumb), not an error for its console.
          res.writeHead(204, { 'cache-control': 'no-store', 'x-mc-why': 'not synced to the relay' });
          return res.end();
        }
      }
      if (!st.isFile()) return json(res, 404, { ok: false, error: 'no such asset' });
      const etag = `"${shaOf(f, st)}"`;
      const headers = {
        'content-type': TYPES[extOf(name)].mime,
        'cache-control': 'private, max-age=3600',
        etag,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      if (m === 'HEAD') return res.end();
      return fs.createReadStream(f).pipe(res);
    }

    if (m === 'PUT') {
      let body;
      try {
        body = await readBody(req, maxFileBytes);
      } catch (e) {
        return json(res, e.status || 400, { ok: false, error: e.status === 413 ? `too large (max ${Math.round(maxFileBytes / MB)} MB)` : 'read failed' });
      }
      if (!body.length) return json(res, 400, { ok: false, error: 'empty body' });
      if (!TYPES[extOf(name)].sniff(body)) return json(res, 415, { ok: false, error: `the bytes are not a ${extOf(name)} image` });
      let prev = 0;
      try {
        prev = fs.statSync(file).size;
      } catch {}
      if (!thumb && !prev && list(stem).length >= maxFiles) return json(res, 507, { ok: false, error: `too many files for one doc (max ${maxFiles})` });
      if (total - prev + body.length > maxTotalBytes) return json(res, 507, { ok: false, error: 'asset store is full' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      total += body.length - prev;
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      return json(res, 200, { ok: true, doc: stem, name, thumb, bytes: body.length, sha256: sha });
    }

    if (m === 'DELETE') {
      let removed = false;
      for (const f of [fileFor(stem, name, false), fileFor(stem, name, true)]) {
        try {
          const n = fs.statSync(f).size;
          fs.unlinkSync(f);
          total -= n;
          removed = true;
        } catch {}
      }
      return json(res, removed ? 200 : 404, { ok: removed, doc: stem, name });
    }

    return json(res, 405, { ok: false, error: 'GET, HEAD, PUT or DELETE' });
  }

  return { handle, root, info: () => ({ bytes: total, dir: root }) };
}

const mimeOf = (name) => (TYPES[extOf(name)] || {}).mime || 'application/octet-stream';

module.exports = { createDocAssets, parsePath, okName, okStem, mimeOf };
