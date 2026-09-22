import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The panel is a pure client SPA that talks to the relay over WebSocket.
// Source lives in ./app (React); the build lands in ./dist, which server.js
// serves. The old Svelte panel in ./panel stays as the reference implementation
// and is no longer built.
export default defineConfig({
  root: 'app',
  plugins: [react(), tailwindcss()],
  server: {
    // The panel opens its WebSocket against location.host, so dev mode proxies
    // /ws through to a local relay (server.js) — run it on 8899 (or MC_RELAY).
    proxy: {
      '/ws': {
        target: `ws://localhost:${process.env.MC_RELAY || 8899}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
