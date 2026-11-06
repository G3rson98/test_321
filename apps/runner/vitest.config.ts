import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `source` resuelve @katalyst/shared a su código TypeScript (sin build previo, D-003).
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Redis propio del agente RUNNER (docs/fase2-coordinacion.md): índice 4.
      TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/4',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.*.ts'],
    },
  },
});
