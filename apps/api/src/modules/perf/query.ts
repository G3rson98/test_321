/**
 * Consultas del panel de rendimiento (RF-REN-02, RF-REN-04, RF-REN-05; ESP §7, §13.8, §17.4).
 * - Series separadas por ambiente, endpoint/pantalla, procedencia, origen, tipo de métrica, caché y perfil.
 * - Dentro de la retención de crudos (90 días): media/máx/p95 sobre muestras crudas (p95 por rango, por bucket).
 * - Fuera de ella: solo métricas conservadas en `perf_hourly_aggregate`; p95 `no_disponible` (no se promedian).
 * - Máx. 1.000 puntos por serie: granularidad explícita (`chooseGranularity`) devuelta en la respuesta.
 * - Huecos y antigüedad del último dato: falta de muestras no equivale a sistema sano.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  bucketCount,
  bucketStart,
  chooseGranularity,
  KatalystError,
  mergeAggregates,
  normalizeEndpointKey,
  normalizeScreenKey,
  seriesKey,
  MAX_POINTS_PER_SERIES,
  type IntervalAggregate,
  type PerfGranularity,
  type PerfPoint,
  type PerfQuery,
  type SeriesDimensions,
} from '@katalyst/shared';
import { apiCSettings } from '../recordings/settings.js';
import {
  aggregateFilterSql,
  HTTP_ERROR_SQL,
  intervalFor,
  pointFromRaw,
  rawFilterSql,
  SERIES_COLUMNS,
  SERIES_GROUP,
  STATS_COLUMNS,
  type SeriesDimsRow,
  type SeriesFilter,
  type StatsRow,
} from './sql.js';

type Db = PrismaClient | Prisma.TransactionClient;
export const MAX_SERIES_PER_QUERY = 100;
const DAY_MS = 86_400_000;

export interface PerfSeriesOut {
  key: SeriesDimensions;
  points: PerfPoint[];
  comparison: PerfPoint[] | null;
}

export interface PerfResponseOut {
  granularity: PerfGranularity;
  series: PerfSeriesOut[];
  marks: {
    id: string;
    ts: string;
    label: string;
    environmentId: string;
    frontendVersion: string | null;
    backendVersion: string | null;
    createdBy: { id: string | null; kind: 'panel_user' | 'api_credential' | 'servicio' | 'sistema'; displayName: string };
    createdAt: string;
  }[];
  lastSampleAt: string | null;
  gaps: { from: string; to: string }[];
}

/** Primer instante con crudos completos: inicio del día UTC siguiente al corte de retención. */
export function rawRetentionStart(now: Date, retentionDays = apiCSettings().PERF_RAW_RETENTION_DAYS): Date {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return new Date(Math.floor(cutoff / DAY_MS) * DAY_MS + DAY_MS);
}

function dimsOf(r: SeriesDimsRow): SeriesDimensions {
  return {
    environmentId: r.environment_id,
    endpointKey: r.endpoint_key,
    provenance: r.provenance,
    source: r.source,
    metricKind: r.metric_kind,
    cacheMode: r.cache_mode,
    workerProfile: r.worker_profile === '' ? null : r.worker_profile,
  };
}

export function filterFromQuery(q: Pick<PerfQuery, 'environmentId' | 'endpoint' | 'screen' | 'provenance' | 'source' | 'metricKind' | 'cacheMode' | 'workerProfile'>): SeriesFilter {
  const f: SeriesFilter = { environmentId: q.environmentId };
  if (q.endpoint) {
    const e = q.endpoint.trim();
    const keys = new Set<string>([e]);
    if (!/^[A-Z]{3,10} /.test(e)) keys.add(normalizeEndpointKey(e));
    f.endpointKeys = [...keys];
  }
  if (q.screen) f.screenKey = normalizeScreenKey(q.screen);
  if (q.provenance) f.provenance = q.provenance;
  if (q.source) f.source = q.source;
  if (q.metricKind) f.metricKind = q.metricKind;
  if (q.cacheMode) f.cacheMode = q.cacheMode;
  if (q.workerProfile !== undefined) f.workerProfile = q.workerProfile;
  return f;
}

/** Estadísticas crudas por serie y bucket en `[from, to)`. */
export async function rawBuckets(
  db: Db,
  f: SeriesFilter,
  from: Date,
  to: Date,
  g: PerfGranularity,
): Promise<(SeriesDimsRow & StatsRow & { bucket: Date })[]> {
  if (to <= from) return [];
  return db.$queryRaw<(SeriesDimsRow & StatsRow & { bucket: Date })[]>`
    SELECT ${SERIES_COLUMNS},
      date_bin(${intervalFor(g)}::interval, ts, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket,
      ${STATS_COLUMNS}
    FROM perf_sample
    WHERE ${rawFilterSql(f)} AND ts >= ${from} AND ts < ${to}
    GROUP BY ${SERIES_GROUP}, bucket
    ORDER BY endpoint_key, bucket`;
}

interface AggRow extends SeriesDimsRow {
  bucket_start: Date;
  started: number;
  completed: number;
  discarded: number;
  sum_ms: number;
  sum_sq_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  http_errors: number;
  network_errors: number;
  timeouts: number;
  over_29s: number;
}

async function aggregateRows(db: Db, f: SeriesFilter, from: Date, to: Date): Promise<AggRow[]> {
  if (to <= from) return [];
  return db.$queryRaw<AggRow[]>`
    SELECT environment_id::text AS environment_id, endpoint_key, provenance::text AS provenance,
      source::text AS source, metric_kind::text AS metric_kind, cache_mode::text AS cache_mode, worker_profile,
      bucket_start, started, completed, discarded, sum_ms, sum_sq_ms, min_ms, max_ms, http_errors, network_errors,
      timeouts, over_29s
    FROM perf_hourly_aggregate
    WHERE ${aggregateFilterSql(f)} AND bucket_start >= ${from} AND bucket_start < ${to}
    ORDER BY endpoint_key, bucket_start`;
}

function pointFromAggregates(bucket: Date, rows: IntervalAggregate[]): PerfPoint {
  const m = mergeAggregates(rows);
  return {
    bucketStart: bucket.toISOString(),
    started: m.started,
    completed: m.completed,
    discarded: m.discarded,
    httpErrors: m.httpErrors,
    networkErrors: m.networkErrors,
    timeouts: m.timeouts,
    over29s: m.over29s,
    meanMs: m.mean,
    maxMs: m.max,
    p95Ms: null,
    p95Status: 'no_disponible',
    errorRate: m.errorRate,
    timeoutRate: m.timeoutRate,
    quality: m.started + m.discarded === 0 ? 'sin_datos' : 'insuficiente',
  };
}

/** Puntos por serie para un período (crudos dentro de retención + agregados fuera). */
export async function seriesPoints(
  db: Db,
  f: SeriesFilter,
  from: Date,
  to: Date,
  g: PerfGranularity,
  now: Date,
): Promise<Map<string, { dims: SeriesDimensions; points: PerfPoint[] }>> {
  const rawFrom = rawRetentionStart(now);
  const out = new Map<string, { dims: SeriesDimensions; points: PerfPoint[] }>();
  const add = (dims: SeriesDimensions, p: PerfPoint) => {
    const k = seriesKey(dims);
    let s = out.get(k);
    if (!s) out.set(k, (s = { dims, points: [] }));
    s.points.push(p);
  };
  // Fuera de retención: agregados horarios re-agrupados a la granularidad pedida.
  const aggTo = from < rawFrom ? (to < rawFrom ? to : rawFrom) : from;
  const agg = await aggregateRows(db, f, from, aggTo);
  const groups = new Map<string, { dims: SeriesDimensions; bucket: Date; rows: IntervalAggregate[] }>();
  for (const r of agg) {
    const dims = dimsOf(r);
    const b = bucketStart(r.bucket_start, g === 'minute' ? 'hour' : g);
    const k = `${seriesKey(dims)}@${b.getTime()}`;
    let grp = groups.get(k);
    if (!grp) groups.set(k, (grp = { dims, bucket: b, rows: [] }));
    grp.rows.push({
      dims,
      bucketStart: r.bucket_start,
      granularity: 'hour',
      started: r.started,
      completed: r.completed,
      discarded: r.discarded,
      sumMs: r.sum_ms,
      sumSqMs: r.sum_sq_ms,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      httpErrors: r.http_errors,
      networkErrors: r.network_errors,
      timeouts: r.timeouts,
      over29s: r.over_29s,
    });
  }
  for (const grp of groups.values()) add(grp.dims, pointFromAggregates(grp.bucket, grp.rows));
  // Dentro de retención: crudos.
  const raw = await rawBuckets(db, f, from > rawFrom ? from : rawFrom, to, g);
  for (const r of raw) add(dimsOf(r), pointFromRaw(r.bucket, r));
  for (const s of out.values()) s.points.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  return out;
}

async function lastSampleAt(db: Db, f: SeriesFilter): Promise<Date | null> {
  const raw = await db.$queryRaw<{ last: Date | null }[]>`
    SELECT max(ts) AS last FROM perf_sample WHERE ${rawFilterSql(f)}`;
  if (raw[0]?.last) return raw[0].last;
  const agg = await db.$queryRaw<{ last: Date | null }[]>`
    SELECT max(bucket_start) AS last FROM perf_hourly_aggregate WHERE ${aggregateFilterSql(f)}`;
  return agg[0]?.last ? new Date(agg[0].last.getTime() + 3_600_000) : null;
}

/** Huecos: intervalos sin muestras mayores al umbral (ESP §13.8). */
export async function findGaps(
  db: Db,
  f: SeriesFilter,
  from: Date,
  to: Date,
  now: Date,
  thresholdMin = apiCSettings().PERF_GAP_THRESHOLD_MIN,
): Promise<{ from: string; to: string }[]> {
  const end = to < now ? to : now;
  if (end <= from) return [];
  const th = thresholdMin * 60_000;
  const rawFrom = rawRetentionStart(now);
  const gaps: { from: Date; to: Date }[] = [];
  // Parte agregada: horas sin fila.
  if (from < rawFrom) {
    const aggEnd = end < rawFrom ? end : rawFrom;
    const rows = await db.$queryRaw<{ b: Date }[]>`
      SELECT DISTINCT bucket_start AS b FROM perf_hourly_aggregate
      WHERE ${aggregateFilterSql(f)} AND bucket_start >= ${bucketStart(from, 'hour')} AND bucket_start < ${aggEnd}
      ORDER BY b`;
    let cursor = from.getTime();
    for (const r of rows) {
      if (r.b.getTime() - cursor >= Math.max(th, 3_600_000)) gaps.push({ from: new Date(cursor), to: r.b });
      cursor = r.b.getTime() + 3_600_000;
    }
    if (aggEnd.getTime() - cursor >= Math.max(th, 3_600_000)) gaps.push({ from: new Date(cursor), to: aggEnd });
  }
  const rawStart = from > rawFrom ? from : rawFrom;
  if (end > rawStart) {
    const inner = await db.$queryRaw<{ prev: Date; ts: Date }[]>`
      SELECT prev, ts FROM (
        SELECT ts, lag(ts) OVER (ORDER BY ts) AS prev FROM perf_sample
        WHERE ${rawFilterSql(f)} AND ts >= ${rawStart} AND ts < ${end}
      ) x WHERE prev IS NOT NULL AND ts - prev > ${`${thresholdMin} minutes`}::interval
      ORDER BY ts LIMIT 500`;
    const bounds = await db.$queryRaw<{ first: Date | null; last: Date | null }[]>`
      SELECT min(ts) AS first, max(ts) AS last FROM perf_sample
      WHERE ${rawFilterSql(f)} AND ts >= ${rawStart} AND ts < ${end}`;
    const first = bounds[0]?.first ?? null;
    const last = bounds[0]?.last ?? null;
    if (!first || !last) {
      gaps.push({ from: rawStart, to: end });
    } else {
      if (first.getTime() - rawStart.getTime() > th) gaps.push({ from: rawStart, to: first });
      for (const g of inner) gaps.push({ from: g.prev, to: g.ts });
      if (end.getTime() - last.getTime() > th) gaps.push({ from: last, to: end });
    }
  }
  // Fusionar adyacentes.
  gaps.sort((a, b) => a.from.getTime() - b.from.getTime());
  const merged: { from: Date; to: Date }[] = [];
  for (const g of gaps) {
    const prev = merged[merged.length - 1];
    if (prev && g.from.getTime() <= prev.to.getTime()) {
      if (g.to > prev.to) prev.to = g.to;
    } else merged.push({ ...g });
  }
  return merged.slice(0, 500).map((g) => ({ from: g.from.toISOString(), to: g.to.toISOString() }));
}

export function resolveGranularity(from: Date, to: Date, requested: PerfGranularity, now: Date): PerfGranularity {
  if (bucketCount(from, to, 'day') > MAX_POINTS_PER_SERIES) throw new KatalystError('PERF_RANGE_TOO_LARGE');
  let g = chooseGranularity(from, to, requested);
  if (g === 'minute' && from < rawRetentionStart(now)) g = 'hour';
  return g;
}

/** `GET /perf`. */
export async function getPerf(db: Db, q: PerfQuery, now = new Date()): Promise<PerfResponseOut> {
  const from = new Date(q.from);
  const to = new Date(q.to);
  const g = resolveGranularity(from, to, q.by, now);
  const f = filterFromQuery(q);
  const current = await seriesPoints(db, f, from, to, g, now);
  let previous: Map<string, { dims: SeriesDimensions; points: PerfPoint[] }> | null = null;
  if (q.compare === 'previous_period') {
    const d = to.getTime() - from.getTime();
    previous = await seriesPoints(db, f, new Date(from.getTime() - d), from, g, now);
  }
  const keys = [...new Set([...current.keys(), ...(previous?.keys() ?? [])])].sort().slice(0, MAX_SERIES_PER_QUERY);
  const series: PerfSeriesOut[] = keys.map((k) => {
    const cur = current.get(k);
    const prev = previous?.get(k);
    return {
      key: (cur ?? prev)!.dims,
      points: (cur?.points ?? []).slice(0, MAX_POINTS_PER_SERIES),
      comparison: previous ? (prev?.points ?? []).slice(0, MAX_POINTS_PER_SERIES) : null,
    };
  });
  const marks = await db.eventMark.findMany({
    where: { environmentId: q.environmentId, ts: { gte: from, lt: to } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    take: 500,
    include: { createdBy: { select: { id: true, name: true } } },
  });
  const last = await lastSampleAt(db, f);
  return {
    granularity: g,
    series,
    marks: marks.map((m) => ({
      id: m.id,
      ts: m.ts.toISOString(),
      label: m.label,
      environmentId: m.environmentId,
      frontendVersion: m.frontendVersion,
      backendVersion: m.backendVersion,
      createdBy: m.createdBy
        ? { id: m.createdBy.id, kind: 'panel_user' as const, displayName: m.createdBy.name }
        : { id: null, kind: 'sistema' as const, displayName: 'sistema' },
      createdAt: m.createdAt.toISOString(),
    })),
    lastSampleAt: last ? last.toISOString() : null,
    gaps: await findGaps(db, f, from, to, now),
  };
}

/** `GET /perf/series`: series disponibles (crudos dentro de retención) con conteo y último dato. */
export async function listSeries(
  db: Db,
  q: { environmentId: string; q?: string | undefined; limit: number; cursor?: string | undefined },
  now = new Date(),
): Promise<{
  items: (SeriesDimensions & { sampleCount: number; lastSampleAt: string })[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const since = new Date(now.getTime() - apiCSettings().PERF_RAW_RETENTION_DAYS * DAY_MS);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db.$queryRaw<(SeriesDimsRow & { n: number; last: Date })[]>`
    SELECT ${SERIES_COLUMNS}, count(*)::int AS n, max(ts) AS last
    FROM perf_sample
    WHERE environment_id = ${q.environmentId}::uuid AND ts >= ${since}
      ${like ? Prisma.sql`AND endpoint_key ILIKE ${like}` : Prisma.empty}
    GROUP BY ${SERIES_GROUP}
    ORDER BY endpoint_key, provenance, source, metric_kind, cache_mode, coalesce(worker_profile, '')
    LIMIT 5000`;
  const all = rows.map((r) => ({ ...dimsOf(r), sampleCount: r.n, lastSampleAt: r.last.toISOString() }));
  const start = q.cursor ? Math.max(0, all.findIndex((s) => seriesKey(s) === q.cursor) + 1) : 0;
  const page = all.slice(start, start + q.limit);
  const hasNext = start + q.limit < all.length;
  return { items: page, hasNext, nextCursor: hasNext && page.length ? seriesKey(page[page.length - 1]!) : null };
}

export type PerfErrorKindOut = 'http_error' | 'network_error' | 'timeout' | 'over_29s';

/** `GET /perf/errors` (RF-REN-05): errores HTTP, de red, timeouts y > 29 s con hora exacta. */
export async function listPerfErrors(
  db: Db,
  q: {
    environmentId: string;
    from: string;
    to: string;
    kind?: PerfErrorKindOut | undefined;
    endpoint?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<{
  items: {
    id: string;
    ts: string;
    runId: string;
    endpointKey: string;
    provenance: SeriesDimensions['provenance'];
    source: SeriesDimensions['source'];
    kind: PerfErrorKindOut;
    statusCode: number | null;
    totalMs: number | null;
    censoredAtMs: number | null;
  }[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const f = filterFromQuery({ environmentId: q.environmentId, endpoint: q.endpoint });
  const httpErr = Prisma.sql`(NOT timeout AND NOT network_error AND ${HTTP_ERROR_SQL})`;
  const kindCond: Record<PerfErrorKindOut, Prisma.Sql> = {
    timeout: Prisma.sql`timeout`,
    network_error: Prisma.sql`(NOT timeout AND network_error)`,
    http_error: httpErr,
    over_29s: Prisma.sql`over_29s`,
  };
  const cond = q.kind
    ? kindCond[q.kind]
    : Prisma.sql`(${kindCond.timeout} OR ${kindCond.network_error} OR ${kindCond.http_error} OR ${kindCond.over_29s})`;
  let after: { ts: Date; id: string } | null = null;
  if (q.cursor) {
    const [t, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
    if (!t || !id || Number.isNaN(Date.parse(t)) || !/^[0-9a-f-]{36}$/.test(id)) {
      throw new KatalystError('VALIDATION_FAILED', 'Cursor inválido para este filtro u orden.');
    }
    after = { ts: new Date(t), id };
  }
  const rows = await db.$queryRaw<
    {
      id: string;
      ts: Date;
      run_id: string;
      endpoint_key: string;
      provenance: SeriesDimensions['provenance'];
      source: SeriesDimensions['source'];
      timeout: boolean;
      network_error: boolean;
      over_29s: boolean;
      http_error: boolean;
      status_code: number | null;
      total_ms: number | null;
      censored_at_ms: number | null;
    }[]
  >`
    SELECT id::text AS id, ts, run_id::text AS run_id, endpoint_key, provenance::text AS provenance,
      source::text AS source, timeout, network_error, over_29s, ${httpErr} AS http_error, status_code, total_ms,
      censored_at_ms
    FROM perf_sample
    WHERE ${rawFilterSql(f)} AND invalid_reason IS NULL AND ts >= ${new Date(q.from)} AND ts < ${new Date(q.to)}
      AND ${cond}
      ${after ? Prisma.sql`AND (ts, id) < (${after.ts}, ${after.id}::uuid)` : Prisma.empty}
    ORDER BY ts DESC, id DESC
    LIMIT ${q.limit + 1}`;
  const hasNext = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const kindOf = (r: (typeof rows)[number]): PerfErrorKindOut =>
    q.kind ?? (r.timeout ? 'timeout' : r.network_error ? 'network_error' : r.http_error ? 'http_error' : 'over_29s');
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      runId: r.run_id,
      endpointKey: r.endpoint_key,
      provenance: r.provenance,
      source: r.source,
      kind: kindOf(r),
      statusCode: r.status_code,
      totalMs: r.total_ms,
      censoredAtMs: r.censored_at_ms,
    })),
    hasNext,
    nextCursor: hasNext && last ? Buffer.from(`${last.ts.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}
