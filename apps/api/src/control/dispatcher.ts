/**
 * Despacho de shards a BullMQ (ESP §13.3, §13.5; plan §4.3). Cola `run-shards` (prefijo `QUEUE_PREFIX`); cada trabajo
 * transporta SOLO `ShardJobPayload {runId, shardId}`; el supervisor reclama el lease por la API.
 * - Las entregas `run.dispatch_shard` se crean en la outbox dentro de la transacción de admisión. Se procesan por dos
 *   caminos idempotentes: el handler registrado en el publicador genérico de outbox y un camino rápido propio
 *   (`dispatchPendingDeliveries`, ~1 s). El `jobId` derivado de la entrega impide trabajos duplicados.
 * - `redispatchStaleShards` (reconciliación tras reinicio de Redis/supervisor): shard `asignado` sin lease durante
 *   > 60 s ⇒ nueva entrega de despacho; > 5 min ⇒ libera la reserva y vuelve a admisión.
 * RF-EJE-04, RF-EJE-08, RNF-CON-04, RNF-OBS-01.
 */
import { randomUUID } from 'node:crypto';
import type { OutboxDelivery, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Gauge } from 'prom-client';
import { ShardJobPayloadSchema, type ShardJobPayload } from '@katalyst/shared';
import { enqueueOutbox, registerOutboxHandler, type OutboxHandlerResult } from '../lib/outbox.js';
import { metricsRegistry, registerMetricsCollector } from '../lib/metrics.js';
import { runInTransaction } from '../lib/events-publish.js';
import { releaseShardCapacity } from '../services/capacity.js';

export const RUN_SHARDS_QUEUE = 'run-shards';
export const SHARD_JOB_NAME = 'shard';

export function shardJobId(shardId: string, deliveryId: string): string {
  return `shard-${shardId}-${deliveryId}`;
}

/** Opciones de conexión BullMQ desde `REDIS_URL` (`maxRetriesPerRequest: null`, requisito de BullMQ). */
export function bullConnectionFromUrl(redisUrl: string, opts: { failFast?: boolean } = {}): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    ...(opts.failFast ? { enableOfflineQueue: false, connectTimeout: 2_000 } : {}),
  };
}

export function createShardQueue(connection: ConnectionOptions, prefix: string): Queue<ShardJobPayload> {
  return new Queue<ShardJobPayload>(RUN_SHARDS_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } },
  });
}

export type ShardQueue = Pick<Queue<ShardJobPayload>, 'add' | 'getJob' | 'getJobCounts'>;

/** Publica un trabajo para la entrega; `cancelled` si el shard ya no espera despacho. */
export async function dispatchDelivery(
  prisma: PrismaClient,
  queue: ShardQueue,
  d: Pick<OutboxDelivery, 'id' | 'payload'>,
): Promise<OutboxHandlerResult> {
  const parsed = ShardJobPayloadSchema.safeParse(d.payload);
  if (!parsed.success) return { kind: 'intervention', error: 'payload de despacho inválido' };
  const shard = await prisma.runShard.findUnique({
    where: { id: parsed.data.shardId },
    select: { status: true, runId: true, run: { select: { status: true, cancelRequestedAt: true } } },
  });
  if (!shard || shard.runId !== parsed.data.runId) return { kind: 'cancelled', reason: 'shard inexistente' };
  if (shard.status !== 'asignado' || shard.run.cancelRequestedAt) {
    return { kind: 'cancelled', reason: `shard en estado ${shard.status}` };
  }
  const jobId = shardJobId(parsed.data.shardId, d.id);
  try {
    await queue.add(SHARD_JOB_NAME, { runId: parsed.data.runId, shardId: parsed.data.shardId }, { jobId });
  } catch (err) {
    return { kind: 'retry', error: err instanceof Error ? err.message : 'redis no disponible' };
  }
  return { kind: 'delivered', externalId: jobId };
}

/** Registra el handler en el publicador genérico de outbox (API-A). */
export function registerDispatchHandler(prisma: PrismaClient, queue: ShardQueue): void {
  registerOutboxHandler('run.dispatch_shard', (d) => dispatchDelivery(prisma, queue, d), { timeoutMs: 15_000 });
}

/** Camino rápido: procesa entregas de despacho pendientes con `FOR UPDATE SKIP LOCKED`. */
export async function dispatchPendingDeliveries(
  prisma: PrismaClient,
  queue: ShardQueue,
  now: Date = new Date(),
  limit = 50,
): Promise<{ delivered: number; cancelled: number; retried: number }> {
  const stats = { delivered: 0, cancelled: 0, retried: 0 };
  const lockUntil = new Date(now.getTime() + 60_000);
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    WITH c AS (
      SELECT id FROM outbox_delivery
       WHERE operation = 'run.dispatch_shard' AND status = 'pendiente' AND next_attempt_at <= ${now}
       ORDER BY next_attempt_at, created_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE outbox_delivery o SET status = 'en_proceso', attempts = o.attempts + 1, locked_until = ${lockUntil},
           locked_by = 'dispatcher', updated_at = ${now}
      FROM c WHERE o.id = c.id
    RETURNING o.id::text AS id`;
  for (const { id } of claimed) {
    const d = await prisma.outboxDelivery.findUniqueOrThrow({ where: { id } });
    const r = await dispatchDelivery(prisma, queue, d);
    if (r.kind === 'delivered') {
      stats.delivered++;
      await prisma.outboxDelivery.update({
        where: { id },
        data: { status: 'entregada', externalId: r.externalId ?? null, lockedUntil: null, lockedBy: null, nextAttemptAt: null },
      });
    } else if (r.kind === 'cancelled' || r.kind === 'intervention') {
      stats.cancelled++;
      await prisma.outboxDelivery.update({
        where: { id },
        data: {
          status: r.kind === 'cancelled' ? 'cancelada' : 'requiere_intervencion',
          lastError: r.kind === 'cancelled' ? r.reason : r.error,
          lockedUntil: null,
          lockedBy: null,
          nextAttemptAt: null,
        },
      });
    } else {
      stats.retried++;
      await prisma.outboxDelivery.update({
        where: { id },
        data: {
          status: 'pendiente',
          lastError: r.kind === 'retry' ? r.error.slice(0, 500) : 'diferida',
          lockedUntil: null,
          lockedBy: null,
          nextAttemptAt: new Date(now.getTime() + 5_000),
        },
      });
    }
  }
  return stats;
}

export const REDISPATCH_AFTER_MS = 60_000;
export const READMIT_AFTER_MS = 5 * 60_000;

/**
 * Reconciliación de despacho: shards asignados que nadie reclamó (Redis reiniciado, supervisor caído, trabajo
 * perdido). PostgreSQL es la fuente de verdad; la cola se reconstruye.
 */
export async function redispatchStaleShards(
  prisma: PrismaClient,
  now: Date = new Date(),
  logger?: Logger,
): Promise<{ redispatched: number; readmitted: number }> {
  const stale = await prisma.runShard.findMany({
    where: {
      status: 'asignado',
      updatedAt: { lt: new Date(now.getTime() - REDISPATCH_AFTER_MS) },
      run: { status: { in: ['en_cola', 'preparando', 'corriendo'] }, cancelRequestedAt: null },
      leases: { none: { revokedAt: null, releasedAt: null } },
    },
    select: { id: true, runId: true, updatedAt: true },
    take: 100,
  });
  const out = { redispatched: 0, readmitted: 0 };
  for (const s of stale) {
    const pending = await prisma.outboxDelivery.count({
      where: { operation: 'run.dispatch_shard', runId: s.runId, status: { in: ['pendiente', 'en_proceso'] }, payload: { path: ['shardId'], equals: s.id } },
    });
    if (pending > 0) continue;
    await runInTransaction(prisma, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM run_shard WHERE id = ${s.id}::uuid AND status = 'asignado' FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return;
      if (now.getTime() - s.updatedAt.getTime() > READMIT_AFTER_MS) {
        await releaseShardCapacity(tx, s.id, now);
        await tx.runShard.update({ where: { id: s.id }, data: { status: 'pendiente', updatedAt: now } });
        out.readmitted++;
        return;
      }
      await enqueueOutbox(tx, {
        operation: 'run.dispatch_shard',
        dedupKey: `run.dispatch_shard:${s.id}:${randomUUID()}`,
        payload: { runId: s.runId, shardId: s.id },
        runId: s.runId,
      });
      await tx.runShard.update({ where: { id: s.id }, data: { updatedAt: now } });
      out.redispatched++;
    });
  }
  if (logger && (out.redispatched || out.readmitted)) logger.warn(out, 'reconciliación de despacho');
  return out;
}

const bullJobs = new Gauge({
  name: 'katalyst_bullmq_jobs',
  help: 'Trabajos de la cola run-shards por estado (RNF-OBS-01)',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

export function registerQueueMetrics(queue: ShardQueue): void {
  registerMetricsCollector('bullmq_run_shards', async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    for (const [state, n] of Object.entries(counts)) bullJobs.set({ state }, n);
  });
}
