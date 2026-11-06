/**
 * Utilidades de prueba de API-A: app con BD/Redis reales (TEST_DATABASE_URL / TEST_REDIS_URL), usuarios por rol,
 * sesiones (cookie + CSRF), tokens API y credencial de servicio. Datos sintéticos, sin secretos reales.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { buildApp, type KatalystApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPrisma } from '../../src/db.js';
import { createRedis } from '../../src/redis.js';
import { generateOpaqueToken, hashPassword, hashToken, tokenHint } from '../../src/lib/crypto-tokens.js';
import { sessionCookieName } from '../../src/lib/auth.js';
import { createSession } from '../../src/modules/auth/sessions.js';

export type Role = 'qa' | 'dev' | 'admin';

export interface TestCtx {
  app: KatalystApp;
  prisma: PrismaClient;
  redis: Redis;
  config: Config;
  close(): Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    ...process.env,
    RATE_LIMIT_MAX: '100000',
    SSRF_ALLOW_LOOPBACK: 'true',
    SSRF_ALLOW_HTTP: 'true',
    QUEUE_PREFIX: `katalyst-test-api-a-${process.pid}`,
    ...overrides,
  });
}

export async function makeCtx(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const config = testConfig(overrides);
  const prisma = createPrisma(config, 'api');
  const redis = createRedis(config.REDIS_URL);
  const app = await buildApp({ config, logger: createLogger({ level: 'silent', service: 'test' }), prisma, redis });
  await app.ready();
  return {
    app,
    prisma,
    redis,
    config,
    async close() {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

let cachedHash: Promise<string> | undefined;
export const TEST_PASSWORD = 'contrasena-de-prueba-123';
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export function uniqueEmail(prefix = 'u'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export async function createUser(
  prisma: PrismaClient,
  role: Role,
  opts: { email?: string; password?: boolean; disabled?: boolean } = {},
) {
  return prisma.panelUser.create({
    data: {
      email: opts.email ?? uniqueEmail(role),
      name: `Usuario ${role}`,
      role,
      passwordHash: opts.password === false ? null : await testPasswordHash(),
      disabledAt: opts.disabled ? new Date() : null,
    },
  });
}

export type AuthHeaders = Record<string, string> & { cookie: string; 'x-csrf-token': string };

/** Sesión del panel creada directamente (sin pasar por login) → encabezados para `inject`. */
export async function sessionFor(ctx: TestCtx, userId: string): Promise<AuthHeaders> {
  const s = await createSession(ctx.prisma, userId, 1);
  return { cookie: `${sessionCookieName(ctx.config)}=${s.token}`, 'x-csrf-token': s.csrfToken };
}

export async function loginAs(ctx: TestCtx, role: Role): Promise<{ headers: AuthHeaders; userId: string; email: string }> {
  const u = await createUser(ctx.prisma, role);
  return { headers: await sessionFor(ctx, u.id), userId: u.id, email: u.email };
}

export async function apiTokenFor(
  prisma: PrismaClient,
  userId: string,
  scopes: string[],
  opts: { expiresAt?: Date; revoked?: boolean } = {},
): Promise<{ authorization: string; id: string }> {
  const token = generateOpaqueToken('apiToken');
  const c = await prisma.apiCredential.create({
    data: {
      principalId: userId,
      kind: 'token_api',
      name: 'prueba',
      tokenHash: hashToken(token),
      scopes,
      hint: tokenHint(token),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: opts.revoked ? new Date() : null,
    },
  });
  return { authorization: `Bearer ${token}`, id: c.id };
}

export async function serviceTokenFor(prisma: PrismaClient, scopes = ['worker.claim']): Promise<{ authorization: string; id: string }> {
  const token = generateOpaqueToken('service');
  const c = await prisma.apiCredential.create({
    data: {
      serviceName: `supervisor:test-${randomUUID().slice(0, 6)}`,
      kind: 'servicio_supervisor',
      name: 'supervisor de prueba',
      tokenHash: hashToken(token),
      scopes,
      hint: tokenHint(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { authorization: `Bearer ${token}`, id: c.id };
}

/** Encabezados de cada actor de la matriz qa/dev/admin/servicio. */
export async function actorMatrix(ctx: TestCtx): Promise<Record<Role | 'servicio' | 'anonimo', Record<string, string>>> {
  const qa = await loginAs(ctx, 'qa');
  const dev = await loginAs(ctx, 'dev');
  const admin = await loginAs(ctx, 'admin');
  const svc = await serviceTokenFor(ctx.prisma);
  return {
    qa: { ...qa.headers },
    dev: { ...dev.headers },
    admin: { ...admin.headers },
    servicio: { authorization: svc.authorization },
    anonimo: {},
  };
}
