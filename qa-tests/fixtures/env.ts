/**
 * Lectura y validación de la configuración de ejecución de qa-tests.
 *
 * Requisitos: RF-AMB-01 (ambiente: nombre, URL app, URL API, producción), RF-AMB-03 (storageState aislado),
 * RF-EJE-01 (reintentos 0..2, default 0; solo Chromium), RF-RES-02 / ESP §13.7 (política de artefactos),
 * RNF-SEG-01 (sin secretos en repo/argumentos).
 *
 * Toda la configuración llega por variables de entorno que fija el ejecutor de Katalyst (o el desarrollador en
 * local). Este módulo NO escribe nada en stdout: `playwright test --list --reporter=json` debe producir JSON limpio.
 * Ningún valor secreto pasa por aquí: las credenciales se leen de un archivo montado (KATALYST_TEST_USER_FILE) solo
 * dentro de auth.setup.ts.
 */
import os from 'node:os';
import path from 'node:path';
import { KatalystError } from './errors.ts';

/** Raíz del repositorio qa-tests (directorio que contiene playwright.config.ts). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Hosts conocidos de producción de FMS DeltaX (ESP §2). Fuerzan `isProduction=true` aunque la variable diga lo contrario. */
export const KNOWN_PRODUCTION_HOSTS: readonly string[] = ['cbc.deltax.la', 'fmsapi.deltax.la'];

export type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
export type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
export type ScreenshotMode = 'off' | 'on' | 'only-on-failure';

export interface ArtifactPolicy {
  trace: TraceMode;
  video: VideoMode;
  screenshot: ScreenshotMode;
  /**
   * Declaración del backend de que la sanitización del formato fue demostrada con datos canario (ESP §13.7).
   * En producción, trace/video distintos de `off` exigen `sanitizationVerified: true`; de lo contrario la
   * configuración falla cerrada.
   */
  sanitizationVerified: boolean;
}

export interface ReportPaths {
  outputDir: string;
  htmlDir: string;
  jsonFile: string;
  junitFile: string;
}

export interface KatalystEnv {
  envName: string;
  appUrl: string | undefined;
  apiUrl: string | undefined;
  isProduction: boolean;
  environmentId: string | undefined;
  runId: string;
  storageStatePath: string;
  testUserFile: string | undefined;
  expectedUsername: string | undefined;
  fixtureProfile: string;
  retries: number;
  workers: number;
  artifactPolicy: ArtifactPolicy;
  reports: ReportPaths;
}

const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function readString(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readInt(name: string, def: number, min: number, max: number): number {
  const raw = readString(name);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) {
    throw new KatalystError('configuracion_invalida', `${name} debe ser un entero entre ${min} y ${max}.`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new KatalystError('configuracion_invalida', `${name} debe estar entre ${min} y ${max} (recibido ${n}).`);
  }
  return n;
}

function readUrl(name: string): string | undefined {
  const raw = readString(name);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KatalystError('configuracion_invalida', `${name} no es una URL válida.`);
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new KatalystError('configuracion_invalida', `${name} debe usar https (solo loopback admite http).`);
  }
  if (url.username || url.password) {
    throw new KatalystError('configuracion_invalida', `${name} no puede contener credenciales.`);
  }
  if (url.search || url.hash) {
    throw new KatalystError('configuracion_invalida', `${name} no puede contener query ni fragmento.`);
  }
  // Normaliza sin barra final para componer rutas.
  return url.toString().replace(/\/+$/, '');
}

function readBool(name: string): boolean | undefined {
  const raw = readString(name);
  if (raw === undefined) return undefined;
  if (/^(1|true|si|sí|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new KatalystError('configuracion_invalida', `${name} debe ser true o false.`);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const TRACE_MODES: readonly TraceMode[] = ['off', 'on', 'retain-on-failure', 'on-first-retry'];
const VIDEO_MODES: readonly VideoMode[] = ['off', 'on', 'retain-on-failure', 'on-first-retry'];
const SCREENSHOT_MODES: readonly ScreenshotMode[] = ['off', 'on', 'only-on-failure'];

/**
 * Política de artefactos (ESP §13.7). Defaults seguros:
 * - producción: sin trazas, sin video, sin capturas (las capturas solo tras probar el enmascaramiento con canarios);
 * - no producción: sin trazas ni video; captura solo en fallas (datos sintéticos de staging).
 * El backend envía la política efectiva del ambiente en `KATALYST_ARTIFACT_POLICY` (JSON).
 */
export function parseArtifactPolicy(raw: string | undefined, isProduction: boolean): ArtifactPolicy {
  const defaults: ArtifactPolicy = isProduction
    ? { trace: 'off', video: 'off', screenshot: 'off', sanitizationVerified: false }
    : { trace: 'off', video: 'off', screenshot: 'only-on-failure', sanitizationVerified: false };
  if (raw === undefined) return defaults;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KatalystError('configuracion_invalida', 'KATALYST_ARTIFACT_POLICY no es JSON válido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KatalystError('configuracion_invalida', 'KATALYST_ARTIFACT_POLICY debe ser un objeto JSON.');
  }
  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['trace', 'video', 'screenshot', 'sanitizationVerified']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new KatalystError('configuracion_invalida', `KATALYST_ARTIFACT_POLICY: clave no soportada "${key}".`);
    }
  }
  const pick = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw new KatalystError(
        'configuracion_invalida',
        `KATALYST_ARTIFACT_POLICY.${key} debe ser uno de: ${allowed.join(', ')}.`,
      );
    }
    return v as T;
  };
  const sanitizationVerified = obj['sanitizationVerified'];
  if (sanitizationVerified !== undefined && typeof sanitizationVerified !== 'boolean') {
    throw new KatalystError('configuracion_invalida', 'KATALYST_ARTIFACT_POLICY.sanitizationVerified debe ser booleano.');
  }
  const policy: ArtifactPolicy = {
    trace: pick('trace', TRACE_MODES, defaults.trace),
    video: pick('video', VIDEO_MODES, defaults.video),
    screenshot: pick('screenshot', SCREENSHOT_MODES, defaults.screenshot),
    sanitizationVerified: sanitizationVerified ?? false,
  };
  if (isProduction && !policy.sanitizationVerified && (policy.trace !== 'off' || policy.video !== 'off' || policy.screenshot !== 'off')) {
    throw new KatalystError(
      'politica_artefactos_insegura',
      'En producción, trazas/video/capturas requieren sanitizationVerified=true (ESP §13.7).',
    );
  }
  return policy;
}

let cached: KatalystEnv | undefined;

/**
 * Lee la configuración. No exige URLs para permitir `playwright test --list` sin ambiente (CI/catálogo); los tests y
 * el setup las exigen en tiempo de ejecución mediante {@link requireTarget}.
 */
export function readEnv(): KatalystEnv {
  if (cached) return cached;

  const envName = readString('KATALYST_ENV_NAME') ?? 'sin-ambiente';
  if (!ENV_NAME_RE.test(envName) || envName === 'setup') {
    throw new KatalystError('configuracion_invalida', 'KATALYST_ENV_NAME inválido (letras, números, "-", "_"; no "setup").');
  }
  const appUrl = readUrl('KATALYST_APP_URL');
  const apiUrl = readUrl('KATALYST_API_URL');

  // Producción por defecto (fail-safe): solo `false` explícito la desactiva, y nunca para hosts productivos conocidos.
  const declared = readBool('KATALYST_ENV_IS_PRODUCTION');
  const hosts = [appUrl, apiUrl].filter((u): u is string => !!u).map((u) => new URL(u).hostname);
  const knownProd = hosts.some((h) => KNOWN_PRODUCTION_HOSTS.includes(h));
  const isProduction = knownProd || declared !== false;

  // El id de corrida debe ser estable entre el proceso principal y los workers: si falta, se fija una sola vez aquí
  // y los workers lo heredan por process.env.
  let runId = readString('KATALYST_RUN_ID');
  if (runId === undefined) {
    runId = `local-${Date.now()}`;
    process.env['KATALYST_RUN_ID'] = runId;
  }
  if (!RUN_ID_RE.test(runId)) {
    throw new KatalystError('configuracion_invalida', 'KATALYST_RUN_ID admite solo [A-Za-z0-9_-] (máx. 64).');
  }

  const storageStatePath = path.resolve(
    readString('KATALYST_STORAGE_STATE_PATH') ??
      path.join(os.tmpdir(), `katalyst-qa-tests-${process.getuid?.() ?? 'u'}`, `${envName}.storageState.json`),
  );
  if (isInside(storageStatePath, REPO_ROOT)) {
    throw new KatalystError(
      'storage_state_ruta_insegura',
      'KATALYST_STORAGE_STATE_PATH no puede estar dentro del repositorio (RNF-SEG-01). Use un directorio temporal/tmpfs.',
    );
  }

  const testUserFileRaw = readString('KATALYST_TEST_USER_FILE');
  const testUserFile = testUserFileRaw ? path.resolve(testUserFileRaw) : undefined;
  if (testUserFile && isInside(testUserFile, REPO_ROOT)) {
    throw new KatalystError(
      'auth_credenciales_ruta_insegura',
      'KATALYST_TEST_USER_FILE no puede estar dentro del repositorio; debe montarse en tmpfs fuera del checkout.',
    );
  }

  const fixtureProfile = readString('KATALYST_FIXTURE_PROFILE') ?? 'default';
  if (!/^[a-z0-9_-]{1,40}$/.test(fixtureProfile)) {
    throw new KatalystError('configuracion_invalida', 'KATALYST_FIXTURE_PROFILE inválido.');
  }

  const reportsBase = path.resolve(REPO_ROOT, 'playwright-report');
  const reports: ReportPaths = {
    outputDir: path.resolve(REPO_ROOT, readString('KATALYST_OUTPUT_DIR') ?? 'test-results'),
    htmlDir: path.resolve(REPO_ROOT, readString('KATALYST_REPORT_HTML_DIR') ?? path.join(reportsBase, 'html')),
    jsonFile: path.resolve(REPO_ROOT, readString('KATALYST_REPORT_JSON_FILE') ?? path.join(reportsBase, 'results.json')),
    junitFile: path.resolve(REPO_ROOT, readString('KATALYST_REPORT_JUNIT_FILE') ?? path.join(reportsBase, 'junit.xml')),
  };
  if (isInside(reports.htmlDir, reports.outputDir)) {
    throw new KatalystError('configuracion_invalida', 'KATALYST_REPORT_HTML_DIR no puede estar dentro de KATALYST_OUTPUT_DIR.');
  }

  cached = {
    envName,
    appUrl,
    apiUrl,
    isProduction,
    environmentId: readString('KATALYST_ENVIRONMENT_ID'),
    runId,
    storageStatePath,
    testUserFile,
    expectedUsername: readString('KATALYST_EXPECTED_USERNAME'),
    fixtureProfile,
    retries: readInt('KATALYST_RETRIES', 0, 0, 2),
    workers: readInt('KATALYST_WORKERS', 1, 1, 8),
    artifactPolicy: parseArtifactPolicy(readString('KATALYST_ARTIFACT_POLICY'), isProduction),
    reports,
  };
  return cached;
}

/** Exige ambiente objetivo configurado (URLs). Se usa al ejecutar, no al listar. */
export function requireTarget(env: KatalystEnv = readEnv()): { appUrl: string; apiUrl: string } {
  if (!env.appUrl || !env.apiUrl) {
    throw new KatalystError(
      'ambiente_no_configurado',
      'Defina KATALYST_APP_URL y KATALYST_API_URL (los fija el runner de Katalyst por asignación).',
    );
  }
  return { appUrl: env.appUrl, apiUrl: env.apiUrl };
}
