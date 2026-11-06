/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env.KATALYST_API_PROXY ?? 'http://localhost:3000';

/**
 * Panel Katalyst (plan §1, puerto 5173). `source` resuelve @katalyst/shared a su TypeScript (D-003).
 * Proxy `/api` → API Fastify en dev; con VITE_USE_MOCKS=true responde MSW en el navegador.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['source', ...defaultClientConditions],
    alias: [
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
      // Fallback de mocks sin Service Worker (vistas embebidas): MSW marca `msw/native` como no-browser.
      { find: /^msw\/native$/, replacement: fileURLToPath(new URL('./node_modules/msw/lib/native/index.mjs', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false, ws: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Presupuesto RNF-OPT-03 lo mide scripts/size.mjs (JS inicial ≤ 250 KiB gzip).
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Solo React va a un chunk fijo (cache estable). Recharts NO se fuerza a un chunk manual: Rollup arrastraría
        // a ese chunk dependencias compartidas (clsx, use-sync-external-store…) y lo volvería inicial. Al cargarse
        // solo por import() (perf-chart), queda diferido de forma natural.
        manualChunks(id) {
          if (id.includes('node_modules') && /node_modules\/(?:\.pnpm\/)?(react|react-dom|scheduler)[@/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    css: false,
    testTimeout: 15_000,
    server: { deps: { inline: ['@katalyst/shared'] } },
  },
});
