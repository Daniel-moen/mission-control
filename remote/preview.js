'use strict';
// Link previews for `mia panel show-url` (docs/mia.md §8.2). The panel can't
// tell from the browser whether a site lets itself be framed — a blocked
// iframe just stays blank — so the relay fetches the page once and answers:
//   { ok, url, finalUrl, status, frameable, why, title, site, description, image, images[] }
// frameable is true only for a 2xx HTML page with no X-Frame-Options and no
// CSP frame-ancestors that would refuse us. The card fields come from the
// Open Graph / Twitter / <title> / description tags, plus a few gallery
// images from the same host as og:image (listing sites like Property24).
//
// Guard rails: https only, no private/loopback/link-local addresses (checked
// on every redirect hop), 8 s, 1.5 MB of body, 5 redirects.

const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_HOPS = 5;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function publicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !privateIp(h);
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) return false;
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch {
    return false;
  }
}

// Would this response refuse to render inside our panel's iframe?
function frameBlock(headers) {
  const xfo = String(headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin' || xfo.startsWith('allow-from')) return `X-Frame-Options: ${xfo}`;
  const csp = String(headers.get('content-security-policy') || '');
  const fa = csp.split(/[;,]/).map((s) => s.trim()).find((d) => /^frame-ancestors\b/i.test(d));
  if (fa) {
    const srcs = fa.split(/\s+/).slice(1).map((s) => s.toLowerCase());
    if (!srcs.includes('*') && !srcs.includes('https:')) return `CSP ${fa}`;
  }
  return '';
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
const decode = (s) =>
  String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (ENT[e.toLowerCase()]) return ENT[e.toLowerCase()];
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

function parseCard(html, base) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || '').toLowerCase();
    if (k && a.content && !(k in meta)) meta[k] = decode(a.content);
  }
  const abs = (u) => {
    if (!u) return '';
    try {
      const x = new URL(u, base);
      return x.protocol === 'https:' ? x.href : '';
    } catch {
      return '';
    }
  };
  const titleTag = decode((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const image = abs(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || '');
  // A small gallery: images on the same host as og:image (a listing's photos),
  // de-duplicated, capped. Nothing when there's no og:image to anchor on.
  const images = [];
  if (image) {
    // One entry per photo: size variants (…/Ensure960x540, ?w=…) collapse to
    // one key, and small crops (agent headshots, logos) are skipped.
    const sized = /\/[A-Za-z]*(\d{2,4})x(\d{2,4})[^/]*$/;
    const keyOf = (u) => u.split('?')[0].replace(sized, '');
    const host = new URL(image).host;
    const seen = new Set([keyOf(image)]);
    for (const m of html.matchAll(/https:\/\/[^\s"'<>()\\]+/g)) {
      const u = m[0].replace(/&amp;/g, '&');
      let h = '';
      try {
        h = new URL(u).host;
      } catch {}
      if (h !== host || /\.(js|css|svg|ico|json)(\?|$)|logo|icon|sprite|favicon/i.test(u)) continue;
      const dims = u.split('?')[0].match(sized);
      if (dims && Math.max(+dims[1], +dims[2]) < 600) continue;
      const k = keyOf(u);
      if (seen.has(k)) continue;
      seen.add(k);
      images.push(u);
      if (images.length >= 11) break;
    }
  }
  return {
    title: meta['og:title'] || meta['twitter:title'] || titleTag || '',
    site: meta['og:site_name'] || '',
    description: meta['og:description'] || meta['description'] || meta['twitter:description'] || '',
    image,
    images: image ? [image, ...images] : [],
  };
}

async function preview(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return { ok: false, error: 'not a valid link' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'https links only' };
  const out = { ok: true, url: url.href, finalUrl: url.href, status: 0, frameable: false, why: '', title: '', site: '', description: '', image: '', images: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res = null;
    let at = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (at.protocol !== 'https:') return { ...out, why: 'redirected off https' };
      if (!(await publicHost(at.hostname))) return { ...out, why: 'not a public address' };
      res = await fetch(at.href, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-ZA,en;q=0.9' },
      });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      at = new URL(loc, at);
      res.body?.cancel?.().catch(() => {});
      res = null;
    }
    if (!res) return { ...out, why: 'too many redirects' };
    out.finalUrl = at.href;
    out.status = res.status;
    const block = frameBlock(res.headers);
    const type = String(res.headers.get('content-type') || '');
    let html = '';
    if (/html/i.test(type) && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let n = 0;
      while (n < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
      reader.cancel().catch(() => {});
      html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    } else {
      res.body?.cancel?.().catch(() => {});
    }
    Object.assign(out, parseCard(html, at.href));
    if (block) out.why = `the site forbids framing (${block})`;
    else if (res.status < 200 || res.status >= 300) out.why = `the site answered HTTP ${res.status}`;
    else if (!/html/i.test(type)) out.why = `not a web page (${type.split(';')[0] || 'unknown type'})`;
    else out.frameable = true;
    return out;
  } catch (e) {
    return { ...out, why: e && e.name === 'AbortError' ? 'the site took too long to answer' : `couldn't reach the site (${(e && e.cause && e.cause.code) || (e && e.message) || 'error'})` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { preview, frameBlock, parseCard, privateIp, publicHost, UA };
