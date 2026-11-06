/**
 * Publicación de eventos de dominio (plan §4.4, ESP §17.2, RNF-OPT-04).
 * - `publishEvent` persiste en `event_log` (seq BIGSERIAL = id SSE / Last-Event-ID) DENTRO de la transacción del
 *   cambio de estado: PostgreSQL es la fuente de verdad; SSE nunca lo es (ESP §13.2).
 * - Tras el commit se notifica por Redis pub/sub (`<QUEUE_PREFIX>:events`) con `{seq, type, entity, entityId,
 *   runId, environmentId}` (sin `data`): los suscriptores leen `event_log` por seq. Si la transacción no se creó con
 *   `runInTransaction`, la notificación se difiere (best effort); el SSE debe además sondear `event_log` como respaldo.
 * - `data` se sanitiza antes de persistir.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { sanitizeJson, type EventEntity, type EventType } from '@katalyst/shared';

export interface DomainEventInput {
  type: EventType;
  entity: EventEntity;
  entityId: string;
  version: number;
  data: unknown;
  /** Corrida relacionada (filtro por recurso en SSE). */
  runId?: string | null;
  environmentId?: string | null;
}

export interface EventNotification {
  seq: number;
  type: EventType;
  entity: EventEntity;
  entityId: string;
  runId: string | null;
  environmentId: string | null;
}

interface Notifier {
  redis: Redis;
  channel: string;
}
let notifier: Notifier | undefined;

export const DEFAULT_EVENTS_CHANNEL = 'katalyst:events';

/** Configura el canal Redis de notificación (lo llama app.ts / main.control.ts). */
export function configureEventNotifier(n: { redis: Redis; channel?: string } | undefined): void {
  notifier = n ? { redis: n.redis, channel: n.channel ?? DEFAULT_EVENTS_CHANNEL } : undefined;
}

export function eventsChannel(): string {
  return notifier?.channel ?? DEFAULT_EVENTS_CHANNEL;
}

const pendingByTx = new WeakMap<object, EventNotification[]>();

async function notify(items: EventNotification[]): Promise<void> {
  const n = notifier;
  if (!n || items.length === 0) return;
  try {
    if (n.redis.status === 'wait') await n.redis.connect();
    for (const item of items) await n.redis.publish(n.channel, JSON.stringify(item));
  } catch {
    // Redis es transporte reconstruible: el SSE recupera por seq desde event_log.
  }
}

export async function publishEvent(tx: Prisma.TransactionClient, e: DomainEventInput): Promise<void> {
  const { value } = sanitizeJson(e.data ?? {}, { maxDepth: 16 });
  const data = (value && typeof value === 'object' && !Array.isArray(value) ? value : { value }) as Prisma.InputJsonValue;
  const row = await tx.eventLog.create({
    data: {
      type: e.type,
      entity: e.entity,
      entityId: e.entityId,
      version: e.version,
      runId: e.runId ?? null,
      environmentId: e.environmentId ?? null,
      data,
    },
    select: { seq: true },
  });
  const item: EventNotification = {
    seq: Number(row.seq),
    type: e.type,
    entity: e.entity,
    entityId: e.entityId,
    runId: e.runId ?? null,
    environmentId: e.environmentId ?? null,
  };
  const pending = pendingByTx.get(tx as object);
  if (pending) pending.push(item);
  else setTimeout(() => void notify([item]), 250).unref();
}

/**
 * `prisma.$transaction` que notifica los eventos publicados SOLO tras el commit (si hace rollback no se notifica).
 */
export async function runInTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  let collected: EventNotification[] = [];
  const result = await prisma.$transaction(async (tx) => {
    collected = [];
    pendingByTx.set(tx as object, collected);
    return fn(tx);
  }, opts);
  await notify(collected);
  return result;
}

/** Suscripción a notificaciones (para SSE). Usa una conexión Redis dedicada (modo subscriber). */
export async function subscribeEvents(
  subscriber: Redis,
  onEvent: (n: EventNotification) => void,
  channel: string = eventsChannel(),
): Promise<() => Promise<void>> {
  if (subscriber.status === 'wait') await subscriber.connect();
  const handler = (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      onEvent(JSON.parse(message) as EventNotification);
    } catch {
      // mensaje inválido: ignorar
    }
  };
  subscriber.on('message', handler);
  await subscriber.subscribe(channel);
  return async () => {
    subscriber.off('message', handler);
    await subscriber.unsubscribe(channel);
  };
}
