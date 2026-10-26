import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Every build gets an id (task 0126). It's compiled into the bundle and written
// to dist/version.json; the panel polls that file and reloads itself when a
// new build is live — an installed iPad PWA otherwise keeps running the old
// bundle for days (it never re-requests index.html while it stays in memory).
const BUILD = process.env.MC_BUILD || `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}-${Math.random().toString(36).slice(2, 7)}`;
const versionFile = {
  name: 'mc-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
  },
};

// The panel is a pure client SPA that talks to the relay over WebSocket.
// Source lives in ./app (React); the build lands in ./dist, which server.js
// serves. The old Svelte panel in ./panel stays as the reference implementation
// and is no longer built.
//
// This builds v1, the default panel. The rebuilt one (v2, task 0444) is a
// Next.js static export (next-v2/, code in app/v2) that build.mjs puts beside
// it in dist/; both share app/src/lib. server.js picks one per device.
export default defineConfig({
  root: 'app',
  plugins: [react(), tailwindcss(), versionFile],
  define: { __MC_BUILD__: JSON.stringify(BUILD) },
  server: {
    // The panel opens its WebSocket against location.host, so dev mode proxies
    // /ws through to a local relay (server.js) — run it on 8899 (or MC_RELAY).
    proxy: {
      '/ws': {
        target: `ws://localhost:${process.env.MC_RELAY || 8899}`,
        ws: true,
      },
      // The HTTP polling fallback (and the #diag probes) use the REST API.
      '/api': {
        target: `http://localhost:${process.env.MC_RELAY || 8899}`,
      },
      // Files for Mia (lib/upload.js → upload.js).
      '/upload': {
        target: `http://localhost:${process.env.MC_RELAY || 8899}`,
      },
      // The Mia tab's push subscription talks to the relay over plain HTTP.
      '/push': {
        target: `http://localhost:${process.env.MC_RELAY || 8899}`,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // test/v2-budget.mjs walks this to weigh each front end's first load.
    manifest: true,
  },
});
