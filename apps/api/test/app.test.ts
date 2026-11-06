/**
 * RNF-OBS-02 / RNF-SEG-03: health, readiness con BD y Redis reales, requestId y error uniforme.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KatalystError, RunCreateRequestSchema, ApiErrorSchema } from '@katalyst/shared';
import { buildApp, genRequestId, type KatalystApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createPrisma } from '../src/db.js';
import { createRedis } from '../src/redis.js';

let app: KatalystApp;
const config = loadConfig({ ...process.env, RATE_LIMIT_MAX: '1000' });
const prisma = createPrisma(config, 'api');
const redis = createRedis(config.REDIS_URL);

beforeAll(async () => {
  app = await buildApp({ config, logger: createLogger({ level: 'silent', service: 'test' }), prisma, redis });
  // Rutas de prueba para ejercitar el manejador de errores (no forman parte de la API).
  app.post('/__test/selection', { schema: { body: RunCreateRequestSchema } }, async () => ({ ok: true }));
  app.get('/__test/domain', async () => {
    throw new KatalystError('ENVIRONMENT_DISABLED');
  });
  app.get('/__test/boom', async () => {
    throw new Error('fallo interno con password=supersecreta123');
  });
  app.get(
    '/__test/query',
    { schema: { querystring: z.object({ limit: z.coerce.number().int().max(100) }) } },
    async () => ({ ok: true }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});

describe('health (RNF-OBS-02)', () => {
  it('RNF-OBS-02 /healthz responde 200 sin secretos', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', service: 'katalyst-api' });
    expect(res.body).not.toMatch(/postgres|redis:\/\//i);
  });

  it('RNF-OBS-02 /readyz refleja BD y Redis reales', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { database: { ok: true }, redis: { ok: true } } });
  });

  it('RNF-OBS-02 /readyz devuelve 503 si Redis no está disponible', async () => {
    const badRedis = createRedis('redis://127.0.0.1:1/0');
    const bad = await buildApp({
      config,
      logger: createLogger({ level: 'silent', service: 'test' }),
      prisma,
      redis: badRedis,
    });
    const res = await bad.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not_ready', checks: { redis: { ok: false } } });
    await bad.close();
    badRedis.disconnect();
  });
});

describe('errores y requestId (RNF-SEG-03, RNF-OBS-01)', () => {
  it('RNF-OBS-01 hace eco de x-request-id válido y genera uno si falta', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'req-12345678' } });
    expect(res.headers['x-request-id']).toBe('req-12345678');
    const res2 = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(res2.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(genRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('RNF-SEG-03 ruta inexistente → 404 ROUTE_NOT_FOUND con requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/no-existe',
      headers: { 'x-request-id': 'req-abcdefgh' },
    });
    expect(res.statusCode).toBe(404);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(body.error.requestId).toBe('req-abcdefgh');
  });

  it('RF-EJE-01 selección con más de un criterio → 422 SELECTION_EXCLUSIVE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/selection',
      payload: {
        suiteId: '7f3c2a3e-2a7b-4c1e-9d5f-0d8f2f6b1a11',
        tags: ['@humo'],
        environmentId: '7f3c2a3e-2a7b-4c1e-9d5f-0d8f2f6b1a12',
      },
    });
    expect(res.statusCode).toBe(422);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('SELECTION_EXCLUSIVE');
    expect(body.error.details?.issues?.length).toBeGreaterThan(0);
  });

  it('RF-EJE-01 lista vacía → 422 SELECTION_EMPTY', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/selection',
      payload: { caseIds: [], environmentId: '7f3c2a3e-2a7b-4c1e-9d5f-0d8f2f6b1a12' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SELECTION_EMPTY');
  });

  it('RNF-SEG-03 validación genérica → 422 VALIDATION_FAILED sin reflejar valores', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/query?limit=5000' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.body).not.toContain('5000');
  });

  it('RNF-SEG-03 KatalystError conserva código y estado', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/domain' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ENVIRONMENT_DISABLED');
  });

  it('RNF-SEG-01 error no controlado → 500 INTERNAL_ERROR sin filtrar el mensaje', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('supersecreta123');
  });

  it('RNF-SEG-03 JSON mal formado → 400 BAD_REQUEST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/selection',
      headers: { 'content-type': 'application/json' },
      payload: '{"suiteId":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('RNF-SEG-03 CORS cerrado por defecto y cabeceras de seguridad', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('RNF-SEG-03 OpenAPI generado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths['/readyz']).toBeDefined();
  });
});

describe('rate limit (RNF-SEG-03)', () => {
  it('RNF-SEG-03 excedido → 429 RATE_LIMITED con Retry-After', async () => {
    const limited = await buildApp({
      config: loadConfig({ ...process.env, RATE_LIMIT_MAX: '1' }),
      logger: createLogger({ level: 'silent', service: 'test' }),
      prisma,
      redis,
    });
    limited.get('/__test/rl', async () => ({ ok: true }));
    expect((await limited.inject({ method: 'GET', url: '/__test/rl' })).statusCode).toBe(200);
    const res = await limited.inject({ method: 'GET', url: '/__test/rl' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });
});
