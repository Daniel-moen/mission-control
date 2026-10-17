// Library pages (task 0126): the relay's page store + sandboxed serving, and
// `mc-doc new --kind page` / `mc-doc page`.
//
//   cd remote && node test/docpages-test.mjs
//
// Part 1 boots the real relay (server.js) on temp dirs and drives it over HTTP:
//   - the token-auth API (PUT/GET/DELETE /api/v1/doc-pages/<stem>): auth, bad
//     ids, size cap (413), non-UTF-8 (415);
//   - the capability link: works for its own stem only, tampered / expired /
//     malformed caps 404, and it is not the token;
//   - the served page: CSP (sandbox without allow-same-origin, CDN allowlist,
//     img-src scoped to the page's own path, connect-src 'none', frame-
//     ancestors), nosniff, no-referrer, the wrapper + theme, and the token
//     appears nowhere in it;
//   - assets under the page path: served with the image type; traversal,
//     encoded separators, dotfiles, other extensions, other docs' stems all 404;
//   - /version.json + /health report the panel build and viewer builds.
// Part 2 runs scripts/mc-doc against a temp library and that relay.
// macOS only for part 2 (sips).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { buildPage, createDocPages } = require('../docpages.js');
const WebSocket = require('ws');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const MC_DOC = path.join(DIR, '..', '..', 'scripts', 'mc-doc');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docpages-'));
const TOKEN = 'page-test-token-9f3';
const PORT = 8000 + Math.floor(Math.random() * 800) + 100;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
};

function png(w, h, rgb = [120, 150, 170]) {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb.map((v) => (v + x) & 0xff), 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function req(method, rawPath, { body, headers = {}, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method, path: rawPath, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString());
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString(), json });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ---- boot the real relay ------------------------------------------------------
const ASSETS = path.join(TMP, 'assets');
const PAGES = path.join(TMP, 'pages');
const DIST = path.join(DIR, '..', 'dist');
const relay = spawn('node', ['server.js'], {
  cwd: path.join(DIR, '..'),
  env: {
    ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), MIA_DIR: path.join(TMP, 'mia'), PUSH_STORE: path.join(TMP, 'push.json'),
    REALTIME_STORE: path.join(TMP, 'rt.json'), THUMB_CACHE: path.join(TMP, 'thumbs'), DOC_ASSETS: ASSETS, DOC_PAGES: PAGES, OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error('[relay!]', d.toString().trim()));
process.on('exit', () => relay.kill());
for (let i = 0; i < 100; i++) {
  try {
    if ((await req('GET', '/health', { token: '' })).status === 200) break;
  } catch {}
  await sleep(100);
}

console.log('buildPage');
{
  const frag = buildPage('<title>T</title><style>b{}</style><p>hi</p>', { theme: 'dark' });
  ok(/^<!doctype html><html lang="en" data-theme="dark"><head>/.test(frag), 'a fragment is wrapped in a document with data-theme');
  ok(frag.includes('<meta name="viewport"') && frag.includes('<meta charset="utf-8">'), 'the wrapper adds charset + viewport');
  ok(frag.includes("addEventListener('message'"), 'the helper script is injected');
  const full = buildPage('<!DOCTYPE html><html lang="de"><head><title>x</title></head><body>x</body></html>', { theme: 'light' });
  ok(full.startsWith('<!DOCTYPE html><html data-theme="light" lang="de"><head><meta charset'), 'a full document keeps its own tags, gains data-theme and the head bits');
  const own = buildPage('<html data-theme="light"><body>x</body></html>', { theme: 'dark' });
  ok(own.includes('<html data-theme="light">') && !own.includes('data-theme="dark"'), "a page's own data-theme wins");
  const evil = buildPage('<p>x</p>', { theme: '"><script>alert(1)</script>' });
  ok(!evil.includes('alert(1)') && evil.startsWith('<!doctype html><html lang="en"><head>'), 'a junk theme value is ignored (no injection)');
  const nohead = buildPage('<html><body>x</body></html>');
  ok(/^<!doctype html><html><head><meta charset/.test(nohead), 'a document without <head> gets one');
}

console.log('capabilities');
{
  const pages = createDocPages({ tokenOk: () => true, secret: 'k', dir: path.join(TMP, 'caps'), assetsRoot: ASSETS, linkHours: 1 });
  const cap = pages.capFor('a-doc');
  ok(pages.capOk(cap, 'a-doc'), 'a fresh cap is good for its stem');
  ok(!pages.capOk(cap, 'b-doc'), 'not for another stem');
  ok(!pages.capOk(cap, 'a-doc', Date.now() + 2 * 3600e3), 'and not after it expires');
  ok(!pages.capOk(`${cap.slice(0, -1)}${cap.endsWith('A') ? 'B' : 'A'}`, 'a-doc'), 'a tampered signature fails');
  const [exp, sig] = cap.split('-');
  ok(!pages.capOk(`${(parseInt(exp, 36) + 99999).toString(36)}-${sig}`, 'a-doc'), 'a stretched expiry fails');
  ok(!pages.capOk('', 'a-doc') && !pages.capOk('x', 'a-doc') && !pages.capOk('../..', 'a-doc'), 'garbage caps fail');
  const other = createDocPages({ tokenOk: () => true, secret: 'other', dir: path.join(TMP, 'caps2'), assetsRoot: ASSETS });
  ok(!other.capOk(cap, 'a-doc'), 'a cap from another relay token fails');
}

console.log('page API');
const HTML = `<title>Test page</title><style>body{background:#fff}</style>
<h1>Hello</h1><p>A page.</p><img src="assets/one.png" alt="one"><a href="assets/one.png">full</a>
<script>document.title = 'ran';</script>`;
{
  ok((await req('PUT', '/api/v1/doc-pages/test-page', { body: HTML, token: '' })).status === 401, 'PUT without a token → 401');
  ok((await req('PUT', '/api/v1/doc-pages/test-page', { body: HTML, token: 'nope' })).status === 401, 'PUT with a bad token → 401');
  ok((await req('GET', '/api/v1/doc-pages/test-page', { token: '' })).status === 401, 'GET without a token → 401');
  for (const bad of ['..', '.hidden', 'a%2Fb', 'a%5Cb', '..%2Fetc', 'x.md', '%00x', 'a/b']) {
    const r = await req('PUT', `/api/v1/doc-pages/${bad}`, { body: HTML });
    ok(r.status === 400, `bad id "${bad}" → 400 (got ${r.status})`);
  }
  const big = await req('PUT', '/api/v1/doc-pages/too-big', { body: Buffer.alloc(2 * 1024 * 1024 + 10, 0x61) });
  ok(big.status === 413, 'over 2 MB → 413');
  const bin = await req('PUT', '/api/v1/doc-pages/binary', { body: Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x00]) });
  ok(bin.status === 415, 'not UTF-8 text → 415');
  ok((await req('GET', '/api/v1/doc-pages/nothing-here')).status === 404, 'GET of a missing page → 404');
  const put = await req('PUT', '/api/v1/doc-pages/test-page', { body: HTML });
  ok(put.status === 200 && put.json?.ok && put.json.bytes === Buffer.byteLength(HTML), 'PUT stores the page');
  ok(fs.existsSync(path.join(PAGES, 'test-page.html')), 'into the page store');
  // an image for it, through the 0124 asset route
  ok((await req('PUT', '/api/v1/doc-assets/test-page/one.png', { body: png(40, 30) })).status === 200, 'its image goes to the asset store');
  ok((await req('PUT', '/api/v1/doc-assets/other-doc/secret.png', { body: png(10, 10, [9, 9, 9]) })).status === 200, "(another doc's image, for the cross-doc check)");
}

console.log('served page');
let pageUrl = '';
{
  const g = await req('GET', '/api/v1/doc-pages/test-page');
  ok(g.status === 200 && /^\/p\/[0-9a-z]+-[A-Za-z0-9_-]{32}\/test-page\/$/.test(g.json?.url || ''), 'GET gives a capability URL');
  pageUrl = g.json.url;
  ok(!pageUrl.includes(TOKEN), 'the URL does not carry the token');
  ok(g.json.sha256 === crypto.createHash('sha256').update(HTML).digest('hex'), 'and the sha of what was stored');
  const p = await req('GET', `${pageUrl}?theme=dark`, { token: '', headers: { host: `127.0.0.1:${PORT}` } });
  ok(p.status === 200 && /text\/html/.test(p.headers['content-type']), 'the page is served without the token (capability only)');
  ok(p.text.includes('<h1>Hello</h1>') && p.text.includes('data-theme="dark"'), 'with its content and the theme');
  ok(!p.text.includes(TOKEN), 'the token appears nowhere in the page');
  const csp = p.headers['content-security-policy'] || '';
  const dir = (name) => (csp.split(';').map((s) => s.trim()).find((s) => s === name || s.startsWith(`${name} `)) || '');
  ok(/^sandbox( |$)/.test(dir('sandbox')) && dir('sandbox').includes('allow-scripts') && !dir('sandbox').includes('allow-same-origin'), 'CSP sandbox: allow-scripts, never allow-same-origin');
  ok(!dir('sandbox').includes('allow-top-navigation') && !dir('sandbox').includes('allow-forms'), 'no top navigation, no forms');
  ok(dir('default-src') === "default-src 'none'", "default-src 'none'");
  ok(dir('script-src') === "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com", 'scripts: inline + cdnjs/jsdelivr/unpkg only');
  ok(dir('font-src') === 'font-src https://fonts.gstatic.com data:', 'fonts: Google Fonts (+ data:)');
  ok(dir('style-src').includes('https://fonts.googleapis.com') && !dir('style-src').includes('*'), 'styles: inline + Google Fonts + the CDNs');
  ok(dir('img-src') === `img-src http://127.0.0.1:${PORT}${pageUrl} data: blob:`, "images: only this page's own path + data: + blob:");
  ok(dir('connect-src') === "connect-src 'none'", "no fetch/XHR/WebSocket (connect-src 'none')");
  ok(dir('frame-src') === "frame-src 'none'" && dir('object-src') === "object-src 'none'" && dir('form-action') === "form-action 'none'" && dir('base-uri') === "base-uri 'none'", 'no frames, plugins, forms or <base>');
  ok(dir('frame-ancestors') === `frame-ancestors http://127.0.0.1:${PORT}`, 'only the relay itself may frame it');
  ok(p.headers['x-content-type-options'] === 'nosniff' && p.headers['referrer-policy'] === 'no-referrer', 'nosniff + no-referrer (the cap never leaks to CDNs)');
  const fwd = await req('GET', pageUrl, { token: '', headers: { host: 'mc.example.app', 'x-forwarded-proto': 'https' } });
  ok((fwd.headers['content-security-policy'] || '').includes(`img-src https://mc.example.app${pageUrl} `), 'behind the proxy the CSP uses the public https origin');
  const idx = await req('GET', `${pageUrl}index.html`, { token: '' });
  ok(idx.status === 200 && idx.text.includes('<h1>Hello</h1>'), '…/index.html works too');
  ok((await req('HEAD', pageUrl, { token: '' })).status === 200, 'HEAD works');
  ok((await req('POST', pageUrl, { token: '' })).status === 405, 'POST → 405');
}

console.log('page assets + path safety');
{
  const [, , cap] = pageUrl.split('/');
  const a = await req('GET', `${pageUrl}assets/one.png`, { token: '' });
  ok(a.status === 200 && a.headers['content-type'] === 'image/png' && a.buf.subarray(1, 4).toString() === 'PNG', 'an image under assets/ is served (no token)');
  ok(a.headers['x-content-type-options'] === 'nosniff' && /sandbox/.test(a.headers['content-security-policy'] || ''), 'with nosniff and a sandbox CSP');
  const etag = a.headers.etag;
  ok((await req('GET', `${pageUrl}assets/one.png`, { token: '', headers: { 'if-none-match': etag } })).status === 304, 'ETag → 304');
  ok((await req('GET', `${pageUrl}one.png`, { token: '' })).status === 200, 'a bare relative name resolves to the asset too');
  const bad = [
    `/p/${cap}/test-page/assets/../../other-doc/secret.png`,
    `/p/${cap}/test-page/assets/..%2F..%2Fother-doc%2Fsecret.png`,
    `/p/${cap}/test-page/..%2Fother-doc/secret.png`,
    `/p/${cap}/test-page/assets%2F..%2F..%2Fother-doc%2Fsecret.png`,
    `/p/${cap}/test-page/assets/%2e%2e/secret.png`,
    `/p/${cap}/test-page/assets/.thumbs`,
    `/p/${cap}/test-page/.thumbs/one.png`,
    `/p/${cap}/test-page/assets/one.html`,
    `/p/${cap}/test-page/assets/one.svg`,
    `/p/${cap}/test-page/a/b/c.png`,
    `/p/${cap}/other-doc/secret.png`,
    `/p/${cap}/other-doc/`,
    `/p/${cap}/..%2Fpages/test-page.html`,
    `/p/${cap}/test-page/..`,
    `/p/${cap}/test-page/%00one.png`,
    `/p/${cap}/test-page/assets/one.png%00.html`,
    `/p/${cap}%2Ftest-page/`,
    `/p/AAAA-${'A'.repeat(32)}/test-page/`,
    `/p//test-page/`,
    `/p/${cap}/test-page`,
    `/p/${TOKEN}/test-page/`,
  ];
  for (const b of bad) {
    const r = await req('GET', b, { token: '' });
    ok(r.status === 404 || r.status === 400, `${b.replace(cap, '<cap>')} → ${r.status}`);
  }
  // the old asset API still needs the token
  ok((await req('GET', '/api/v1/doc-assets/test-page/one.png', { token: '' })).status === 401, 'the token-auth asset API is unchanged (401 without it)');
  const del = await req('DELETE', '/api/v1/doc-pages/test-page');
  ok(del.status === 200 && (await req('GET', pageUrl, { token: '' })).status === 404, 'DELETE removes the page (its link 404s)');
}

console.log('version + viewer builds');
{
  const v = await req('GET', '/version.json', { token: '' });
  const want = fs.existsSync(path.join(DIST, 'version.json')) ? JSON.parse(fs.readFileSync(path.join(DIST, 'version.json'), 'utf8')).build : '';
  ok(v.status === 200 && v.json?.build === want && /no-store/.test(v.headers['cache-control'] || ''), '/version.json is the dist build, no-store');
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=viewer&build=abc-123&token=${TOKEN}`);
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=viewer&token=${TOKEN}`);
  await Promise.all([ws1, ws2].map((w) => new Promise((r) => w.on('open', r))));
  await sleep(100);
  const h = await req('GET', '/health', { token: '' });
  ok(h.json?.panelBuild === want, '/health says which panel build is live');
  ok(JSON.stringify((h.json?.viewerBuilds || []).sort()) === JSON.stringify(['abc-123', 'legacy']), '/health lists each viewer build (old panels = legacy)');
  ws1.close();
  ws2.close();
}

// ---- part 2: mc-doc ---------------------------------------------------------
if (process.platform !== 'darwin') {
  console.log('(mc-doc part skipped: needs macOS sips)');
} else {
  console.log('mc-doc page');
  const LIB = path.join(TMP, 'lib');
  const WORK = path.join(TMP, 'work');
  fs.mkdirSync(path.join(WORK, 'pics'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'pics', 'a.png'), png(64, 48));
  fs.writeFileSync(path.join(WORK, 'b photo.png'), png(32, 32, [200, 10, 10]));
  fs.writeFileSync(path.join(WORK, 'bg.png'), png(20, 20, [0, 200, 0]));
  fs.writeFileSync(path.join(WORK, 'set-1x.png'), png(30, 30, [1, 2, 3]));
  fs.writeFileSync(path.join(WORK, 'set-2x.png'), png(60, 60, [3, 2, 1]));
  const long = 'a-very-long-file-name-that-goes-past-forty-chars';
  fs.writeFileSync(path.join(WORK, `${long}-one.png`), png(10, 12, [5, 5, 5]));
  fs.writeFileSync(path.join(WORK, `${long}-two.png`), png(12, 10, [9, 9, 9]));
  fs.writeFileSync(path.join(WORK, 'notes.txt'), 'hi');
  const page = `<title>Garden</title>
<meta name="description" content="Screens from the &quot;Garden&quot; build.">
<style>.hero{background:url('bg.png')} .x{background:url(https://example.com/x.png)}</style>
<h1>Garden</h1>
<figure><a href="pics/a.png"><img src="./pics/a.png" alt="A"></a></figure>
<img src="b%20photo.png" alt="B">
<img srcset="set-1x.png 1x, set-2x.png 2x" src="set-1x.png" alt="set">
<img src="${long}-one.png"><img src="${long}-two.png">
<img src="https://example.com/remote.jpg"><img src="data:image/png;base64,AAAA"><a href="#top">top</a>
<a href="notes.txt">notes</a><img src="missing.png">
<a href="silvertree-place-is-the-doubled-flat-her.md">other doc</a>`;
  fs.writeFileSync(path.join(WORK, 'index.html'), page);
  const env = { ...process.env, MC_LIBRARY: LIB, MC_RELAY_URL: BASE, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' };
  const run = (args, opts = {}) => spawnSync('bash', [MC_DOC, ...args], { env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input, cwd: opts.cwd });

  const r = run(['new', '--kind', 'page', '--title', 'Crystal Garden designs', '--html', path.join(WORK, 'index.html'), '--tags', 'games, page']);
  ok(r.status === 0 && r.stdout.trim() === path.join(LIB, 'crystal-garden-designs.md'), 'new --kind page prints the stub path');
  const id = 'crystal-garden-designs.md';
  const stub = fs.readFileSync(path.join(LIB, id), 'utf8');
  ok(/^---\nkind: page\nstatus: done\ntags: games, page\ncreated: \S+\n---\n# Crystal Garden designs\n/.test(stub), 'the stub: kind page, status done, the page tag once, the title');
  ok(stub.includes('Screens from the "Garden" build.'), 'the stub summary comes from <meta name=description>');
  const html = fs.readFileSync(path.join(LIB, 'crystal-garden-designs.html'), 'utf8');
  ok(html.includes('<a href="assets/a.png"><img src="assets/a.png"'), 'src and href to the same local image → assets/a.png');
  ok(html.includes('src="assets/b-photo.png"'), 'an encoded name (b%20photo.png) is found and slugged');
  ok(html.includes("url('assets/bg.png')"), 'CSS url() is rewritten');
  ok(html.includes('srcset="assets/set-1x.png 1x, assets/set-2x.png 2x"'), 'srcset entries are rewritten');
  const names = fs.readdirSync(path.join(LIB, 'crystal-garden-designs.assets')).filter((n) => !n.startsWith('.')).sort();
  ok(names.length === 7, `7 images attached (${names.join(' ')})`);
  const longNames = names.filter((n) => n.startsWith('a-very-long'));
  ok(longNames.length === 2 && new Set(longNames).size === 2, 'two long names that slug alike get distinct asset names');
  ok(html.includes(`src="assets/${longNames[0]}"`) && html.includes(`src="assets/${longNames[1]}"`), 'and each ref points at its own file');
  ok(html.includes('src="https://example.com/remote.jpg"') && html.includes('src="data:image/png;base64,AAAA"') && html.includes('href="#top"'), 'web, data: and #anchor refs are left alone');
  ok(html.includes('href="notes.txt"') && /notes\.txt is a local file the page cannot load/.test(r.stderr), 'a non-image local file is left and warned about');
  ok(/image not found: missing\.png/.test(r.stderr), 'a missing image is warned about');
  ok(/pushed the page to the relay/.test(r.stderr), 'the page is pushed to the relay');
  const g = await req('GET', '/api/v1/doc-pages/crystal-garden-designs');
  ok(g.status === 200 && g.json.sha256 === crypto.createHash('sha256').update(html).digest('hex'), 'the relay has exactly the stored HTML');
  const img = await req('GET', `${g.json.url}assets/a.png`, { token: '' });
  ok(img.status === 200 && img.headers['content-type'] === 'image/png', 'and its images, through the page path');

  const ls = run(['list', '--kind', 'page']);
  ok(ls.stdout.trim() === `${id}\tpage\tdone\tCrystal Garden designs`, 'list --kind page');
  ok(run(['page', id]).stdout.trim() === path.join(LIB, 'crystal-garden-designs.html'), 'page <id> prints the HTML path');
  const w = run(['write', id, '--stdin'], { input: '# x\n' });
  ok(w.status !== 0 && /is a page/.test(w.stderr), 'write refuses a page');

  // update
  fs.writeFileSync(path.join(WORK, 'v2.html'), '<title>v2</title><p>Second <b>version</b> here.</p><img src="pics/a.png">');
  const before = fs.statSync(path.join(LIB, id)).mtimeMs;
  await sleep(1100);
  const u = run(['page', id, '--html', path.join(WORK, 'v2.html')]);
  ok(u.status === 0, 'page <id> --html updates it');
  const html2 = fs.readFileSync(path.join(LIB, 'crystal-garden-designs.html'), 'utf8');
  ok(html2.includes('<p>Second <b>version</b> here.</p><img src="assets/a.png">'), 'the new HTML is stored, refs rewritten');
  const stub2 = fs.readFileSync(path.join(LIB, id), 'utf8');
  ok(stub2.includes('# Crystal Garden designs\n\nSecond version here.\n') && fs.statSync(path.join(LIB, id)).mtimeMs > before, 'the stub keeps its title, gets the new summary and a new mtime (the panel refreshes)');
  const g2 = await req('GET', '/api/v1/doc-pages/crystal-garden-designs');
  ok(g2.json.sha256 === crypto.createHash('sha256').update(html2).digest('hex'), 'and the relay has the new version');

  // an older Mac app rewrote the kind to note: page still works and repairs it
  fs.writeFileSync(path.join(LIB, id), stub2.replace('kind: page', 'kind: note').replace('tags: games, page', 'tags: games'));
  const rep = run(['page', id, '--html', path.join(WORK, 'v2.html')]);
  const stub3 = fs.readFileSync(path.join(LIB, id), 'utf8');
  ok(rep.status === 0 && stub3.includes('kind: page') && /tags: page, games\n/.test(stub3), 'page <id> repairs kind/tag an older app rewrote');

  // stdin + --assets-from
  const s = run(['new', '--kind', 'page', '--title', 'From stdin', '--stdin', '--assets-from', WORK], { input: '<p>hi</p><img src="bg.png">', cwd: TMP });
  ok(s.status === 0 && fs.readFileSync(path.join(LIB, 'from-stdin.html'), 'utf8') === '<p>hi</p><img src="assets/bg.png">', '--stdin + --assets-from');

  // refusals
  ok(run(['new', '--kind', 'page', '--title', 'x']).status !== 0, 'new --kind page without --html fails');
  ok(run(['new', '--kind', 'note', '--title', 'x', '--html', path.join(WORK, 'index.html')]).status !== 0, '--html on a non-page fails');
  ok(run(['new', '--kind', 'page', '--title', 'x', '--html', path.join(WORK, 'nope.html')]).status !== 0 && !fs.existsSync(path.join(LIB, 'x.md')), 'a missing HTML file fails and leaves no stub');
  fs.writeFileSync(path.join(WORK, 'huge.html'), `<p>${'x'.repeat(2 * 1024 * 1024)}</p>`);
  const huge = run(['new', '--kind', 'page', '--title', 'Huge', '--html', path.join(WORK, 'huge.html')]);
  ok(huge.status !== 0 && /over 2 MB/.test(huge.stderr) && !fs.existsSync(path.join(LIB, 'huge.md')), 'over 2 MB is refused, nothing left behind');
  const md = run(['new', '--kind', 'note', '--title', 'Plain note']);
  ok(run(['page', 'plain-note.md', '--html', path.join(WORK, 'v2.html')]).status !== 0, 'page on a markdown doc is refused');
  ok(run(['set', 'plain-note.md', 'kind', 'page']).status !== 0, 'set kind page without HTML is refused');
  ok(md.status === 0, '(markdown docs still work)');

  // relay down: the page stays on the Mac, sync pushes it later
  const off = run(['new', '--kind', 'page', '--title', 'Offline', '--html', path.join(WORK, 'v2.html')], { env: { MC_RELAY_URL: 'http://127.0.0.1:9' } });
  ok(off.status === 0 && /could not push the page/.test(off.stderr) && fs.existsSync(path.join(LIB, 'offline.html')), 'relay down: kept on the Mac, told to sync');
  ok((await req('GET', '/api/v1/doc-pages/offline')).status === 404, '(not on the relay yet)');
  const sy = run(['sync', 'offline.md']);
  ok(sy.status === 0 && (await req('GET', '/api/v1/doc-pages/offline')).status === 200, 'sync pushes images then the page');
  const nosync = run(['new', '--kind', 'page', '--title', 'No sync', '--html', path.join(WORK, 'v2.html')], { env: { MC_DOC_NO_SYNC: '1' } });
  ok(nosync.status === 0 && (await req('GET', '/api/v1/doc-pages/no-sync')).status === 404, 'MC_DOC_NO_SYNC=1 keeps it local');
}

relay.kill();
console.log(`\n${passed} passed, ${failed} failed`);
await sleep(200);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(failed ? 1 : 0);
