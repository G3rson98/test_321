/**
 * Restricción de producción en el worker (RF-EJE-06, RNF-SEG-04), reintentos efectivos (RF-EJE-05) y
 * clasificación por prefijo `[codigo]` (ESP §13.2), política de artefactos hacia qa-tests (ESP §13.7).
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_PRODUCTION_ARTIFACT_POLICY, ManifestSchema } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { attemptOutcome, categorizeFailure, extractErrorCode } from '../src/executor/classify.js';
import { effectiveRetries, evaluateGuards } from '../src/executor/production-guard.js';
import { buildPlaywrightEnv, toQaArtifactPolicy } from '../src/executor/qa-env.js';
import { assignedTest, assignment, STAGING_POLICY } from './helpers/assignment.js';

const k1 = randomUUID();
const k2 = randomUUID();
const k3 = randomUUID();
const manifest = ManifestSchema.parse({
  schemaVersion: 1,
  tests: [
    { stableKey: k1, file: 'tests/a.spec.ts', title: 'C1 a', cases: ['C1'], tags: [], classification: 'lectura', owner: 'qa' },
    { stableKey: k2, file: 'tests/b.spec.ts', title: 'C2 b', cases: ['C2'], tags: ['@escritura'], classification: 'escritura', owner: 'qa' },
    { stableKey: k3, file: 'tests/c.spec.ts', title: 'C3 c', cases: ['C3'], tags: [], classification: 'sin_clasificar', owner: 'qa' },
  ],
});

describe('evaluateGuards (RF-EJE-06)', () => {
  it('producción: solo lectura con usuario de solo lectura', () => {
    const tests = [assignedTest(k1), assignedTest(k2, { classification: 'escritura' }), assignedTest(k3, { classification: 'sin_clasificar' })];
    const r = evaluateGuards({ tests, isProduction: true, testUser: { readOnly: true }, manifest });
    expect(r.allowed.map((t) => t.stableKey)).toEqual([k1]);
    expect(r.blocked.map((b) => b.reason)).toEqual(['escritura_en_produccion', 'clasificacion_ausente']);
    const r2 = evaluateGuards({ tests: [assignedTest(k1)], isProduction: true, testUser: { readOnly: false }, manifest });
    expect(r2.blocked.map((b) => b.reason)).toEqual(['usuario_con_escritura']);
    const r3 = evaluateGuards({ tests: [assignedTest(k1)], isProduction: true, testUser: null, manifest });
    expect(r3.blocked.map((b) => b.reason)).toEqual(['usuario_con_escritura']);
  });

  it('clasificación contradictoria con el manifiesto, test ausente o variante no declarada ⇒ bloqueado', () => {
    const r = evaluateGuards({
      tests: [assignedTest(k1, { classification: 'escritura' }), assignedTest(randomUUID()), assignedTest(k1, { parameterKey: 'otra' })],
      isProduction: false,
      testUser: { readOnly: false },
      manifest,
    });
    expect(r.blocked.map((b) => b.reason)).toEqual(['clasificacion_contradictoria', 'test_no_aprobado', 'variante_faltante']);
  });

  it('staging admite escritura', () => {
    const r = evaluateGuards({ tests: [assignedTest(k2, { classification: 'escritura' })], isProduction: false, testUser: { readOnly: false }, manifest });
    expect(r.allowed).toHaveLength(1);
  });

  it('reintentos: escritura sin idempotencia aprobada = 0; con aprobación hasta 2', () => {
    expect(effectiveRetries(assignedTest(k2, { classification: 'escritura', retries: 2 }))).toBe(0);
    expect(effectiveRetries(assignedTest(k2, { classification: 'escritura', retries: 2, writeIdempotencyApproved: true }))).toBe(2);
    expect(effectiveRetries(assignedTest(k1, { retries: 1 }))).toBe(1);
  });
});

describe('clasificación de errores (ESP §13.2)', () => {
  it('extrae el código [codigo] con o sin prefijo Error:', () => {
    expect(extractErrorCode('[auth_desafio_mfa] MFA')).toBe('auth_desafio_mfa');
    expect(extractErrorCode('Error: [dxmon_no_disponible] x')).toBe('dxmon_no_disponible');
    expect(extractErrorCode('\u001b[31m[auth_timeout]\u001b[39m x')).toBe('auth_timeout');
    expect(extractErrorCode('sin código')).toBeNull();
  });

  it('categorías', () => {
    expect(categorizeFailure('failed', [{ message: '[auth_credenciales_invalidas] x' }])).toBe('login');
    expect(categorizeFailure('failed', [{ message: '[datos_escritura_en_produccion] x' }])).toBe('politica');
    expect(categorizeFailure('failed', [{ message: '[rendimiento_ciclo_excedido] x' }])).toBe('timeout_aplicacion');
    expect(categorizeFailure('failed', [{ message: 'locator.click: Timeout 30000ms exceeded.' }])).toBe('timeout_aplicacion');
    expect(categorizeFailure('timedOut', [{ message: 'Test timeout of 120000ms exceeded.' }])).toBe('timeout_aplicacion');
    expect(categorizeFailure('failed', [{ message: 'expect(received).toBe(expected)' }])).toBe('asercion');
    expect(categorizeFailure('failed', [{ message: 'TypeError: x is undefined' }])).toBe('error_aplicacion');
    expect(categorizeFailure('failed', [{ message: 'browserType.launch: Failed to launch chromium' }])).toBe('navegador_no_disponible');
  });

  it('interrupción según la causa de detención', () => {
    expect(attemptOutcome('interrupted', 'passed', [], 'cancel')).toMatchObject({ attemptStatus: 'cancelado', reason: 'cancelado_por_usuario' });
    expect(attemptOutcome('interrupted', 'passed', [], 'run_timeout')).toMatchObject({ attemptStatus: 'error_infraestructura', reason: 'timeout_corrida' });
    expect(attemptOutcome('passed', 'failed', [], null)).toMatchObject({ attemptStatus: 'fallido' });
  });
});

describe('entorno de qa-tests (RNF-SEG-01, ESP §13.7)', () => {
  it('producción por defecto: trazas, video y capturas deshabilitados', () => {
    expect(toQaArtifactPolicy(DEFAULT_PRODUCTION_ARTIFACT_POLICY, true)).toEqual({ trace: 'off', video: 'off', screenshot: 'off', sanitizationVerified: false });
    expect(toQaArtifactPolicy(STAGING_POLICY, false)).toEqual({ trace: 'retain-on-failure', video: 'off', screenshot: 'only-on-failure', sanitizationVerified: false });
  });

  it('variables mínimas: rutas a secretos/estado, nunca valores ni leaseToken', () => {
    const a = assignment([assignedTest(k1)]);
    const env = buildPlaywrightEnv({
      assignment: a,
      paths: { testsDir: '/work/tests', outputDir: '/work/out', stateDir: '/run/katalyst/state', testUserFile: '/run/katalyst/secrets/test-user.json' },
      envName: 'staging',
      retries: 1,
      expectedUsername: 'qa.bot',
      planFile: '/work/out/plan/plan-1.json',
    });
    expect(env).toMatchObject({
      KATALYST_ENV_NAME: 'staging',
      KATALYST_ENV_IS_PRODUCTION: 'false',
      KATALYST_TEST_USER_FILE: '/run/katalyst/secrets/test-user.json',
      KATALYST_STORAGE_STATE_PATH: '/run/katalyst/state/storageState.json',
      KATALYST_RETRIES: '1',
      KATALYST_WORKERS: '1',
      KATALYST_PERF_OUTPUT_DIR: '/work/out/perf',
      KATALYST_EXPECTED_USERNAME: 'qa.bot',
    });
    expect(Object.keys(env).some((k) => /TOKEN|PASSWORD|SECRET__/.test(k))).toBe(false);
  });
});
