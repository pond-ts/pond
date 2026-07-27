import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API lives in a separate long-lived process, so `/api` is proxied
// rather than served by Vite. That split is the point: the graph has to
// outlive requests, and a dev server that reloads on every edit is the
// one place it must not live.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist' },
});
