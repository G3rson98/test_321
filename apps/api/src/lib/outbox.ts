/**
 * Outbox durable transaccional (ESP §13.4, RF-TR-08, RNF-CON-02): las entregas externas (TestRail, despacho de shards,
 * notificaciones) se crean en la MISMA transacción que el cambio de estado y las procesa el publicador del proceso de
 * control (`src/control/outbox-publisher.ts`), que es genérico: cada área registra el handler de sus operaciones.
 *
 * - `enqueueOutbox` es idempotente por `dedupKey` (INSERT … ON CONFLICT DO NOTHING; no aborta la transacción).
 * - El `payload` debe llegar ya sanitizado y sin secretos (solo IDs/referencias); el publicador no lo modifica.
 * - Orden por destino (`targetId` + `sequence`): crear corrida → resultados → adjuntos → cerrar.
 */
import { randomUUID } from 'node:crypto';
import type { OutboxDelivery, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { OUTBOX_RETRY_POLICY, type OutboxOperation } from '@katalyst/shared';
import type { SecretProvider } from './secrets.js';

export type { OutboxDelivery };

export interface EnqueueOutboxInput {
  operation: OutboxOperation;
  dedupKey: string;
  payload: unknown;
  runId?: string;
  expiresAt?: Date;
  notBefore?: Date;
  /** Destino TestRail (`run_testrail_target.id`) para ordenar por destino. */
  targetId?: string;
  /** Orden dentro del destino (menor primero). */
  sequence?: number;
  alertId?: string;
}

export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  d: EnqueueOutboxInput,
): Promise<{ id: string; created: boolean }> {
  if (!d.dedupKey || d.dedupKey.length > 512) throw new TypeError('dedupKey inválida');
  const now = new Date();
  const id = randomUUID();
  const expiresAt = d.expiresAt ?? new Date(now.getTime() + OUTBOX_RETRY_POLICY.expiresAfterMs);
  const nextAttemptAt = d.notBefore ?? now;
  const payload = JSON.stringify(d.payload ?? {});
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "outbox_delivery"
      ("id", "run_id", "target_id", "alert_id", "operation", "dedup_key", "sequence", "payload", "status",
       "attempts", "next_attempt_at", "expires_at", "created_at", "updated_at")
    VALUES
      (${id}::uuid, ${d.runId ?? null}::uuid, ${d.targetId ?? null}::uuid, ${d.alertId ?? null}::uuid,
       ${d.operation}, ${d.dedupKey}, ${d.sequence ?? 0}, ${payload}::jsonb, 'pendiente'::"outbox_status",
       0, ${nextAttemptAt}, ${expiresAt}, ${now}, ${now})
    ON CONFLICT ("dedup_key") DO NOTHING
    RETURNING "id"::text AS "id"`;
  if (inserted.length > 0) return { id: inserted[0]!.id, created: true };
  const existing = await tx.outboxDelivery.findUnique({ where: { dedupKey: d.dedupKey }, select: { id: true } });
  if (!existing) throw new Error('outbox: conflicto de dedupKey sin fila visible');
  return { id: existing.id, created: false };
}

// ---------------------------------------------------------------------------
// Registro de handlers
// ---------------------------------------------------------------------------

export interface OutboxCtx {
  prisma: PrismaClient;
  logger: Logger;
  secrets: SecretProvider;
  now: Date;
  /** Nº de intento actual (1 = primero). Si > 1, el handler debe reconciliar antes de repetir (ESP §13.4). */
  attempt: number;
  /** El intento anterior terminó de forma ambigua (timeout tras enviar o proceso caído en `en_proceso`). */
  previousAmbiguous: boolean;
  signal: AbortSignal;
}

export type OutboxHandlerResult =
  /** Entregada (o reconciliada como ya aplicada). */
  | { kind: 'delivered'; externalId?: string | null; note?: string }
  /** Falla transitoria: reintentar con backoff (429 usa `retryAfterMs`). `ambiguous` si pudo haberse aplicado. */
  | { kind: 'retry'; error: string; httpStatus?: number; retryAfterMs?: number; ambiguous?: boolean }
  /** Falla permanente (401/403/validación) o indeterminable: requiere intervención (sin bucle infinito). */
  | { kind: 'intervention'; error: string; httpStatus?: number }
  /** Aún no procede (p. ej. depende de otra entrega): reprogramar sin contar intento. */
  | { kind: 'defer'; untilMs: number; reason: string }
  /** Ya no aplica (p. ej. destino cancelado): cerrar sin entregar. */
  | { kind: 'cancelled'; reason: string };

export type OutboxHandler = (delivery: OutboxDelivery, ctx: OutboxCtx) => Promise<OutboxHandlerResult>;

export type ReconciliationOutcome =
  | { state: 'ya_aplicada'; externalId?: string | null }
  | { state: 'no_aplicada' }
  | { state: 'indeterminada'; error?: string };

export interface OutboxHandlerOptions {
  /** Reconciliación previa a un reintento administrativo (ESP §9 "reconciliar antes de reenviar"). */
  reconcile?: (delivery: OutboxDelivery, ctx: OutboxCtx) => Promise<ReconciliationOutcome>;
  /** Hook al pasar a estado terminal (entregada, requiere_intervencion, vencida, cancelada). */
  onTerminal?: (
    tx: Prisma.TransactionClient,
    delivery: OutboxDelivery,
    status: 'entregada' | 'requiere_intervencion' | 'vencida' | 'cancelada',
  ) => Promise<void>;
  /** Timeout de un intento (default 120 s). */
  timeoutMs?: number;
}

export interface RegisteredHandler extends OutboxHandlerOptions {
  handle: OutboxHandler;
}

const handlers = new Map<OutboxOperation, RegisteredHandler>();

export function registerOutboxHandler(op: OutboxOperation, h: OutboxHandler, opts: OutboxHandlerOptions = {}): void {
  handlers.set(op, { handle: h, ...opts });
}

export function getOutboxHandler(op: string): RegisteredHandler | undefined {
  return handlers.get(op as OutboxOperation);
}

export function registeredOutboxOperations(): OutboxOperation[] {
  return [...handlers.keys()];
}

/** Solo pruebas. */
export function clearOutboxHandlers(): void {
  handlers.clear();
}

/** Marca de error para el intento ambiguo (persistida en `last_error`). */
export const AMBIGUOUS_MARK = '[ambiguo]';
