/**
 * Entorno de la invocación `playwright test` para qa-tests (contrato en qa-tests/README.md y .env.example).
 * Entorno MÍNIMO construido desde cero (no hereda el del ejecutor): sin leaseToken, sin credenciales de la API,
 * sin variables del host. La credencial de DeltaX solo llega como RUTA a un archivo 0600 en tmpfs
 * (`KATALYST_TEST_USER_FILE`); el storageState vive en tmpfs (`KATALYST_STORAGE_STATE_PATH`).
 * RF-AMB-03, RF-EJE-01, RNF-SEG-01, RNF-CON-03, ESP §13.7.
 */
import path from 'node:path';
import type { ArtifactPolicy } from '@katalyst/shared';
import { REPORTER_ENV } from '../reporter/protocol.js';
import type { RunnerShardAssignment } from '../worker-api/types.js';

export type TraceMode = 'off' | 'on' | 'retain-on-failure';
export type ScreenshotMode = 'off' | 'on' | 'only-on-failure';

/** Formato que espera qa-tests en `KATALYST_ARTIFACT_POLICY`. */
export interface QaArtifactPolicy {
  trace: TraceMode;
  video: TraceMode;
  screenshot: ScreenshotMode;
  sanitizationVerified: boolean;
}

/**
 * Traduce la política del ambiente (shared `ArtifactPolicy`) al formato de qa-tests. Solo se habilita lo que la
 * política habilita explícitamente (`enabledKinds`); en producción la habilitación administrativa de un tipo
 * equivale a la declaración de que su sanitización fue demostrada con canarios (D-RUNNER, ESP §13.7).
 */
export function toQaArtifactPolicy(policy: ArtifactPolicy, isProduction: boolean): QaArtifactPolicy {
  const enabled = new Set(policy.enabledKinds);
  const trace: TraceMode = enabled.has('traza') ? (policy.traceOnFailureOnly ? 'retain-on-failure' : 'on') : 'off';
  const video: TraceMode = enabled.has('video') ? (policy.videoOnFailureOnly ? 'retain-on-failure' : 'on') : 'off';
  const screenshot: ScreenshotMode = enabled.has('captura')
    ? policy.screenshotsOnFailureOnly
      ? 'only-on-failure'
      : 'on'
    : 'off';
  const anyVisual = trace !== 'off' || video !== 'off' || screenshot !== 'off';
  return { trace, video, screenshot, sanitizationVerified: isProduction ? anyVisual : false };
}

export interface ShardPaths {
  testsDir: string;
  outputDir: string;
  stateDir: string;
  testUserFile: string | null;
}

export function shardOutputPaths(outputDir: string) {
  return {
    testResults: path.join(outputDir, 'test-results'),
    htmlDir: path.join(outputDir, 'report', 'html'),
    jsonFile: path.join(outputDir, 'report', 'results.json'),
    junitFile: path.join(outputDir, 'report', 'junit.xml'),
    perfDir: path.join(outputDir, 'perf'),
    gateDir: path.join(outputDir, 'gate'),
    planDir: path.join(outputDir, 'plan'),
    playwrightLog: path.join(outputDir, 'playwright.log'),
    sanitizedDir: path.join(outputDir, 'sanitized'),
    home: path.join(outputDir, 'home'),
  };
}

export interface BuildEnvOptions {
  assignment: RunnerShardAssignment;
  paths: ShardPaths;
  envName: string;
  retries: number;
  expectedUsername: string | null;
  planFile: string;
  browsersPath?: string | undefined;
  basePath?: string | undefined;
}

export const DEFAULT_ENV_NAME = 'katalyst';

/** Variables para `playwright test` (y nada más). */
export function buildPlaywrightEnv(o: BuildEnvOptions): NodeJS.ProcessEnv {
  const a = o.assignment;
  const out = shardOutputPaths(o.paths.outputDir);
  const policy = toQaArtifactPolicy(a.artifactPolicy, a.environment.isProduction);
  const env: NodeJS.ProcessEnv = {
    PATH: o.basePath ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: out.home,
    TMPDIR: process.env.TMPDIR && process.platform === 'darwin' ? process.env.TMPDIR : '/tmp',
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    CI: '1',
    FORCE_COLOR: '0',
    // qa-tests (README "Variables de entorno")
    KATALYST_ENV_NAME: o.envName,
    KATALYST_APP_URL: a.environment.appUrl,
    KATALYST_API_URL: a.environment.apiUrl,
    KATALYST_ENV_IS_PRODUCTION: a.environment.isProduction ? 'true' : 'false',
    KATALYST_RUN_ID: a.runId,
    KATALYST_STORAGE_STATE_PATH: path.join(o.paths.stateDir, 'storageState.json'),
    KATALYST_ARTIFACT_POLICY: JSON.stringify(policy),
    KATALYST_RETRIES: String(o.retries),
    KATALYST_WORKERS: '1',
    KATALYST_OUTPUT_DIR: out.testResults,
    KATALYST_REPORT_HTML_DIR: out.htmlDir,
    KATALYST_REPORT_JSON_FILE: out.jsonFile,
    KATALYST_REPORT_JUNIT_FILE: out.junitFile,
    KATALYST_PERF_OUTPUT_DIR: out.perfDir,
    KATALYST_ATTEMPT_GATE_DIR: out.gateDir,
    // Reporters integrados cuando se pasan por CLI (--reporter)
    PLAYWRIGHT_JSON_OUTPUT_FILE: out.jsonFile,
    PLAYWRIGHT_HTML_OUTPUT_DIR: out.htmlDir,
    PLAYWRIGHT_HTML_OPEN: 'never',
    PLAYWRIGHT_JUNIT_OUTPUT_FILE: out.junitFile,
    [REPORTER_ENV.planFile]: o.planFile,
  };
  if (a.environment.id) env.KATALYST_ENVIRONMENT_ID = a.environment.id;
  if (o.paths.testUserFile) env.KATALYST_TEST_USER_FILE = o.paths.testUserFile;
  if (o.expectedUsername) env.KATALYST_EXPECTED_USERNAME = o.expectedUsername;
  if (o.browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = o.browsersPath;
  return env;
}
