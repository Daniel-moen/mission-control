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
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
