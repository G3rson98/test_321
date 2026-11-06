import { describe, expect, it } from 'vitest';
import {
  aggregateByInterval,
  alertFingerprint,
  bucketCount,
  bucketStart,
  canSendAlert,
  chooseGranularity,
  computePerfStats,
  displayMetric,
  effectiveMinSamples,
  evaluateThreshold,
  evaluationWindow,
  INSUFFICIENT_SAMPLE_LABEL,
  isOver29s,
  isValidMinSamples,
  mergeAggregates,
  metricFromStats,
  normalizeEndpointKey,
  normalizePathSegment,
  normalizeScreenKey,
  observedDurationMs,
  p95,
  parsePerfSamples,
  parsePerfSummary,
  normalizeEndpointForStorage,
  normalizeEndpointPath,
  seriesEndpointKey,
  isIdLikeSegment,
  percentileByRank,
  seriesKey,
  statsByBucket,
  type PerfObservation,
  type SampleForAggregation,
  type SeriesDimensions,
} from '../src/perf/index.js';

const done = (ms: number, extra: Partial<PerfObservation> = {}): PerfObservation => ({
  totalMs: ms,
  timeout: false,
  statusCode: 200,
  ...extra,
});
const range = <T = PerfObservation>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

describe('RF-REN-02 p95 por rango ceil(0.95n) base 1 (ESP §13.8)', () => {
  it('dataset con p95 conocido', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    expect(p95(values)).toBe(1900); // ceil(19) = 19 → 1900
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95(Array.from({ length: 21 }, (_, i) => i + 1))).toBe(20); // ceil(19.95)=20
    expect(p95([5])).toBe(5);
    expect(p95([])).toBeNull();
    expect(percentileByRank([3, 1, 2], 0.5)).toBe(2);
    expect(percentileByRank([3, 1, 2], 1)).toBe(3);
    expect(() => percentileByRank([1], 0)).toThrow(RangeError);
  });

  it('no promedia percentiles: p95 global ≠ media de p95 por bucket', () => {
    const t0 = Date.UTC(2026, 10, 9, 12);
    const dims: SeriesDimensions = {
      environmentId: 'e',
      endpointKey: 'k',
      provenance: 'dxmon',
      source: 'probe',
      metricKind: 'network_request',
      cacheMode: 'fria',
      workerProfile: null,
    };
    const samples: SampleForAggregation[] = [
      ...range(20, (i) => ({ ...done(100 + i), ts: new Date(t0 + i * 1000), dims })),
      ...range(20, (i) => ({ ...done(5000 + i * 100), ts: new Date(t0 + 3_600_000 + i * 1000), dims })),
    ];
    const buckets = statsByBucket(samples, 'hour');
    const avgOfP95 = buckets.reduce((a, b) => a + (b.stats.p95.value ?? 0), 0) / buckets.length;
    const global = computePerfStats(samples).p95.value;
    expect(global).toBe(6700); // rango ceil(0.95·40)=38 → 5000+17·100
    expect(avgOfP95).not.toBe(global);
  });
});

describe('RF-REN-05 timeouts censurados, errores HTTP y over_29s', () => {
  it('timeouts no entran en latencia; sí en tasas; over_29s estricto > 29000', () => {
    const obs: PerfObservation[] = [
      ...range(18, (i) => done(1000 + i)),
      done(29_000), // no es > 29 s
      done(29_001), // sí
      done(500, { statusCode: 500 }), // HTTP no exitoso: completada, cuenta en latencia y error
      { totalMs: null, timeout: true, censoredAtMs: 20_000 }, // timeout a 20 s: no over_29s
      { totalMs: null, timeout: true, censoredAtMs: 30_000 }, // timeout a 30 s: censurado, NO over_29s (D-016)
      { totalMs: null, timeout: false, networkError: true },
      { totalMs: 100, timeout: false, invalidReason: 'contencion' },
    ];
    const s = computePerfStats(obs);
    expect(s.started).toBe(24);
    expect(s.discarded).toBe(1);
    expect(s.completed).toBe(21);
    expect(s.timeouts).toBe(2);
    expect(s.networkErrors).toBe(1);
    expect(s.httpErrors).toBe(1);
    expect(s.over29s).toBe(1);
    expect(s.errorRate.value).toBeCloseTo(4 / 24);
    expect(s.timeoutRate.value).toBeCloseTo(2 / 24);
    expect(s.max.value).toBe(29_001);
    expect(s.min.value).toBe(500);
    expect(s.p95.sufficient).toBe(true);
    expect(s.quality).toBe('suficiente');
  });

  it('timeout nunca se convierte en 0 ms', () => {
    const s = computePerfStats([{ totalMs: null, timeout: true, censoredAtMs: 20_000 }]);
    expect(s.completed).toBe(0);
    expect(s.max.value).toBeNull();
    expect(s.mean.value).toBeNull();
  });

  it('observedDurationMs e isOver29s', () => {
    expect(observedDurationMs({ totalMs: null, timeout: true, censoredAtMs: null })).toBeNull();
    expect(observedDurationMs({ totalMs: -5, timeout: false })).toBeNull();
    expect(isOver29s({ totalMs: 29_000.5, timeout: false })).toBe(true);
    expect(isOver29s({ totalMs: null, timeout: true })).toBe(false);
    expect(isOver29s({ totalMs: 30_000, timeout: false, networkError: true })).toBe(false);
    expect(observedDurationMs({ totalMs: null, timeout: true, censoredAtMs: 30_000 })).toBe(30_000);
    expect(observedDurationMs({ totalMs: 10, timeout: false })).toBe(10);
  });

  it('pantallas usan condición lista/fallida, no HTTP', () => {
    const s = computePerfStats([
      done(1000, { metricKind: 'screen_ready', ok: false, statusCode: 200 }),
      done(1000, { metricKind: 'root_ready', ok: true, statusCode: 500 }),
    ]);
    expect(s.httpErrors).toBe(1);
    expect(s.successes).toBe(1);
  });

  it('ok explícito tiene prioridad y status sin datos no es error', () => {
    const s = computePerfStats([
      done(10, { ok: false, statusCode: 200 }),
      done(10, { statusCode: null }),
      done(10, { statusCode: 302 }),
    ]);
    expect(s.httpErrors).toBe(1);
    expect(s.successes).toBe(2);
  });

  it('iniciada sin duración disponible cuenta en iniciadas, no en latencia', () => {
    const s = computePerfStats([
      { totalMs: null, timeout: false, statusCode: 200 },
      { totalMs: null, timeout: false, statusCode: 404 },
    ]);
    expect(s.started).toBe(2);
    expect(s.completed).toBe(0);
    expect(s.httpErrors).toBe(1);
  });
});

describe('RF-REN-02 mínimos de muestra y "muestra insuficiente"', () => {
  it('p95 exige ≥ 20 completadas; rates ≥ 20 iniciadas; max ≥ 1', () => {
    const s = computePerfStats(range(19, (i) => done(i + 1)));
    expect(s.p95).toMatchObject({ value: null, sufficient: false, n: 19, required: 20 });
    expect(s.errorRate.value).toBeNull();
    expect(s.max.value).toBe(19);
    expect(s.quality).toBe('insuficiente');
    expect(displayMetric(s.p95)).toBe(INSUFFICIENT_SAMPLE_LABEL);
    expect(displayMetric(s.max, (v) => `${v} ms`)).toBe('19 ms');
    expect(displayMetric(s.max)).toBe('19');
    expect(computePerfStats([]).quality).toBe('sin_datos');
    const s20 = computePerfStats(range(20, (i) => done(i + 1)));
    expect(s20.p95.value).toBe(19);
    expect(s20.errorRate.value).toBe(0);
  });
  it('min_samples puede aumentarse, no bajarse del piso', () => {
    expect(
      computePerfStats(
        range(20, (i) => done(i)),
        { minCompletedForP95: 5 },
      ).p95.required,
    ).toBe(20);
    expect(
      computePerfStats(
        range(20, (i) => done(i)),
        { minCompletedForP95: 30 },
      ).p95.sufficient,
    ).toBe(false);
    expect(
      computePerfStats(
        range(25, (i) => done(i)),
        { minStartedForRates: 30 },
      ).errorRate.sufficient,
    ).toBe(false);
    expect(effectiveMinSamples('p95', 5)).toBe(20);
    expect(effectiveMinSamples('p95', 50)).toBe(50);
    expect(effectiveMinSamples('max', 0)).toBe(1);
    expect(isValidMinSamples('p95', 19)).toBe(false);
    expect(isValidMinSamples('p95', 20)).toBe(true);
    expect(isValidMinSamples('max', 1)).toBe(true);
    expect(isValidMinSamples('error_rate', 20.5)).toBe(false);
  });
});

describe('RF-REN-03 evaluación de umbrales', () => {
  const obs = range(20, (i) => done(i < 19 ? 1000 : 12_000)); // p95 = valor en rango 19 → 1000
  it('estrictamente mayor al límite', () => {
    expect(evaluateThreshold({ metric: 'p95', limit: 1000, minSamples: 20 }, obs).state).toBe('normal');
    expect(evaluateThreshold({ metric: 'p95', limit: 999, minSamples: 20 }, obs)).toMatchObject({
      state: 'superado',
      value: 1000,
    });
    expect(evaluateThreshold({ metric: 'max', limit: 10_000, minSamples: 1 }, obs).state).toBe('superado');
  });
  it('muestra insuficiente no dispara', () => {
    expect(evaluateThreshold({ metric: 'p95', limit: 1, minSamples: 20 }, obs.slice(0, 19))).toMatchObject({
      state: 'insuficiente',
      value: null,
      required: 20,
    });
    expect(evaluateThreshold({ metric: 'p95', limit: 1, minSamples: 40 }, obs).state).toBe('insuficiente');
    expect(evaluateThreshold({ metric: 'error_rate', limit: 0, minSamples: 20 }, obs.slice(0, 10)).state).toBe(
      'insuficiente',
    );
  });
  it('rates y entrada como estadísticas precalculadas', () => {
    const withErrors = [
      ...range(18, (i) => done(i)),
      { totalMs: null, timeout: true, censoredAtMs: 20_000 },
      done(5, { statusCode: 503 }),
    ];
    expect(evaluateThreshold({ metric: 'timeout_rate', limit: 0.04, minSamples: 20 }, withErrors)).toMatchObject({
      state: 'superado',
      value: 0.05,
    });
    expect(evaluateThreshold({ metric: 'error_rate', limit: 0.1, minSamples: 20 }, withErrors)).toMatchObject({
      state: 'normal',
      value: 0.1,
    });
    const stats = computePerfStats(withErrors);
    expect(evaluateThreshold({ metric: 'error_rate', limit: 0.05, minSamples: 20 }, stats).state).toBe('superado');
    expect(metricFromStats(stats, 'max').value).toBe(17);
  });
  it('RF-NOT-02 deduplicación: máximo una alerta por 60 min móviles', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    expect(canSendAlert(null, now)).toBe(true);
    expect(canSendAlert(new Date('2026-11-09T11:00:01Z'), now)).toBe(false);
    expect(canSendAlert(new Date('2026-11-09T11:00:00Z'), now)).toBe(true);
    expect(alertFingerprint({ thresholdId: 't1', environmentId: 'e1', source: 'probe', channel: 'slack' })).toBe(
      'umbral:t1:e1:probe:slack',
    );
    expect(alertFingerprint({ thresholdId: 't:1', environmentId: 'e', source: 'ui', channel: 'correo' })).toBe(
      'umbral:t%3A1:e:ui:correo',
    );
  });
  it('ventana móvil por reloj UTC', () => {
    const w = evaluationWindow(new Date('2026-11-09T12:00:00Z'), 60);
    expect(w.from.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(() => evaluationWindow(new Date(), 0)).toThrow(RangeError);
  });
});

describe('RF-REN-01 normalización de endpoint_key', () => {
  it('quita IDs y query de negocio, conserva typeOperation; formato METHOD ruta', () => {
    const url =
      'https://fmsapi.deltax.la/travelUploader/api/travelUploader/cbc/loadingOrder/123?typeOperation=distribution&page=2&email=a@b.com';
    expect(normalizeEndpointKey(url)).toBe(
      'GET /travelUploader/api/travelUploader/cbc/loadingOrder/:id?typeOperation=distribution',
    );
    expect(normalizeEndpointKey(url, { method: 'post' })).toBe(
      'POST /travelUploader/api/travelUploader/cbc/loadingOrder/:id?typeOperation=distribution',
    );
    expect(normalizeEndpointKey(url, { method: '' })).toMatch(/^GET /);
    expect(normalizeEndpointPath(url, { includeHost: true })).toBe(
      'fmsapi.deltax.la/travelUploader/api/travelUploader/cbc/loadingOrder/:id?typeOperation=distribution',
    );
    expect(
      normalizeEndpointPath('https://FMSAPI.deltax.la:8443/warehouse/api/warehouse/list/scheduling?from=2026-11-01', {
        includeHost: true,
      }),
    ).toBe('fmsapi.deltax.la:8443/warehouse/api/warehouse/list/scheduling');
    expect(normalizeEndpointPath('/users/api/users/current')).toBe('/users/api/users/current');
    expect(normalizeEndpointPath('users/api/users/current')).toBe('/users/api/users/current');
    expect(normalizeEndpointPath('https://x.la/a?typeoperation=catering&TYPEOPERATION=direct')).toBe(
      '/a?typeOperation=catering',
    );
    expect(normalizeEndpointPath('https://x.la/a?typeOperation=<script>')).toBe('/a?typeOperation=:value');
    expect(normalizeEndpointPath('https://x.la/a/b/', { includeHost: true })).toBe('x.la/a/b');
    expect(
      normalizeEndpointPath('https://x.la/a?k=v&typeOperation=direct', {
        allowedQueryDimensions: ['k', 'typeOperation'],
      }),
    ).toBe('/a?k=v&typeOperation=direct');
  });
  it('acepta la forma alias:/ruta del productor (qa-tests) y conserva el alias al persistir', () => {
    expect(
      normalizeEndpointKey('api:/travelUploader/api/travelUploader/cbc/loadingOrder?typeOperation=distribution'),
    ).toBe('GET /travelUploader/api/travelUploader/cbc/loadingOrder?typeOperation=distribution');
    expect(normalizeEndpointForStorage('api:/warehouse/api/warehouse/42?x=1')).toBe('api:/warehouse/api/warehouse/:id');
    expect(normalizeEndpointForStorage('https://fmsapi.deltax.la/w/9')).toBe('fmsapi.deltax.la/w/:id');
    expect(normalizeEndpointForStorage('/w/9')).toBe('/w/:id');
  });
  it('segmentos con forma de ID → :id', () => {
    for (const seg of [
      '0b7c3a6e-2f8a-4c1e-9d3b-5e6f7a8b9c0d',
      '42',
      'ana%40corp.com',
      '2026-11-09',
      '2026-11-09T08:00:00Z',
      'deadbeefdeadbeef',
      'aB3dE5fG7hJ9kL1mN3pQ',
      'abcdefghijklmnopqrstuvwxyz',
      'OC-12345',
      '%E0%A4%A',
    ]) {
      expect(normalizePathSegment(seg), seg).toBe(':id');
    }
    expect(normalizePathSegment('loadingOrder')).toBe('loadingOrder');
    expect(normalizePathSegment('v2')).toBe('v2');
    expect(normalizePathSegment('')).toBe('');
    expect(isIdLikeSegment('a@b')).toBe(true);
  });
  it('screen_key: rutas y etiquetas', () => {
    expect(normalizeScreenKey('https://cbc.deltax.la/loadOrder?tab=distribution')).toBe('/loadOrder');
    expect(normalizeScreenKey('/schedulings/77')).toBe('/schedulings/:id');
    expect(normalizeScreenKey('loadOrder:distribution')).toBe('loadOrder:distribution');
    expect(normalizeScreenKey('warehouse:123/config')).toBe('warehouse::id/config');
  });
  it('clave de serie para peticiones, pantallas y arranque', () => {
    expect(
      seriesEndpointKey({ endpoint: 'api:/users/api/users/current', method: 'GET', metricKind: 'network_request' }),
    ).toBe('GET /users/api/users/current');
    expect(seriesEndpointKey({ endpoint: null, screenKey: 'loadOrder:distribution', metricKind: 'screen_ready' })).toBe(
      'screen_ready loadOrder:distribution',
    );
    expect(seriesEndpointKey({ endpoint: null, metricKind: 'root_ready' })).toBe('root_ready');
  });
});

describe('RF-REN-01 contrato de importación versionado (schema_version 1, formato qa-tests)', () => {
  const RUN = '7d1f0c2a-6b1e-4a7e-9a1c-2b3c4d5e6f70';
  const base = {
    schema_version: 1,
    run_id: RUN,
    sample_key: 's1',
    ts: '2026-11-09T12:00:00.000Z',
    provenance: 'playwright',
    source: 'app',
    metric_kind: 'network_request',
    endpoint: 'https://fmsapi.deltax.la/users/api/users/current?token=abc',
    method: 'GET',
    status_code: 200,
    ok: true,
    total_ms: 1200,
    bytes_wire: 150_000,
    bytes_body: 1_200_000,
    over_29s: false,
    cache_mode: 'fria',
    null_reasons: { ttfb_ms: 'timing_no_disponible' },
  };
  const file = (samples: unknown[], extra: Record<string, unknown> = {}) => ({
    schema_version: 1,
    kind: 'katalyst.perf_samples',
    run_id: RUN,
    worker_profile: 'linux-x64-2cpu',
    producer: { adapter: 'katalyst-dxmon-adapter', dxmon: { available: false } },
    samples,
    quarantine: [{ index: 9, provenance: 'dxmon', reason: 'source_desconocido' }],
    ...extra,
  });

  it('importa válidas, cuarentena inválidas sin detener, dedupe por sample_key', () => {
    const res = parsePerfSamples(
      file([
        base,
        { ...base }, // duplicado
        { ...base, sample_key: 's2', total_ms: -1 },
        { ...base, sample_key: 's3', total_ms: Number.NaN },
        {
          ...base,
          sample_key: 's4',
          timeout: true,
          censored: true,
          total_ms: null,
          censored_at_ms: 30_000,
          timeout_limit_ms: 30_000,
          error_kind: 'timeout',
        },
        { ...base, sample_key: 's5', timeout: true, censored: true, total_ms: 100 }, // censurada con latencia
        { ...base, sample_key: 's6', timeout: true, censored: true, total_ms: null }, // sin corte ni límite
        { ...base, sample_key: 's7', censored_at_ms: 10 }, // censura sin timeout
        { ...base, sample_key: 's8', ttfb_ms: 5000 }, // ttfb > total
        { ...base, sample_key: 's9', source: 'otro' },
        { ...base, sample_key: 's10', total_ms: 29_500, over_29s: false }, // incoherente
        { ...base, sample_key: 's11', timeout: true, censored: false, total_ms: null, censored_at_ms: 1 }, // timeout no censurado
        { ...base, sample_key: 's12', censored: true }, // censurada sin timeout
        { ...base, sample_key: 's13', endpoint: null }, // petición sin endpoint
        { ...base, sample_key: 's14', run_id: 'otro' },
        'basura',
        {
          ...base,
          sample_key: 's15',
          total_ms: 29_500,
          over_29s: true,
          provenance: 'dxmon',
          source: 'probe',
          cache_mode: null,
        },
        {
          ...base,
          sample_key: 's16',
          metric_kind: 'screen_ready',
          source: 'ui',
          endpoint: null,
          screen_key: 'loadOrder:distribution',
          method: null,
          status_code: null,
        },
      ]),
      { expectedRunId: RUN },
    );
    expect(res.ok).toBe(true);
    expect(res.valid.map((v) => v.sampleKey)).toEqual(['s1', 's4', 's15', 's16']);
    expect(res.duplicates).toBe(1);
    expect(res.producerQuarantined).toBe(1);
    expect(res.quarantined.map((q) => q.sampleKey)).toEqual([
      's2',
      's3',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      's13',
      's14',
      null,
    ]);
    expect(res.quarantined.find((q) => q.sampleKey === 's3')!.reasons).toEqual(['valor_no_finito:total_ms']);
    expect(res.quarantined.find((q) => q.sampleKey === 's10')!.reasons[0]).toContain('over_29s_incoherente');
    const s1 = res.valid[0]!;
    expect(s1.endpointKey).toBe('GET /users/api/users/current');
    expect(s1.endpoint).toBe('fmsapi.deltax.la/users/api/users/current');
    expect(s1.ttfbMs).toBeNull(); // no disponible → null, nunca 0
    expect(s1.nullReasons).toEqual({ ttfb_ms: 'timing_no_disponible' });
    expect(s1.workerProfile).toBe('linux-x64-2cpu');
    expect(res.valid[1]).toMatchObject({ censored: true, over29s: false, totalMs: null, errorKind: 'timeout' });
    expect(res.valid[2]).toMatchObject({ over29s: true, cacheMode: 'desconocida', provenance: 'dxmon' });
    expect(res.valid[3]).toMatchObject({
      endpoint: null,
      endpointKey: 'screen_ready loadOrder:distribution',
      method: null,
    });
  });

  it('dedupe contra importaciones previas y error de red', () => {
    const res = parsePerfSamples(
      file([base, { ...base, sample_key: 's2', error_kind: 'red', total_ms: null, ok: null, status_code: null }]),
      {
        existingSampleKeys: new Set(['s1']),
      },
    );
    expect(res.duplicates).toBe(1);
    expect(res.valid[0]).toMatchObject({ sampleKey: 's2', networkError: true });
  });

  it('rechaza archivo con versión no soportada, encabezado inválido o run_id distinto', () => {
    expect(parsePerfSamples({ ...file([]), schema_version: 2 })).toMatchObject({
      ok: false,
      fileError: 'schema_version_no_soportada',
    });
    expect(parsePerfSamples({ schema_version: 1 })).toMatchObject({ ok: false, fileError: 'encabezado_invalido' });
    expect(parsePerfSamples(null).ok).toBe(false);
    expect(parsePerfSamples(file([base]), { expectedRunId: 'otro' })).toMatchObject({
      ok: false,
      fileError: 'run_id_distinto',
    });
  });

  it('summary.json', () => {
    const ok = parsePerfSummary({
      started_at: '2026-11-09T12:00:00Z',
      finished_at: '2026-11-09T12:04:00Z',
      cycle_limit_ms: 240_000,
      extra: true,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.summary.series).toEqual([]);
      expect((ok.summary as Record<string, unknown>).extra).toBe(true);
    }
    expect(parsePerfSummary({ started_at: 'x' }).ok).toBe(false);
  });
});

describe('RF-REN-02 series y agregados por intervalo', () => {
  const dims: SeriesDimensions = {
    environmentId: 'e1',
    endpointKey: 'GET /api/x',
    provenance: 'dxmon',
    source: 'probe',
    metricKind: 'network_request',
    cacheMode: 'caliente',
    workerProfile: null,
  };
  const dims2: SeriesDimensions = { ...dims, cacheMode: 'fria' };
  const t0 = Date.UTC(2026, 10, 9, 12, 0);

  it('series separadas por caché/origen', () => {
    expect(seriesKey(dims)).not.toBe(seriesKey(dims2));
    expect(seriesKey({ ...dims, workerProfile: 'p' })).toContain('|p|');
    expect(seriesKey({ ...dims, provenance: 'playwright' })).not.toBe(seriesKey(dims));
  });

  it('buckets UTC y elección de granularidad ≤ 1000 puntos', () => {
    expect(bucketStart(new Date(t0 + 59 * 60_000), 'hour').toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(bucketStart(new Date(t0 + 59 * 60_000), 'day').toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(bucketStart(new Date(t0 + 61_000), 'minute').toISOString()).toBe('2026-11-09T12:01:00.000Z');
    const from = new Date(t0);
    expect(bucketCount(from, new Date(t0 + 3_600_000), 'minute')).toBe(60);
    expect(chooseGranularity(from, new Date(t0 + 3_600_000))).toBe('minute');
    expect(chooseGranularity(from, new Date(t0 + 7 * 86_400_000))).toBe('hour');
    expect(chooseGranularity(from, new Date(t0 + 90 * 86_400_000))).toBe('day');
    expect(chooseGranularity(from, new Date(t0 + 3_600_000), 'hour')).toBe('hour');
    expect(chooseGranularity(from, new Date(t0 + 5000 * 86_400_000), 'day')).toBe('day');
  });

  it('agrega conteos/sumas/min/max sin URL cruda y combina sin p95', () => {
    const samples: SampleForAggregation[] = [
      { ...done(100), ts: new Date(t0), dims },
      { ...done(300), ts: new Date(t0 + 1000), dims },
      { totalMs: null, timeout: true, censoredAtMs: 30_000, ts: new Date(t0 + 2000), dims },
      { ...done(200, { statusCode: 500 }), ts: new Date(t0 + 3_600_000), dims },
      { ...done(50), ts: new Date(t0), dims: dims2 },
      { ...done(10, { invalidReason: 'visibilidad' }), ts: new Date(t0), dims },
    ];
    const rows = aggregateByInterval(samples, 'hour');
    expect(rows).toHaveLength(3);
    const first = rows.find((r) => r.dims.cacheMode === 'caliente' && r.bucketStart.getTime() === t0)!;
    expect(first).toMatchObject({
      started: 3,
      completed: 2,
      discarded: 1,
      sumMs: 400,
      sumSqMs: 100_000,
      minMs: 100,
      maxMs: 300,
      timeouts: 1,
      over29s: 0,
    });
    const merged = mergeAggregates(
      rows.filter((r) => r.dims.cacheMode === 'caliente'),
      1,
    );
    expect(merged).toMatchObject({
      started: 4,
      completed: 3,
      mean: 200,
      max: 300,
      min: 100,
      p95: null,
      httpErrors: 1,
      timeouts: 1,
    });
    expect(merged.errorRate).toBeCloseTo(0.5);
    expect(merged.timeoutRate).toBeCloseTo(0.25);
    expect(mergeAggregates(rows)).toMatchObject({ errorRate: null, timeoutRate: null });
    expect(mergeAggregates([])).toMatchObject({ mean: null, max: null, min: null });
  });
});
