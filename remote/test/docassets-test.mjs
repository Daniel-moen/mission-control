// Library doc images (task 0124): the relay's asset store and `mc-doc attach`.
//
//   cd remote && node test/docassets-test.mjs
//
// Part 1 drives docassets.js over real HTTP (an in-process server on a temp
// dir): auth, path safety (traversal, encoded separators, dotfiles, bad
// extensions — and that nothing lands outside the store), byte sniffing, size
// and count limits, thumb fallback, ETag/304, list, delete.
// Part 2 runs scripts/mc-doc against a temp library and that same server:
// attach (shrink + thumb + printed markdown), --name, refusals, assets, sync
// (idempotent), detach, relative image refs in new/write, no-relay behaviour.
// macOS only for part 2 (it needs sips).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createDocAssets, parsePath } = require('../docassets.js');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const MC_DOC = path.join(DIR, '..', '..', 'scripts', 'mc-doc');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docassets-'));
const TOKEN = 'secret-token';

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

// A solid-colour RGB PNG of w×h, built here so the test needs no fixtures.
function png(w, h, rgb = [120, 150, 170], noise = false) {
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
  for (let x = 0; x < w; x++) row.set(rgb.map((v) => (v + x) & 0xff), 1 + x * 3); // a gradient, so it isn't trivially tiny
  // noise: a photo-like PNG that doesn't compress (big on disk, like a real one)
  const raw = noise ? Buffer.concat(Array.from({ length: h }, () => { const r = crypto.randomBytes(row.length); r[0] = 0; return r; })) : Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const fakeJpeg = (n = 2000) => Buffer.concat([JPEG_HEAD, crypto.randomBytes(n)]);

// Raw request (no URL normalisation — "../" reaches the server as written).
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
          resolve({ status: res.statusCode, headers: res.headers, buf, json });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const STORE = path.join(TMP, 'store');
const assets = createDocAssets({ tokenOk: (t) => t === TOKEN, dir: STORE, maxFileBytes: 64 * 1024, maxFiles: 5, maxTotalBytes: 400 * 1024 });
const server = http.createServer((rq, rs) => {
  const url = new URL(rq.url, 'http://x');
  if (url.pathname.startsWith('/api/v1/doc-assets/')) return assets.handle(rq, rs, url).catch(() => rs.end());
  rs.writeHead(404);
  rs.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// Every file in the temp dir must stay under STORE (or the library/inputs).
const allFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)]));

try {
  console.log('parsePath');
  ok(parsePath('/api/v1/doc-assets/my-doc/photo.jpg').name === 'photo.jpg', 'a plain stem/name parses');
  ok(parsePath('/api/v1/doc-assets/my-doc/').name === '' && parsePath('/api/v1/doc-assets/my-doc').stem === 'my-doc', 'a bare stem is a listing');
  for (const bad of [
    '/api/v1/doc-assets/../x.jpg',
    '/api/v1/doc-assets/my-doc/../../etc.jpg',
    '/api/v1/doc-assets/my-doc/..%2F..%2Fx.jpg',
    '/api/v1/doc-assets/%2e%2e/x.jpg',
    '/api/v1/doc-assets/my-doc/%2e%2e%2fx.jpg',
    '/api/v1/doc-assets/my-doc/a%5Cb.jpg',
    '/api/v1/doc-assets/my-doc/a%00.jpg',
    '/api/v1/doc-assets/my-doc/.hidden.jpg',
    '/api/v1/doc-assets/.ssh/id.jpg',
    '/api/v1/doc-assets/my-doc/x.svg',
    '/api/v1/doc-assets/my-doc/x.html',
    '/api/v1/doc-assets/my-doc/x',
    '/api/v1/doc-assets/my-doc.md/x.jpg',
    '/api/v1/doc-assets/my-doc/sub/x.jpg',
    '/api/v1/doc-assets/my-doc/%E0%A4%A.jpg',
  ]) ok(!!parsePath(bad).error, `refused: ${bad}`);

  console.log('auth');
  let r = await req('GET', '/api/v1/doc-assets/my-doc/', { token: '' });
  ok(r.status === 401, 'no token → 401');
  r = await req('GET', '/api/v1/doc-assets/my-doc/', { token: 'nope' });
  ok(r.status === 401, 'wrong token → 401');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/a.jpg', { token: 'nope', body: fakeJpeg() });
  ok(r.status === 401 && !fs.existsSync(path.join(STORE, 'my-doc', 'a.jpg')), 'a PUT with a wrong token stores nothing');
  r = await req('GET', `/api/v1/doc-assets/my-doc/?token=${TOKEN}`, { token: '' });
  ok(r.status === 200, '?token= works like the rest of /api');

  console.log('store + serve');
  const a = fakeJpeg(3000);
  r = await req('PUT', '/api/v1/doc-assets/my-doc/a.jpg', { body: a });
  ok(r.status === 200 && r.json.sha256 === crypto.createHash('sha256').update(a).digest('hex'), 'PUT stores it and answers its sha256');
  r = await req('GET', '/api/v1/doc-assets/my-doc/a.jpg');
  ok(r.status === 200 && r.buf.equals(a), 'GET returns the same bytes');
  ok(r.headers['content-type'] === 'image/jpeg' && r.headers['x-content-type-options'] === 'nosniff' && /sandbox/.test(r.headers['content-security-policy']), 'served as image/jpeg with nosniff + sandbox CSP');
  const etag = r.headers.etag;
  r = await req('GET', '/api/v1/doc-assets/my-doc/a.jpg', { headers: { 'if-none-match': etag } });
  ok(r.status === 304 && r.buf.length === 0, 'If-None-Match → 304');
  r = await req('HEAD', '/api/v1/doc-assets/my-doc/a.jpg');
  ok(r.status === 200 && r.buf.length === 0 && Number(r.headers['content-length']) === a.length, 'HEAD: headers only');
  r = await req('GET', '/api/v1/doc-assets/my-doc/a.jpg?size=thumb');
  ok(r.status === 200 && r.buf.equals(a), 'no thumb yet → the full image');
  const t = fakeJpeg(500);
  r = await req('PUT', '/api/v1/doc-assets/my-doc/a.jpg?size=thumb', { body: t });
  ok(r.status === 200 && fs.existsSync(path.join(STORE, 'my-doc', '.thumbs', 'a.jpg')), 'PUT ?size=thumb stores the small copy');
  r = await req('GET', '/api/v1/doc-assets/my-doc/a.jpg?size=thumb');
  ok(r.status === 200 && r.buf.equals(t), 'GET ?size=thumb serves it');
  r = await req('GET', '/api/v1/doc-assets/my-doc/');
  ok(r.json?.files?.length === 1 && r.json.files[0].name === 'a.jpg' && r.json.files[0].thumb === crypto.createHash('sha256').update(t).digest('hex'), 'the listing has name, sha256 and the thumb hash');
  r = await req('GET', '/api/v1/doc-assets/my-doc/missing.jpg');
  ok(r.status === 404, 'a missing asset → 404');
  r = await req('GET', '/api/v1/doc-assets/my-doc/missing.jpg?size=thumb');
  ok(r.status === 204, '…and 204 for the inline (thumb) ask, so the panel console stays clean');
  r = await req('GET', '/api/v1/doc-assets/other-doc/a.jpg');
  ok(r.status === 404, "another doc can't see this doc's files");

  console.log('refusals');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/b.png', { body: fakeJpeg() });
  ok(r.status === 415, 'JPEG bytes named .png → 415');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/c.jpg', { body: Buffer.from('<html><script>alert(1)</script></html>') });
  ok(r.status === 415, 'HTML named .jpg → 415');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/x.svg', { body: Buffer.from('<svg/>') });
  ok(r.status === 400, 'SVG → 400 (never stored)');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/big.jpg', { body: fakeJpeg(70 * 1024) });
  ok(r.status === 413 && !fs.existsSync(path.join(STORE, 'my-doc', 'big.jpg')), 'over the per-file cap → 413, nothing kept');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/empty.jpg', { body: Buffer.alloc(0) });
  ok(r.status === 400, 'empty body → 400');
  r = await req('POST', '/api/v1/doc-assets/my-doc/a.jpg', { body: a });
  ok(r.status === 405, 'POST → 405');
  for (const p of [
    '/api/v1/doc-assets/my-doc/../../escape.jpg',
    '/api/v1/doc-assets/../escape.jpg',
    '/api/v1/doc-assets/my-doc/..%2F..%2Fescape.jpg',
    '/api/v1/doc-assets/my-doc/%2e%2e%2fescape.jpg',
    '/api/v1/doc-assets/%2e%2e/escape.jpg',
    '/api/v1/doc-assets/my-doc/..%5Cescape.jpg',
  ]) {
    r = await req('PUT', p, { body: fakeJpeg() });
    // "../" spelled out is folded away by URL parsing before the route sees
    // it (→ some other path, 404); encoded forms reach the route (→ 400).
    ok(r.status >= 400 && r.status < 500, `traversal PUT refused: ${p} (${r.status})`);
  }
  r = await req('GET', '/api/v1/doc-assets/my-doc/..%2F..%2F..%2Fetc%2Fpasswd');
  ok(r.status === 400, 'traversal GET refused');
  const escaped = allFiles(TMP).filter((f) => /escape/.test(f));
  ok(escaped.length === 0, `nothing was written outside the store (${escaped.join(', ')})`);

  console.log('limits');
  for (const n of ['b', 'c', 'd', 'e']) await req('PUT', `/api/v1/doc-assets/my-doc/${n}.jpg`, { body: fakeJpeg(1000) });
  r = await req('PUT', '/api/v1/doc-assets/my-doc/f.jpg', { body: fakeJpeg(1000) });
  ok(r.status === 507, 'the per-doc file count cap → 507');
  r = await req('PUT', '/api/v1/doc-assets/my-doc/b.jpg', { body: fakeJpeg(1200) });
  ok(r.status === 200, '…but replacing an existing file still works');
  let full = 0;
  for (let i = 0; i < 12; i++) {
    const rr = await req('PUT', `/api/v1/doc-assets/fill-${i}/x.jpg`, { body: fakeJpeg(60 * 1024) });
    if (rr.status === 507) full += 1;
  }
  ok(full > 0, `the store's total cap kicks in (${full} refused)`);

  console.log('delete');
  r = await req('DELETE', '/api/v1/doc-assets/my-doc/a.jpg');
  ok(r.status === 200 && !fs.existsSync(path.join(STORE, 'my-doc', 'a.jpg')) && !fs.existsSync(path.join(STORE, 'my-doc', '.thumbs', 'a.jpg')), 'DELETE removes the image and its thumb');
  r = await req('DELETE', '/api/v1/doc-assets/my-doc/a.jpg');
  ok(r.status === 404, 'deleting it again → 404');
} catch (e) {
  failed += 1;
  console.error(e);
}

// ---------------------------------------------------------------------------
// Part 2: mc-doc
if (process.platform === 'darwin') {
  // A roomier store for real images.
  const store2 = path.join(TMP, 'store2');
  const assets2 = createDocAssets({ tokenOk: (t) => t === TOKEN, dir: store2 });
  const s2 = http.createServer((rq, rs) => {
    const url = new URL(rq.url, 'http://x');
    s2.hits = (s2.hits || 0) + (rq.method === 'PUT' ? 1 : 0);
    if (url.pathname.startsWith('/api/v1/doc-assets/')) return assets2.handle(rq, rs, url).catch(() => rs.end());
    rs.writeHead(404);
    rs.end();
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const RELAY2 = `http://127.0.0.1:${s2.address().port}`;
  const LIB = path.join(TMP, 'lib');
  const IN = path.join(TMP, 'in');
  fs.mkdirSync(path.join(IN, 'pics'), { recursive: true });
  fs.writeFileSync(path.join(IN, 'big.png'), png(2400, 1500, undefined, true));
  fs.writeFileSync(path.join(IN, 'small.png'), png(400, 300));
  fs.writeFileSync(path.join(IN, 'pics', 'Drive View.png'), png(1200, 800, [200, 90, 40]));
  fs.writeFileSync(path.join(IN, 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(IN, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const env = { ...process.env, MC_LIBRARY: LIB, MC_RELAY_URL: RELAY2, MC_TOKEN: TOKEN, MC_DOC_NO_DEFAULTS: '1' };
  // Async: the relay above runs in this process, so a blocking spawn would
  // leave mc-doc's uploads waiting on it forever.
  const run = (args, opts = {}) =>
    new Promise((resolve) => {
      const p = spawn(MC_DOC, args, { env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || IN });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (status) => resolve({ status, stdout, stderr }));
      p.stdin.end(opts.input || '');
    });
  const sips = (f, k) => Number((execFileSync('sips', ['-g', k, f], { encoding: 'utf8' }).match(new RegExp(`${k}: (\\d+)`)) || [])[1]);

  try {
    console.log('mc-doc attach');
    const id = path.basename((await run(['new', '--kind', 'research', '--title', 'Image test'])).stdout.trim());
    ok(id === 'image-test.md', `new still prints only the path (${id})`);
    let r = await run(['attach', id, 'big.png', '--tag', 'Listing', '--caption', 'The drive']);
    ok(r.status === 0, `attach exits 0 (${r.stderr.trim()})`);
    ok(r.stdout.trim() === '![The drive](assets/big.jpg "Listing | The drive")', `prints the markdown to paste (${r.stdout.trim()})`);
    const adir = path.join(LIB, 'image-test.assets');
    ok(fs.existsSync(path.join(adir, 'big.jpg')), 'stored next to the doc in <stem>.assets/');
    ok(Math.max(sips(path.join(adir, 'big.jpg'), 'pixelWidth'), sips(path.join(adir, 'big.jpg'), 'pixelHeight')) === 1600, 'a 2400 px photo-like PNG is shrunk to a 1600 px JPEG');
    ok(Math.max(sips(path.join(adir, '.thumbs', 'big.jpg'), 'pixelWidth'), sips(path.join(adir, '.thumbs', 'big.jpg'), 'pixelHeight')) === 800, '…with an 800 px thumb');
    r = await run(['attach', id, 'small.png']);
    ok(r.stdout.trim() === '![small](assets/small.png)' && !fs.existsSync(path.join(adir, '.thumbs', 'small.png')), 'a small PNG stays PNG, no thumb needed');
    r = await run(['attach', id, 'pics/Drive View.png', '--name', 'Drive North.png']);
    ok(r.stdout.trim() === '![drive-north](assets/drive-north.png)', `--name picks a safe name (${r.stdout.trim()})`);
    r = await run(['attach', id, 'notes.txt']);
    ok(r.status !== 0 && /not an image/.test(r.stderr), 'a text file is refused');
    r = await run(['attach', id, 'evil.svg']);
    ok(r.status !== 0, 'an SVG is refused');
    r = await run(['attach', id, 'small.png', 'big.png', '--name', 'x.png']);
    ok(r.status !== 0 && /one file/.test(r.stderr), '--name with two files is refused');
    r = await run(['attach', '../../etc/passwd.md', 'small.png']);
    ok(r.status !== 0 && /bad id/.test(r.stderr), 'a bad doc id is refused');
    r = await run(['attach', 'nope.md', 'small.png']);
    ok(r.status !== 0 && /no such doc/.test(r.stderr), 'a missing doc is refused');

    console.log('mc-doc assets / sync / detach');
    r = await run(['assets', id]);
    const lines = r.stdout.trim().split('\n');
    ok(lines.length === 3 && lines.some((l) => /^big\.jpg\t\d+\t1600x1000\tassets\/big\.jpg$/.test(l)), `assets lists name, bytes, size, ref (${lines.join(' / ')})`);
    const listed = await (await fetch(`${RELAY2}/api/v1/doc-assets/image-test/`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    ok(listed.files.length === 3 && listed.files.find((f) => f.name === 'big.jpg')?.thumb, 'attach pushed every image (and the thumb) to the relay');
    const relayBig = fs.readFileSync(path.join(store2, 'image-test', 'big.jpg'));
    ok(relayBig.equals(fs.readFileSync(path.join(adir, 'big.jpg'))), 'the relay copy is byte-identical');
    const before = s2.hits;
    r = await run(['sync', id]);
    ok(r.status === 0 && s2.hits === before, `sync skips what the relay already has (${s2.hits - before} uploads)`);
    fs.rmSync(path.join(store2, 'image-test', 'small.png'));
    r = await run(['sync', id]);
    ok(r.status === 0 && fs.existsSync(path.join(store2, 'image-test', 'small.png')) && s2.hits === before + 1, 'sync re-pushes only what is missing');
    r = await run(['detach', id, 'assets/small.png']);
    ok(r.status === 0 && !fs.existsSync(path.join(adir, 'small.png')) && !fs.existsSync(path.join(store2, 'image-test', 'small.png')), 'detach removes it here and on the relay');

    console.log('relative refs in write / new');
    fs.writeFileSync(
      path.join(IN, 'report.md'),
      [
        '# Report',
        '',
        ':::pair',
        '![Drive](pics/Drive%20View.png "Listing | The drive")',
        '![Drive](<pics/Drive View.png> "Listing | The drive")',
        '![Big](./big.png "Street View | From the road")',
        ':::',
        '',
        '![Web](https://example.com/a.jpg)',
        '![Already](assets/big.jpg)',
        '![Gone](assets/gone.jpg)',
        '![Nowhere](pics/missing.png)',
        '',
        '```',
        '![code](big.png)',
        '```',
        '',
      ].join('\n')
    );
    r = await run(['write', id, '--body-file', path.join(IN, 'report.md')], { cwd: TMP });
    const body = (await run(['get', id])).stdout;
    ok(r.status === 0, `write exits 0 (${r.stderr.trim().split('\n').join(' / ')})`);
    ok(body.includes('![Drive](assets/drive-view.png "Listing | The drive")'), 'a <relative path> next to the body file is attached and rewritten');
    ok(body.includes('![Big](assets/big.jpg "Street View | From the road")'), './file is attached and rewritten (title kept)');
    ok(body.includes('![Web](https://example.com/a.jpg)') && body.includes('![Already](assets/big.jpg)'), 'web and assets/ refs are left alone');
    ok(body.includes('```\n![code](big.png)\n```'), 'fenced code is left alone');
    ok(/assets\/gone\.jpg is not attached/.test(r.stderr) && /image not found: pics\/missing\.png/.test(r.stderr), 'missing images are warned about');
    ok(body.includes('![Nowhere](pics/missing.png)'), '…and left as written');
    ok(fs.existsSync(path.join(store2, 'image-test', 'drive-view.png')), 'write pushed the newly attached image');
    const head = fs.readFileSync(path.join(LIB, id), 'utf8').split('\n').slice(0, 4).join('\n');
    ok(/^---\nkind: research\nstatus: draft\ncreated: /.test(head), 'frontmatter untouched');

    const id2 = path.basename(
      (await run(['new', '--kind', 'note', '--title', 'Stdin doc', '--stdin', '--assets-from', path.join(IN, 'pics')], { input: '# Stdin doc\n\n![d](Drive View.png)\n![e](<Drive View.png>)\n', cwd: TMP })).stdout.trim()
    );
    const b2 = (await run(['get', id2])).stdout;
    ok(id2 === 'stdin-doc.md' && b2.includes('![e](assets/drive-view.png)'), `new --stdin --assets-from attaches relative refs (${b2.trim().split('\n').pop()})`);

    console.log('trim / no relay');
    r = await run(['set', id, 'subject', ' tesla trust ']);
    ok((await run(['list'])).status === 0 && /subject: tesla trust\n/.test(fs.readFileSync(path.join(LIB, id), 'utf8')), 'set subject keeps a leading "t" (trim fix)');
    const noRelay = { MC_RELAY_URL: '', MC_TOKEN: '' };
    r = await run(['attach', id, 'small.png'], { env: noRelay });
    ok(r.status === 0 && /this Mac only/.test(r.stderr), 'without a relay attach still works, and says the images are local only');
    r = await run(['sync', id], { env: noRelay });
    ok(r.status !== 0 && /no relay configured/.test(r.stderr), 'sync without a relay fails loudly');
    r = await run(['attach', id, 'small.png', '--name', 'down.png'], { env: { MC_RELAY_URL: 'http://127.0.0.1:9' } });
    ok(r.status === 0 && fs.existsSync(path.join(adir, 'down.png')) && /could not push/.test(r.stderr) && /mc-doc sync/.test(r.stderr), 'relay down: the image is kept and sync is suggested');
    r = await run(['attach', id, 'small.png', '--name', 'quiet.png'], { env: { MC_DOC_NO_SYNC: '1' } });
    ok(r.status === 0 && r.stderr === '' && !fs.existsSync(path.join(store2, 'image-test', 'quiet.png')), 'MC_DOC_NO_SYNC=1 skips the push silently');
  } catch (e) {
    failed += 1;
    console.error(e);
  }
  s2.close();
} else {
  console.log('(mc-doc part skipped: needs macOS sips)');
}

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
