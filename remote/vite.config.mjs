import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// The panel is a pure client SPA that talks to the relay over WebSocket.
// Source lives in ./panel; the build lands in ./dist, which server.js serves.
export default defineConfig({
  root: 'panel',
  plugins: [
    svelte({ preprocess: vitePreprocess() }),
    tailwindcss(),
  ],
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
