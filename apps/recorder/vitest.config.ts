import { defineConfig } from 'vitest/config';

// Pruebas de los módulos main sin Electron (api-client, device-flow, session-store, codegen-runner, step-parser,
// cleanup, seguridad de ventana e IPC). `source` resuelve @katalyst/shared a su código TypeScript (D-003).
export default defineConfig({
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/main/core/**/*.ts',
        'src/shared/**/*.ts',
        'src/main/electron/window-security.ts',
        'src/main/electron/ipc-router.ts',
      ],
    },
  },
});
