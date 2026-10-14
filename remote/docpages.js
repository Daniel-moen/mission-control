'use strict';
// HTML pages in the Library (task 0126). A "page" doc is a full, self-contained
// HTML page (like a Claude artifact) that Mia publishes with `mc-doc new --kind
// page`. On the Mac it is <stem>.md (a stub, so lists work) + <stem>.html +
// <stem>.assets/. mc-doc pushes the HTML here and the images to the doc-asset
// store (docassets.js), and the panel shows it full-bleed in an iframe.
//
//   PUT    /api/v1/doc-pages/<stem>   body = the HTML (≤ 2 MB)   → {ok, bytes, sha256}
//   GET    /api/v1/doc-pages/<stem>   → {ok, url, bytes, sha256, updatedAt}  (404 if none)
//   DELETE /api/v1/doc-pages/<stem>   → removes it
//   (token-auth like the rest of /api: Bearer or ?token=)
//
//   GET    /p/<cap>/<stem>/                → the page, wrapped and locked down
//   GET    /p/<cap>/<stem>/assets/<name>   → one of its images (also /p/<cap>/<stem>/<name>)
//
// Security model — a page is untrusted content and must never reach the
// panel's token or the API:
//   - `url` carries a capability, not the token: <cap> = expiry + HMAC(stem,
//     expiry) under a key derived from MC_TOKEN. It grants read access to that
//     one page and its images, for PAGE_LINK_HOURS (default 7 days), nothing
//     else. The panel asks for a fresh one each time it opens the page.
//   - the panel frames it with sandbox="allow-scripts" (no allow-same-origin),
//     and the response itself carries CSP `sandbox` too, so even opened on its
//     own the page runs in an opaque origin: no localStorage, no cookies, no
//     same-origin reads of the panel.
//   - CSP like Claude artifacts: scripts only inline or from cdnjs / jsdelivr /
//     unpkg; styles inline + those CDNs + Google Fonts; fonts from Google
//     Fonts; images/media only from the page's own /p/<cap>/<stem>/ path plus
//     data: and blob:; connect-src/frame-src/object-src/form-action 'none'; it
//     can only be framed by the relay's own origin; no referrer leaves it (the
//     capability stays out of CDN logs).
//   - The panel talks to the page only by postMessage, and checks what comes
//     back (an image URL must sit under this page's own path).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { okName, okStem, mimeOf } = require('./docassets');

const MB = 1024 * 1024;
const CDN_SCRIPT = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];
const FONT_CSS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';

// What the page's own little helper does inside the frame (opaque origin, so
// the panel can't reach in): follow the panel's theme, send a tap on one of
// its own images to the panel's lightbox, open web links in a new tab, and
// open links to other Library docs (other-doc.md) in the panel.
const HELPER = `(function(){
var P=window.parent,R=document.documentElement;
function theme(t){if(t==='dark'||t==='light')R.setAttribute('data-theme',t);else R.removeAttribute('data-theme');}
addEventListener('message',function(e){if(e.source!==P)return;var d=e.data||{};if(d.mc==='theme')theme(d.theme);});
var IMG=/\\.(jpe?g|png|gif|webp|avif)$/i,BASE=location.href.replace(/[?#].*$/,'').replace(/[^/]*$/,'');
function own(u){try{var x=new URL(u,location.href);x.hash='';x.search='';return x.href.indexOf(BASE)===0&&IMG.test(x.pathname)?x.href:'';}catch(_){return '';}}
function fullOf(i){var a=i.closest('a[href]');return (a&&own(a.href))||own(i.currentSrc||i.src);}
document.addEventListener('click',function(e){
if(e.defaultPrevented||e.button||!e.target.closest)return;
var a=e.target.closest('a[href]'),img=e.target.closest('img');
var hit=a?own(a.href):(img?fullOf(img):'');
if(hit){e.preventDefault();var all=[],seen={};
[].forEach.call(document.querySelectorAll('img'),function(i){var s=fullOf(i);if(!s||seen[s])return;seen[s]=1;var f=i.closest('figure'),c=f&&f.querySelector('figcaption');all.push({src:s,alt:(i.alt||'').slice(0,300),caption:c?c.textContent.replace(/\\s+/g,' ').trim().slice(0,300):''});});
var at=-1;for(var k=0;k<all.length;k++)if(all[k].src===hit)at=k;if(at<0){all.unshift({src:hit,alt:'',caption:''});at=0;}
P.postMessage({mc:'lightbox',items:all.slice(0,400),at:at},'*');return;}
if(!a)return;var h=a.getAttribute('href')||'',m=/^(?:\\.\\/)?([A-Za-z0-9][A-Za-z0-9._-]*\\.md)(?:#.*)?$/.exec(h);
if(m){e.preventDefault();P.postMessage({mc:'open-doc',id:m[1]},'*');return;}
if(/^https?:/i.test(a.href)&&a.href.indexOf(BASE)!==0){a.target='_blank';a.rel='noopener noreferrer';}
},false);
})();`;

// The page as served: a document skeleton around a fragment (Claude-artifact
// style pages often have none), the theme on <html data-theme>, and the head
// bits every page needs.
function buildPage(src, { theme = '' } = {}) {
  let html = String(src || '').replace(/^﻿/, '');
  const t = theme === 'dark' || theme === 'light' ? theme : '';
  const head =
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="referrer" content="no-referrer">' +
    '<style>:where(html){-webkit-text-size-adjust:100%}:where(body){margin:0}:where(img,video,canvas,svg){max-width:100%}</style>' +
    `<script>${HELPER}</script>`;
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (!htmlTag) {
    return `<!doctype html><html lang="en"${t ? ` data-theme="${t}"` : ''}><head>${head}</head><body>${html}</body></html>`;
  }
  let tag = htmlTag[0];
  if (t && !/\sdata-theme\s*=/i.test(tag)) tag = tag.replace(/^<html\b/i, `<html data-theme="${t}"`);
  html = html.slice(0, htmlTag.index) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  const headTag = /<head\b[^>]*>/i.exec(html);
  if (headTag) {
    const at = headTag.index + headTag[0].length;
    html = html.slice(0, at) + head + html.slice(at);
  } else {
    const h = /<html\b[^>]*>/i.exec(html);
    const at = h.index + h[0].length;
    html = html.slice(0, at) + `<head>${head}</head>` + html.slice(at);
  }
  if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>${html}`;
  return html;
}

function pageCsp(origin, base) {
  const own = `${origin}${base}`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${CDN_SCRIPT.join(' ')}`,
    `style-src 'unsafe-inline' ${FONT_CSS} ${CDN_SCRIPT.join(' ')}`,
    `font-src ${FONT_FILES} data:`,
    `img-src ${own} data: blob:`,
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${origin}`,
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  ].join('; ');
}

function createDocPages({ tokenOk, secret, dir, assetsRoot, maxPageBytes = 2 * MB, maxTotalBytes = 200 * MB, linkHours = 24 * 7 }) {
  const root = path.resolve(dir || path.join(os.tmpdir(), 'mc-doc-pages'));
  fs.mkdirSync(root, { recursive: true });
  const key = crypto.createHash('sha256').update(`mc-doc-page-cap\n${secret}`).digest();
  const assets = path.resolve(assetsRoot || path.join(os.tmpdir(), 'mc-doc-assets'));

  let total = 0;
  try {
    for (const f of fs.readdirSync(root)) if (f.endsWith('.html')) total += fs.statSync(path.join(root, f)).size;
  } catch {}

  const sign = (stem, exp) => crypto.createHmac('sha256', key).update(`${stem}\n${exp}`).digest('base64url').slice(0, 32);
  function capFor(stem, now = Date.now()) {
    const exp = Math.floor(now / 1000) + Math.round(linkHours * 3600);
    return `${exp.toString(36)}-${sign(stem, exp)}`;
  }
  function capOk(cap, stem, now = Date.now()) {
    const m = /^([0-9a-z]{1,10})-([A-Za-z0-9_-]{32})$/.exec(cap || '');
    if (!m) return false;
    const exp = parseInt(m[1], 36);
    if (!Number.isFinite(exp) || exp * 1000 < now) return false;
    const want = Buffer.from(sign(stem, exp));
    const got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  const fileOf = (stem) => {
    const p = path.resolve(root, `${stem}.html`);
    return p.startsWith(root + path.sep) ? p : null;
  };
  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const notFound = (res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end('not found');
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      const chunks = [];
      let n = 0;
      let over = Number.isFinite(declared) && declared > limit;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) over = true;
        if (!over) chunks.push(c);
      });
      req.on('end', () => (over ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  // The origin the browser used (Railway terminates TLS in front of us).
  function originOf(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? `${proto === 'https' ? 'https' : 'http'}://${host}` : '';
  }

  // /api/v1/doc-pages/<stem>
  async function handleApi(req, res, url) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenOk(bearer) && !tokenOk(url.searchParams.get('token') || '')) {
      return json(res, 401, { ok: false, error: 'missing or bad token' });
    }
    const raw = url.pathname.slice('/api/v1/doc-pages/'.length);
    let stem;
    try {
      stem = decodeURIComponent(raw);
    } catch {
      return json(res, 400, { ok: false, error: 'bad path' });
    }
    if (/[/\\\0]/.test(stem) || !okStem(stem)) return json(res, 400, { ok: false, error: 'bad doc id' });
    const file = fileOf(stem);
    if (!file) return json(res, 400, { ok: false, error: 'bad path' });
    const m = req.method;

    if (m === 'GET' || m === 'HEAD') {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        return json(res, 404, { ok: false, error: 'no such page (run `mc-doc sync` on the Mac)' });
      }
      const buf = fs.readFileSync(file);
      return json(res, 200, {
        ok: true,
        doc: stem,
        url: `/p/${capFor(stem)}/${encodeURIComponent(stem)}/`,
        bytes: st.size,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        updatedAt: Math.floor(st.mtimeMs / 1000),
      });
    }

    if (m === 'PUT') {
      let body;
      try {
        body = await readBody(req, maxPageBytes);
      } catch (e) {
        return json(res, e.status || 400, { ok: false, error: e.status === 413 ? `too large (max ${Math.round(maxPageBytes / MB)} MB of HTML; put images in assets)` : 'read failed' });
      }
      if (!body.length) return json(res, 400, { ok: false, error: 'empty body' });
      if (body.includes(0)) return json(res, 415, { ok: false, error: 'not text' });
      const text = body.toString('utf8');
      if (Buffer.byteLength(text) !== body.length || text.includes('�')) return json(res, 415, { ok: false, error: 'the page must be UTF-8 HTML' });
      let prev = 0;
      try {
        prev = fs.statSync(file).size;
      } catch {}
      if (total - prev + body.length > maxTotalBytes) return json(res, 507, { ok: false, error: 'page store is full' });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      total += body.length - prev;
      return json(res, 200, { ok: true, doc: stem, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') });
    }

    if (m === 'DELETE') {
      try {
        const n = fs.statSync(file).size;
        fs.unlinkSync(file);
        total -= n;
        return json(res, 200, { ok: true, doc: stem });
      } catch {
        return json(res, 404, { ok: false, doc: stem });
      }
    }
    return json(res, 405, { ok: false, error: 'GET, PUT or DELETE' });
  }

  // /p/<cap>/<stem>/[assets/]<name> — public by capability. Works on the RAW
  // path: an encoded "/" or ".." never becomes a separator.
  function handlePublic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    const parts = url.pathname.split('/'); // ['', 'p', cap, stem, ...]
    if (parts.length < 5 || parts.length > 6) return notFound(res);
    let dec;
    try {
      dec = parts.slice(2).map((p) => decodeURIComponent(p));
    } catch {
      return notFound(res);
    }
    if (dec.some((p) => /[/\\\0]/.test(p))) return notFound(res);
    const [cap, stem, ...rest] = dec;
    if (!okStem(stem) || !capOk(cap, stem)) return notFound(res);
    const base = `/p/${parts[2]}/${parts[3]}/`;

    // The page itself: /p/<cap>/<stem>/ (or …/index.html)
    if (rest.length === 1 && (rest[0] === '' || rest[0] === 'index.html')) {
      const file = fileOf(stem);
      let src;
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch {
        return notFound(res);
      }
      const origin = originOf(req);
      if (!origin) return notFound(res);
      const out = Buffer.from(buildPage(src, { theme: url.searchParams.get('theme') || '' }));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': out.length,
        'cache-control': 'private, no-cache',
        'content-security-policy': pageCsp(origin, base),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      });
      return res.end(req.method === 'HEAD' ? undefined : out);
    }

    // An image: /p/<cap>/<stem>/assets/<name> or /p/<cap>/<stem>/<name>
    let name = '';
    if (rest.length === 2 && rest[0] === 'assets') name = rest[1];
    else if (rest.length === 1) name = rest[0];
    if (!okName(name)) return notFound(res);
    const f = path.resolve(assets, stem, name);
    if (!f.startsWith(path.resolve(assets, stem) + path.sep)) return notFound(res);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      return notFound(res);
    }
    if (!st.isFile()) return notFound(res);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = {
      'content-type': mimeOf(name),
      'cache-control': 'private, max-age=86400',
      etag,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(f).pipe(res);
  }

  return { handleApi, handlePublic, capFor, capOk, root, info: () => ({ bytes: total }) };
}

module.exports = { createDocPages, buildPage, pageCsp };
