// `npm run build`: both panels into dist/ with ONE build id, so neither ever
// mistakes the other for a newer deploy (lib/update.js polls dist/version.json).
//   1. v1 — Vite → dist/ (version.json, /assets/…)
//   2. v2 — Next.js static export (next-v2/) → dist/v2.html + dist/v2/_next/…
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD = process.env.MC_BUILD || `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}-${Math.random().toString(36).slice(2, 7)}`;
const env = { ...process.env, MC_BUILD: BUILD, NEXT_TELEMETRY_DISABLED: '1' };
const bin = (name) => path.join(ROOT, 'node_modules', '.bin', name);
const only = process.argv[2]; // 'v1' | 'v2' | undefined (both)

if (only !== 'v2') execFileSync(bin('vite'), ['build'], { cwd: ROOT, env, stdio: 'inherit' });
if (only !== 'v1') {
  execFileSync(bin('next'), ['build', '--webpack', 'next-v2'], { cwd: ROOT, env, stdio: 'inherit' });
  const out = path.join(ROOT, 'next-v2', 'out');
  const dist = path.join(ROOT, 'dist');
  fs.rmSync(path.join(dist, 'v2'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'v2'), { recursive: true });
  fs.cpSync(path.join(out, '_next'), path.join(dist, 'v2', '_next'), { recursive: true });
  // The panel itself is loaded by the page with a client-only dynamic import,
  // and Home by the panel — a chain of round trips on a phone. Tell the
  // browser about those chunks up front so they download alongside Next's own.
  const loadable = JSON.parse(fs.readFileSync(path.join(ROOT, 'next-v2', '.next', 'react-loadable-manifest.json'), 'utf8'));
  const early = Object.entries(loadable)
    .filter(([k]) => /-> (\.\.\/)+app\/v2\/boot\.jsx$|v2\/shell\/pages\.js -> \.\.\/views\/Home\.jsx$/.test(k))
    .flatMap(([, v]) => v.files);
  if (early.length < 2) throw new Error('build.mjs: boot/Home chunks not found in react-loadable-manifest.json');
  const links = early.map((f) => `<link rel="preload" as="script" href="/v2/_next/${f}"/>`).join('');
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8').replace('</head>', `${links}</head>`);
  fs.writeFileSync(path.join(dist, 'v2.html'), html);
  // Task 0445/0446: the v3 and v4 design directions, one page each (/v3a … /v4c);
  // task 0483: v5 (/v5, or the device's pick via ?ui=v5); task 0491: v5.2 (/v52); task 0502: v5.3 (/v53).
  for (const ui of ['v3a', 'v3b', 'v3c', 'v4a', 'v4b', 'v4c', 'v5', 'v52', 'v53']) {
    const f = path.join(out, `${ui}.html`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dist, `${ui}.html`));
  }
  console.log(`v2 → dist/v2.html + dist/v2/_next (build ${BUILD})`);
}
