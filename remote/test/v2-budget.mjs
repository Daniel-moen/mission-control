// First-load budget for the panel (task 0444). Serves the built dist/ on a
// throwaway port (no relay — the shell renders without one), opens each front
// end in headless Chromium at phone size, and weighs — gzipped, from the files
// on disk — every JS/CSS file the browser fetched before the first useful
// paint (v2: the tab bar is up). Then checks v2's lazy chunks stay small,
// apart from the big on-demand vendors (PDF export, the wake-word model).
//
//   cd remote && npm run build && PLAYWRIGHT=<playwright pkg> node test/v2-budget.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.BUDGET_PORT || 8873);
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const gzCache = new Map();
const gz = (rel) => {
  if (!gzCache.has(rel)) gzCache.set(rel, zlib.gzipSync(fs.readFileSync(path.join(DIST, rel)), { level: 9 }).length);
  return gzCache.get(rel);
};
const BUDGET = { v2js: 250 * 1024, v2css: 26 * 1024, lazy: 70 * 1024 };

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(u.pathname);
  const file = path.join(DIST, path.normalize(rel));
  if (rel !== '/' && file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // gzip like the relay does (server.js serveFile), so throttled timings are honest
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (/\.(js|css|html|json|svg)$/.test(file) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
    }
    res.writeHead(200, { 'content-type': type });
    return fs.createReadStream(file).pipe(res);
  }
  if (rel.startsWith('/api') || rel.startsWith('/ws')) {
    res.writeHead(503);
    return res.end();
  }
  const v2 = /mc_ui=v2/.test(req.headers.cookie || '');
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(path.join(DIST, v2 ? 'v2.html' : 'index.html')).pipe(res);
});

let bad = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) bad += 1;
};

async function firstLoad(browser, ui, throttle = false) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'mc_ui', value: ui, url: `http://localhost:${PORT}` }]);
  await ctx.addInitScript(() => {
    localStorage.setItem('mc_token', 'budget');
  });
  const page = await ctx.newPage();
  if (throttle) {
    // "Slow 4G": 1.6 Mbps down, 750 kbps up, 150 ms round trips.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  }
  const files = [];
  let frozen = false;
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (!frozen && /\.(js|css)$/.test(p)) files.push(p.slice(1));
  });
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(ui === 'v2' ? '[data-tabbar]' : 'nav', { timeout: 20000, state: 'attached' });
  frozen = true;
  const ms = Date.now() - t0;
  await ctx.close();
  const uniq = [...new Set(files)];
  const js = uniq.filter((f) => f.endsWith('.js')).reduce((a, f) => a + gz(f), 0);
  const css = uniq.filter((f) => f.endsWith('.css')).reduce((a, f) => a + gz(f), 0);
  return { js, css, n: uniq.length, ms, files: uniq };
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  const v1 = await firstLoad(browser, 'v1');
  const v2 = await firstLoad(browser, 'v2');
  const v1slow = await firstLoad(browser, 'v1', true);
  const v2slow = await firstLoad(browser, 'v2', true);
  await browser.close();
  server.close();

  console.log('First load to a usable screen (gzipped, phone):');
  console.log(`  v1  ${KB(v1.js)} JS + ${KB(v1.css)} CSS in ${v1.n} files`);
  console.log(`  v2  ${KB(v2.js)} JS + ${KB(v2.css)} CSS in ${v2.n} files (Next.js runtime + shell + Home)`);
  console.log(`On slow 4G (1.6 Mbps, 150 ms RTT), cold cache, to a usable screen: v1 ${v1slow.ms} ms · v2 ${v2slow.ms} ms`);
  check(v2slow.ms <= v1slow.ms, 'v2 is usable no later than v1 on a slow phone connection');
  if (process.env.VERBOSE) for (const f of v2.files) console.log(`    ${f} ${KB(gz(f))}`);
  check(v2.js <= BUDGET.v2js, `v2 first-load JS ≤ ${KB(BUDGET.v2js)}`);
  check(v2.css <= BUDGET.v2css, `v2 CSS ≤ ${KB(BUDGET.v2css)}`);
  check(v2.js < v1.js, 'v2 loads less JS up front than v1');

  // Every other v2 chunk loads on demand (pages, sheets, hosted v1 views).
  const dir = path.join(DIST, 'v2', '_next', 'static', 'chunks');
  const all = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && all.push(path.relative(DIST, path.join(d, e.name)))));
  walk(dir);
  const initial = new Set(v2.files);
  const heavy = /pdfmake|vfs_fonts|Roboto-|vosk|Kaldi/;
  let big = 0;
  for (const f of all.filter((x) => !initial.has(x))) {
    const size = gz(f);
    if (size <= BUDGET.lazy) continue;
    const vendor = heavy.test(fs.readFileSync(path.join(DIST, f), 'utf8'));
    if (vendor) continue;
    big += 1;
    console.log(`    ${f} ${KB(size)}`);
  }
  check(big === 0, `every v2 lazy chunk ≤ ${KB(BUDGET.lazy)} (PDF export and the wake-word model excepted) — ${all.length - initial.size} lazy chunks`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
