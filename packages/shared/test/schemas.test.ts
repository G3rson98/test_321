import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../src/index.js';
import {
  ApiErrorSchema,
  CursorQuerySchema,
  decodeCursor,
  defaultMessageFor,
  encodeCursor,
  ERROR_CATALOG,
  ERROR_CODES,
  EventStreamQuerySchema,
  ExclusionWindowCreateSchema,
  httpStatusFor,
  IdempotencyKeySchema,
  isKatalystError,
  KatalystError,
  LoginRequestSchema,
  MAX_EXPLICIT_CASES,
  normalizeSelection,
  outboxBackoffMs,
  pageSchema,
  PerfQuerySchema,
  PerfThresholdCreateSchema,
  RunCreateRequestSchema,
  RunSelectionSchema,
  ScheduleCreateSchema,
  SchedulePreviewRequestSchema,
  SecretRefSchema,
  selectionToFields,
  sortQuerySchema,
  SuiteSelectorSchema,
  TimeZoneSchema,
  toApiErrorBody,
  WorkerResultRequestSchema,
  isValidTimeZone,
  RecordingCreatedResponseSchema,
  DeviceAuthorizeResponseSchema,
  OUTBOX_RETRY_POLICY,
  CONTRACT_VERSION,
} from '../src/index.js';
import { RUN_STATUSES, RUN_OUTCOMES, SYNC_STATUSES, RUN_RESULT_STATUSES, RECORDING_STATUSES } from '../src/enums.js';

const U1 = '0b7c3a6e-2f8a-4c1e-9d3b-5e6f7a8b9c0d';
const U2 = '1b7c3a6e-2f8a-4c1e-9d3b-5e6f7a8b9c0d';
const codeOf = (r: { success: boolean; error?: z.ZodError }) => r.error?.issues.map((i) => i.message);

describe('RF-EJE-07 enums exactos de ESP §7/§13.2', () => {
  it('valores de estado', () => {
    expect(RUN_STATUSES).toEqual([
      'en_cola',
      'preparando',
      'corriendo',
      'finalizando',
      'terminada',
      'cancelando',
      'cancelada',
      'interrumpida',
      'omitida',
    ]);
    expect(RUN_OUTCOMES).toEqual(['pasado', 'inestable', 'fallido', 'bloqueado', 'incompleto']);
    expect(SYNC_STATUSES).toEqual(['no_aplica', 'pendiente', 'enviando', 'sincronizada', 'requiere_intervencion']);
    expect(RUN_RESULT_STATUSES).toEqual([
      'pendiente',
      'corriendo',
      'pasado',
      'inestable',
      'fallido',
      'bloqueado',
      'omitido',
      'cancelado',
      'error_infraestructura',
    ]);
    expect(RECORDING_STATUSES).toEqual([
      'creada',
      'vinculada',
      'grabando',
      'validando',
      'pr_abierto',
      'rechazada',
      'cancelada',
      'vencida',
    ]);
    expect(CONTRACT_VERSION).toBe('1.0.0');
    expect(typeof shared.parseCron).toBe('function');
  });
});

describe('RF-EJE-01 selección discriminada exactamente uno de suiteId|caseIds|tags (ESP §9)', () => {
  const base = { environmentId: U1 };
  it('acepta cada variante y aplica defaults', () => {
    const r = RunCreateRequestSchema.parse({ ...base, tags: ['@humo'] });
    expect(r.retries).toBe(0);
    expect(r.excludeFlaky).toBe(false);
    expect(r.testrail).toEqual({ mode: 'nueva' });
    expect(RunCreateRequestSchema.safeParse({ ...base, suiteId: U1 }).success).toBe(true);
    expect(RunCreateRequestSchema.safeParse({ ...base, caseIds: [U1, U2] }).success).toBe(true);
  });
  it('SELECTION_EXCLUSIVE si ninguno o más de uno', () => {
    expect(codeOf(RunCreateRequestSchema.safeParse(base))).toContain('SELECTION_EXCLUSIVE');
    expect(codeOf(RunCreateRequestSchema.safeParse({ ...base, suiteId: U1, tags: ['@oc'] }))).toContain(
      'SELECTION_EXCLUSIVE',
    );
  });
  it('listas no vacías, sin duplicados, máximo 500 casos', () => {
    expect(codeOf(RunCreateRequestSchema.safeParse({ ...base, caseIds: [] }))).toContain('SELECTION_EMPTY');
    expect(codeOf(RunCreateRequestSchema.safeParse({ ...base, tags: ['@oc', '@oc'] }))).toContain(
      'SELECTION_DUPLICATES',
    );
    const many = Array.from(
      { length: MAX_EXPLICIT_CASES + 1 },
      (_, i) => `${String(i).padStart(8, '0')}-2f8a-4c1e-9d3b-5e6f7a8b9c0d`,
    );
    expect(codeOf(RunCreateRequestSchema.safeParse({ ...base, caseIds: many }))).toContain('SELECTION_TOO_LARGE');
    expect(RunCreateRequestSchema.safeParse({ ...base, caseIds: many.slice(0, 500) }).success).toBe(true);
  });
  it('reintentos 0..2 y testrail existente', () => {
    expect(RunCreateRequestSchema.safeParse({ ...base, tags: ['@oc'], retries: 3 }).success).toBe(false);
    const r = RunCreateRequestSchema.parse({ ...base, tags: ['@oc'], testrail: { mode: 'existente', trRunId: 9 } });
    expect(r.testrail).toEqual({ mode: 'existente', trRunId: 9, closeExistingRun: false });
  });
  it('normalizeSelection / selectionToFields', () => {
    expect(normalizeSelection({ tags: ['@a'] })).toEqual({ kind: 'tags', tags: ['@a'] });
    expect(normalizeSelection({ caseIds: [U1] })).toEqual({ kind: 'cases', caseIds: [U1] });
    expect(normalizeSelection({ suiteId: U1 })).toEqual({ kind: 'suite', suiteId: U1 });
    expect(() => normalizeSelection({})).toThrow('SELECTION_EXCLUSIVE');
    expect(selectionToFields({ kind: 'suite', suiteId: U1 })).toEqual({ suiteId: U1 });
    expect(selectionToFields({ kind: 'cases', caseIds: [U1] })).toEqual({ caseIds: [U1] });
    expect(selectionToFields({ kind: 'tags', tags: ['@a'] })).toEqual({ tags: ['@a'] });
    expect(RunSelectionSchema.safeParse({ kind: 'tags', tags: [] }).success).toBe(false);
  });
  it('selector de suite: al menos un criterio', () => {
    expect(SuiteSelectorSchema.safeParse({}).success).toBe(false);
    expect(SuiteSelectorSchema.parse({ sectionIds: [U1] }).excludeFlaky).toBe(false);
  });
});

describe('RF-PRG-01 esquema de programación', () => {
  const base = { name: 'Humo', environmentId: U1, tags: ['@humo'] };
  it('exactamente uno entre editor y cronExpressions', () => {
    const ok = ScheduleCreateSchema.parse({
      ...base,
      editor: { mode: 'intervalo', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', everyMinutes: 30 },
    });
    expect(ok.timezone).toBe('America/La_Paz');
    expect(ok.notify.onFailure).toBe(true);
    expect(ScheduleCreateSchema.safeParse({ ...base, cronExpressions: ['0 8 * * *'] }).success).toBe(true);
    expect(codeOf(ScheduleCreateSchema.safeParse(base))).toContain('CRON_INVALID');
    expect(
      codeOf(
        ScheduleCreateSchema.safeParse({
          ...base,
          cronExpressions: ['0 8 * * *'],
          editor: { mode: 'hora_fija', days: [1], times: ['08:00'] },
        }),
      ),
    ).toContain('CRON_INVALID');
    expect(ScheduleCreateSchema.safeParse({ ...base, cronExpressions: ['0 8 * * *'], timezone: 'X/Y' }).success).toBe(
      false,
    );
    expect(SchedulePreviewRequestSchema.safeParse({ cronExpressions: ['0 8 * * *'] }).success).toBe(true);
    expect(SchedulePreviewRequestSchema.safeParse({}).success).toBe(false);
  });
  it('ventana de exclusión con fin posterior', () => {
    expect(
      ExclusionWindowCreateSchema.safeParse({
        startsAt: '2026-11-09T12:00:00Z',
        endsAt: '2026-11-09T11:00:00Z',
        reason: 'deploy',
      }).success,
    ).toBe(false);
    expect(
      ExclusionWindowCreateSchema.parse({
        startsAt: '2026-11-09T12:00:00Z',
        endsAt: '2026-11-09T13:00:00Z',
        reason: 'deploy',
      }).environmentId,
    ).toBeNull();
  });
});

describe('RF-REN-03 umbral: min_samples no menor al piso y unidades', () => {
  const base = {
    environmentId: U1,
    seriesSelector: {
      endpointKey: 'x',
      provenance: 'dxmon',
      source: 'probe',
      metricKind: 'network_request',
      cacheMode: 'fria',
      workerProfile: null,
    },
    windowMin: 60,
  };
  it('pisos por métrica', () => {
    expect(
      codeOf(PerfThresholdCreateSchema.safeParse({ ...base, metric: 'p95', limit: 10_000, minSamples: 12 })),
    ).toContain('THRESHOLD_MIN_SAMPLES');
    expect(PerfThresholdCreateSchema.safeParse({ ...base, metric: 'p95', limit: 10_000, minSamples: 20 }).success).toBe(
      true,
    );
    expect(PerfThresholdCreateSchema.safeParse({ ...base, metric: 'max', limit: 29_000, minSamples: 1 }).success).toBe(
      true,
    );
    expect(
      PerfThresholdCreateSchema.safeParse({ ...base, metric: 'error_rate', limit: 1.5, minSamples: 20 }).success,
    ).toBe(false);
  });
  it('consulta perf exige rango válido', () => {
    expect(
      PerfQuerySchema.safeParse({ environmentId: U1, from: '2026-11-09T12:00:00Z', to: '2026-11-09T11:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      PerfQuerySchema.parse({ environmentId: U1, from: '2026-11-09T11:00:00Z', to: '2026-11-09T12:00:00Z' }).by,
    ).toBe('hour');
  });
});

describe('RNF-OPT-02 paginación por cursor', () => {
  it('limit 1..100 default 25', () => {
    expect(CursorQuerySchema.parse({}).limit).toBe(25);
    expect(CursorQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(CursorQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
  it('page schema y cursores opacos', () => {
    const P = pageSchema(z.object({ id: z.string() }));
    expect(P.safeParse({ items: [{ id: 'a' }], nextCursor: null, hasNext: false }).success).toBe(true);
    expect(P.safeParse({ items: Array(101).fill({ id: 'a' }), nextCursor: null, hasNext: false }).success).toBe(false);
    const c = encodeCursor({ createdAt: '2026-11-09T12:00:00Z', id: U1, n: 1, x: null });
    expect(c).not.toMatch(/[+/=]/);
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-11-09T12:00:00Z', id: U1, n: 1, x: null });
    expect(decodeCursor(encodeCursor({ t: 'ñandú' }))).toEqual({ t: 'ñandú' });
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(btoa('[1]'))).toBeNull();
  });
  it('sort permitido con desc', () => {
    const S = sortQuerySchema(['name', 'createdAt'] as const, 'name');
    expect(S.parse(undefined)).toBe('name');
    expect(S.parse('-createdAt')).toBe('-createdAt');
    expect(S.safeParse('password').success).toBe(false);
  });
});

describe('RNF-SEG-03 errores uniformes y códigos estables', () => {
  it('catálogo con estados HTTP coherentes', () => {
    expect(httpStatusFor('SELECTION_EMPTY')).toBe(422);
    expect(httpStatusFor('CRON_INVALID')).toBe(422);
    expect(httpStatusFor('ENVIRONMENT_DISABLED')).toBe(422);
    expect(httpStatusFor('IDEMPOTENCY_CONFLICT')).toBe(409);
    expect(httpStatusFor('LEASE_STALE')).toBe(409);
    expect(httpStatusFor('PRODUCTION_BLOCKED')).toBe(422);
    expect(httpStatusFor('UNAUTHENTICATED')).toBe(401);
    expect(httpStatusFor('FORBIDDEN')).toBe(403);
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(ERROR_CODES.length).toBe(Object.keys(ERROR_CATALOG).length);
    for (const c of ERROR_CODES) expect(defaultMessageFor(c).length).toBeGreaterThan(0);
  });
  it('cuerpo { error: { code, message, requestId, details? } }', () => {
    const body = toApiErrorBody('SELECTION_EMPTY', 'req-1');
    expect(ApiErrorSchema.parse(body)).toEqual({
      error: { code: 'SELECTION_EMPTY', message: defaultMessageFor('SELECTION_EMPTY'), requestId: 'req-1' },
    });
    const withDetails = toApiErrorBody('VALIDATION_FAILED', 'r', 'x', {
      issues: [{ path: ['a', 0], code: 'too_small', message: 'm' }],
    });
    expect(ApiErrorSchema.safeParse(withDetails).success).toBe(true);
    expect(ApiErrorSchema.safeParse({ error: { code: 'NOPE', message: 'x', requestId: 'r' } }).success).toBe(false);
  });
  it('KatalystError', () => {
    const e = new KatalystError('LEASE_STALE', undefined, { reasons: ['generation'] });
    expect(e.status).toBe(409);
    expect(e.message).toBe(defaultMessageFor('LEASE_STALE'));
    expect(isKatalystError(e)).toBe(true);
    expect(isKatalystError(new Error('x'))).toBe(false);
  });
});

describe('RNF-SEG-01 referencias de secretos, zona, idempotencia, login', () => {
  it.each(['env:TESTRAIL_API_KEY', 'file:/run/secrets/katalyst/tr', 'ssm:/katalyst/internal/testrail'])(
    'acepta %s',
    (v) => {
      expect(SecretRefSchema.safeParse(v).success).toBe(true);
    },
  );
  it.each(['mi-api-key-en-claro', 'env:lower', 'file:relative', 'ssm:/a/../b', 'http://x'])('rechaza %s', (v) => {
    expect(SecretRefSchema.safeParse(v).success).toBe(false);
  });
  it('zona IANA', () => {
    expect(TimeZoneSchema.safeParse('America/La_Paz').success).toBe(true);
    expect(TimeZoneSchema.safeParse('Nope/Zone').success).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
  it('Idempotency-Key', () => {
    expect(IdempotencyKeySchema.safeParse('a1b2c3d4-xyz').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('bad key with spaces').success).toBe(false);
  });
  it('correo normalizado en login', () => {
    expect(LoginRequestSchema.parse({ email: 'QA@Empresa.COM', password: 'x' }).email).toBe('qa@empresa.com');
  });
});

describe('Contratos de worker, SSE, grabación y outbox', () => {
  it('RF-EJE-08 resultado de worker con fencing', () => {
    const ok = WorkerResultRequestSchema.safeParse({
      leaseId: U1,
      generation: 1,
      runResultId: U2,
      attemptNo: 1,
      attemptStatus: 'fallido',
      finishedAt: '2026-11-09T12:00:00Z',
      durationMs: 10,
      errorCategory: 'asercion',
      error: 'x',
      final: false,
    });
    expect(ok.success).toBe(true);
    expect(WorkerResultRequestSchema.safeParse({ ...ok.data, attemptStatus: 'corriendo' }).success).toBe(false);
    expect(WorkerResultRequestSchema.safeParse({ ...ok.data, generation: 0 }).success).toBe(false);
  });
  it('RNF-OPT-04 filtros del stream SSE', () => {
    expect(EventStreamQuerySchema.parse({ topics: 'runs,alerts' }).topics).toEqual(['runs', 'alerts']);
    expect(EventStreamQuerySchema.safeParse({ topics: ['tokens'] }).success).toBe(false);
  });
  it('RF-GRB-01 enlace del asistente solo con ID de sesión y user code corto', () => {
    expect(RecordingCreatedResponseSchema.shape.assistantLink.safeParse(`katalyst://recording/${U1}`).success).toBe(
      true,
    );
    expect(
      RecordingCreatedResponseSchema.shape.assistantLink.safeParse(`katalyst://recording/${U1}?token=x`).success,
    ).toBe(false);
    expect(DeviceAuthorizeResponseSchema.shape.userCode.safeParse('ABCD-EF12').success).toBe(true);
  });
  it('RNF-CON-02 backoff exponencial con jitter, tope 1 h y Retry-After', () => {
    expect(outboxBackoffMs(1, () => 0.5)).toBe(5000);
    expect(outboxBackoffMs(2, () => 0.5)).toBe(10_000);
    expect(outboxBackoffMs(30, () => 0.5)).toBe(OUTBOX_RETRY_POLICY.maxDelayMs);
    expect(outboxBackoffMs(30, () => 1)).toBe(OUTBOX_RETRY_POLICY.maxDelayMs);
    expect(outboxBackoffMs(1, () => 0)).toBe(4000);
    expect(outboxBackoffMs(1, () => 0.5, 7000)).toBe(7000);
    expect(outboxBackoffMs(1, () => 0.5, 10 * 3_600_000)).toBe(OUTBOX_RETRY_POLICY.maxDelayMs);
  });
});

describe('RF-EJE-01 uniqueNonEmptyArray', () => {
  it('lista no vacía, sin duplicados y con máximo', () => {
    const S = shared.uniqueNonEmptyArray(z.string(), 2);
    expect(S.safeParse(['a']).success).toBe(true);
    expect(codeOf(S.safeParse([]))).toContain('SELECTION_EMPTY');
    expect(codeOf(S.safeParse(['a', 'a']))).toContain('SELECTION_DUPLICATES');
    expect(codeOf(S.safeParse(['a', 'b', 'c']))).toContain('SELECTION_TOO_LARGE');
  });
});
