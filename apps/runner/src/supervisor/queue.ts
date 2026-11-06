/**
 * Transporte: BullMQ `run-shards` y `catalog-listing` (payload mínimo, entrega al menos una vez; Redis es
 * reconstruible, PostgreSQL es la fuente de verdad — ESP §4, §13.3) y Redis pub/sub de cancelación.
 * Canal de control (contrato de API-B, `apps/api/src/services/cancellation.ts`): `<QUEUE_PREFIX>:runs:control` con
 * `RunControlMessage {type:'cancel'|'revoke', runId, shardIds, leaseIds, reason, requestedAt, deadlineAt}`.
 * Se acepta además `{runId}` o el UUID plano como cancelación de toda la corrida.
 * BullMQ no requiere CONFIG/ACL (bloqueados en el Redis de producción).
 */
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { UuidSchema } from '@katalyst/shared';
import type { Logger } from '../logger.js';
import type { CancelRegistry } from './cancel-registry.js';

export function redisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export interface QueueWorkerOptions {
  redisUrl: string;
  prefix: string;
  queueName: string;
  concurrency: number;
  logger: Logger;
  handler: (data: unknown, job: Job) => Promise<unknown>;
}

export function startQueueWorker(o: QueueWorkerOptions): Worker {
  const connection = redisConnection(o.redisUrl);
  const worker = new Worker(o.queueName, (job) => o.handler(job.data, job), {
    connection,
    prefix: o.prefix,
    concurrency: o.concurrency,
    // El permiso se mantiene mientras el ejecutor corre (lock renovado por BullMQ).
    lockDuration: 60_000,
    maxStalledCount: 1,
  });
  worker.on('failed', (job, err) => o.logger.warn({ queue: o.queueName, jobId: job?.id, err: err.message }, 'trabajo fallido (BullMQ reintentará según su política)'));
  worker.on('error', (err) => o.logger.error({ queue: o.queueName, err: err.message }, 'error del worker BullMQ'));
  return worker;
}

export interface ControlMessage {
  type: 'cancel' | 'revoke';
  runId: string;
  shardIds: string[];
  leaseIds: string[];
  /** Motivo informado por la API (p. ej. `cancelado_por_usuario`, `timeout_corrida`, `lease_vencido`). */
  reason: string | null;
  /** Límite para tener detenido el árbol de procesos (epoch ms; `null` si no vino o no es válido). */
  deadlineAtMs: number | null;
}

const ControlMessageSchema = z.object({
  type: z.enum(['cancel', 'revoke']).default('cancel'),
  runId: UuidSchema,
  shardIds: z.array(UuidSchema).max(1000).default([]),
  leaseIds: z.array(UuidSchema).max(1000).default([]),
  reason: z.string().max(200).nullish(),
  requestedAt: z.string().max(64).nullish(),
  deadlineAt: z.string().max(64).nullish(),
});

/** Parseo del mensaje de control (RunControlMessage, `{runId}` o UUID plano). `null` si es inválido. */
export function parseControlMessage(message: string): ControlMessage | null {
  let candidate: unknown = message.trim();
  try {
    candidate = JSON.parse(message) as unknown;
  } catch {
    // UUID plano
  }
  if (typeof candidate === 'string') candidate = { runId: candidate };
  const r = ControlMessageSchema.safeParse(candidate);
  if (!r.success) return null;
  const deadline = r.data.deadlineAt ? Date.parse(r.data.deadlineAt) : Number.NaN;
  return {
    type: r.data.type,
    runId: r.data.runId,
    shardIds: r.data.shardIds,
    leaseIds: r.data.leaseIds,
    reason: r.data.reason ?? null,
    deadlineAtMs: Number.isFinite(deadline) ? deadline : null,
  };
}

/** Compatibilidad: solo el `runId` de una cancelación. */
export function parseCancelMessage(message: string): string | null {
  const m = parseControlMessage(message);
  return m && m.type === 'cancel' ? m.runId : null;
}

export class CancelSubscriber {
  private redis: Redis | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly channel: string,
    private readonly registry: CancelRegistry,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const redis = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.redis = redis;
    redis.on('message', (channel: string, message: string) => {
      if (channel !== this.channel) return;
      const m = parseControlMessage(message);
      if (!m) {
        this.logger.warn('mensaje de control inválido ignorado');
        return;
      }
      const n =
        m.type === 'cancel'
          ? this.registry.cancelRun(m.runId, m.shardIds, m.deadlineAtMs)
          : this.registry.revoke(m.runId, m.shardIds, m.leaseIds);
      this.logger.warn({ runId: m.runId, type: m.type, reason: m.reason, shards: n }, 'mensaje de control recibido (pub/sub)');
    });
    await redis.subscribe(this.channel);
  }

  async stop(): Promise<void> {
    if (!this.redis) return;
    await this.redis.quit().catch(() => undefined);
    this.redis = null;
  }
}
