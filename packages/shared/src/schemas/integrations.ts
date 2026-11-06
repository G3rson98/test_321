/**
 * Entregas de outbox (TestRail, notificaciones): visibles y reintentables con auditoría (ESP §13.4, RF-TR-08).
 * El reintento administrativo reconcilia antes de reenviar (ESP §9).
 */
import { z } from 'zod';
import { OutboxOperationSchema, OutboxStatusSchema } from '../enums.js';
import { CursorQuerySchema, IsoDateTimeSchema, UuidSchema } from './common.js';

export const OutboxDeliverySchema = z.object({
  id: UuidSchema,
  runId: UuidSchema.nullable(),
  targetId: UuidSchema.nullable(),
  operation: OutboxOperationSchema,
  dedupKey: z.string(),
  status: OutboxStatusSchema,
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema,
  externalId: z.string().nullable(),
  /** Error sanitizado. */
  lastError: z.string().nullable(),
  lastHttpStatus: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OutboxDelivery = z.infer<typeof OutboxDeliverySchema>;

export const DeliveryListQuerySchema = CursorQuerySchema.extend({
  status: z.union([OutboxStatusSchema, z.array(OutboxStatusSchema)]).optional(),
  operation: OutboxOperationSchema.optional(),
  runId: UuidSchema.optional(),
});

export const DeliveryRetryRequestSchema = z.object({
  /** Siempre se reconcilia contra TestRail antes de reenviar; `note` queda en auditoría. */
  note: z.string().trim().max(500).optional(),
});
export const DeliveryRetryResponseSchema = z.object({
  delivery: OutboxDeliverySchema,
  reconciliation: z.enum(['ya_aplicada', 'no_aplicada', 'indeterminada']),
});

/** Política de reintentos de outbox (ESP §13.4, RNF-CON-02). */
export const OUTBOX_RETRY_POLICY = {
  baseDelayMs: 5_000,
  maxDelayMs: 60 * 60 * 1000,
  expiresAfterMs: 24 * 60 * 60 * 1000,
  jitterRatio: 0.2,
} as const;

/** Siguiente espera con backoff exponencial y jitter acotado; `random` inyectable para pruebas. */
export function outboxBackoffMs(attempt: number, random: () => number = Math.random, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return Math.min(retryAfterMs, OUTBOX_RETRY_POLICY.maxDelayMs);
  const exp = Math.min(OUTBOX_RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1), OUTBOX_RETRY_POLICY.maxDelayMs);
  const jitter = exp * OUTBOX_RETRY_POLICY.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(Math.round(exp + jitter), OUTBOX_RETRY_POLICY.maxDelayMs));
}
