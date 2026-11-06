/**
 * Resúmenes horarios y retención de rendimiento (ESP §7): crudos 90 días, `perf_hourly_aggregate` 365 días.
 * - Rollup horario idempotente: recalcula desde crudos las últimas 48 h completas (UPSERT): incorpora importaciones
 *   tardías recientes; nunca la hora en curso.
 * - Antes de borrar crudos vencidos se completan (sin sobrescribir) los agregados de esas horas.
 * - Borrado por lotes (sin bloquear la tabla), luego agregados > 365 días.
 * - Los agregados conservan dimensiones, conteos, sumas, mín/máx y errores/timeouts; sin URL cruda ni p95.
 * Además (mantenimiento horario de API-C): vence sesiones de grabación > 2 h y exportaciones vencidas.
 * Lo invoca `main.control.ts` (API-B). RF-REN-02, ESP §13.8.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { OVER_29S_THRESHOLD_MS } from '@katalyst/shared';
import { apiCSettings } from '../modules/recordings/settings.js';
import { HTTP_ERROR_SQL } from '../modules/perf/sql.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function floorHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** Agrega crudos de `[from, to)` por serie y hora. `mode=upsert` recalcula; `fill` solo inserta horas faltantes. */
export async function rollupPerfHours(
  db: PrismaClient | Prisma.TransactionClient,
  from: Date,
  to: Date,
  mode: 'upsert' | 'fill' = 'upsert',
): Promise<number> {
  if (to <= from) return 0;
  const completed = Prisma.sql`(invalid_reason IS NULL AND NOT timeout AND NOT network_error AND total_ms IS NOT NULL)`;
  const conflict =
    mode === 'upsert'
      ? Prisma.sql`DO UPDATE SET started = EXCLUDED.started, completed = EXCLUDED.completed,
          discarded = EXCLUDED.discarded, sum_ms = EXCLUDED.sum_ms, sum_sq_ms = EXCLUDED.sum_sq_ms,
          min_ms = EXCLUDED.min_ms, max_ms = EXCLUDED.max_ms, http_errors = EXCLUDED.http_errors,
          network_errors = EXCLUDED.network_errors, timeouts = EXCLUDED.timeouts, over_29s = EXCLUDED.over_29s,
          updated_at = EXCLUDED.updated_at`
      : Prisma.sql`DO NOTHING`;
  return db.$executeRaw`
    INSERT INTO perf_hourly_aggregate (id, environment_id, endpoint_key, provenance, source, metric_kind, cache_mode,
      worker_profile, bucket_start, started, completed, discarded, sum_ms, sum_sq_ms, min_ms, max_ms, http_errors,
      network_errors, timeouts, over_29s, created_at, updated_at)
    SELECT gen_random_uuid(), environment_id, endpoint_key, provenance, source, metric_kind, cache_mode,
      coalesce(worker_profile, ''), date_bin('1 hour'::interval, ts, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
      count(*) FILTER (WHERE invalid_reason IS NULL),
      count(*) FILTER (WHERE ${completed}),
      count(*) FILTER (WHERE invalid_reason IS NOT NULL),
      coalesce(sum(total_ms) FILTER (WHERE ${completed}), 0),
      coalesce(sum(total_ms * total_ms) FILTER (WHERE ${completed}), 0),
      min(total_ms) FILTER (WHERE ${completed}),
      max(total_ms) FILTER (WHERE ${completed}),
      count(*) FILTER (WHERE invalid_reason IS NULL AND NOT timeout AND NOT network_error AND ${HTTP_ERROR_SQL}),
      count(*) FILTER (WHERE invalid_reason IS NULL AND NOT timeout AND network_error),
      count(*) FILTER (WHERE invalid_reason IS NULL AND timeout),
      count(*) FILTER (WHERE ${completed} AND total_ms > ${OVER_29S_THRESHOLD_MS}),
      now(), now()
    FROM perf_sample
    WHERE ts >= ${from} AND ts < ${to}
    GROUP BY environment_id, endpoint_key, provenance, source, metric_kind, cache_mode, coalesce(worker_profile, ''),
      date_bin('1 hour'::interval, ts, TIMESTAMPTZ '1970-01-01 00:00:00+00')
    ON CONFLICT (environment_id, endpoint_key, provenance, source, metric_kind, cache_mode, worker_profile, bucket_start)
    ${conflict}`;
}

export interface PurgeResult {
  filledAggregates: number;
  deletedSamples: number;
  deletedAggregates: number;
}

/** Retención: completa agregados de las horas a borrar y elimina crudos > N días en lotes. */
export async function purgePerfData(
  prisma: PrismaClient,
  now: Date,
  opts: { batchSize?: number; maxBatches?: number; rawDays?: number; aggregateDays?: number } = {},
): Promise<PurgeResult> {
  const s = apiCSettings();
  const cutoff = new Date(now.getTime() - (opts.rawDays ?? s.PERF_RAW_RETENTION_DAYS) * DAY_MS);
  const oldest = await prisma.perfSample.findFirst({ where: { ts: { lt: cutoff } }, orderBy: { ts: 'asc' }, select: { ts: true } });
  let filled = 0;
  let deleted = 0;
  if (oldest) {
    // La hora que contiene el corte se agrega completa antes de borrar parte de ella.
    filled = await rollupPerfHours(prisma, floorHour(oldest.ts), new Date(floorHour(cutoff).getTime() + HOUR_MS), 'fill');
    const batch = opts.batchSize ?? 5000;
    for (let i = 0; i < (opts.maxBatches ?? 200); i++) {
      const n = await prisma.$executeRaw`
        DELETE FROM perf_sample WHERE id IN (
          SELECT id FROM perf_sample WHERE ts < ${cutoff} ORDER BY ts LIMIT ${batch})`;
      deleted += n;
      if (n < batch) break;
    }
  }
  const aggCutoff = new Date(now.getTime() - (opts.aggregateDays ?? s.PERF_AGGREGATE_RETENTION_DAYS) * DAY_MS);
  const deletedAggregates = await prisma.$executeRaw`
    DELETE FROM perf_hourly_aggregate WHERE bucket_start < ${aggCutoff}`;
  return { filledAggregates: filled, deletedSamples: deleted, deletedAggregates };
}

export interface RollupTickResult extends PurgeResult {
  upserted: number;
  expiredRecordings: number;
  expiredExports: number;
}

/** Un ciclo horario: rollup de 48 h, retención y mantenimiento de grabaciones/exportaciones. */
export async function runPerfRollup(deps: { prisma: PrismaClient; logger?: Logger; now?: Date }): Promise<RollupTickResult> {
  const now = deps.now ?? new Date();
  const end = floorHour(now);
  const upserted = await rollupPerfHours(deps.prisma, new Date(end.getTime() - 48 * HOUR_MS), end, 'upsert');
  const purge = await purgePerfData(deps.prisma, now);
  const { expireRecordingSessions } = await import('../modules/recordings/service.js');
  const { purgeExpiredExports } = await import('../modules/exports/service.js');
  const expiredRecordings = await expireRecordingSessions(deps.prisma, now);
  const expiredExports = await purgeExpiredExports(deps.prisma, now);
  return { upserted, ...purge, expiredRecordings, expiredExports };
}

/** Bucle para `main.control.ts`: cada hora (por defecto), hasta `signal`. */
export async function perfRollupLoop(
  deps: { prisma: PrismaClient; logger?: Logger },
  opts: { intervalMs?: number; signal?: AbortSignal; onTick?: () => void } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? HOUR_MS;
  while (!opts.signal?.aborted) {
    try {
      const r = await runPerfRollup(deps);
      deps.logger?.info({ ...r }, 'rollup de rendimiento');
    } catch (err) {
      deps.logger?.error({ err }, 'rollup de rendimiento fallido');
    }
    opts.onTick?.();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
