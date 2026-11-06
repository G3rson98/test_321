/**
 * Series y resúmenes por intervalo (ESP §7 `perf_hourly_aggregate`, §13.8, §17.4).
 * - Series separadas por ambiente, procedencia (dxmon/playwright), endpoint/pantalla normalizado, origen, tipo de
 *   métrica, caché y perfil de worker.
 * - Los agregados conservan conteo, sumas, mín/máx y conteos de errores/timeouts; sin URL cruda.
 * - p95 NO se reconstruye desde agregados (no promediar percentiles): se calcula sobre muestras crudas.
 * - Máximo 1.000 puntos por serie por consulta: elegir granularidad explícita.
 * RF-REN-02, RF-REN-05, RNF-OPT-03.
 */
import type { CacheMode, PerfGranularity, PerfMetricKind, PerfProvenance, PerfSource } from '../enums.js';
import { computePerfStats, type PerfObservation, type PerfStats } from './stats.js';

export const MAX_POINTS_PER_SERIES = 1000;

export interface SeriesDimensions {
  environmentId: string;
  /** endpoint_key para peticiones, screen_key para pantallas. */
  endpointKey: string;
  provenance: PerfProvenance;
  source: PerfSource;
  metricKind: PerfMetricKind;
  cacheMode: CacheMode;
  workerProfile: string | null;
}

export function seriesKey(d: SeriesDimensions): string {
  return [d.environmentId, d.provenance, d.source, d.metricKind, d.cacheMode, d.workerProfile ?? '-', d.endpointKey]
    .map((p) => encodeURIComponent(p))
    .join('|');
}

const GRANULARITY_MS: Record<PerfGranularity, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Inicio del bucket UTC que contiene `ts`. */
export function bucketStart(ts: Date, granularity: PerfGranularity): Date {
  const size = GRANULARITY_MS[granularity];
  return new Date(Math.floor(ts.getTime() / size) * size);
}

export function bucketCount(from: Date, to: Date, granularity: PerfGranularity): number {
  const size = GRANULARITY_MS[granularity];
  return Math.max(0, Math.ceil((to.getTime() - bucketStart(from, granularity).getTime()) / size));
}

/** Granularidad más fina que respeta el máximo de puntos (ESP §17.4). */
export function chooseGranularity(from: Date, to: Date, requested?: PerfGranularity): PerfGranularity {
  const order: PerfGranularity[] = ['minute', 'hour', 'day'];
  const startIdx = requested ? order.indexOf(requested) : 0;
  for (let i = startIdx; i < order.length; i++) {
    const g = order[i]!;
    if (bucketCount(from, to, g) <= MAX_POINTS_PER_SERIES) return g;
  }
  return 'day';
}

export interface SampleForAggregation extends PerfObservation {
  ts: Date;
  dims: SeriesDimensions;
}

/** Fila de `perf_hourly_aggregate` (o de cualquier granularidad). */
export interface IntervalAggregate {
  dims: SeriesDimensions;
  bucketStart: Date;
  granularity: PerfGranularity;
  started: number;
  completed: number;
  discarded: number;
  sumMs: number;
  sumSqMs: number;
  minMs: number | null;
  maxMs: number | null;
  httpErrors: number;
  networkErrors: number;
  timeouts: number;
  over29s: number;
}

export function aggregateByInterval(
  samples: readonly SampleForAggregation[],
  granularity: PerfGranularity,
): IntervalAggregate[] {
  const groups = new Map<string, { dims: SeriesDimensions; start: Date; obs: PerfObservation[] }>();
  for (const s of samples) {
    const start = bucketStart(s.ts, granularity);
    const key = `${seriesKey(s.dims)}@${start.toISOString()}`;
    let g = groups.get(key);
    if (!g) {
      g = { dims: s.dims, start, obs: [] };
      groups.set(key, g);
    }
    g.obs.push(s);
  }
  const out: IntervalAggregate[] = [];
  for (const g of groups.values()) {
    const stats = computePerfStats(g.obs);
    const durations = g.obs
      .filter((o) => !o.invalidReason && !o.timeout && !o.networkError && typeof o.totalMs === 'number')
      .map((o) => o.totalMs as number);
    out.push({
      dims: g.dims,
      bucketStart: g.start,
      granularity,
      started: stats.started,
      completed: stats.completed,
      discarded: stats.discarded,
      sumMs: durations.reduce((a, b) => a + b, 0),
      sumSqMs: durations.reduce((a, b) => a + b * b, 0),
      minMs: stats.min.value,
      maxMs: stats.max.value,
      httpErrors: stats.httpErrors,
      networkErrors: stats.networkErrors,
      timeouts: stats.timeouts,
      over29s: stats.over29s,
    });
  }
  return out.sort(
    (a, b) => a.bucketStart.getTime() - b.bucketStart.getTime() || seriesKey(a.dims).localeCompare(seriesKey(b.dims)),
  );
}

export interface MergedAggregateStats {
  started: number;
  completed: number;
  discarded: number;
  mean: number | null;
  max: number | null;
  min: number | null;
  /** Siempre null: p95 no es combinable desde agregados (ESP §7). */
  p95: null;
  p95Unavailable: 'no_disponible_desde_agregados';
  errorRate: number | null;
  timeoutRate: number | null;
  httpErrors: number;
  networkErrors: number;
  timeouts: number;
  over29s: number;
}

/** Combina agregados (p. ej. horarios → diario fuera de los 90 días de crudo). */
export function mergeAggregates(rows: readonly IntervalAggregate[], minStartedForRates = 20): MergedAggregateStats {
  const t = rows.reduce(
    (acc, r) => {
      acc.started += r.started;
      acc.completed += r.completed;
      acc.discarded += r.discarded;
      acc.sum += r.sumMs;
      acc.httpErrors += r.httpErrors;
      acc.networkErrors += r.networkErrors;
      acc.timeouts += r.timeouts;
      acc.over29s += r.over29s;
      if (r.maxMs !== null) acc.max = acc.max === null ? r.maxMs : Math.max(acc.max, r.maxMs);
      if (r.minMs !== null) acc.min = acc.min === null ? r.minMs : Math.min(acc.min, r.minMs);
      return acc;
    },
    {
      started: 0,
      completed: 0,
      discarded: 0,
      sum: 0,
      httpErrors: 0,
      networkErrors: 0,
      timeouts: 0,
      over29s: 0,
      max: null as number | null,
      min: null as number | null,
    },
  );
  const rates = t.started >= minStartedForRates;
  return {
    started: t.started,
    completed: t.completed,
    discarded: t.discarded,
    mean: t.completed > 0 ? t.sum / t.completed : null,
    max: t.max,
    min: t.min,
    p95: null,
    p95Unavailable: 'no_disponible_desde_agregados',
    errorRate: rates ? (t.httpErrors + t.networkErrors + t.timeouts) / t.started : null,
    timeoutRate: rates ? t.timeouts / t.started : null,
    httpErrors: t.httpErrors,
    networkErrors: t.networkErrors,
    timeouts: t.timeouts,
    over29s: t.over29s,
  };
}

/** Estadísticas por bucket sobre muestras crudas (incluye p95 correcto por bucket). */
export function statsByBucket(
  samples: readonly SampleForAggregation[],
  granularity: PerfGranularity,
): { bucketStart: Date; stats: PerfStats }[] {
  const groups = new Map<number, PerfObservation[]>();
  for (const s of samples) {
    const k = bucketStart(s.ts, granularity).getTime();
    const arr = groups.get(k) ?? [];
    arr.push(s);
    groups.set(k, arr);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([k, obs]) => ({ bucketStart: new Date(k), stats: computePerfStats(obs) }));
}
