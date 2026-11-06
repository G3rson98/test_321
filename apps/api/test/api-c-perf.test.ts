/**
 * Monitoreo (ESP §14 "Monitoreo"): dataset con p95 conocido, n insuficiente, timeouts censurados, HTTP erróneo,
 * caché/origen separados, importación duplicada, > 29 s con hora exacta, fuera de 90 días, rollup y retención.
 * RF-REN-01, RF-REN-02, RF-REN-04, RF-REN-05. BD real (PostgreSQL).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { computePerfStats, KatalystError, type PerfObservation } from '@katalyst/shared';
import { importPerfSamples } from '../src/modules/perf/import.js';
import { getPerf, listPerfErrors, listSeries, rawRetentionStart } from '../src/modules/perf/query.js';
import { purgePerfData, rollupPerfHours, floorHour } from '../src/control/perf-rollup.js';
import { createEnvironment, createRun, sample, samplesFile } from './support/api-c.js';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
afterAll(() => prisma.$disconnect());

const MIN = 60_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

async function seedRun(samples: (Record<string, unknown> & { sample_key: string; ts: string })[], envId?: string) {
  const env = envId ? { id: envId } : await createEnvironment(prisma);
  const run = await createRun(prisma, env.id);
  const summary = await prisma.$transaction((tx) => importPerfSamples(tx, run.id, samplesFile(run.id, samples.map((s) => sample(s)))));
  return { envId: env.id, runId: run.id, summary };
}

describe('importación de samples.json (RF-REN-01, ESP §13.8)', () => {
  it('RF-REN-01 importa válidas, cuarentena inválidas con conteo y deduplica (run_id, sample_key) entre importaciones', async () => {
    const env = await createEnvironment(prisma);
    const run = await createRun(prisma, env.id);
    const file = samplesFile(run.id, [
      sample({ sample_key: 'a', ts: ago(5 * MIN) }),
      sample({ sample_key: 'b', ts: ago(4 * MIN), total_ms: -5 }),
      sample({ sample_key: 'c', ts: ago(3 * MIN), timeout: true, censored: false, total_ms: null }),
      sample({ sample_key: 'a', ts: ago(5 * MIN) }),
      sample({ sample_key: 'd', ts: ago(2 * MIN), timeout: true, censored: true, total_ms: null, censored_at_ms: 20_000, timeout_limit_ms: 20_000 }),
    ]);
    const r1 = await prisma.$transaction((tx) => importPerfSamples(tx, run.id, file));
    expect(r1).toMatchObject({ imported: 2, quarantined: 2, duplicates: 1 });
    expect(Object.keys(r1.quarantineReasons).length).toBeGreaterThan(0);
    // Reimportar el mismo archivo no duplica.
    const r2 = await prisma.$transaction((tx) => importPerfSamples(tx, run.id, file));
    expect(r2.imported).toBe(0);
    expect(r2.duplicates).toBe(3);
    expect(await prisma.perfSample.count({ where: { runId: run.id } })).toBe(2);
    // El ambiente se toma de la corrida y endpoint_key lo recalcula el backend.
    const stored = await prisma.perfSample.findFirstOrThrow({ where: { runId: run.id, sampleKey: 'a' } });
    expect(stored.environmentId).toBe(env.id);
    expect(stored.endpointKey).toBe('GET /warehouse/api/warehouse/list/scheduling');
  });

  it('RF-REN-01 archivo de otra corrida o versión no soportada → PERF_IMPORT_INVALID sin importar nada', async () => {
    const env = await createEnvironment(prisma);
    const run = await createRun(prisma, env.id);
    const other = await createRun(prisma, env.id);
    await expect(
      prisma.$transaction((tx) => importPerfSamples(tx, run.id, samplesFile(other.id, [sample({ sample_key: 'x', ts: ago(MIN) })]))),
    ).rejects.toMatchObject({ code: 'PERF_IMPORT_INVALID' });
    await expect(
      prisma.$transaction((tx) => importPerfSamples(tx, run.id, { schema_version: 2, samples: [] })),
    ).rejects.toBeInstanceOf(KatalystError);
    expect(await prisma.perfSample.count({ where: { runId: run.id } })).toBe(0);
  });
});

describe('agregados (RF-REN-02, RF-REN-05, ESP §13.8)', () => {
  it('RF-REN-02 dataset con p95 conocido: rango ceil(0,95·n), media, máx, n; timeouts censurados y HTTP erróneo separados', async () => {
    const samples: (Record<string, unknown> & { sample_key: string; ts: string })[] = [];
    // 40 completadas 100..4000 ms (3 con HTTP 500, incluidas en latencia), 2 timeouts, 1 descartada.
    for (let i = 1; i <= 40; i++) {
      samples.push({ sample_key: `k${i}`, ts: ago((50 - i) * 1000), total_ms: i * 100, ...(i % 13 === 0 ? { status_code: 500, ok: false } : {}) });
    }
    samples.push({ sample_key: 't1', ts: ago(30_000), timeout: true, censored: true, total_ms: null, censored_at_ms: 20_000, timeout_limit_ms: 20_000 });
    samples.push({ sample_key: 't2', ts: ago(29_000), timeout: true, censored: true, total_ms: null, censored_at_ms: 30_000, timeout_limit_ms: 30_000 });
    samples.push({ sample_key: 'inv', ts: ago(28_000), total_ms: 999_999, over_29s: true, invalid_reason: 'pagina_no_visible' });
    const { envId } = await seedRun(samples);
    const res = await getPerf(prisma, {
      environmentId: envId,
      from: ago(2 * 3_600_000),
      to: new Date(now.getTime() + MIN).toISOString(),
      by: 'day',
      compare: 'none',
    });
    expect(res.granularity).toBe('day');
    const pts = res.series.flatMap((s) => s.points);
    const agg = {
      started: pts.reduce((a, p) => a + p.started, 0),
      completed: pts.reduce((a, p) => a + p.completed, 0),
      timeouts: pts.reduce((a, p) => a + p.timeouts, 0),
      httpErrors: pts.reduce((a, p) => a + p.httpErrors, 0),
      discarded: pts.reduce((a, p) => a + p.discarded, 0),
    };
    expect(agg).toEqual({ started: 42, completed: 40, timeouts: 2, httpErrors: 3, discarded: 1 });
    // Si el día UTC no se partió, un solo punto con el p95 conocido.
    if (pts.length === 1) {
      const p = pts[0]!;
      expect(p.p95Ms).toBe(3800); // ceil(0.95·40) = 38 → 3800 ms
      expect(p.p95Status).toBe('ok');
      expect(p.maxMs).toBe(4000); // la descartada (999 999) no cuenta
      expect(p.meanMs).toBeCloseTo(2050, 6);
      expect(p.over29s).toBe(0); // timeout a 30 s es censurado, no "> 29 s"
      expect(p.errorRate).toBeCloseTo(5 / 42, 10);
      expect(p.timeoutRate).toBeCloseTo(2 / 42, 10);
      // Equivalente a la implementación de referencia de @katalyst/shared.
      const ref = computePerfStats(
        samples.map(
          (s): PerfObservation => ({
            totalMs: (s.total_ms as number | null | undefined) ?? (s.timeout ? null : 100),
            timeout: Boolean(s.timeout),
            statusCode: (s.status_code as number | undefined) ?? 200,
            ok: (s.ok as boolean | undefined) ?? true,
            invalidReason: (s.invalid_reason as string | undefined) ?? null,
            metricKind: 'network_request',
          }),
        ),
      );
      expect(p.p95Ms).toBe(ref.p95.value);
      expect(p.maxMs).toBe(ref.max.value);
      expect(p.httpErrors).toBe(ref.httpErrors);
    }
    expect(res.lastSampleAt).not.toBeNull();
  });

  it('RF-REN-02 n insuficiente → "muestra_insuficiente" y p95 null; media/máx sí con ≥ 1 completada', async () => {
    const { envId } = await seedRun(Array.from({ length: 10 }, (_, i) => ({ sample_key: `s${i}`, ts: ago((i + 1) * 1000), total_ms: 1000 + i })));
    const res = await getPerf(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), by: 'hour', compare: 'none' });
    const p = res.series[0]!.points[0]!;
    expect(p.p95Ms).toBeNull();
    expect(p.p95Status).toBe('muestra_insuficiente');
    expect(p.quality).toBe('insuficiente');
    expect(p.maxMs).toBe(1009);
    expect(p.errorRate).toBeNull(); // < 20 iniciadas
  });

  it('WEB→API-C resumen del período: p95 sobre crudas del período completo (no el peor p95 por intervalo) y bytes promedio', async () => {
    // 40 completadas repartidas en dos horas distintas: p95 horario (≥ 20 por hora) ≠ p95 del período completo.
    const samples: (Record<string, unknown> & { sample_key: string; ts: string })[] = [];
    for (let i = 1; i <= 20; i++) samples.push({ sample_key: `a${i}`, ts: ago(2 * 3_600_000 + i * 1000), total_ms: i * 10, bytes_wire: 1000, bytes_body: 4000 });
    for (let i = 1; i <= 20; i++) samples.push({ sample_key: `b${i}`, ts: ago(30 * MIN + i * 1000), total_ms: 1000 + i * 10, bytes_wire: 3000, bytes_body: 8000 });
    const { envId } = await seedRun(samples);
    const res = await getPerf(prisma, { environmentId: envId, from: ago(4 * 3_600_000), to: now.toISOString(), by: 'hour', compare: 'none' });
    const s = res.series[0]!;
    expect(s.points.length).toBeGreaterThanOrEqual(2);
    expect(s.summary).toMatchObject({ completed: 40, p95Status: 'ok', p95Ms: 1000 + 18 * 10, avgBytesWire: 2000, avgBytesBody: 6000 });
    // Con pocas muestras el resumen del período dice "muestra_insuficiente" y conserva bytes.
    const few = await seedRun(Array.from({ length: 5 }, (_, i) => ({ sample_key: `f${i}`, ts: ago((i + 1) * 1000), total_ms: 100, bytes_wire: 500 })));
    const r2 = await getPerf(prisma, { environmentId: few.envId, from: ago(3_600_000), to: now.toISOString(), by: 'hour', compare: 'none' });
    expect(r2.series[0]!.summary).toMatchObject({ completed: 5, p95Ms: null, p95Status: 'muestra_insuficiente', avgBytesWire: 500, avgBytesBody: null });
  });

  it('RF-REN-02 series separadas por caché, procedencia y origen (no mezclar DXMon con Playwright ni fría/caliente)', async () => {
    const { envId } = await seedRun([
      { sample_key: 'c1', ts: ago(5000), cache_mode: 'fria', total_ms: 900 },
      { sample_key: 'c2', ts: ago(4000), cache_mode: 'caliente', total_ms: 100 },
      { sample_key: 'd1', ts: ago(3000), provenance: 'dxmon', source: 'probe', total_ms: 300 },
      { sample_key: 'd2', ts: ago(2000), provenance: 'dxmon', source: 'app', total_ms: 400 },
    ]);
    const res = await getPerf(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), by: 'hour', compare: 'none' });
    expect(res.series).toHaveLength(4);
    const keys = res.series.map((s) => `${s.key.provenance}/${s.key.source}/${s.key.cacheMode}`).sort();
    expect(keys).toEqual(['dxmon/app/caliente', 'dxmon/probe/caliente', 'playwright/app/caliente', 'playwright/app/fria']);
    const onlyCold = await getPerf(prisma, { environmentId: envId, cacheMode: 'fria', from: ago(3_600_000), to: now.toISOString(), by: 'hour', compare: 'none' });
    expect(onlyCold.series).toHaveLength(1);
    expect(onlyCold.series[0]!.points[0]!.maxMs).toBe(900);
    const list = await listSeries(prisma, { environmentId: envId, limit: 2 });
    expect(list.items).toHaveLength(2);
    expect(list.hasNext).toBe(true);
    const next = await listSeries(prisma, { environmentId: envId, limit: 2, cursor: list.nextCursor! });
    expect(next.items).toHaveLength(2);
  });

  it('RF-REN-05 errores HTTP, de red, timeouts y > 29 s con hora exacta', async () => {
    const t500 = ago(50_000);
    const { envId } = await seedRun([
      { sample_key: 'e1', ts: t500, status_code: 500, ok: false, total_ms: 50 },
      { sample_key: 'e2', ts: ago(40_000), timeout: true, censored: true, total_ms: null, censored_at_ms: 20_000, timeout_limit_ms: 20_000 },
      { sample_key: 'e3', ts: ago(30_000), total_ms: 29_500, over_29s: true },
      { sample_key: 'e4', ts: ago(20_000), total_ms: null, ok: null, status_code: null, error_kind: 'red' },
      { sample_key: 'ok', ts: ago(10_000), total_ms: 100 },
    ]);
    const all = await listPerfErrors(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), limit: 10 });
    expect(all.items.map((i) => i.kind).sort()).toEqual(['http_error', 'network_error', 'over_29s', 'timeout']);
    const http = all.items.find((i) => i.kind === 'http_error')!;
    expect(http.ts).toBe(t500);
    expect(http.statusCode).toBe(500);
    const timeouts = await listPerfErrors(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), kind: 'timeout', limit: 10 });
    expect(timeouts.items).toHaveLength(1);
    expect(timeouts.items[0]!.censoredAtMs).toBe(20_000);
    expect(timeouts.items[0]!.totalMs).toBeNull();
    const page = await listPerfErrors(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), limit: 2 });
    const page2 = await listPerfErrors(prisma, { environmentId: envId, from: ago(3_600_000), to: now.toISOString(), limit: 2, cursor: page.nextCursor! });
    expect([...page.items, ...page2.items].map((i) => i.id)).toHaveLength(4);
  });

  it('RF-REN-02 comparación con el período anterior, marcas de evento y huecos', async () => {
    const env = await createEnvironment(prisma);
    const { runId } = await seedRun([{ sample_key: 'n1', ts: ago(10 * MIN), total_ms: 100 }], env.id);
    await prisma.$transaction((tx) =>
      importPerfSamples(tx, runId, samplesFile(runId, [sample({ sample_key: 'p1', ts: ago(90 * MIN), total_ms: 300 })])),
    );
    await prisma.eventMark.create({ data: { ts: new Date(ago(20 * MIN)), label: 'Despliegue frontend', environmentId: env.id, frontendVersion: '1.2.3' } });
    const res = await getPerf(prisma, {
      environmentId: env.id,
      from: ago(60 * MIN),
      to: now.toISOString(),
      by: 'minute',
      compare: 'previous_period',
    });
    expect(res.granularity).toBe('minute');
    expect(res.series[0]!.points[0]!.maxMs).toBe(100);
    expect(res.series[0]!.comparison![0]!.maxMs).toBe(300);
    expect(res.marks.map((m) => m.frontendVersion)).toEqual(['1.2.3']);
    // 50 min sin datos antes de la muestra (umbral 15 min) → hueco explícito.
    expect(res.gaps.length).toBeGreaterThan(0);
  });

  it('RF-REN-02 fuera de 90 días solo métricas conservadas: p95 diario "no_disponible"', async () => {
    const env = await createEnvironment(prisma);
    const oldHour = floorHour(new Date(now.getTime() - 120 * 86_400_000));
    await prisma.perfHourlyAggregate.create({
      data: {
        environmentId: env.id,
        endpointKey: 'GET /x',
        provenance: 'playwright',
        source: 'app',
        metricKind: 'network_request',
        cacheMode: 'caliente',
        workerProfile: '',
        bucketStart: oldHour,
        started: 30,
        completed: 30,
        sumMs: 3000,
        sumSqMs: 300_000,
        minMs: 50,
        maxMs: 200,
        timeouts: 0,
      },
    });
    const res = await getPerf(prisma, {
      environmentId: env.id,
      from: new Date(now.getTime() - 130 * 86_400_000).toISOString(),
      to: now.toISOString(),
      by: 'hour',
      compare: 'none',
    });
    expect(res.granularity).toBe('day'); // 130 días por hora > 1.000 puntos
    const p = res.series[0]!.points[0]!;
    expect(p.p95Ms).toBeNull();
    expect(p.p95Status).toBe('no_disponible');
    expect(p.meanMs).toBe(100);
    expect(p.maxMs).toBe(200);
    expect(res.series[0]!.summary).toMatchObject({ p95Ms: null, p95Status: 'no_disponible', avgBytesWire: null, avgBytesBody: null });
    expect(rawRetentionStart(now).getTime()).toBeGreaterThan(now.getTime() - 90 * 86_400_000);
  });

  it('RF-REN-02 rango demasiado grande → PERF_RANGE_TOO_LARGE', async () => {
    const env = await createEnvironment(prisma);
    await expect(
      getPerf(prisma, { environmentId: env.id, from: '2020-01-01T00:00:00Z', to: now.toISOString(), by: 'day', compare: 'none' }),
    ).rejects.toMatchObject({ code: 'PERF_RANGE_TOO_LARGE' });
  });
});

describe('rollup horario y retención (ESP §7)', () => {
  it('RF-REN-02 rollup idempotente conserva conteos/sumas/mín/máx; la purga completa agregados antes de borrar crudos > 90 días', async () => {
    const env = await createEnvironment(prisma);
    const run = await createRun(prisma, env.id);
    const old = new Date(now.getTime() - 95 * 86_400_000);
    await prisma.perfSample.createMany({
      data: [100, 200, 300].map((ms, i) => ({
        runId: run.id,
        environmentId: env.id,
        sampleKey: `old${i}`,
        schemaVersion: 1,
        ts: new Date(old.getTime() + i * 1000),
        provenance: 'playwright' as const,
        source: 'app' as const,
        metricKind: 'network_request' as const,
        endpointKey: 'GET /old',
        totalMs: ms,
        statusCode: i === 2 ? 503 : 200,
        ok: i !== 2,
        cacheMode: 'fria' as const,
      })),
    });
    const res = await purgePerfData(prisma, now, { batchSize: 2 });
    expect(res.filledAggregates).toBeGreaterThanOrEqual(1);
    expect(await prisma.perfSample.count({ where: { runId: run.id } })).toBe(0);
    const agg = await prisma.perfHourlyAggregate.findFirstOrThrow({ where: { environmentId: env.id, endpointKey: 'GET /old' } });
    expect(agg).toMatchObject({ started: 3, completed: 3, sumMs: 600, minMs: 100, maxMs: 300, httpErrors: 1, cacheMode: 'fria' });
    // Rollup reciente: upsert idempotente.
    const r2 = await seedRun([{ sample_key: 'r1', ts: ago(2 * 3_600_000), total_ms: 42 }]);
    const from = floorHour(new Date(now.getTime() - 3 * 3_600_000));
    await rollupPerfHours(prisma, from, floorHour(now));
    await rollupPerfHours(prisma, from, floorHour(now));
    const rows = await prisma.perfHourlyAggregate.findMany({ where: { environmentId: r2.envId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ started: 1, completed: 1, sumMs: 42 });
  });
});
