import { describe, expect, it } from 'vitest';
import {
  aggregateCase,
  assertRunTransition,
  buildTestRailComment,
  canRecover,
  canRetry,
  canTransitionRun,
  chunk,
  computeRunOutcome,
  finalResultFromAttempts,
  flakyScore,
  infraRecoveryCountOf,
  isFunctionalFailure,
  isTerminalRunStatus,
  lostAttemptOutcome,
  passedOnRetryNumber,
  reasonText,
  retryComment,
  retryCountOf,
  runMarker,
  testrailRunName,
  testrailStatusIdFor,
  toTestRailElapsed,
  type AttemptLike,
  type ContributingResult,
} from '../src/aggregation/index.js';
import { RUN_STATUSES } from '../src/enums.js';

const A = { stableKey: 'a', parameterKey: 'default' };
const B = { stableKey: 'b', parameterKey: 'default' };
const B2 = { stableKey: 'b', parameterKey: 'v2' };
const r = (
  v: { stableKey: string; parameterKey: string },
  status: ContributingResult['status'],
  extra: Partial<ContributingResult> = {},
): ContributingResult => ({
  ...v,
  status,
  ...extra,
});

describe('RF-RES-05 outcome de corrida (ESP §13.2)', () => {
  const ok = { status: 'pasado' as const, coverage: 'completa' as const };
  it('activa → null', () => {
    for (const s of ['en_cola', 'preparando', 'corriendo', 'finalizando', 'cancelando'] as const) {
      expect(computeRunOutcome({ status: s, results: [], cases: [] })).toBeNull();
    }
  });
  it('cancelada/interrumpida/omitida → incompleto', () => {
    for (const s of ['cancelada', 'interrumpida', 'omitida'] as const) {
      expect(computeRunOutcome({ status: s, results: [{ status: 'pasado' }], cases: [ok] })).toBe('incompleto');
    }
  });
  it('fallido tiene prioridad', () => {
    expect(
      computeRunOutcome({ status: 'terminada', results: [{ status: 'fallido' }, { status: 'bloqueado' }], cases: [] }),
    ).toBe('fallido');
    expect(
      computeRunOutcome({
        status: 'terminada',
        results: [{ status: 'pasado' }],
        cases: [{ status: 'fallido', coverage: 'parcial' }],
      }),
    ).toBe('fallido');
  });
  it('bloqueado si hay caso parcial/bloqueado o test no exitoso', () => {
    expect(
      computeRunOutcome({
        status: 'terminada',
        results: [{ status: 'pasado' }],
        cases: [{ status: 'bloqueado', coverage: 'ninguna' }],
      }),
    ).toBe('bloqueado');
    expect(
      computeRunOutcome({
        status: 'terminada',
        results: [{ status: 'pasado' }],
        cases: [{ status: 'pasado', coverage: 'parcial' }],
      }),
    ).toBe('bloqueado');
    expect(
      computeRunOutcome({
        status: 'terminada',
        results: [{ status: 'inestable' }, { status: 'omitido' }],
        cases: [ok],
      }),
    ).toBe('bloqueado');
    expect(computeRunOutcome({ status: 'terminada', results: [], cases: [] })).toBe('bloqueado');
    // Solo casos bloqueados, sin navegador (ESP §13.1)
    expect(
      computeRunOutcome({ status: 'terminada', results: [], cases: [{ status: 'bloqueado', coverage: 'ninguna' }] }),
    ).toBe('bloqueado');
  });
  it('inestable si pasó tras retry', () => {
    expect(
      computeRunOutcome({
        status: 'terminada',
        results: [{ status: 'pasado' }, { status: 'inestable' }],
        cases: [ok, { status: 'inestable', coverage: 'completa' }],
      }),
    ).toBe('inestable');
  });
  it('pasado si todo cubierto y pasado', () => {
    expect(computeRunOutcome({ status: 'terminada', results: [{ status: 'pasado' }], cases: [ok] })).toBe('pasado');
  });
});

describe('RF-EJE-08 máquina de estados de corrida', () => {
  it('flujo feliz y cancelación', () => {
    expect(canTransitionRun('en_cola', 'preparando')).toBe(true);
    expect(canTransitionRun('preparando', 'corriendo')).toBe(true);
    expect(canTransitionRun('corriendo', 'finalizando')).toBe(true);
    expect(canTransitionRun('finalizando', 'terminada')).toBe(true);
    expect(canTransitionRun('corriendo', 'cancelando')).toBe(true);
    expect(canTransitionRun('cancelando', 'cancelada')).toBe(true);
    expect(canTransitionRun('en_cola', 'terminada')).toBe(true); // todo bloqueado
    expect(canTransitionRun('en_cola', 'omitida')).toBe(true); // vencida por capacidad
  });
  it('terminal no se reabre', () => {
    for (const t of ['terminada', 'cancelada', 'interrumpida', 'omitida'] as const) {
      expect(isTerminalRunStatus(t)).toBe(true);
      for (const s of RUN_STATUSES) expect(canTransitionRun(t, s)).toBe(false);
    }
    expect(isTerminalRunStatus('corriendo')).toBe(false);
    expect(() => assertRunTransition('terminada', 'corriendo')).toThrow(/no permitida/);
    expect(() => assertRunTransition('en_cola', 'preparando')).not.toThrow();
  });
});

describe('RF-EJE-05 intentos, retries y recuperación (ESP §13.3)', () => {
  const fail = (n: number, kind: AttemptLike['kind'] = 'inicial'): AttemptLike => ({
    attemptNo: n,
    kind,
    status: 'fallido',
    errorCategory: 'asercion',
    durationMs: 100,
  });
  const pass = (n: number, kind: AttemptLike['kind'] = 'inicial'): AttemptLike => ({
    attemptNo: n,
    kind,
    status: 'pasado',
    durationMs: 50,
  });
  const lectura = { retries: 2, classification: 'lectura' as const, writeIdempotencyApproved: false };

  it('falla funcional vs infraestructura', () => {
    expect(isFunctionalFailure({ status: 'fallido', errorCategory: 'asercion' })).toBe(true);
    expect(isFunctionalFailure({ status: 'fallido', errorCategory: 'timeout_aplicacion' })).toBe(true);
    expect(isFunctionalFailure({ status: 'fallido', errorCategory: null })).toBe(true);
    expect(isFunctionalFailure({ status: 'fallido', errorCategory: 'navegador_no_disponible' })).toBe(false);
    expect(isFunctionalFailure({ status: 'pasado' })).toBe(false);
  });

  it('retry permitido hasta N en lectura', () => {
    expect(canRetry([fail(1)], lectura)).toBe(true);
    expect(canRetry([fail(1), fail(2, 'retry')], lectura)).toBe(true);
    expect(canRetry([fail(1), fail(2, 'retry'), fail(3, 'retry')], lectura)).toBe(false);
    expect(canRetry([fail(1)], { ...lectura, retries: 0 })).toBe(false);
    expect(canRetry([fail(1)], { ...lectura, retries: 5 })).toBe(true);
    expect(canRetry([pass(1)], lectura)).toBe(false);
    expect(canRetry([], lectura)).toBe(false);
  });

  it('escritura sin idempotencia aprobada no se reintenta; sin_clasificar tampoco', () => {
    expect(canRetry([fail(1)], { retries: 2, classification: 'escritura', writeIdempotencyApproved: false })).toBe(
      false,
    );
    expect(canRetry([fail(1)], { retries: 2, classification: 'escritura', writeIdempotencyApproved: true })).toBe(true);
    expect(canRetry([fail(1)], { retries: 2, classification: 'sin_clasificar', writeIdempotencyApproved: true })).toBe(
      false,
    );
  });

  it('recuperación por infraestructura: solo lectura, una vez', () => {
    expect(canRecover([], { classification: 'lectura' })).toBe(true);
    expect(
      canRecover([{ attemptNo: 2, kind: 'recuperacion', status: 'corriendo' }], { classification: 'lectura' }),
    ).toBe(false);
    expect(canRecover([], { classification: 'escritura' })).toBe(false);
    expect(lostAttemptOutcome({ classification: 'lectura' })).toEqual({
      status: 'error_infraestructura',
      errorCategory: 'worker_perdido',
    });
    expect(lostAttemptOutcome({ classification: 'escritura' })).toEqual({
      status: 'error_infraestructura',
      errorCategory: 'resultado_desconocido',
    });
  });

  it('resultado final: inestable tras retry, pasado tras recuperación', () => {
    expect(finalResultFromAttempts([pass(1)])).toMatchObject({ status: 'pasado', retryCount: 0, durationMs: 50 });
    expect(finalResultFromAttempts([fail(1), pass(2, 'retry')])).toMatchObject({
      status: 'inestable',
      retryCount: 1,
      durationMs: 150,
    });
    const recovered = finalResultFromAttempts([
      { attemptNo: 1, kind: 'inicial', status: 'error_infraestructura', errorCategory: 'worker_perdido' },
      pass(2, 'recuperacion'),
    ]);
    expect(recovered).toMatchObject({ status: 'pasado', infraRecoveryCount: 1, recovered: true });
    expect(finalResultFromAttempts([fail(1), fail(2, 'retry')]).status).toBe('fallido');
    expect(
      finalResultFromAttempts([{ attemptNo: 1, kind: 'inicial', status: 'fallido', errorCategory: 'login' }]).status,
    ).toBe('error_infraestructura');
    expect(finalResultFromAttempts([]).status).toBe('pendiente');
    expect(finalResultFromAttempts([]).durationMs).toBeNull();
    expect(finalResultFromAttempts([{ attemptNo: 1, kind: 'inicial', status: 'corriendo' }]).status).toBe('corriendo');
    expect(finalResultFromAttempts([{ attemptNo: 1, kind: 'inicial', status: 'omitido' }]).status).toBe('omitido');
    expect(finalResultFromAttempts([{ attemptNo: 1, kind: 'inicial', status: 'cancelado' }]).status).toBe('cancelado');
    expect(finalResultFromAttempts([{ attemptNo: 1, kind: 'inicial', status: 'error_infraestructura' }]).status).toBe(
      'error_infraestructura',
    );
  });

  it('contadores separados y número de reintento', () => {
    const atts: AttemptLike[] = [fail(1), fail(2, 'retry'), pass(3, 'retry')];
    expect(retryCountOf(atts)).toBe(2);
    expect(infraRecoveryCountOf(atts)).toBe(0);
    expect(passedOnRetryNumber(atts)).toBe(2);
    expect(passedOnRetryNumber([pass(1)])).toBeNull();
    expect(passedOnRetryNumber([])).toBeNull();
  });
});

describe('RF-TR-04 agregado por caso (ESP §13.4, tabla completa)', () => {
  it('falla funcional confirmada → Failed aunque cobertura parcial', () => {
    const agg = aggregateCase({ runStatus: 'terminada', required: [A, B], results: [r(A, 'fallido')] });
    expect(agg).toMatchObject({ status: 'fallido', testrailStatusId: 5, coverage: 'parcial', publishable: true });
    expect(agg.failed).toEqual([A]);
  });
  it('falla confirmada en corrida cancelada sí se publica', () => {
    expect(
      aggregateCase({ runStatus: 'cancelada', required: [A, B], results: [r(A, 'fallido'), r(B, 'cancelado')] })
        .testrailStatusId,
    ).toBe(5);
    expect(aggregateCase({ runStatus: 'interrumpida', required: [A], results: [r(A, 'fallido')] }).status).toBe(
      'fallido',
    );
  });
  it('sin falla y falta variante → Blocked, nunca Passed', () => {
    const agg = aggregateCase({
      runStatus: 'terminada',
      required: [A, B, B2],
      results: [r(A, 'pasado'), r(B, 'pasado')],
    });
    expect(agg).toMatchObject({ status: 'bloqueado', testrailStatusId: 2, coverage: 'parcial' });
    expect(agg.missing).toEqual([B2]);
    expect(agg.blockReasons).toContain('variante_faltante');
  });
  it('bloqueo por política (producción) → Blocked con causa', () => {
    const agg = aggregateCase({
      runStatus: 'terminada',
      required: [A, B],
      results: [r(A, 'pasado'), r(B, 'bloqueado', { reason: 'escritura_en_produccion' })],
    });
    expect(agg.status).toBe('bloqueado');
    expect(agg.blockReasons).toEqual(['escritura_en_produccion']);
  });
  it('omitido → Blocked', () => {
    expect(
      aggregateCase({
        runStatus: 'terminada',
        required: [A],
        results: [r(A, 'omitido', { reason: 'excluido_inestable' })],
      }).status,
    ).toBe('bloqueado');
  });
  it('todos pasaron, alguno tras retry → Passed con marca de inestabilidad', () => {
    const agg = aggregateCase({
      runStatus: 'terminada',
      required: [A, B],
      results: [r(A, 'pasado'), r(B, 'inestable', { passedOnRetry: 2 })],
    });
    expect(agg).toMatchObject({ status: 'inestable', testrailStatusId: 1, coverage: 'completa' });
    expect(agg.flakyRetries).toEqual([{ stableKey: 'b', parameterKey: 'default', retry: 2 }]);
  });
  it('todos pasaron al primer intento → Passed; duración = suma de intentos', () => {
    const agg = aggregateCase({
      runStatus: 'terminada',
      required: [A, B],
      results: [r(A, 'pasado', { durationMs: 1000 }), r(B, 'pasado', { durationMs: 2500 })],
    });
    expect(agg).toMatchObject({ status: 'pasado', testrailStatusId: 1, coverage: 'completa', durationMs: 3500 });
  });
  it('cancelación/interrupción sin falla y cobertura incompleta → sin resultado externo', () => {
    for (const runStatus of ['cancelada', 'interrumpida'] as const) {
      const agg = aggregateCase({ runStatus, required: [A, B], results: [r(A, 'pasado'), r(B, 'cancelado')] });
      expect(agg).toMatchObject({ status: 'no_ejecutado', testrailStatusId: null, publishable: false });
    }
    expect(
      aggregateCase({ runStatus: 'interrumpida', required: [A], results: [r(A, 'error_infraestructura')] }).status,
    ).toBe('no_ejecutado');
  });
  it('corrida cancelada publica casos completos', () => {
    expect(aggregateCase({ runStatus: 'cancelada', required: [A], results: [r(A, 'pasado')] }).testrailStatusId).toBe(
      1,
    );
  });
  it('error de infraestructura en corrida terminada → Blocked', () => {
    expect(
      aggregateCase({
        runStatus: 'terminada',
        required: [A],
        results: [r(A, 'error_infraestructura', { reason: 'escritura_resultado_desconocido' })],
      }).status,
    ).toBe('bloqueado');
  });
  it('caso sin automatización → Blocked sin_automatizacion (también en cancelada)', () => {
    for (const runStatus of ['terminada', 'cancelada'] as const) {
      const agg = aggregateCase({ runStatus, required: [], results: [] });
      expect(agg).toMatchObject({ status: 'bloqueado', testrailStatusId: 2, coverage: 'ninguna', publishable: true });
      expect(agg.blockReasons).toEqual(['sin_automatizacion']);
    }
    expect(
      aggregateCase({ runStatus: 'terminada', required: [A], results: [], planBlockReason: 'caso_archivado' })
        .blockReasons,
    ).toContain('caso_archivado');
  });
  it('corrida omitida no crea resultado externo', () => {
    expect(aggregateCase({ runStatus: 'omitida', required: [A], results: [] })).toMatchObject({
      status: 'no_ejecutado',
      testrailStatusId: null,
    });
  });
  it('no completa cobertura con resultados ajenos al conjunto requerido', () => {
    const agg = aggregateCase({ runStatus: 'terminada', required: [A], results: [r(B, 'pasado')] });
    expect(agg.status).toBe('bloqueado');
    expect(agg.coverage).toBe('ninguna');
    expect(agg.durationMs).toBeNull();
  });
});

describe('RF-TR-05 mapeo y comentarios TestRail (ESP §8)', () => {
  it('status_id', () => {
    expect(testrailStatusIdFor('pasado')).toBe(1);
    expect(testrailStatusIdFor('inestable')).toBe(1);
    expect(testrailStatusIdFor('fallido')).toBe(5);
    expect(testrailStatusIdFor('bloqueado')).toBe(2);
    expect(testrailStatusIdFor('no_ejecutado')).toBeNull();
    expect(testrailStatusIdFor('pendiente')).toBeNull();
  });
  it('comentario exacto "pasó en el reintento N"', () => {
    expect(retryComment(1)).toBe('pasó en el reintento 1');
    const agg = aggregateCase({
      runStatus: 'terminada',
      required: [A],
      results: [r(A, 'inestable', { passedOnRetry: 2 })],
    });
    const c = buildTestRailComment(agg, {
      runId: 'r-1',
      runUrl: 'https://katalyst/runs/r-1',
      environmentName: 'staging',
      requiredCount: 1,
    });
    expect(c).toContain('pasó en el reintento 2');
    expect(c).toContain('[katalyst-run:r-1]');
    expect(c).toContain('Cobertura: completa (1/1');
  });
  it('comentario de bloqueo y falla con causa explícita', () => {
    const blocked = aggregateCase({ runStatus: 'terminada', required: [], results: [] });
    expect(
      buildTestRailComment(blocked, { runId: 'x', runUrl: 'u', environmentName: 'prod', requiredCount: 0 }),
    ).toContain('caso sin automatización');
    const partial = aggregateCase({ runStatus: 'terminada', required: [A, B], results: [r(A, 'pasado')] });
    expect(
      buildTestRailComment(partial, { runId: 'x', runUrl: 'u', environmentName: 'e', requiredCount: 2 }),
    ).toContain('falta test/variante requerida');
    const failed = aggregateCase({ runStatus: 'terminada', required: [A], results: [r(A, 'fallido')] });
    const fc = buildTestRailComment(failed, {
      runId: 'x',
      runUrl: 'u',
      environmentName: 'e',
      requiredCount: 1,
      sanitizedError: 'expect(locator).toBeVisible() falló',
      evidenceNote: 'captura deshabilitada por política',
    });
    expect(fc).toContain('Falla funcional confirmada en 1 test(s).');
    expect(fc).toContain('Error: expect');
    expect(fc).toContain('Evidencia: captura deshabilitada');
    const noReason = { ...partial, blockReasons: [] };
    expect(
      buildTestRailComment(noReason, { runId: 'x', runUrl: 'u', environmentName: 'e', requiredCount: 2 }),
    ).toContain('cobertura incompleta');
  });
  it('textos de causas', () => {
    expect(reasonText('sin_automatizacion')).toBe('caso sin automatización');
    expect(reasonText('timeout_corrida')).toBe('timeout corrida');
  });
  it('nombre de corrida con marcador, elapsed y lotes de 100', () => {
    expect(testrailRunName('Humo diario', 'staging', '2026-11-09 08:00', 'abc')).toBe(
      'QA Runner · Humo diario · staging · 2026-11-09 08:00 [katalyst-run:abc]',
    );
    expect(runMarker('abc')).toBe('[katalyst-run:abc]');
    expect(toTestRailElapsed(65_000)).toBe('1m 5s');
    expect(toTestRailElapsed(3_723_000)).toBe('1h 2m 3s');
    expect(toTestRailElapsed(3_600_000)).toBe('1h');
    expect(toTestRailElapsed(10)).toBe('1s');
    expect(toTestRailElapsed(null)).toBeNull();
    expect(toTestRailElapsed(-1)).toBeNull();
    expect(toTestRailElapsed(Number.NaN)).toBeNull();
    expect(chunk([...Array(250).keys()]).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunk([], 10)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('RF-CAT-04 flaky score (ESP §13.1)', () => {
  const obs = (statuses: string[], env = 'e1') =>
    statuses.map((s, i) => ({
      status: s as never,
      finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      environmentId: env,
    }));

  it('≥10 observaciones y ≥0,20 → flaky', () => {
    const f = flakyScore(obs([...Array(8).fill('pasado'), 'inestable', 'inestable']));
    expect(f).toMatchObject({ numerator: 2, denominator: 10, isFlaky: true });
    expect(f.score).toBeCloseTo(0.2);
  });
  it('menos de 10 observaciones no marca aunque score alto', () => {
    expect(flakyScore(obs(['inestable', 'inestable', 'pasado'])).isFlaky).toBe(false);
  });
  it('score < 0,20 no marca', () => {
    expect(flakyScore(obs([...Array(9).fill('pasado'), 'inestable', 'pasado'])).isFlaky).toBe(false);
  });
  it('excluye canceladas, infraestructura, omitidas y bloqueadas; usa las últimas 20', () => {
    const many = obs([
      ...Array(10).fill('inestable'),
      ...Array(20).fill('pasado'),
      'cancelado',
      'error_infraestructura',
      'omitido',
      'bloqueado',
    ]);
    const f = flakyScore(many);
    expect(f.denominator).toBe(20);
    expect(f.numerator).toBe(0); // las 20 más recientes son pasadas
    expect(f.isFlaky).toBe(false);
  });
  it('filtra por ambiente y sin datos devuelve score null', () => {
    const mixed = [...obs(Array(10).fill('inestable'), 'e1'), ...obs(Array(10).fill('pasado'), 'e2')];
    expect(flakyScore(mixed, 'e2')).toMatchObject({
      numerator: 0,
      denominator: 10,
      environmentId: 'e2',
      isFlaky: false,
    });
    expect(flakyScore(mixed, 'e1').isFlaky).toBe(true);
    expect(flakyScore([])).toMatchObject({ score: null, isFlaky: false, environmentId: null });
  });
});
