/**
 * Construcción de la aplicación Fastify 5 (plan §3): Zod type provider, OpenAPI, requestId, cookies, CORS cerrado,
 * rate limit, helmet, error handler uniforme. Rutas de negocio bajo /api/v1 (módulos), health en la raíz.
 * RNF-SEG-03, RNF-OBS-01, RNF-OBS-02.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { API_PREFIX, CONTRACT_VERSION, KatalystError } from '@katalyst/shared';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { authPlugin, sessionCookieName } from './lib/auth.js';
import { configureEventNotifier } from './lib/events-publish.js';
import { metrics, startDefaultMetrics, statusClass } from './lib/metrics.js';
import { registerModules } from './modules/index.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function genRequestId(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID_RE.test(header) ? header : randomUUID();
}

export type KatalystApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function buildApp(deps: AppDeps): Promise<KatalystApp> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    genReqId: (req) => genRequestId(req.headers['x-request-id']),
    logController: new LogController({ requestIdLogLabel: 'requestId', disableRequestLogging: false }),
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.decorate('deps', deps);
  app.decorateRequest('requestId', '');
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  app.addHook('onRequest', async (request, reply) => {
    request.requestId = String(request.id);
    void reply.header('x-request-id', request.requestId);
  });
  // Métricas HTTP con etiqueta de patrón de ruta (baja cardinalidad, RNF-OBS-01).
  startDefaultMetrics('katalyst-api');
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'sin_ruta';
    metrics.httpRequests.inc({ method: request.method, route, status_class: statusClass(reply.statusCode) });
    metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
  });
  // Notificación de eventos tras commit por Redis pub/sub (lib/events-publish).
  configureEventNotifier({ redis: deps.redis, channel: `${config.QUEUE_PREFIX}:events` });

  await app.register(fastifyHelmet, {
    // La API solo sirve JSON; Swagger UI requiere estilos/scripts propios.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(fastifyCors, {
    // Cerrado por defecto: solo orígenes explícitos (ESP §13.7).
    origin: config.CORS_ALLOWED_ORIGINS.length > 0 ? config.CORS_ALLOWED_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'idempotency-key',
      'x-csrf-token',
      'x-request-id',
      'last-event-id',
      'authorization',
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
  });
  await app.register(fastifyCookie, { hook: 'onRequest' });
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_req, ctx) =>
      new KatalystError('RATE_LIMITED', undefined, { retryAfterSeconds: Math.max(1, Math.ceil(ctx.ttl / 1000)) }),
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Katalyst API',
        version: CONTRACT_VERSION,
        description: 'DeltaX QA Runner — API /api/v1 (ESP §9)',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: sessionCookieName(config) },
          bearer: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  if (config.OPENAPI_UI_ENABLED) {
    await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' });
  }

  // Resolución de principal (cookie de sesión / Bearer) y CSRF para todas las rutas (RNF-SEG-03).
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(registerModules, { prefix: API_PREFIX });

  return app;
}
