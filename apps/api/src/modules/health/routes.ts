/**
 * Health/liveness y readiness sin secretos; readiness refleja BD y Redis (RNF-OBS-02). `/metrics` en formato
 * Prometheus, solo desde loopback/red privada salvo `METRICS_PUBLIC` (contrato de deploy). RNF-OBS-01.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HealthzResponseSchema, ReadyzResponseSchema, type ReadyzResponse } from '@katalyst/shared';
import { pingRedis } from '../../redis.js';
import { KatalystError } from '@katalyst/shared';
import { METRICS_CONTENT_TYPE, renderMetrics } from '../../lib/metrics.js';
import { isInternalClientIp } from '../../lib/ssrf.js';
import { registerTestRailMetrics } from '../testrail/metrics.js';

const CHECK_TIMEOUT_MS = 1_500;
const startedAt = Date.now();

async function timed(fn: () => Promise<unknown>): Promise<ReadyzResponse['checks']['database']> {
  const t0 = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref()),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    // Sin detalles internos ni cadenas de conexión.
    const msg = e instanceof Error && e.message === 'timeout' ? 'timeout' : 'no_disponible';
    return { ok: false, latencyMs: null, error: msg };
  }
}

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/healthz',
    {
      config: { rateLimit: false },
      schema: { tags: ['health'], summary: 'Liveness', response: { 200: HealthzResponseSchema } },
    },
    async () => ({
      status: 'ok' as const,
      service: 'katalyst-api',
      version: app.deps.config.SERVICE_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  app.get(
    '/readyz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Readiness (BD + Redis)',
        response: { 200: ReadyzResponseSchema, 503: ReadyzResponseSchema },
      },
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([
        timed(() => app.deps.prisma.$queryRaw`SELECT 1`),
        timed(() => pingRedis(app.deps.redis, CHECK_TIMEOUT_MS)),
      ]);
      const ready = database.ok && redis.ok;
      return reply
        .status(ready ? 200 : 503)
        .send({ status: ready ? 'ready' : 'not_ready', checks: { database, redis } });
    },
  );

  registerTestRailMetrics(app.deps.prisma);
  app.get(
    '/metrics',
    {
      config: { rateLimit: false },
      schema: { tags: ['health'], summary: 'Métricas Prometheus (red interna)', hide: true },
    },
    async (request, reply) => {
      if (!app.deps.config.METRICS_PUBLIC && !isInternalClientIp(request.ip)) throw new KatalystError('FORBIDDEN');
      const body = await renderMetrics();
      return reply.header('content-type', METRICS_CONTENT_TYPE).header('cache-control', 'no-store').send(body);
    },
  );
};

export default healthRoutes;
