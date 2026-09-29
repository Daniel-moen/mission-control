// Listing thumbnails on the relay (thumbs.js, task 0070) — no network: the
// page preview and the image CDN are in-process fakes.
//
//   cd remote && npm run test:thumbs
//
// Asserts: a listing page → its og:image bytes (small CDN variant first, the
// original when the variant fails); 204 for a page with no photo (and that
// answer is remembered); memory then disk cache (a fresh instance on the same
// dir serves from disk, zero upstream); concurrent asks share one fetch; at
// most 4 upstream fetches at once and Property24 one at a time with a gap;
// SVG / non-image refused; the disk cap evicts least-recently-used; the TTL
// expires; ![](…) image proxy; and the relay routes (auth, 400, 204, 200 +
// headers) through the real server.js.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createThumbs, smallVariant } = require('../thumbs.js');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-thumbs-'));

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};

// ---- fakes ---------------------------------------------------------------------
const JPEG = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
function world({ delay = 30 } = {}) {
  const w = { pages: new Map(), images: new Map(), previews: 0, fetches: 0, live: 0, peak: 0, liveP24: 0, peakP24: 0, p24Starts: [] };
  w.preview = async (url) => {
    w.previews += 1;
    const host = new URL(url).hostname;
    const p24 = /property24/.test(host);
    w.live += 1;
    w.peak = Math.max(w.peak, w.live);
    if (p24) {
      w.liveP24 += 1;
      w.peakP24 = Math.max(w.peakP24, w.liveP24);
      w.p24Starts.push(Date.now());
    }
    await sleep(delay);
    w.live -= 1;
    if (p24) w.liveP24 -= 1;
    const img = w.pages.get(url);
    return { ok: true, url, finalUrl: url, status: 200, frameable: false, why: 'x', title: 't', image: img || '', images: img ? [img] : [] };
  };
  w.fetchImpl = async (url) => {
    w.fetches += 1;
    w.live += 1;
    w.peak = Math.max(w.peak, w.live);
    await sleep(delay);
    w.live -= 1;
    const im = w.images.get(url);
    if (!im) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(im.body, { status: 200, headers: { 'content-type': im.type } });
  };
  return w;
}
const make = (w, extra = {}) =>
  createThumbs({ preview: w.preview, fetchImpl: w.fetchImpl, publicHost: async () => true, log: { warn() {} }, ...extra });

async function main() {
  console.log('small CDN variants');
  ok(smallVariant('https://d21tw07c6rnmp0.cloudfront.net/media/uploads/2/r/2_ab_t_c_w_1200_h_630.jpg').endsWith('_t_c_w_240_h_180.jpg'), 'agency cloudfront → 240×180');
  ok(smallVariant('https://resources.pamgolding.co.za/x/1.jpg?w=1200') === 'https://resources.pamgolding.co.za/x/1.jpg?w=240', 'Pam Golding ?w=1200 → ?w=240');
  ok(smallVariant('https://images.prop24.com/382768192') === '', 'unknown scheme: no variant');

  console.log('a listing → its photo; no photo → 204');
  const dir = path.join(TMP, 'cache1');
  const w = world();
  const T = make(w, { dir });
  const page = 'https://www.remax.co.za/listing/1';
  const big = 'https://cdn.example.co.za/1_t_c_w_1200_h_630.jpg';
  const small = 'https://cdn.example.co.za/1_t_c_w_240_h_180.jpg';
  w.pages.set(page, big);
  w.images.set(small, { body: JPEG(900), type: 'image/jpeg' });
  w.images.set(big, { body: JPEG(9000), type: 'image/jpeg' });
  let r = await T.thumb(page);
  ok(r.status === 200 && r.type === 'image/jpeg' && r.body.length === 904 && r.cache === 'miss', `200 with the small variant's bytes (${r.status}, ${r.body?.length})`);
  const f0 = w.fetches;
  const p0 = w.previews;
  r = await T.thumb(page);
  ok(r.status === 200 && r.cache === 'mem' && w.fetches === f0 && w.previews === p0, 'second ask: from memory, no upstream');

  const page2 = 'https://www.seeff.com/results/residential/for-sale/x/2/';
  const orig2 = 'https://cdn.example.co.za/2_t_c_w_1200_h_630.jpg';
  w.pages.set(page2, orig2);
  w.images.set(orig2, { body: JPEG(5000), type: 'image/jpeg' });
  r = await T.thumb(page2);
  ok(r.status === 200 && r.body.length === 5004, 'variant 404 → falls back to the original');

  const bare = 'https://www.privateproperty.co.za/for-sale/none/3';
  r = await T.thumb(bare);
  ok(r.status === 204, 'a page with no og:image → 204');
  const pv = w.previews;
  r = await T.thumb(bare);
  ok(r.status === 204 && w.previews === pv, '…and that answer is remembered (no second fetch)');

  const svgPage = 'https://www.greeff.co.za/listing/svg';
  w.pages.set(svgPage, 'https://cdn.example.co.za/logo.svg');
  w.images.set('https://cdn.example.co.za/logo.svg', { body: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/svg+xml' });
  r = await T.thumb(svgPage);
  ok(r.status === 204 && /raster/.test(r.why), `SVG is never served (${r.why})`);
  ok((await T.thumb('http://www.remax.co.za/x')).status === 400 && (await T.thumb('nonsense')).status === 400, 'http / junk links → 400');

  console.log('disk cache survives a restart');
  await sleep(2300); // pages.json is written on a 2 s debounce
  const w2 = world();
  const T2 = make(w2, { dir });
  r = await T2.thumb(page);
  ok(r.status === 200 && r.cache === 'disk' && w2.previews === 0 && w2.fetches === 0, `fresh instance: from disk, zero upstream (${r.cache}, ${w2.previews}p/${w2.fetches}f)`);
  ok((await T2.thumb(bare)).status === 204 && w2.previews === 0, '…the "no photo" answer too');

  console.log('concurrency: shared fetches, 4 at a time, Property24 one at a time');
  const w3 = world({ delay: 60 });
  const T3 = make(w3, { dir: path.join(TMP, 'cache3'), slowGapMs: 150 });
  const urls = [];
  for (let i = 0; i < 40; i++) {
    const site = ['www.remax.co.za', 'www.tysonprop.co.za', 'www.privateproperty.co.za', 'www.pamgolding.co.za', 'www.jawitz.co.za'][i % 5];
    const u = `https://${site}/listing/${i}`;
    const img = `https://img${i % 7}.example.com/p/${i}.jpg`;
    w3.pages.set(u, img);
    w3.images.set(img, { body: JPEG(100 + i), type: 'image/jpeg' });
    urls.push(u);
  }
  for (let i = 0; i < 5; i++) {
    const u = `https://www.property24.com/for-sale/a/b/c/1/${i}`;
    w3.pages.set(u, `https://images.prop24.com/${i}`);
    w3.images.set(`https://images.prop24.com/${i}`, { body: JPEG(50), type: 'image/jpeg' });
    urls.push(u);
  }
  const t0 = Date.now();
  const all = await Promise.all([...urls, ...urls].map((u) => T3.thumb(u)));
  ok(all.every((x) => x.status === 200), `all ${all.length} asks answered 200`);
  ok(w3.previews === urls.length, `each page fetched once despite duplicate asks (${w3.previews} previews for ${urls.length} pages)`);
  ok(w3.peak <= 4 && w3.peak >= 3, `never more than 4 upstream at once (peak ${w3.peak})`);
  ok(T3.stats().peak <= 4, `limiter's own peak ${T3.stats().peak}`);
  ok(w3.peakP24 === 1, `Property24 one at a time (peak ${w3.peakP24})`);
  const gaps = w3.p24Starts.slice(1).map((t, i) => t - w3.p24Starts[i]);
  ok(gaps.every((g) => g >= 150), `…with a gap between its fetches (${gaps.join(', ')} ms)`);
  console.log(`    (45 pages, ${Date.now() - t0} ms)`);

  console.log('disk cap (LRU) and TTL');
  const w4 = world({ delay: 1 });
  let clock = Date.now();
  const T4 = make(w4, { dir: path.join(TMP, 'cache4'), maxBytes: 13_000, memBytes: 1, now: () => clock });
  for (let i = 0; i < 6; i++) {
    const u = `https://www.remax.co.za/lru/${i}`;
    w4.pages.set(u, `https://cdn.example.com/lru/${i}.jpg`);
    w4.images.set(`https://cdn.example.com/lru/${i}.jpg`, { body: JPEG(2996), type: 'image/jpeg' }); // 3000 B each
    clock += 1000;
    await T4.thumb(u);
    if (i === 2) {
      clock += 1000;
      await T4.thumb('https://www.remax.co.za/lru/0'); // touch 0: now most recent
    }
  }
  const st = T4.stats();
  ok(st.diskBytes <= 13_000, `disk stays under the cap (${st.diskBytes} B, ${st.diskFiles} files)`);
  const files = fs.readdirSync(path.join(TMP, 'cache4')).filter((f) => f.endsWith('.jpg')).length;
  ok(files === st.diskFiles, `files on disk match the index (${files})`);
  let f4 = w4.fetches;
  ok((await T4.thumb('https://www.remax.co.za/lru/0')).cache === 'disk' && w4.fetches === f4, 'the recently used one survived eviction');
  ok((await T4.thumb('https://www.remax.co.za/lru/1')).cache === 'miss' && w4.fetches > f4, 'the least recently used one was evicted');
  clock += 8 * 24 * 3600 * 1000;
  f4 = w4.fetches;
  const p4 = w4.previews;
  r = await T4.thumb('https://www.remax.co.za/lru/0');
  ok(r.cache === 'miss' && w4.fetches > f4 && w4.previews > p4, 'after 7 days the page and photo are fetched again');

  console.log('![](…) image proxy');
  const w5 = world({ delay: 1 });
  const T5 = make(w5, { dir: path.join(TMP, 'cache5') });
  w5.images.set('https://photos.example.com/a.png', { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' });
  r = await T5.proxied('http://photos.example.com/a.png');
  ok(r.status === 200 && r.type === 'image/png', 'http image upgraded to https and proxied');
  ok((await T5.proxied('https://photos.example.com/a.png')).cache === 'mem', '…then cached');
  ok((await T5.proxied('https://photos.example.com/missing.png')).status === 404, 'missing image → 404');

  console.log('private addresses refused');
  const T6 = createThumbs({ dir: path.join(TMP, 'cache6'), log: { warn() {} } });
  r = await T6.proxied('https://127.0.0.1/x.png');
  ok(r.status === 404 && /public/.test(r.error), `loopback refused (${r.error})`);

  // ---- through the real relay ------------------------------------------------------
  console.log('relay routes');
  const PORT = 8873;
  const p = spawn('node', ['server.js'], {
    cwd: path.join(DIR, '..'),
    env: { ...process.env, MC_TOKEN: 'test', PORT: String(PORT), THUMB_CACHE: path.join(TMP, 'relay'), MIA_DIR: path.join(TMP, 'mia'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), OPENAI_API_KEY: '' },
    stdio: 'ignore',
  });
  try {
    const B = `http://localhost:${PORT}/api/v1`;
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`http://localhost:${PORT}/health`).catch(() => null))?.ok) break;
      await sleep(100);
    }
    const H = { authorization: 'Bearer test' };
    ok((await fetch(`${B}/thumb?url=https://example.com/`)).status === 401, 'thumb needs the token');
    ok((await fetch(`${B}/img?url=https://example.com/a.png`)).status === 401, 'img needs the token');
    ok((await fetch(`${B}/thumb?url=ftp://x`, { headers: H })).status === 400, 'bad link → 400');
    const loop = await fetch(`${B}/img?url=${encodeURIComponent('https://localhost/a.png')}`, { headers: H });
    ok(loop.status === 404 && loop.headers.get('x-content-type-options') === 'nosniff', 'localhost image refused, nosniff set');
    const stats = await (await fetch(`${B}/thumb/stats`, { headers: H })).json();
    ok(stats.ok && stats.dir === path.join(TMP, 'relay'), 'stats: cache dir is THUMB_CACHE');
    const idx = await (await fetch(`${B}`, { headers: H })).json();
    ok(Object.keys(idx.endpoints).some((k) => k.includes('/api/v1/thumb?url')), 'the API index lists /thumb');
  } finally {
    p.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} // a debounced pages.json may still be landing
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
