/**
 * Fragmentos SQL de estadísticas de rendimiento sobre muestras CRUDAS, equivalentes a `computePerfStats` de
 * @katalyst/shared/perf (ESP §13.8; verificado por pruebas contra la implementación TypeScript):
 * - descartadas = `invalid_reason` no nulo; iniciadas = válidas.
 * - timeouts censurados no entran en latencia; errores de red tampoco.
 * - completadas = válidas sin timeout/red con `total_ms` no nulo; media/mín/máx/p95 solo sobre completadas.
 * - p95 por rango: `percentile_disc(0.95)` devuelve el valor en la posición `ceil(0.95·n)` (base 1) del orden; nunca
 *   se promedian percentiles.
 * - error HTTP: pantallas/arranque por condición (`ok = false`); peticiones por `ok` o, si falta, por status.
 * - `over_29s`: completadas > 29 000 ms.
 * RF-REN-02, RF-REN-03, RF-REN-05.
 */
import { Prisma } from '@prisma/client';
import {
  MIN_COMPLETED_FOR_MAX,
  MIN_COMPLETED_FOR_P95,
  MIN_STARTED_FOR_RATES,
  OVER_29S_THRESHOLD_MS,
  type CacheMode,
  type PerfMetricKind,
  type PerfPoint,
  type PerfProvenance,
  type PerfSource,
} from '@katalyst/shared';

export const HTTP_ERROR_SQL = Prisma.sql`(CASE
  WHEN metric_kind IN ('screen_ready'::perf_metric_kind, 'root_ready'::perf_metric_kind) THEN ok IS FALSE
  WHEN ok IS NOT NULL THEN NOT ok
  WHEN status_code IS NOT NULL THEN (status_code < 200 OR status_code >= 400)
  ELSE FALSE END)`;
const VALID = Prisma.sql`(invalid_reason IS NULL)`;
const RESPONDED = Prisma.sql`(invalid_reason IS NULL AND NOT timeout AND NOT network_error)`;
const COMPLETED = Prisma.sql`(invalid_reason IS NULL AND NOT timeout AND NOT network_error AND total_ms IS NOT NULL)`;

/** Columnas agregadas (requiere FROM perf_sample). */
export const STATS_COLUMNS = Prisma.sql`
  count(*) FILTER (WHERE invalid_reason IS NOT NULL)::int AS discarded,
  count(*) FILTER (WHERE ${VALID})::int AS started,
  count(*) FILTER (WHERE ${VALID} AND timeout)::int AS timeouts,
  count(*) FILTER (WHERE ${VALID} AND NOT timeout AND network_error)::int AS network_errors,
  count(*) FILTER (WHERE ${COMPLETED})::int AS completed,
  count(*) FILTER (WHERE ${RESPONDED} AND ${HTTP_ERROR_SQL})::int AS http_errors,
  count(*) FILTER (WHERE ${COMPLETED} AND total_ms > ${OVER_29S_THRESHOLD_MS})::int AS over29s,
  avg(total_ms) FILTER (WHERE ${COMPLETED})::float8 AS mean_ms,
  max(total_ms) FILTER (WHERE ${COMPLETED})::float8 AS max_ms,
  min(total_ms) FILTER (WHERE ${COMPLETED})::float8 AS min_ms,
  coalesce(sum(total_ms) FILTER (WHERE ${COMPLETED}), 0)::float8 AS sum_ms,
  coalesce(sum(total_ms * total_ms) FILTER (WHERE ${COMPLETED}), 0)::float8 AS sum_sq_ms,
  (percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE ${COMPLETED}))::float8 AS p95_ms`;

export interface StatsRow {
  discarded: number;
  started: number;
  timeouts: number;
  network_errors: number;
  completed: number;
  http_errors: number;
  over29s: number;
  mean_ms: number | null;
  max_ms: number | null;
  min_ms: number | null;
  sum_ms: number;
  sum_sq_ms: number;
  p95_ms: number | null;
}

export interface SeriesDimsRow {
  environment_id: string;
  endpoint_key: string;
  provenance: PerfProvenance;
  source: PerfSource;
  metric_kind: PerfMetricKind;
  cache_mode: CacheMode;
  worker_profile: string;
}

export const SERIES_COLUMNS = Prisma.sql`environment_id::text AS environment_id, endpoint_key,
  provenance::text AS provenance, source::text AS source, metric_kind::text AS metric_kind,
  cache_mode::text AS cache_mode, coalesce(worker_profile, '') AS worker_profile`;
export const SERIES_GROUP = Prisma.sql`environment_id, endpoint_key, provenance, source, metric_kind, cache_mode,
  coalesce(worker_profile, '')`;

export interface SeriesFilter {
  environmentId: string;
  endpointKeys?: string[];
  screenKey?: string;
  provenance?: PerfProvenance;
  source?: PerfSource;
  metricKind?: PerfMetricKind;
  cacheMode?: CacheMode;
  /** `''` = sin perfil. */
  workerProfile?: string;
}

/** Condiciones WHERE sobre `perf_sample` (sin rango temporal). */
export function rawFilterSql(f: SeriesFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`environment_id = ${f.environmentId}::uuid`];
  if (f.endpointKeys && f.endpointKeys.length > 0) parts.push(Prisma.sql`endpoint_key = ANY(${f.endpointKeys}::text[])`);
  if (f.screenKey !== undefined) parts.push(Prisma.sql`screen_key = ${f.screenKey}`);
  if (f.provenance) parts.push(Prisma.sql`provenance = ${f.provenance}::perf_provenance`);
  if (f.source) parts.push(Prisma.sql`source = ${f.source}::perf_source`);
  if (f.metricKind) parts.push(Prisma.sql`metric_kind = ${f.metricKind}::perf_metric_kind`);
  if (f.cacheMode) parts.push(Prisma.sql`cache_mode = ${f.cacheMode}::cache_mode`);
  if (f.workerProfile !== undefined) parts.push(Prisma.sql`coalesce(worker_profile, '') = ${f.workerProfile}`);
  return Prisma.join(parts, ' AND ');
}

/** Condiciones WHERE sobre `perf_hourly_aggregate`. La pantalla se reconoce por la clave de serie de pantallas. */
export function aggregateFilterSql(f: SeriesFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`environment_id = ${f.environmentId}::uuid`];
  if (f.endpointKeys && f.endpointKeys.length > 0) parts.push(Prisma.sql`endpoint_key = ANY(${f.endpointKeys}::text[])`);
  if (f.screenKey !== undefined) {
    const keys = ['screen_ready', 'root_ready', 'root_current_wait'].map((k) => `${k} ${f.screenKey}`);
    parts.push(Prisma.sql`endpoint_key = ANY(${keys}::text[])`);
  }
  if (f.provenance) parts.push(Prisma.sql`provenance = ${f.provenance}::perf_provenance`);
  if (f.source) parts.push(Prisma.sql`source = ${f.source}::perf_source`);
  if (f.metricKind) parts.push(Prisma.sql`metric_kind = ${f.metricKind}::perf_metric_kind`);
  if (f.cacheMode) parts.push(Prisma.sql`cache_mode = ${f.cacheMode}::cache_mode`);
  if (f.workerProfile !== undefined) parts.push(Prisma.sql`worker_profile = ${f.workerProfile}`);
  return Prisma.join(parts, ' AND ');
}

export function intervalFor(g: 'minute' | 'hour' | 'day'): string {
  return g === 'minute' ? '1 minute' : g === 'hour' ? '1 hour' : '1 day';
}

/** Punto de la API desde una fila de estadísticas crudas. */
export function pointFromRaw(bucket: Date, r: StatsRow, minP95 = MIN_COMPLETED_FOR_P95): PerfPoint {
  const p95ok = r.completed >= Math.max(MIN_COMPLETED_FOR_P95, minP95);
  const hasCompleted = r.completed >= MIN_COMPLETED_FOR_MAX;
  const rates = r.started >= MIN_STARTED_FOR_RATES;
  return {
    bucketStart: bucket.toISOString(),
    started: r.started,
    completed: r.completed,
    discarded: r.discarded,
    httpErrors: r.http_errors,
    networkErrors: r.network_errors,
    timeouts: r.timeouts,
    over29s: r.over29s,
    meanMs: hasCompleted ? r.mean_ms : null,
    maxMs: hasCompleted ? r.max_ms : null,
    p95Ms: p95ok ? r.p95_ms : null,
    p95Status: p95ok ? 'ok' : 'muestra_insuficiente',
    errorRate: rates ? (r.http_errors + r.network_errors + r.timeouts) / r.started : null,
    timeoutRate: rates ? r.timeouts / r.started : null,
    quality: r.started + r.discarded === 0 ? 'sin_datos' : p95ok ? 'suficiente' : 'insuficiente',
  };
}
