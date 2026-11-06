/**
 * Módulo auth: login propio (argon2id, rate limit, bloqueo progresivo, recuperación con token único y vencimiento),
 * OIDC corporativo opcional, sesión de backend en cookie `__Host-katalyst_session` + CSRF, logout que revoca,
 * `GET /auth/me` con permisos efectivos, tokens API revocables con scopes/vencimiento y credenciales de servicio del
 * supervisor (alcance restringido y expirable). Solo estos endpoints emiten credenciales (RNF-SEG-01), una sola vez.
 * RF-USR-01, RF-USR-03, RNF-SEG-03, ESP §13.7.
 */
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiCredential, PrismaClient } from '@prisma/client';
import {
  ApiTokenCreateRequestSchema,
  ApiTokenCreatedResponseSchema,
  ApiTokenListQuerySchema,
  ApiTokenSchema,
  AuthProvidersResponseSchema,
  IdParamsSchema,
  KatalystError,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  OkResponseSchema,
  PasswordChangeSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  ServiceCredentialCreateRequestSchema,
  ServiceCredentialCreatedResponseSchema,
  ServiceCredentialSchema,
  can,
  pageSchema,
  type MeResponse,
  type Permission,
} from '@katalyst/shared';
import { csrfTokenFor, effectivePermissions, routeAuth, type Principal } from '../../lib/auth.js';
import { recordAudit } from '../../lib/audit.js';
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  needsRehash,
  tokenHint,
} from '../../lib/crypto-tokens.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, type SortSpec } from '../../lib/pagination.js';
import { getSecretProvider } from '../../lib/secrets.js';
import { metrics } from '../../lib/metrics.js';
import { clearSessionCookie, createSession, revokeSession, revokeUserSessions, setSessionCookie } from './sessions.js';
import { LoginThrottle } from './throttle.js';
import { LocalIdentityProvider, oidcFromConfig } from './identity.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Canal de entrega del token de recuperación (correo: pendiente de canal, ESP §12 / API-C). */
export interface PasswordResetSender {
  send(to: { email: string; name: string }, resetUrl: string, expiresAt: Date): Promise<void>;
}
let resetSender: PasswordResetSender | undefined;
export function setPasswordResetSender(s: PasswordResetSender | undefined): void {
  resetSender = s;
}

export function toApiTokenDto(c: ApiCredential) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    principalId: c.principalId!,
    scopes: c.scopes as Permission[],
    hint: c.hint,
    expiresAt: iso(c.expiresAt),
    revokedAt: iso(c.revokedAt),
    lastUsedAt: iso(c.lastUsedAt),
    createdAt: c.createdAt.toISOString(),
  };
}

export function toServiceCredentialDto(c: ApiCredential) {
  return {
    id: c.id,
    name: c.name,
    serviceName: c.serviceName ?? '',
    scopes: c.scopes as Permission[],
    hint: c.hint,
    expiresAt: iso(c.expiresAt),
    revokedAt: iso(c.revokedAt),
    lastUsedAt: iso(c.lastUsedAt),
    createdAt: c.createdAt.toISOString(),
  };
}

function panelPrincipal(request: FastifyRequest): Extract<Principal, { kind: 'panel_user' }> {
  const p = request.principal;
  if (p?.kind !== 'panel_user') throw new KatalystError(p ? 'FORBIDDEN' : (request.authError ?? 'UNAUTHENTICATED'));
  return p;
}

const CREATED_SORT: SortSpec = { field: 'createdAt', direction: 'desc', type: 'date' };
const OIDC_STATE_TTL_SECONDS = 600;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config, redis } = app.deps;
  const throttle = new LoginThrottle(redis, {
    maxFailures: config.LOGIN_MAX_FAILURES,
    baseSeconds: config.LOGIN_LOCKOUT_BASE_SECONDS,
    maxSeconds: config.LOGIN_LOCKOUT_MAX_SECONDS,
    prefix: config.QUEUE_PREFIX,
  });
  const local = new LocalIdentityProvider(prisma);
  const oidc = oidcFromConfig(config, getSecretProvider());
  const loginRateLimit = { rateLimit: { max: 20, timeWindow: 60_000 } };

  async function meFor(userId: string, sessionToken: string, expiresAt: Date): Promise<MeResponse> {
    const user = await prisma.panelUser.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });
    return {
      user,
      permissions: effectivePermissions({ kind: 'panel_user', id: user.id, role: user.role, email: user.email, sessionId: '' }),
      session: { expiresAt: expiresAt.toISOString(), csrfToken: csrfTokenFor(sessionToken) },
      timezone: config.DEFAULT_TIMEZONE,
    };
  }

  app.get(
    '/auth/providers',
    {
      ...routeAuth('GET', '/auth/providers'),
      schema: { tags: ['auth'], summary: 'Métodos de login disponibles', response: { 200: AuthProvidersResponseSchema } },
    },
    async () => ({
      local: true,
      oidc: {
        enabled: !!oidc,
        displayName: oidc ? oidc.displayName : null,
        loginUrl: oidc ? '/api/v1/auth/oidc/login' : null,
      },
    }),
  );

  app.post(
    '/auth/login',
    {
      ...routeAuth('POST', '/auth/login'),
      config: loginRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Login con correo y contraseña (sesión HttpOnly + CSRF)',
        body: LoginRequestSchema,
        response: { 200: LoginResponseSchema },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const ip = request.ip;
      const state = await throttle.check(email, ip);
      if (state.locked) {
        metrics.authFailures.inc({ reason: 'locked' });
        throw new KatalystError('RATE_LIMITED', undefined, { retryAfterSeconds: state.retryAfterSeconds });
      }
      const r = await local.verify(email, password);
      if (!r.ok) {
        const after = await throttle.registerFailure(email, ip);
        metrics.authFailures.inc({ reason: 'invalid_credentials' });
        await recordAudit(prisma, {
          actor: 'system',
          action: 'auth.login_failed',
          entity: 'panel_user',
          ...(r.userId ? { entityId: r.userId } : {}),
          diff: { locked: after.locked },
          requestId: request.requestId,
        });
        throw new KatalystError('INVALID_CREDENTIALS');
      }
      if (r.user.disabledAt) throw new KatalystError('USER_DISABLED');
      await throttle.registerSuccess(email);
      const now = new Date();
      const session = await prisma.$transaction(async (tx) => {
        const s = await createSession(tx, r.user.id, config.SESSION_TTL_HOURS, {
          ip,
          userAgent: request.headers['user-agent'],
        });
        await tx.panelUser.update({
          where: { id: r.user.id },
          data: {
            lastLoginAt: now,
            ...(needsRehash(r.user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
          },
        });
        await recordAudit(tx, {
          actor: { kind: 'panel_user', id: r.user.id, role: r.user.role, email: r.user.email, sessionId: s.id },
          action: 'auth.login',
          entity: 'panel_session',
          entityId: s.id,
          diff: { method: 'local' },
          requestId: request.requestId,
        });
        return s;
      });
      setSessionCookie(reply, config, session);
      return meFor(r.user.id, session.token, session.expiresAt);
    },
  );

  app.post(
    '/auth/logout',
    {
      ...routeAuth('POST', '/auth/logout'),
      schema: { tags: ['auth'], summary: 'Cerrar sesión (revoca en servidor)', response: { 200: LogoutResponseSchema } },
    },
    async (request, reply) => {
      const p = panelPrincipal(request);
      await prisma.$transaction(async (tx) => {
        await revokeSession(tx, p.sessionId);
        await recordAudit(tx, {
          actor: p,
          action: 'auth.logout',
          entity: 'panel_session',
          entityId: p.sessionId,
          requestId: request.requestId,
        });
      });
      clearSessionCookie(reply, config);
      return { ok: true as const };
    },
  );

  app.get(
    '/auth/me',
    {
      ...routeAuth('GET', '/auth/me'),
      schema: { tags: ['auth'], summary: 'Identidad, permisos efectivos y token CSRF', response: { 200: MeResponseSchema } },
    },
    async (request) => {
      const p = panelPrincipal(request);
      const s = await prisma.panelSession.findUniqueOrThrow({ where: { id: p.sessionId }, select: { expiresAt: true } });
      return meFor(p.id, request.sessionToken!, s.expiresAt);
    },
  );

  app.post(
    '/auth/password/reset-request',
    {
      ...routeAuth('POST', '/auth/password/reset-request'),
      config: { rateLimit: { max: 5, timeWindow: 60_000 } },
      schema: {
        tags: ['auth'],
        summary: 'Solicitar recuperación (respuesta uniforme, sin enumeración)',
        body: PasswordResetRequestSchema,
        response: { 200: OkResponseSchema },
      },
    },
    async (request) => {
      const user = await prisma.panelUser.findUnique({
        where: { email: request.body.email },
        select: { id: true, email: true, name: true, disabledAt: true, passwordHash: true, authSubject: true },
      });
      if (user && !user.disabledAt && (user.passwordHash || !user.authSubject)) {
        const token = generateOpaqueToken('passwordReset');
        const expiresAt = new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000);
        await prisma.$transaction(async (tx) => {
          // Un único token vigente por usuario: los anteriores quedan inutilizables.
          await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
          await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt } });
        });
        const url = new URL('/recuperar', config.PUBLIC_BASE_URL);
        url.hash = `token=${token}`;
        if (resetSender) {
          await resetSender.send({ email: user.email, name: user.name }, url.toString(), expiresAt).catch((err: unknown) => {
            request.log.warn({ err }, 'no se pudo enviar la recuperación de contraseña');
          });
        } else {
          request.log.warn('recuperación solicitada sin canal de envío configurado (ESP §12)');
        }
      }
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/password/reset',
    {
      ...routeAuth('POST', '/auth/password/reset'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags: ['auth'],
        summary: 'Confirmar recuperación con token único',
        body: PasswordResetConfirmSchema,
        response: { 200: OkResponseSchema },
      },
    },
    async (request) => {
      const now = new Date();
      const row = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(request.body.token) },
        select: { id: true, userId: true, expiresAt: true, usedAt: true, user: { select: { disabledAt: true, email: true } } },
      });
      if (!row || row.usedAt || row.expiresAt <= now || row.user.disabledAt) throw new KatalystError('TOKEN_REVOKED');
      const passwordHash = await hashPassword(request.body.newPassword);
      await prisma.$transaction(async (tx) => {
        const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
        if (used.count === 0) throw new KatalystError('TOKEN_REVOKED');
        await tx.panelUser.update({ where: { id: row.userId }, data: { passwordHash, version: { increment: 1 } } });
        await revokeUserSessions(tx, row.userId);
        await recordAudit(tx, {
          actor: 'system',
          action: 'auth.password_reset',
          entity: 'panel_user',
          entityId: row.userId,
          diff: { via: 'token' },
          requestId: request.requestId,
        });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/auth/password/change',
    {
      ...routeAuth('POST', '/auth/password/change'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { tags: ['auth'], summary: 'Cambiar contraseña', body: PasswordChangeSchema, response: { 200: OkResponseSchema } },
    },
    async (request) => {
      const p = panelPrincipal(request);
      const r = await local.verify(p.email, request.body.currentPassword);
      if (!r.ok) throw new KatalystError('INVALID_CREDENTIALS');
      const passwordHash = await hashPassword(request.body.newPassword);
      await prisma.$transaction(async (tx) => {
        await tx.panelUser.update({ where: { id: p.id }, data: { passwordHash, version: { increment: 1 } } });
        await revokeUserSessions(tx, p.id, p.sessionId);
        await recordAudit(tx, {
          actor: p,
          action: 'auth.password_reset',
          entity: 'panel_user',
          entityId: p.id,
          diff: { via: 'change' },
          requestId: request.requestId,
        });
      });
      return { ok: true as const };
    },
  );

  // -------------------------------------------------------------------------
  // Tokens API (RF-USR-03)
  // -------------------------------------------------------------------------

  app.get(
    '/auth/tokens',
    {
      ...routeAuth('GET', '/auth/tokens'),
      schema: { tags: ['auth'], summary: 'Tokens API (sin valor)', querystring: ApiTokenListQuerySchema, response: { 200: pageSchema(ApiTokenSchema) } },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, CREATED_SORT);
      const rows = await prisma.apiCredential.findMany({
        where: {
          AND: [{ kind: 'token_api' }, q.includeRevoked ? {} : { revokedAt: null }, keysetWhere(CREATED_SORT, after)],
        },
        orderBy: keysetOrderBy(CREATED_SORT),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, CREATED_SORT, toApiTokenDto);
    },
  );

  app.post(
    '/auth/tokens',
    {
      ...routeAuth('POST', '/auth/tokens'),
      schema: {
        tags: ['auth'],
        summary: 'Crear token API (se muestra una sola vez)',
        body: ApiTokenCreateRequestSchema,
        response: { 201: ApiTokenCreatedResponseSchema },
      },
    },
    async (request, reply) => {
      const p = panelPrincipal(request);
      const { name, scopes, expiresAt } = request.body;
      const exp = new Date(expiresAt);
      const now = Date.now();
      if (exp.getTime() <= now || exp.getTime() > now + 366 * 86_400_000) {
        throw new KatalystError('VALIDATION_FAILED', 'El vencimiento debe estar entre ahora y 365 días.');
      }
      const unique = [...new Set(scopes)];
      // Un token no puede exceder los permisos del rol del dueño ni incluir permisos de sistema.
      if (unique.some((s) => !can(p.role, s))) throw new KatalystError('FORBIDDEN', 'Scopes fuera de los permisos del rol.');
      const token = generateOpaqueToken('apiToken');
      const cred = await prisma.$transaction(async (tx) => {
        const c = await tx.apiCredential.create({
          data: {
            principalId: p.id,
            kind: 'token_api',
            name,
            tokenHash: hashToken(token),
            scopes: unique,
            hint: tokenHint(token),
            expiresAt: exp,
            createdById: p.id,
          },
        });
        await recordAudit(tx, {
          actor: p,
          action: 'api_token.create',
          entity: 'api_credential',
          entityId: c.id,
          diff: { name, scopes: unique, expiresAt },
          requestId: request.requestId,
        });
        return c;
      });
      return reply.status(201).send({ credential: toApiTokenDto(cred), token });
    },
  );

  app.delete(
    '/auth/tokens/:id',
    {
      ...routeAuth('DELETE', '/auth/tokens/:id'),
      schema: { tags: ['auth'], summary: 'Revocar token API', params: IdParamsSchema, response: { 200: ApiTokenSchema } },
    },
    async (request) => {
      const actor = request.principal!;
      return prisma.$transaction(async (tx) => {
        const c = await tx.apiCredential.findFirst({ where: { id: request.params.id, kind: 'token_api' } });
        if (!c) throw new KatalystError('NOT_FOUND');
        const updated = c.revokedAt ? c : await tx.apiCredential.update({ where: { id: c.id }, data: { revokedAt: new Date() } });
        if (!c.revokedAt) {
          await recordAudit(tx, { actor, action: 'api_token.revoke', entity: 'api_credential', entityId: c.id, requestId: request.requestId });
        }
        return toApiTokenDto(updated);
      });
    },
  );

  // -------------------------------------------------------------------------
  // Credenciales de servicio del supervisor (RF-USR-03)
  // -------------------------------------------------------------------------

  app.get(
    '/auth/service-credentials',
    {
      ...routeAuth('GET', '/auth/service-credentials'),
      schema: {
        tags: ['auth'],
        summary: 'Credenciales de servicio (sin valor)',
        querystring: ApiTokenListQuerySchema,
        response: { 200: pageSchema(ServiceCredentialSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, CREATED_SORT);
      const rows = await prisma.apiCredential.findMany({
        where: {
          AND: [{ kind: 'servicio_supervisor' }, q.includeRevoked ? {} : { revokedAt: null }, keysetWhere(CREATED_SORT, after)],
        },
        orderBy: keysetOrderBy(CREATED_SORT),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, CREATED_SORT, toServiceCredentialDto);
    },
  );

  app.post(
    '/auth/service-credentials',
    {
      ...routeAuth('POST', '/auth/service-credentials'),
      schema: {
        tags: ['auth'],
        summary: 'Emitir credencial de servicio (se muestra una sola vez)',
        body: ServiceCredentialCreateRequestSchema,
        response: { 201: ServiceCredentialCreatedResponseSchema },
      },
    },
    async (request, reply) => {
      const p = panelPrincipal(request);
      const { name, scopes, expiresInDays } = request.body;
      if (expiresInDays > config.SERVICE_CREDENTIAL_TTL_DAYS) {
        throw new KatalystError('VALIDATION_FAILED', `La vigencia máxima es ${config.SERVICE_CREDENTIAL_TTL_DAYS} días.`);
      }
      const { credential, token } = await issueServiceCredential(prisma, {
        serviceName: name,
        scopes: [...new Set(scopes)],
        expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
        actor: p,
        requestId: request.requestId,
      });
      return reply.status(201).send({ credential: toServiceCredentialDto(credential), token });
    },
  );

  app.delete(
    '/auth/service-credentials/:id',
    {
      ...routeAuth('DELETE', '/auth/service-credentials/:id'),
      schema: { tags: ['auth'], summary: 'Revocar credencial de servicio', params: IdParamsSchema, response: { 200: ServiceCredentialSchema } },
    },
    async (request) => {
      const actor = request.principal!;
      return prisma.$transaction(async (tx) => {
        const c = await tx.apiCredential.findFirst({ where: { id: request.params.id, kind: 'servicio_supervisor' } });
        if (!c) throw new KatalystError('NOT_FOUND');
        const updated = c.revokedAt ? c : await tx.apiCredential.update({ where: { id: c.id }, data: { revokedAt: new Date() } });
        if (!c.revokedAt) {
          await recordAudit(tx, { actor, action: 'api_token.revoke', entity: 'api_credential', entityId: c.id, requestId: request.requestId });
        }
        return toServiceCredentialDto(updated);
      });
    },
  );

  // -------------------------------------------------------------------------
  // OIDC corporativo opcional (ESP §12)
  // -------------------------------------------------------------------------

  const OidcCallbackQuery = z.object({
    code: z.string().min(1).max(2048).optional(),
    state: z.string().min(1).max(256).optional(),
    error: z.string().max(256).optional(),
  });

  app.get(
    '/auth/oidc/login',
    { ...routeAuth('GET', '/auth/oidc/login'), schema: { tags: ['auth'], summary: 'Iniciar login OIDC (redirección)' } },
    async (_request, reply) => {
      if (!oidc) throw new KatalystError('NOT_FOUND');
      const start = await oidc.beginLogin();
      if (redis.status === 'wait') await redis.connect();
      await redis.set(
        `${config.QUEUE_PREFIX}:oidc:state:${hashToken(start.state)}`,
        JSON.stringify({ v: start.codeVerifier, n: start.nonce }),
        'EX',
        OIDC_STATE_TTL_SECONDS,
      );
      return reply.redirect(start.url, 302);
    },
  );

  app.get(
    '/auth/oidc/callback',
    {
      ...routeAuth('GET', '/auth/oidc/callback'),
      schema: { tags: ['auth'], summary: 'Callback OIDC', querystring: OidcCallbackQuery },
    },
    async (request, reply) => {
      if (!oidc) throw new KatalystError('NOT_FOUND');
      const fail = () => reply.redirect(new URL('/login?error=sso', config.PUBLIC_BASE_URL).toString(), 302);
      const { code, state } = request.query;
      if (!code || !state) return fail();
      if (redis.status === 'wait') await redis.connect();
      const key = `${config.QUEUE_PREFIX}:oidc:state:${hashToken(state)}`;
      const raw = await redis.get(key);
      await redis.del(key);
      if (!raw) return fail();
      const { v } = JSON.parse(raw) as { v: string };
      let identity: { subject: string; email: string | null };
      try {
        identity = await oidc.completeLogin(code, v);
      } catch (err) {
        request.log.warn({ err }, 'login OIDC fallido');
        return fail();
      }
      const user =
        (await prisma.panelUser.findFirst({ where: { authSubject: identity.subject } })) ??
        (identity.email
          ? await prisma.panelUser.findFirst({ where: { email: identity.email, authSubject: null } })
          : null);
      if (!user || user.disabledAt) return fail();
      const session = await prisma.$transaction(async (tx) => {
        if (!user.authSubject) await tx.panelUser.update({ where: { id: user.id }, data: { authSubject: identity.subject } });
        await tx.panelUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        const s = await createSession(tx, user.id, config.SESSION_TTL_HOURS, { ip: request.ip, userAgent: request.headers['user-agent'] });
        await recordAudit(tx, {
          actor: { kind: 'panel_user', id: user.id, role: user.role, email: user.email, sessionId: s.id },
          action: 'auth.login',
          entity: 'panel_session',
          entityId: s.id,
          diff: { method: 'oidc' },
          requestId: request.requestId,
        });
        return s;
      });
      setSessionCookie(reply, config, session);
      return reply.redirect(new URL('/', config.PUBLIC_BASE_URL).toString(), 302);
    },
  );
};

/** Emite credencial de servicio (API y CLI comparten esta función). Token devuelto una sola vez. */
export async function issueServiceCredential(
  prisma: PrismaClient,
  o: { serviceName: string; scopes: string[]; expiresAt: Date; actor: Principal | 'system'; requestId?: string },
): Promise<{ credential: ApiCredential; token: string }> {
  if (o.scopes.some((s) => s !== 'worker.claim')) throw new KatalystError('FORBIDDEN', 'Scope no admitido para servicio.');
  const token = generateOpaqueToken('service');
  const credential = await prisma.$transaction(async (tx) => {
    const c = await tx.apiCredential.create({
      data: {
        serviceName: o.serviceName,
        kind: 'servicio_supervisor',
        name: o.serviceName,
        tokenHash: hashToken(token),
        scopes: o.scopes,
        hint: tokenHint(token),
        expiresAt: o.expiresAt,
        createdById: o.actor !== 'system' && o.actor.kind === 'panel_user' ? o.actor.id : null,
      },
    });
    await recordAudit(tx, {
      actor: o.actor,
      action: 'api_token.create',
      entity: 'api_credential',
      entityId: c.id,
      diff: { kind: 'servicio_supervisor', serviceName: o.serviceName, scopes: o.scopes, expiresAt: o.expiresAt },
      ...(o.requestId ? { requestId: o.requestId } : {}),
    });
    return c;
  });
  return { credential, token };
}

export default authRoutes;
