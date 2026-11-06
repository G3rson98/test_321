/**
 * Cancelación (RF-EJE-03, ESP §13.3) y timeouts de corrida.
 * - `requestCancel`: idempotente; marca durable `cancel_requested_at`, revoca despacho nuevo (shards no reclamados y
 *   entregas `run.dispatch_shard` pendientes), notifica al supervisor por Redis pub/sub (canal de control) y por la
 *   respuesta del heartbeat. Tests no iniciados ⇒ `cancelado`; resultados persistidos se conservan.
 * - `enforceCancelDeadlines`: si a los 30 s el worker no confirmó la detención, revoca sus credenciales (lease), cierra
 *   la corrida como `cancelada` y deja constancia auditada de que la detención no pudo confirmarse.
 * - `enforceRunTimeouts`: corrida que agota su timeout congelado ⇒ detener (señal) e `interrumpida/timeout_corrida`.
 *
 * Contrato con el supervisor (docs/decisiones.md): canal `<QUEUE_PREFIX>:runs:control`, mensajes JSON
 * `RunControlMessage` (`cancel` | `revoke`). La recuperación nunca reactiva una corrida cancelada.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CANCEL_DEADLINE_MS, KatalystError, reasonText, type ResultReason } from '@katalyst/shared';
import type { Principal } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { publishEvent, runInTransaction } from '../lib/events-publish.js';
import { releaseShardCapacity } from './capacity.js';
import { bumpRun, finalizeRun, getRunSummary, isTerminalRun, settleRunIfDone, snapshotOf } from './results.js';

type Db = Prisma.TransactionClient;

export interface RunControlMessage {
  type: 'cancel' | 'revoke';
  runId: string;
  shardIds: string[];
  leaseIds: string[];
  reason: ResultReason | string;
  requestedAt: string;
  /** Instante límite para tener detenido el árbol de procesos (≤ 30 s desde la aceptación). */
  deadlineAt: string;
}

export function runControlChannel(prefix: string): string {
  return `${prefix}:runs:control`;
}

export type ControlPublisher = (msg: RunControlMessage) => Promise<void>;

export function redisControlPublisher(redis: Redis, prefix: string): ControlPublisher {
  const channel = runControlChannel(prefix);
  return async (msg) => {
    try {
      if (redis.status === 'wait') await redis.connect();
      await redis.publish(channel, JSON.stringify(msg));
    } catch {
      // Redis es transporte: el heartbeat (`cancelRequested`) y la revocación del lease garantizan el efecto.
    }
  };
}

export interface CancelDeps {
  prisma: PrismaClient;
  logger: Logger;
  publicBaseUrl: string;
  publishControl: ControlPublisher;
}

async function activeLeases(tx: Db, runId: string) {
  return tx.workerLease.findMany({
    where: { runShard: { runId }, revokedAt: null, releasedAt: null },
    select: { id: true, runShardId: true },
  });
}

/** `POST /runs/{id}/cancel`. Dos cancelaciones tienen el mismo efecto. */
export async function requestCancel(
  deps: CancelDeps,
  runId: string,
  actor: Principal | 'system',
  opts: { reason?: string; requestId?: string; cause?: ResultReason } = {},
  now: Date = new Date(),
) {
  const cause: ResultReason = opts.cause ?? 'cancelado_por_usuario';
  const res = await runInTransaction(deps.prisma, async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM run WHERE id = ${runId}::uuid FOR NO KEY UPDATE`;
    if (locked.length === 0) throw new KatalystError('NOT_FOUND');
    const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
    if (isTerminalRun(run.status)) {
      if (run.status === 'cancelada') return { changed: false, leases: [] as { id: string; runShardId: string }[] };
      throw new KatalystError('RUN_NOT_CANCELLABLE');
    }
    if (run.cancelRequestedAt) return { changed: false, leases: await activeLeases(tx, runId) };

    await bumpRun(tx, runId, { cancelRequestedAt: now, reason: cause });
    // Revocar despacho nuevo: shards sin lease y entregas de despacho pendientes.
    const unclaimed = await tx.runShard.findMany({
      where: { runId, status: { in: ['pendiente', 'asignado'] } },
      select: { id: true },
    });
    for (const s of unclaimed) {
      await tx.runShard.update({ where: { id: s.id }, data: { status: 'cancelado', updatedAt: now } });
      await releaseShardCapacity(tx, s.id, now);
      await tx.runResult.updateMany({
        where: { runShardId: s.id, status: { in: ['pendiente', 'corriendo'] } },
        data: { status: 'cancelado', reason: cause, reasonText: reasonText(cause), ownerLeaseId: null },
      });
    }
    await tx.outboxDelivery.updateMany({
      where: { runId, operation: 'run.dispatch_shard', status: 'pendiente' },
      data: { status: 'cancelada', lastError: 'corrida cancelada' },
    });
    // Tests aún no iniciados de shards en curso: el worker recibe `proceed=false` al intentar iniciarlos y la
    // finalización los deja `cancelado`.
    await recordAudit(tx, {
      actor,
      action: 'run.cancel',
      entity: 'run',
      entityId: runId,
      diff: { reason: opts.reason ?? null, cause, previousStatus: run.status },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    });
    const leases = await activeLeases(tx, runId);
    if (leases.length === 0) {
      await settleRunIfDone(tx, runId, now, deps.publicBaseUrl);
      // Corrida sin shards (todo bloqueado no llega aquí) o con todos los shards ya cerrados.
      const after = await tx.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
      if (!isTerminalRun(after.status)) {
        await finalizeRun(tx, { runId, terminal: 'cancelada', reason: cause, now, publicBaseUrl: deps.publicBaseUrl });
      }
    } else {
      await bumpRun(tx, runId, { status: 'cancelando' });
    }
    return { changed: true, leases };
  });
  if (res.changed && res.leases.length > 0) {
    await deps.publishControl({
      type: 'cancel',
      runId,
      shardIds: [...new Set(res.leases.map((l) => l.runShardId))],
      leaseIds: res.leases.map((l) => l.id),
      reason: cause,
      requestedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + CANCEL_DEADLINE_MS).toISOString(),
    });
  }
  const run = await getRunSummary(deps.prisma, runId);
  const remaining = await deps.prisma.workerLease.count({
    where: { runShard: { runId }, revokedAt: null, releasedAt: null },
  });
  return { run, stopConfirmed: remaining === 0 };
}

/** Watchdog: cancelaciones sin confirmación del worker a los 30 s ⇒ revocar credenciales y cerrar con constancia. */
export async function enforceCancelDeadlines(deps: CancelDeps, now: Date = new Date()): Promise<string[]> {
  const runs = await deps.prisma.run.findMany({
    where: { status: 'cancelando', cancelRequestedAt: { lte: new Date(now.getTime() - CANCEL_DEADLINE_MS) } },
    select: { id: true },
    take: 50,
  });
  const closed: string[] = [];
  for (const r of runs) {
    const leases = await runInTransaction(deps.prisma, async (tx) => {
      const run = await tx.run.findUniqueOrThrow({ where: { id: r.id } });
      if (run.status !== 'cancelando') return null;
      const active = await activeLeases(tx, r.id);
      if (active.length) {
        await tx.workerLease.updateMany({ where: { id: { in: active.map((l) => l.id) } }, data: { revokedAt: now } });
      }
      await recordAudit(tx, {
        actor: 'system',
        action: 'run.cancel_unconfirmed',
        entity: 'run',
        entityId: r.id,
        diff: {
          message: 'No se pudo confirmar la detención del worker dentro de 30 s; credenciales del lease revocadas.',
          revokedLeases: active.length,
        },
      });
      for (const l of active) {
        await publishEvent(tx, {
          type: 'shard.updated',
          entity: 'run_shard',
          entityId: l.runShardId,
          version: 0,
          runId: r.id,
          environmentId: run.environmentId,
          data: { status: 'cancelado', event: 'detencion_no_confirmada' },
        });
      }
      await finalizeRun(tx, {
        runId: r.id,
        terminal: 'cancelada',
        reason: run.reason ?? 'cancelado_por_usuario',
        now,
        publicBaseUrl: deps.publicBaseUrl,
      });
      return active;
    });
    if (leases) {
      closed.push(r.id);
      if (leases.length) {
        await deps.publishControl({
          type: 'revoke',
          runId: r.id,
          shardIds: [...new Set(leases.map((l) => l.runShardId))],
          leaseIds: leases.map((l) => l.id),
          reason: 'detencion_no_confirmada',
          requestedAt: now.toISOString(),
          deadlineAt: now.toISOString(),
        });
      }
    }
  }
  return closed;
}

/** Corridas activas que superan su timeout congelado (20 min funcional / 4 min rendimiento) ⇒ interrumpidas. */
export async function enforceRunTimeouts(deps: CancelDeps, now: Date = new Date()): Promise<string[]> {
  const runs = await deps.prisma.run.findMany({
    where: { status: { in: ['preparando', 'corriendo', 'finalizando'] }, startedAt: { not: null } },
    select: { id: true, startedAt: true, selectionSnapshot: true },
    take: 200,
  });
  const out: string[] = [];
  for (const r of runs) {
    const limit = snapshotOf(r).timeouts.runMs;
    if (!r.startedAt || r.startedAt.getTime() + limit > now.getTime()) continue;
    const leases = await runInTransaction(deps.prisma, async (tx) => {
      const active = await activeLeases(tx, r.id);
      if (active.length) {
        await tx.workerLease.updateMany({ where: { id: { in: active.map((l) => l.id) } }, data: { revokedAt: now } });
      }
      const ok = await finalizeRun(tx, {
        runId: r.id,
        terminal: 'interrumpida',
        reason: 'timeout_corrida',
        now,
        publicBaseUrl: deps.publicBaseUrl,
      });
      return ok ? active : null;
    });
    if (leases) {
      out.push(r.id);
      if (leases.length) {
        await deps.publishControl({
          type: 'cancel',
          runId: r.id,
          shardIds: [...new Set(leases.map((l) => l.runShardId))],
          leaseIds: leases.map((l) => l.id),
          reason: 'timeout_corrida',
          requestedAt: now.toISOString(),
          deadlineAt: now.toISOString(),
        });
      }
    }
  }
  return out;
}
