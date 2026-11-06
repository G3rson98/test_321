/**
 * Módulo events: SSE global `GET /events/stream` (un canal por pestaña, sesión por cookie, `Last-Event-ID`, snapshot
 * tras (re)conexión, eventos sanitizados con versión, autorización por recurso, sin tokens en query string) y la
 * alternativa acotada `GET /runs/{id}/events`. SSE nunca es fuente de verdad: los contadores se derivan de la BD.
 * RF-EJE-02, RNF-OPT-04, ESP §17.2.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ACTIVE_RUN_STATUSES,
  EventStreamQuerySchema,
  KatalystError,
  RunEventsParamsSchema,
  SSE_PING_INTERVAL_MS,
  type DomainEvent,
  type EventEntity,
  type Permission,
} from '@katalyst/shared';
import { hasPermission, isAdmin, principalUserId, routeGuard, type Principal } from '../../lib/auth.js';
import { eventsChannel } from '../../lib/events-publish.js';
import { getRunSummary } from '../../services/results.js';
import { EventHub, currentSeq, minRetainedSeq, readEventsAfter } from './hub.js';

type Topic = 'runs' | 'schedules' | 'alerts' | 'catalog' | 'testrail' | 'recordings' | 'exports' | 'generation';

const TOPIC_OF: Record<EventEntity, Topic> = {
  run: 'runs',
  run_result: 'runs',
  test_attempt: 'runs',
  run_shard: 'runs',
  case_result: 'runs',
  run_testrail_target: 'runs',
  schedule: 'schedules',
  schedule_occurrence: 'schedules',
  alert: 'alerts',
  catalog_revision: 'catalog',
  testrail_sync_run: 'testrail',
  recording_session: 'recordings',
  export_job: 'exports',
  generation_request: 'generation',
};

const TOPIC_PERMISSION: Record<Topic, Permission> = {
  runs: 'runs.read',
  schedules: 'schedules.read',
  alerts: 'alerts.read',
  catalog: 'catalog.read',
  testrail: 'testrail.read',
  recordings: 'recordings.read',
  exports: 'exports.create',
  generation: 'generate.create',
};
/** Temas con autorización por propietario (solo el creador o admin). */
const OWNER_TOPICS: ReadonlySet<Topic> = new Set(['recordings', 'exports', 'generation']);
export const MAX_STREAMS_PER_PRINCIPAL = 10;

/** ¿El principal puede recibir este evento? (autorización por recurso, RNF-SEG-03) */
export function canSee(p: Principal, e: DomainEvent): boolean {
  const topic = TOPIC_OF[e.entity];
  if (!topic || !hasPermission(p, TOPIC_PERMISSION[topic])) return false;
  if (OWNER_TOPICS.has(topic) && !isAdmin(p)) {
    const owner = e.data['ownerId'] ?? e.data['createdById'];
    return typeof owner === 'string' && owner === principalUserId(p);
  }
  return true;
}

function parseLastEventId(request: FastifyRequest): number | null {
  const raw = request.headers['last-event-id'];
  if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw)) return null;
  return Number(raw);
}

function write(reply: FastifyReply, chunk: string): boolean {
  return reply.raw.write(chunk);
}

function sendEvent(reply: FastifyReply, e: DomainEvent): void {
  write(reply, `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

function sendControl(reply: FastifyReply, event: 'snapshot' | 'ping' | 'reset', data: unknown): void {
  write(reply, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const openStreams = new Map<string, number>();
function principalKey(p: Principal): string {
  return `${p.kind}:${p.id}`;
}

export const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  const hub = new EventHub(app.deps.prisma, { redis: app.deps.redis, channel: eventsChannel() });
  app.addHook('onClose', async () => hub.close());

  async function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { topics: Set<Topic> | null; runId: string | null; snapshot: () => Promise<Record<string, unknown>> },
  ): Promise<void> {
    const p = request.principal;
    if (!p) throw new KatalystError('UNAUTHENTICATED');
    const key = principalKey(p);
    if ((openStreams.get(key) ?? 0) >= MAX_STREAMS_PER_PRINCIPAL) {
      throw new KatalystError('RATE_LIMITED', 'Demasiados canales de eventos abiertos.', { retryAfterSeconds: 30 });
    }
    openStreams.set(key, (openStreams.get(key) ?? 0) + 1);
    const visible = (e: DomainEvent) =>
      canSee(p, e) &&
      (opts.runId === null || e.runId === opts.runId) &&
      (opts.topics === null || opts.topics.has(TOPIC_OF[e.entity]));

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'x-request-id': request.requestId,
    });
    write(reply, 'retry: 3000\n\n');

    let sentSeq = 0;
    let closed = false;
    let buffer: DomainEvent[] | null = [];
    const deliver = (events: DomainEvent[]) => {
      if (closed) return;
      if (buffer) {
        buffer.push(...events);
        return;
      }
      for (const e of events) {
        if (e.seq <= sentSeq) continue;
        sentSeq = e.seq;
        if (visible(e)) sendEvent(reply, e);
      }
    };
    const unsubscribe = await hub.subscribe(deliver);
    const ping = setInterval(() => sendControl(reply, 'ping', { serverTime: new Date().toISOString() }), SSE_PING_INTERVAL_MS);
    ping.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      const n = (openStreams.get(key) ?? 1) - 1;
      if (n <= 0) openStreams.delete(key);
      else openStreams.set(key, n);
    };
    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    try {
      const lastEventId = parseLastEventId(request);
      const lastSeq = await currentSeq(app.deps.prisma);
      // Snapshot consistente tras (re)conexión: cubre huecos; luego solo eventos posteriores.
      sendControl(reply, 'snapshot', { lastSeq, serverTime: new Date().toISOString(), ...(await opts.snapshot()) });
      if (lastEventId !== null && lastEventId < lastSeq) {
        const min = await minRetainedSeq(app.deps.prisma);
        if (min !== null && lastEventId < min - 1) {
          sendControl(reply, 'reset', { reason: 'last_event_id_expirado', lastSeq });
          sentSeq = lastSeq;
        } else {
          let after = lastEventId;
          for (;;) {
            const batch = await readEventsAfter(app.deps.prisma, after, 500);
            for (const e of batch) {
              if (e.seq > lastSeq) break;
              if (visible(e)) sendEvent(reply, e);
              after = e.seq;
            }
            if (batch.length < 500 || after >= lastSeq) break;
          }
          sentSeq = lastSeq;
        }
      } else {
        sentSeq = lastSeq;
      }
      const queued = buffer;
      buffer = null;
      deliver(queued);
    } catch (err) {
      request.log.warn({ err }, 'SSE: error inicial');
      cleanup();
      reply.raw.end();
    }
  }

  async function activeRunIds(): Promise<string[]> {
    const rows = await app.deps.prisma.run.findMany({
      where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
      orderBy: { queuedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => r.id);
  }

  app.get(
    '/events/stream',
    {
      ...routeGuard('GET', '/events/stream'),
      config: { rateLimit: false },
      schema: { tags: ['events'], summary: 'SSE global (un canal por pestaña)', querystring: EventStreamQuerySchema },
    },
    async (request, reply) => {
      const topics = request.query.topics ? new Set(request.query.topics as Topic[]) : null;
      const p = request.principal!;
      await stream(request, reply, {
        topics,
        runId: null,
        snapshot: async () => ({ activeRunIds: hasPermission(p, 'runs.read') ? await activeRunIds() : [] }),
      });
    },
  );

  app.get(
    '/runs/:id/events',
    {
      ...routeGuard('GET', '/runs/:id/events'),
      config: { rateLimit: false },
      schema: { tags: ['events'], summary: 'SSE acotado a una corrida', params: RunEventsParamsSchema },
    },
    async (request, reply) => {
      const run = await getRunSummary(app.deps.prisma, request.params.id);
      await stream(request, reply, {
        topics: new Set<Topic>(['runs']),
        runId: run.id,
        snapshot: async () => ({
          activeRunIds: [run.id],
          run: await getRunSummary(app.deps.prisma, run.id),
        }),
      });
    },
  );
};

export default eventsRoutes;
