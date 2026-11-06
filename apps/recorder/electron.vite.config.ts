/**
 * Build de main/preload/renderer del asistente local (RF-GRB-01). main y preload se emiten en CommonJS (`.cjs`):
 * los preload en `sandbox: true` deben ser CJS sin dependencias externas salvo `electron`.
 * `@katalyst/shared` y `zod` se empaquetan (no se cargan de node_modules en runtime); solo `@playwright/test`
 * queda externo porque se ejecuta como CLI (codegen) y gestiona Chromium.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { DEV_CSP, PROD_CSP } from './src/shared/csp.js';

const conditions = ['source', 'node', 'module', 'import', 'default'];

/** Inserta la CSP: estricta en build; relajada solo para el servidor de desarrollo de Vite (loopback). */
function cspPlugin(): Plugin {
  return {
    name: 'katalyst-csp',
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? DEV_CSP : PROD_CSP;
      return html.replace('%KATALYST_CSP%', csp);
    },
  };
}

export default defineConfig({
  main: {
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: ['node'] } },
    build: {
      externalizeDeps: { exclude: ['@katalyst/shared', 'zod'] },
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name]-[hash].cjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { conditions: ['source', 'module', 'browser', 'import', 'default'] },
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      minify: 'esbuild',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
