import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        // RNF-MAN-01 y encargo de base: >= 90 % en schedule, aggregation, perf y sanitize.
        'src/schedule/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/aggregation/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/perf/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/sanitize/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
