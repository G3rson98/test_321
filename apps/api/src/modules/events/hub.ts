/**
 * Concentrador de eventos SSE por proceso (ESP §17.2, plan §4.4; RF-EJE-02, RNF-OPT-04).
 * PostgreSQL (`event_log`, `seq`) es la fuente; Redis pub/sub (`<QUEUE_PREFIX>:events`, lib/events-publish) solo
 * despierta el sondeo. Un único sondeo por proceso (≤ 1 consulta/s con clientes conectados) reparte a todas las
 * conexiones: el costo no crece por pestaña. Si Redis cae, el sondeo periódico mantiene la entrega.
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { DomainEvent } from '@katalyst/shared';
import { subscribeEvents } from '../../lib/events-publish.js';

export type HubListener = (events: DomainEvent[]) => void;

interface EventRow {
  seq: bigint;
  type: string;
  entity: string;
  entityId: string;
  version: number;
  runId: string | null;
  environmentId: string | null;
  data: unknown;
  createdAt: Date;
}

export function toDomainEvent(r: EventRow): DomainEvent {
  const seq = Number(r.seq);
  return {
    id: String(seq),
    seq,
    type: r.type as DomainEvent['type'],
    entity: r.entity as DomainEvent['entity'],
    entityId: r.entityId,
    version: r.version,
    occurredAt: r.createdAt.toISOString(),
    runId: r.runId,
    environmentId: r.environmentId,
    data: (r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}) as Record<string, unknown>,
  };
}

export async function readEventsAfter(prisma: PrismaClient, afterSeq: number, limit = 500): Promise<DomainEvent[]> {
  const rows = await prisma.eventLog.findMany({
    where: { seq: { gt: BigInt(afterSeq) } },
    orderBy: { seq: 'asc' },
    take: limit,
  });
  return rows.map(toDomainEvent);
}

export async function currentSeq(prisma: PrismaClient): Promise<number> {
  const r = await prisma.eventLog.aggregate({ _max: { seq: true } });
  return Number(r._max.seq ?? 0n);
}

export async function minRetainedSeq(prisma: PrismaClient): Promise<number | null> {
  const r = await prisma.eventLog.aggregate({ _min: { seq: true } });
  return r._min.seq === null ? null : Number(r._min.seq);
}

export class EventHub {
  private listeners = new Set<HubListener>();
  private lastSeq: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private pending = false;
  private unsubscribe: (() => Promise<void>) | null = null;
  private subscriber: Redis | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: { redis?: Redis; channel?: string; pollMs?: number } = {},
  ) {}

  get size(): number {
    return this.listeners.size;
  }

  async subscribe(l: HubListener): Promise<() => void> {
    this.listeners.add(l);
    if (this.listeners.size === 1) await this.start();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  /** Último seq ya repartido (los clientes nuevos reproducen hasta aquí desde la BD). */
  async watermark(): Promise<number> {
    if (this.lastSeq === null) this.lastSeq = await currentSeq(this.prisma);
    return this.lastSeq;
  }

  private async start(): Promise<void> {
    await this.watermark();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 1000);
    this.timer.unref();
    if (this.opts.redis) {
      try {
        this.subscriber = this.opts.redis.duplicate({ lazyConnect: true });
        this.subscriber.on('error', () => undefined);
        this.unsubscribe = await subscribeEvents(this.subscriber, () => void this.poll(), this.opts.channel);
      } catch {
        this.subscriber?.disconnect();
        this.subscriber = null;
      }
    }
  }

  private async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const unsub = this.unsubscribe;
    this.unsubscribe = null;
    await unsub?.().catch(() => undefined);
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.lastSeq = null;
  }

  async poll(): Promise<void> {
    if (this.polling) {
      this.pending = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.pending = false;
        const after = await this.watermark();
        const events = await readEventsAfter(this.prisma, after);
        if (events.length) {
          this.lastSeq = events[events.length - 1]!.seq;
          for (const l of this.listeners) {
            try {
              l(events);
            } catch {
              // un consumidor roto no afecta a los demás
            }
          }
          if (events.length >= 500) this.pending = true;
        }
      } while (this.pending && this.listeners.size > 0);
    } catch {
      // BD momentáneamente no disponible: se reintenta en el próximo tick.
    } finally {
      this.polling = false;
    }
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.stop();
  }
}
