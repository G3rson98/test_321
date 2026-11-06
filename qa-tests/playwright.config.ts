/**
 * Configuración Playwright de qa-tests (ESP §10 estructura; ESP §4 "Un proyecto por ambiente; navegador Chromium").
 *
 * - Un project por ambiente, tomado de KATALYST_ENV_NAME / KATALYST_APP_URL / KATALYST_API_URL (RF-AMB-01). El runner
 *   de Katalyst ejecuta una asignación (un ambiente) por invocación.
 * - Project `setup` (auth.setup.ts) como dependencia: login y validación de identidad/ambiente (RF-AMB-03).
 * - Solo Chromium (RF-EJE-01). Flags sin freno de temporizadores en segundo plano (RNF-CON-03).
 * - Reporters html, json y junit con rutas configurables (RF-RES-02).
 * - Trace/video/screenshot desde KATALYST_ARTIFACT_POLICY con defaults seguros (ESP §13.7).
 * - Timeout de test 120 s (ESP §13.3); reintentos 0..2 default 0 (RF-EJE-01/05); workers=1 por defecto (ESP §13.5).
 * - storageState en ruta temporal (KATALYST_STORAGE_STATE_PATH), nunca en el repo (RNF-SEG-01); se borra al terminar.
 *
 * Importante: este archivo no imprime nada; `playwright test --list --reporter=json` debe emitir JSON limpio.
 */
import { defineConfig, devices } from '@playwright/test';
import { readEnv } from './fixtures/env.ts';
import { AUTH_TIMEOUT_MS, TEST_TIMEOUT_MS } from './fixtures/timeouts.ts';

const env = readEnv();

/** RNF-CON-03: los navegadores corren sin freno de temporizadores en segundo plano. */
export const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
] as const;

export default defineConfig({
  testDir: './tests',
  outputDir: env.reports.outputDir,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: env.retries,
  workers: env.workers,
  globalTeardown: './global-teardown.ts',
  reporter: [
    ['list'],
    ['html', { outputFolder: env.reports.htmlDir, open: 'never' }],
    ['json', { outputFile: env.reports.jsonFile }],
    ['junit', { outputFile: env.reports.junitFile }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    headless: true,
    ...(env.appUrl ? { baseURL: env.appUrl } : {}),
    locale: 'es-BO',
    timezoneId: 'America/La_Paz',
    viewport: { width: 1366, height: 768 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    ignoreHTTPSErrors: false,
    trace: env.artifactPolicy.trace,
    video: env.artifactPolicy.video,
    screenshot: env.artifactPolicy.screenshot,
    launchOptions: { args: [...CHROMIUM_ARGS] },
  },
  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /auth\.setup\.ts$/,
      timeout: AUTH_TIMEOUT_MS,
      retries: 0,
      // El login nunca produce evidencia: la acción `fill` de la contraseña quedaría en trazas/video.
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
    {
      name: env.envName,
      dependencies: ['setup'],
      use: { storageState: env.storageStatePath },
    },
  ],
});
