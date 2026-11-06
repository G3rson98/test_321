/**
 * Proyecto de fixtures con la misma forma que qa-tests: project `setup` (login) + project por ambiente
 * (`KATALYST_ENV_NAME`), Chromium con flags RNF-CON-03 y política de artefactos de `KATALYST_ARTIFACT_POLICY`.
 */
import { defineConfig } from '@playwright/test';

const envName = process.env.KATALYST_ENV_NAME ?? 'local';
const policy = JSON.parse(process.env.KATALYST_ARTIFACT_POLICY ?? '{}') as { trace?: 'off'; video?: 'off'; screenshot?: 'off' | 'only-on-failure' };

export default defineConfig({
  testDir: './tests',
  outputDir: process.env.KATALYST_OUTPUT_DIR ?? 'test-results',
  timeout: 120_000,
  retries: Number(process.env.KATALYST_RETRIES ?? 0),
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: process.env.KATALYST_APP_URL,
    headless: true,
    trace: policy.trace ?? 'off',
    video: policy.video ?? 'off',
    screenshot: policy.screenshot ?? 'off',
    launchOptions: {
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    },
  },
  projects: [
    { name: 'setup', testDir: '.', testMatch: /auth\.setup\.ts$/, use: { trace: 'off', video: 'off', screenshot: 'off' } },
    { name: envName, dependencies: ['setup'], use: { storageState: process.env.KATALYST_STORAGE_STATE_PATH } },
  ],
});
