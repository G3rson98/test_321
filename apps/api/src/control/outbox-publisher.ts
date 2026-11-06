/**
 * Publicador genérico de outbox (proceso de control) — ESP §13.4, RF-TR-08, RNF-CON-02.
 * - Reclama entregas `pendiente` vencidas con `FOR UPDATE SKIP LOCKED` (varias réplicas sin doble proceso) y respeta
 *   el orden por destino: una entrega espera a sus predecesoras (`target_id`, `sequence` menor) mientras estén
 *   pendientes/en proceso, o en falla terminal si son bloqueantes (crear corrida, resultados). Un destino degradado no
 *   bloquea a otros destinos.
 * - Backoff exponencial con jitter (D-021), máximo 1 h; vencimiento 24 h → `vencida`; `Retry-After` prevalece.
 * - 401/403/validación → `requiere_intervencion` (lo decide el handler) sin bucle infinito.
 * - Persistencia: el estado vive en PostgreSQL; un proceso caído con entregas `en_proceso` las libera al vencer
 *   `locked_until` marcándolas ambiguas (`[ambiguo]`): el siguiente intento reconcilia antes de repetir.
 * - Reintento administrativo auditado (`adminRetryDelivery`): reconcilia contra el destino antes de reenviar.
 */
import { randomUUID } from 'node:crypto';
import type { OutboxDelivery, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { KatalystError, OUTBOX_RETRY_POLICY, outboxBackoffMs, sanitizeErrorMessage } from '@katalyst/shared';
import {
  AMBIGUOUS_MARK,
  getOutboxHandler,
  registeredOutboxOperations,
  type OutboxCtx,
  type OutboxHandlerResult,
  type ReconciliationOutcome,
} from '../lib/outbox.js';
import { recordAudit } from '../lib/audit.js';
import type { Principal } from '../lib/auth.js';
import { metrics, opFamily, registerMetricsCollector } from '../lib/metrics.js';
import type { SecretProvider } from '../lib/secrets.js';

/** Operaciones cuya falla terminal impide continuar con las siguientes del mismo destino. */
export const BLOCKING_OPERATIONS = ['testrail.add_run', 'testrail.add_results_for_cases'] as const;

export interface OutboxPublisherDeps {
  prisma: PrismaClient;
  logger: Logger;
  secrets: SecretProvider;
  workerId?: string;
  random?: () => number;
  batchSize?: number;
  /** Duración del bloqueo de una entrega en proceso (default 5 min). */
  lockMs?: number;
  /** Límite de operaciones a procesar (pruebas). Por defecto todas las registradas. */
  operations?: readonly string[];
}

export interface OutboxTickStats {
  claimed: number;
  delivered: number;
  retried: number;
  intervention: number;
  expired: number;
  deferred: number;
  cancelled: number;
  recovered: number;
}

type TerminalStatus = 'entregada' | 'requiere_intervencion' | 'vencida' | 'cancelada';

async function callTerminal(tx: Prisma.TransactionClient, d: OutboxDelivery, status: TerminalStatus): Promise<void> {
  const h = getOutboxHandler(d.operation);
  if (h?.onTerminal) await h.onTerminal(tx, d, status);
}

function cleanError(e: string): string {
  return sanitizeErrorMessage(e, 2000);
}

/** Un tick del publicador. Devuelve estadísticas (para pruebas y logs). */
export async function runOutboxPublisherTick(deps: OutboxPublisherDeps, now: Date = new Date()): Promise<OutboxTickStats> {
  const { prisma, logger } = deps;
  const workerId = deps.workerId ?? `control-${process.pid}`;
  const random = deps.random ?? Math.random;
  const lockMs = deps.lockMs ?? 5 * 60_000;
  const ops = (deps.operations ?? registeredOutboxOperations()).filter((o) => getOutboxHandler(o));
  const stats: OutboxTickStats = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    intervention: 0,
    expired: 0,
    deferred: 0,
    cancelled: 0,
    recovered: 0,
  };
  if (ops.length === 0) return stats;

  // 1. Entregas en proceso con bloqueo vencido (proceso caído): volver a pendiente como ambiguas.
  const recovered = await prisma.$executeRaw`
    UPDATE "outbox_delivery"
       SET "status" = 'pendiente', "locked_until" = NULL, "locked_by" = NULL, "updated_at" = ${now},
           "last_error" = ${AMBIGUOUS_MARK} || ' proceso interrumpido durante el intento'
     WHERE "status" = 'en_proceso' AND "locked_until" < ${now} AND "operation" = ANY(${ops})`;
  stats.recovered = recovered;

  // 2. Vencidas (24 h) → terminal.
  await prisma.$transaction(async (tx) => {
    const expired = await tx.outboxDelivery.findMany({
      where: { status: 'pendiente', expiresAt: { lte: now }, operation: { in: ops } },
      take: 500,
    });
    for (const d of expired) {
      await tx.outboxDelivery.update({
        where: { id: d.id },
        data: { status: 'vencida', nextAttemptAt: null, lastError: d.lastError ?? 'vencida sin entregar (24 h)' },
      });
      await callTerminal(tx, d, 'vencida');
      metrics.outboxDeliveries.inc({ family: opFamily(d.operation), result: 'vencida' });
    }
    stats.expired = expired.length;
  });

  // 3. Reclamar lote respetando el orden por destino.
  const lockUntil = new Date(now.getTime() + lockMs);
  const blocking = [...BLOCKING_OPERATIONS] as string[];
  const claimedIds = await prisma.$queryRaw<{ id: string }[]>`
    WITH c AS (
      SELECT d."id" FROM "outbox_delivery" d
       WHERE d."status" = 'pendiente' AND d."next_attempt_at" <= ${now} AND d."expires_at" > ${now}
         AND d."operation" = ANY(${ops})
         AND NOT EXISTS (
           SELECT 1 FROM "outbox_delivery" p
            WHERE d."target_id" IS NOT NULL AND p."target_id" = d."target_id" AND p."sequence" < d."sequence"
              AND (p."status" IN ('pendiente', 'en_proceso')
                   OR (p."status" IN ('requiere_intervencion', 'vencida') AND p."operation" = ANY(${blocking}))))
       ORDER BY d."next_attempt_at", d."sequence", d."created_at"
       LIMIT ${deps.batchSize ?? 20}
       FOR UPDATE OF d SKIP LOCKED)
    UPDATE "outbox_delivery" o
       SET "status" = 'en_proceso', "attempts" = o."attempts" + 1, "locked_until" = ${lockUntil},
           "locked_by" = ${workerId}, "updated_at" = ${now}
      FROM c WHERE o."id" = c."id"
    RETURNING o."id"::text AS "id"`;
  stats.claimed = claimedIds.length;
  if (claimedIds.length === 0) return stats;
  const claimed = await prisma.outboxDelivery.findMany({
    where: { id: { in: claimedIds.map((c) => c.id) } },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  });

  for (const d of claimed) {
    const h = getOutboxHandler(d.operation)!;
    const ac = new AbortController();
    const timeoutMs = h.timeoutMs ?? 120_000;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const ctx: OutboxCtx = {
      prisma,
      logger: logger.child({ deliveryId: d.id, operation: d.operation, runId: d.runId ?? undefined }),
      secrets: deps.secrets,
      now,
      attempt: d.attempts,
      previousAmbiguous: (d.lastError ?? '').startsWith(AMBIGUOUS_MARK),
      signal: ac.signal,
    };
    const t0 = performance.now();
    let result: OutboxHandlerResult;
    try {
      result = await Promise.race([
        h.handle(d, ctx),
        new Promise<OutboxHandlerResult>((resolve) =>
          ac.signal.addEventListener('abort', () =>
            resolve({ kind: 'retry', error: 'timeout del intento', ambiguous: true }),
          ),
        ),
      ]);
    } catch (e) {
      // Excepción no controlada: conservador (puede haberse aplicado).
      result = { kind: 'retry', error: e instanceof Error ? e.message : String(e), ambiguous: true };
    } finally {
      clearTimeout(timer);
    }
    metrics.outboxAttemptDuration.observe({ family: opFamily(d.operation) }, (performance.now() - t0) / 1000);
    await applyResult(prisma, d, result, { now, workerId, random, stats });
    ctx.logger.info({ result: result.kind, attempt: d.attempts }, 'entrega de outbox procesada');
  }
  return stats;
}

async function applyResult(
  prisma: PrismaClient,
  d: OutboxDelivery,
  result: OutboxHandlerResult,
  o: { now: Date; workerId: string; random: () => number; stats: OutboxTickStats },
): Promise<void> {
  const family = opFamily(d.operation);
  const owned = { id: d.id, status: 'en_proceso' as const, lockedBy: o.workerId };
  const unlock = { lockedUntil: null, lockedBy: null };
  await prisma.$transaction(async (tx) => {
    switch (result.kind) {
      case 'delivered': {
        const n = await tx.outboxDelivery.updateMany({
          where: owned,
          data: {
            ...unlock,
            status: 'entregada',
            nextAttemptAt: null,
            externalId: result.externalId ?? d.externalId,
            lastError: null,
          },
        });
        if (n.count > 0) await callTerminal(tx, { ...d, externalId: result.externalId ?? d.externalId }, 'entregada');
        o.stats.delivered++;
        break;
      }
      case 'retry': {
        const delay = outboxBackoffMs(d.attempts, o.random, result.retryAfterMs);
        const next = new Date(o.now.getTime() + delay);
        const err = `${result.ambiguous ? `${AMBIGUOUS_MARK} ` : ''}${cleanError(result.error)}`;
        if (next >= d.expiresAt) {
          const n = await tx.outboxDelivery.updateMany({
            where: owned,
            data: { ...unlock, status: 'vencida', nextAttemptAt: null, lastError: err, lastHttpStatus: result.httpStatus ?? null },
          });
          if (n.count > 0) await callTerminal(tx, d, 'vencida');
          o.stats.expired++;
        } else {
          await tx.outboxDelivery.updateMany({
            where: owned,
            data: { ...unlock, status: 'pendiente', nextAttemptAt: next, lastError: err, lastHttpStatus: result.httpStatus ?? null },
          });
          o.stats.retried++;
        }
        break;
      }
      case 'intervention': {
        const n = await tx.outboxDelivery.updateMany({
          where: owned,
          data: {
            ...unlock,
            status: 'requiere_intervencion',
            nextAttemptAt: null,
            lastError: cleanError(result.error),
            lastHttpStatus: result.httpStatus ?? null,
          },
        });
        if (n.count > 0) await callTerminal(tx, d, 'requiere_intervencion');
        o.stats.intervention++;
        break;
      }
      case 'defer': {
        await tx.outboxDelivery.updateMany({
          where: owned,
          data: {
            ...unlock,
            status: 'pendiente',
            attempts: Math.max(0, d.attempts - 1),
            nextAttemptAt: new Date(o.now.getTime() + Math.max(1_000, result.untilMs)),
          },
        });
        o.stats.deferred++;
        break;
      }
      case 'cancelled': {
        const n = await tx.outboxDelivery.updateMany({
          where: owned,
          data: { ...unlock, status: 'cancelada', nextAttemptAt: null, lastError: cleanError(result.reason) },
        });
        if (n.count > 0) await callTerminal(tx, d, 'cancelada');
        o.stats.cancelled++;
        break;
      }
    }
  });
  metrics.outboxDeliveries.inc({ family, result: result.kind });
}

// ---------------------------------------------------------------------------
// Reintento administrativo (POST /integrations/testrail/deliveries/{id}/retry)
// ---------------------------------------------------------------------------

export const ADMIN_RETRYABLE_STATUSES = ['requiere_intervencion', 'vencida', 'pendiente'] as const;

export async function adminRetryDelivery(
  deps: { prisma: PrismaClient; logger: Logger; secrets: SecretProvider },
  id: string,
  actor: Principal,
  opts: { note?: string; requestId?: string; now?: Date } = {},
): Promise<{ delivery: OutboxDelivery; reconciliation: ReconciliationOutcome['state'] }> {
  const now = opts.now ?? new Date();
  const d = await deps.prisma.outboxDelivery.findUnique({ where: { id } });
  if (!d) throw new KatalystError('NOT_FOUND');
  if (!(ADMIN_RETRYABLE_STATUSES as readonly string[]).includes(d.status)) {
    throw new KatalystError('DELIVERY_NOT_RETRYABLE');
  }
  const h = getOutboxHandler(d.operation);
  let outcome: ReconciliationOutcome = { state: 'no_aplicada' };
  if (h?.reconcile) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), h.timeoutMs ?? 60_000);
    try {
      outcome = await h.reconcile(d, {
        prisma: deps.prisma,
        logger: deps.logger.child({ deliveryId: d.id, operation: d.operation }),
        secrets: deps.secrets,
        now,
        attempt: d.attempts,
        previousAmbiguous: true,
        signal: ac.signal,
      });
    } catch (e) {
      outcome = { state: 'indeterminada', error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  const updated = await deps.prisma.$transaction(async (tx) => {
    let row: OutboxDelivery;
    if (outcome.state === 'ya_aplicada') {
      row = await tx.outboxDelivery.update({
        where: { id },
        data: {
          status: 'entregada',
          externalId: outcome.externalId ?? d.externalId,
          nextAttemptAt: null,
          lockedUntil: null,
          lockedBy: null,
          lastError: null,
        },
      });
      await callTerminal(tx, row, 'entregada');
    } else if (outcome.state === 'no_aplicada') {
      row = await tx.outboxDelivery.update({
        where: { id },
        data: {
          status: 'pendiente',
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + OUTBOX_RETRY_POLICY.expiresAfterMs),
          lockedUntil: null,
          lockedBy: null,
          // Reconciliado: el siguiente intento no es ambiguo.
          lastError: d.lastError ? cleanError(d.lastError.replace(AMBIGUOUS_MARK, '').trim()) : null,
        },
      });
    } else {
      row = await tx.outboxDelivery.update({
        where: { id },
        data: { lastError: cleanError(`reconciliación indeterminada: ${outcome.error ?? 'sin detalle'}`) },
      });
    }
    await recordAudit(tx, {
      actor,
      action: 'outbox_delivery.retry',
      entity: 'outbox_delivery',
      entityId: id,
      diff: { status: { from: d.status, to: row.status }, reconciliation: outcome.state, note: opts.note ?? null },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    });
    return row;
  });
  return { delivery: updated, reconciliation: outcome.state };
}

// ---------------------------------------------------------------------------
// Métricas y bucle
// ---------------------------------------------------------------------------

export function registerOutboxMetrics(prisma: PrismaClient): void {
  registerMetricsCollector('outbox', async () => {
    const now = new Date();
    const rows = await prisma.$queryRaw<{ family: string; n: bigint }[]>`
      SELECT split_part("operation", '.', 1) AS "family", count(*)::bigint AS "n"
        FROM "outbox_delivery" WHERE "status" IN ('pendiente', 'en_proceso') GROUP BY 1`;
    metrics.outboxPending.reset();
    for (const r of rows) metrics.outboxPending.set({ family: opFamily(`${r.family}.x`) }, Number(r.n));
    const overdue = await prisma.outboxDelivery.count({
      where: {
        OR: [
          { status: 'vencida', updatedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
          { status: 'pendiente', nextAttemptAt: { lt: new Date(now.getTime() - 3600_000) } },
        ],
      },
    });
    metrics.outboxOverdue.set(overdue);
    metrics.outboxIntervention.set(await prisma.outboxDelivery.count({ where: { status: 'requiere_intervencion' } }));
  });
}

/** Bucle de control (forma `ControlLoop` de main.control.ts). */
export function outboxPublisherLoop(deps: OutboxPublisherDeps, intervalMs: number) {
  const workerId = deps.workerId ?? `control-${process.pid}-${randomUUID().slice(0, 8)}`;
  return {
    name: 'publicador_outbox',
    intervalMs,
    tick: async ({ now }: { logger: Logger; now: Date }) => {
      const stats = await runOutboxPublisherTick({ ...deps, workerId }, now);
      if (stats.claimed > 0 || stats.expired > 0 || stats.recovered > 0) deps.logger.info({ stats }, 'outbox');
    },
  };
}
