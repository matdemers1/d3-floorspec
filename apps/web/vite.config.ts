import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', sourcemap: false },
  // manifold-3d finds its WASM with `new URL('manifold.wasm', import.meta.url)`; pre-bundling it for
  // the dev server would move the script away from the file (the 3D view, FLR-T-7.5).
  optimizeDeps: { exclude: ['manifold-3d'] },
  server: {
    port: 5173,
    // Everything the editor talks to lives on the API, which also serves it in production: one
    // origin, one cookie, no CORS.
    proxy: {
      '/api': 'http://localhost:3400',
      '/auth': 'http://localhost:3400',
      '/health': 'http://localhost:3400',
      '/readyz': 'http://localhost:3400',
    },
  },
});
