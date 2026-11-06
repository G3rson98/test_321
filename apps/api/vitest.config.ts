import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://katalyst:katalyst_dev@localhost:5432/katalyst_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export default defineConfig({
  // `source` resuelve @katalyst/shared a su código TypeScript (sin build previo).
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      COOKIE_SECURE: 'false',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.*.ts'],
    },
  },
});
