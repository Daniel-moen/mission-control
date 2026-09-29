'use strict';
// Listing thumbnails for Library docs (task 0070). A doc's table links to a
// property page; the panel shows a small photo beside the link. The browser
// can't fetch those pages itself (CORS, hotlink blocks, X-Frame-Options), so
// the relay does it:
//
//   GET /api/v1/thumb?url=<page>  → the page's first photo (og:image), as bytes;
//                                   204 when the page has none
//   GET /api/v1/img?url=<image>   → an image a doc embeds (![](…)), proxied
//
// Both answer from a cache: images in memory (LRU, ~32 MB) and on disk (the
// Railway volume; LRU, 200 MB, 7-day TTL), plus which image each page maps to
// (pages.json). Upstream fetches go through one limiter: at most 4 at a time,
// at most 2 per site, and Property24 (which rate-limits) one at a time with a
// gap. Concurrent asks for the same page or image share one fetch.
//
// Thumbnails ask a CDN for a small size where we know its URL scheme
// (the cloudfront host most SA agencies share, Pam Golding's ?w=), and fall
// back to the full image. Only raster images are served (no SVG — it could
// carry script), with nosniff and a sandboxing CSP.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { preview: realPreview, publicHost: realPublicHost, UA } = require('./preview');

const DAY = 24 * 3600 * 1000;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const EXT_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));
const MAX_IMAGE = 6 * 1024 * 1024;
const IMG_TIMEOUT_MS = 10000;
const MAX_HOPS = 5;

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const slowSite = (host) => /(^|\.)(property24\.com|prop24\.com)$/.test(host);
// Who the limiter counts a fetch against. Most SA agency sites (Seeff, Tyson,
// Greeff, Lance, DG, Marion Taylor, Chas Everitt, Jawitz…) are one hosted
// platform — /results/residential/… — that slows to a crawl when hit on
// several of its domains at once, so they share one slot pool.
function groupOf(u) {
  const host = hostOf(u);
  try {
    if (/^\/results\/(residential|commercial|agricultural)\//i.test(new URL(u).pathname)) return 'agency-platform';
  } catch {}
  return host;
}

// A smaller copy of a listing photo, where the CDN's URL scheme allows it.
function smallVariant(u) {
  let x;
  try {
    x = new URL(u);
  } catch {
    return '';
  }
  // d21tw07c6rnmp0.cloudfront.net/…_t_c_w_1200_h_630.jpg (Seeff, Tyson, Greeff, Lance, DG, Jawitz…)
  if (/_t_c?_?w_\d+(_h_\d+)?\.(jpe?g|png|webp)$/i.test(x.pathname)) {
    x.pathname = x.pathname.replace(/_t_c?_?w_\d+(_h_\d+)?\.(jpe?g|png|webp)$/i, (_m, _h, ext) => `_t_c_w_240_h_180.${ext}`);
    return x.href === u ? '' : x.href;
  }
  // resources.pamgolding.co.za/…jpg?w=1200
  if (x.searchParams.has('w') && +x.searchParams.get('w') > 320) {
    x.searchParams.set('w', '240');
    return x.href;
  }
  return '';
}

function createThumbs({
  dir,
  maxBytes = 200 * 1024 * 1024,
  memBytes = 32 * 1024 * 1024,
  ttlMs = 7 * DAY,
  noneTtlMs = DAY, // a page with no photo is asked again after a day
  failTtlMs = 20 * 60 * 1000, // a timeout / 429 / 5xx after 20 minutes
  concurrency = 4,
  perHost = 2,
  slowGapMs = 1500,
  preview = realPreview,
  publicHost = realPublicHost,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console,
} = {}) {
  dir = dir || path.join(os.tmpdir(), 'mc-thumb-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log.warn(`thumbs: no disk cache (${e.message})`);
    dir = '';
  }

  // ---- upstream limiter ------------------------------------------------------
  let active = 0;
  const hostActive = new Map();
  const hostLast = new Map();
  const queue = [];
  const stats = { upstream: 0, peak: 0, peakSlow: 0, memHits: 0, diskHits: 0, misses: 0 };

  function pump() {
    for (let i = 0; i < queue.length && active < concurrency; i++) {
      const job = queue[i];
      const n = hostActive.get(job.host) || 0;
      const slow = slowSite(job.host);
      if (n >= (slow ? 1 : perHost)) continue;
      if (slow) {
        const wait = (hostLast.get(job.host) || 0) + slowGapMs - now();
        if (wait > 0) {
          if (!job.timer) job.timer = setTimeout(() => ((job.timer = null), pump()), wait);
          continue;
        }
      }
      queue.splice(i--, 1);
      active += 1;
      hostActive.set(job.host, n + 1);
      stats.upstream += 1;
      stats.peak = Math.max(stats.peak, active);
      if (slow) stats.peakSlow = Math.max(stats.peakSlow, n + 1);
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          hostActive.set(job.host, (hostActive.get(job.host) || 1) - 1);
          if (slow) hostLast.set(job.host, now());
          pump();
        });
    }
  }
  const limited = (url, fn) =>
    new Promise((resolve, reject) => {
      queue.push({ host: groupOf(url), fn, resolve, reject, timer: null });
      pump();
    });

  // Concurrent asks for the same key share one promise.
  const inflight = new Map();
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---- image store: memory LRU over a disk LRU --------------------------------
  // disk index: key → { file, size, type, at (fetched), used }
  const disk = new Map();
  let diskBytes = 0;
  const mem = new Map(); // key → { body, type, at }; Map order = recency
  let memUsed = 0;

  if (dir) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([0-9a-f]{40})\.(\w+)$/);
      if (!m || !EXT_TYPE[m[2]]) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        disk.set(m[1], { file: f, size: st.size, type: EXT_TYPE[m[2]], at: st.mtimeMs, used: Math.max(st.atimeMs, st.mtimeMs) });
        diskBytes += st.size;
      } catch {}
    }
  }

  function dropDisk(key) {
    const e = disk.get(key);
    if (!e) return;
    disk.delete(key);
    diskBytes -= e.size;
    try {
      fs.unlinkSync(path.join(dir, e.file));
    } catch {}
  }
  function trimDisk() {
    if (diskBytes <= maxBytes) return;
    const byUse = [...disk.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of byUse) {
      if (diskBytes <= maxBytes * 0.9) break;
      dropDisk(k);
    }
  }
  function memPut(key, v) {
    if (v.body.length > memBytes / 4) return;
    if (mem.has(key)) memUsed -= mem.get(key).body.length;
    mem.delete(key);
    mem.set(key, v);
    memUsed += v.body.length;
    for (const [k, old] of mem) {
      if (memUsed <= memBytes) break;
      mem.delete(k);
      memUsed -= old.body.length;
    }
  }

  function getImage(key) {
    const m = mem.get(key);
    if (m && now() - m.at < ttlMs) {
      mem.delete(key);
      mem.set(key, m);
      stats.memHits += 1;
      return { ...m, cache: 'mem' };
    }
    const d = disk.get(key);
    if (d && now() - d.at < ttlMs) {
      try {
        const body = fs.readFileSync(path.join(dir, d.file));
        d.used = now();
        try {
          fs.utimesSync(path.join(dir, d.file), new Date(d.used), new Date(d.at));
        } catch {}
        const v = { body, type: d.type, at: d.at };
        memPut(key, v);
        stats.diskHits += 1;
        return { ...v, cache: 'disk' };
      } catch {
        dropDisk(key);
      }
    } else if (d) dropDisk(key);
    return null;
  }

  function putImage(key, body, type) {
    const at = now();
    memPut(key, { body, type, at });
    if (!dir) return;
    dropDisk(key);
    const file = `${key}.${TYPES[type]}`;
    try {
      fs.writeFileSync(path.join(dir, file), body);
      fs.utimesSync(path.join(dir, file), new Date(at), new Date(at));
      disk.set(key, { file, size: body.length, type, at, used: at });
      diskBytes += body.length;
      trimDisk();
    } catch (e) {
      log.warn(`thumbs: disk write failed (${e.message})`);
    }
  }

  // ---- page → image map (pages.json) -----------------------------------------
  // url → { img: string|'' , at, ttl }
  const pagesFile = dir ? path.join(dir, 'pages.json') : '';
  let pages = new Map();
  try {
    if (pagesFile) pages = new Map(Object.entries(JSON.parse(fs.readFileSync(pagesFile, 'utf8'))));
  } catch {}
  let saveTimer = null;
  function savePages() {
    if (!pagesFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const t = now();
      for (const [k, v] of pages) if (t - v.at > v.ttl) pages.delete(k);
      const keep = [...pages.entries()].slice(-5000);
      pages = new Map(keep);
      try {
        fs.writeFileSync(pagesFile + '.tmp', JSON.stringify(Object.fromEntries(keep)));
        fs.renameSync(pagesFile + '.tmp', pagesFile);
      } catch {}
    }, 2000);
    saveTimer.unref?.();
  }
  function notePage(url, img, ttl) {
    pages.delete(url);
    pages.set(url, { img, at: now(), ttl });
    savePages();
  }

  // Recent full previews (10 min) so tapping a thumbnail → the card is instant.
  const cards = new Map();
  function cachedPreview(url) {
    const c = cards.get(url);
    if (c && now() - c.at < 10 * 60 * 1000) return Promise.resolve(c.v);
    return once(`p:${url}`, () =>
      limited(url, () => preview(url))
        // One more go for a timeout: a busy site often answers the second time.
        .then((v) => (v && v.ok && !v.status && /too long/.test(v.why || '') ? limited(url, () => preview(url)) : v))
        .then((v) => {
        if (v && v.ok && v.status >= 200 && v.status < 300) {
          cards.set(url, { v, at: now() });
          if (cards.size > 300) cards.delete(cards.keys().next().value);
        }
        return v;
      })
    );
  }

  // ---- upstream image fetch ---------------------------------------------------
  async function fetchImage(url, referer) {
    let at;
    try {
      at = new URL(url);
    } catch {
      return { error: 'bad url' };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMG_TIMEOUT_MS);
    try {
      let res = null;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        if (at.protocol !== 'https:') return { error: 'not https' };
        if (!(await publicHost(at.hostname))) return { error: 'not a public address' };
        const headers = { 'user-agent': UA, accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8' };
        if (referer) headers.referer = referer;
        res = await fetchImpl(at.href, { redirect: 'manual', signal: ctl.signal, headers });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!loc) break;
        res.body?.cancel?.().catch(() => {});
        at = new URL(loc, at);
        res = null;
      }
      if (!res) return { error: 'too many redirects' };
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (res.status < 200 || res.status >= 300) {
        res.body?.cancel?.().catch(() => {});
        return { error: `HTTP ${res.status}`, retry: res.status === 429 || res.status >= 500 };
      }
      if (!TYPES[type]) {
        res.body?.cancel?.().catch(() => {});
        return { error: `not a raster image (${type || 'unknown'})` };
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length || body.length > MAX_IMAGE) return { error: 'empty or too large' };
      return { body, type };
    } catch (e) {
      return { error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'fetch failed', retry: true };
    } finally {
      clearTimeout(timer);
    }
  }

  // An image by URL, through the caches; null + why on failure.
  function image(url, { referer = '', small = false } = {}) {
    const key = sha(`${small ? 's:' : ''}${url}`);
    const hit = getImage(key);
    if (hit) return Promise.resolve(hit);
    return once(`i:${key}`, async () => {
      stats.misses += 1;
      let r = null;
      const v = small ? smallVariant(url) : '';
      if (v) r = await limited(v, () => fetchImage(v, referer));
      if (!r || !r.body) r = await limited(url, () => fetchImage(url, referer));
      if (!r.body) return { error: r.error, retry: r.retry };
      putImage(key, r.body, r.type);
      return { body: r.body, type: r.type, at: now(), cache: 'miss' };
    });
  }

  // The first photo of a listing page.
  async function thumb(pageUrl) {
    let u;
    try {
      u = new URL(String(pageUrl || ''));
    } catch {
      return { status: 400, error: 'not a valid link' };
    }
    if (u.protocol !== 'https:') return { status: 400, error: 'https links only' };
    const url = u.href;
    let known = pages.get(url);
    if (known && now() - known.at > known.ttl) known = null;
    if (known && !known.img) return { status: 204, why: known.why || 'no photo on that page' };
    let img = known?.img || '';
    if (!img) {
      const p = await cachedPreview(url);
      if (!p || !p.ok) {
        notePage(url, '', failTtlMs);
        return { status: 204, why: (p && p.error) || 'preview failed' };
      }
      img = p.image || '';
      const failed = !p.status || p.status === 429 || p.status >= 500;
      if (!img) {
        const why = p.why || 'no photo on that page';
        pages.set(url, { img: '', why, at: now(), ttl: failed ? failTtlMs : noneTtlMs });
        savePages();
        return { status: 204, why };
      }
    }
    const r = await image(img, { referer: `${u.origin}/`, small: true });
    if (!r.body) {
      notePage(url, '', r.retry ? failTtlMs : noneTtlMs);
      return { status: 204, why: `photo failed: ${r.error}` };
    }
    if (!known) notePage(url, img, ttlMs);
    return { status: 200, body: r.body, type: r.type, cache: r.cache, image: img };
  }

  async function proxied(imgUrl) {
    let u;
    try {
      u = new URL(String(imgUrl || ''));
    } catch {
      return { status: 400, error: 'not a valid link' };
    }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') return { status: 400, error: 'https links only' };
    const r = await image(u.href);
    if (!r.body) return { status: 404, error: r.error };
    return { status: 200, body: r.body, type: r.type, cache: r.cache };
  }

  // Write an image result to an http response.
  function send(res, r) {
    const base = {
      'cache-control': r.status === 200 ? 'private, max-age=604800' : 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    };
    if (r.status === 200) {
      res.writeHead(200, { ...base, 'content-type': r.type, 'content-length': r.body.length, 'x-mc-cache': r.cache || '' });
      return res.end(r.body);
    }
    if (r.status === 204) {
      res.writeHead(204, { ...base, 'x-mc-why': String(r.why || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200) });
      return res.end();
    }
    res.writeHead(r.status, { ...base, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: r.error || 'failed' }));
  }

  return {
    thumb,
    proxied,
    preview: cachedPreview,
    send,
    stats: () => ({ ...stats, active, queued: queue.length, diskBytes, diskFiles: disk.size, memBytes: memUsed, pages: pages.size, dir }),
  };
}

module.exports = { createThumbs, smallVariant };
