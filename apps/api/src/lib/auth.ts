/**
 * Autenticación y autorización transversal (RF-USR-01, RF-USR-03, RNF-SEG-03, ESP §9, §13.7).
 *
 * `authPlugin` resuelve el principal de cada solicitud:
 * - Cookie de sesión del panel `__Host-katalyst_session` (HttpOnly/Secure/SameSite; sin `__Host-` solo en loopback de
 *   desarrollo con `COOKIE_SECURE=false`) → `panel_user`. Solicitudes no seguras con cookie exigen CSRF
 *   (encabezado `X-CSRF-Token` derivado de la sesión, doble envío ligado) + verificación de Origin.
 * - `Authorization: Bearer <token>` (prefijo de tipo, ver crypto-tokens): token API revocable con scopes
 *   (`api_token`), credencial de servicio del supervisor (`service`), token de lease del ejecutor (`lease`) o credencial
 *   del asistente local (`device`). Bearer inválido/revocado/vencido → 401 (no se degrada a anónimo).
 *
 * `requirePermission(p)` aplica la matriz de `@katalyst/shared/rbac`: rol del panel; tokens = rol ∩ scopes; servicio
 * solo `worker.claim`; lease solo `worker.callback`; dispositivo solo grabación. La autorización por recurso
 * (propietario) la hace cada handler.
 *
 * Tokens de lease: el plugin los autentica hasta 24 h después de emitidos aunque el lease esté revocado/liberado, para
 * que un callback repetido reciba su acuse original (ESP §13.3); los handlers del worker DEBEN validar vigencia y
 * generación (LEASE_STALE / LEASE_EXPIRED).
 */
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  preValidationHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import {
  KatalystError,
  ROUTES,
  SERVICE_PERMISSIONS,
  can,
  canWithScopes,
  findRoute,
  permissionsForRole,
  type ErrorCode,
  type HttpMethod,
  type PanelRole,
  type Permission,
  type RouteAccess,
} from '@katalyst/shared';
import { hashToken, hmacToken, safeEqual, tokenKindOf } from './crypto-tokens.js';
import { metrics } from './metrics.js';

export type Principal =
  | { kind: 'panel_user'; id: string; role: 'qa' | 'dev' | 'admin'; email: string; sessionId: string }
  | { kind: 'api_token'; id: string; role: 'qa' | 'dev' | 'admin'; scopes: string[] }
  | { kind: 'service'; id: string; scopes: string[] } // supervisor del host / publicador
  | { kind: 'lease'; id: string; leaseId: string; shardId: string; runId: string; generation: number } // ejecutor
  | { kind: 'device'; id: string; userId: string; role: 'qa' | 'dev' | 'admin' };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    requestId: string;
    /** Motivo por el que no se autenticó (para el código 401). */
    authError?: ErrorCode;
    /** Token de sesión crudo de la cookie (solo para derivar CSRF / logout); nunca se registra. */
    sessionToken?: string;
  }
}

/** Permisos admitidos para credenciales de dispositivo (asistente local de grabación, ESP §13.6). */
export const DEVICE_PERMISSIONS: readonly Permission[] = ['recordings.create', 'recordings.read'];
/** Ventana de autenticación de tokens de lease tras su emisión. */
export const LEASE_TOKEN_AUTH_WINDOW_MS = 24 * 60 * 60 * 1000;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthPluginOptions {
  /** Orígenes aceptados en solicitudes no seguras con cookie (además de PUBLIC_BASE_URL). */
  extraAllowedOrigins?: string[];
}

/** Nombre de la cookie de sesión: `__Host-` + nombre configurado cuando Secure está activo (contrato de deploy). */
export function sessionCookieName(config: { SESSION_COOKIE_NAME: string; COOKIE_SECURE: boolean }): string {
  const base = config.SESSION_COOKIE_NAME.replace(/^__Host-/, '');
  return config.COOKIE_SECURE ? `__Host-${base}` : base;
}

/** Token CSRF derivado del token de sesión (no almacenable sin la cookie); en BD solo su SHA-256. */
export function csrfTokenFor(sessionToken: string): string {
  return hmacToken(sessionToken, 'katalyst-csrf-v1');
}

export function isPanelRole(r: string): r is PanelRole {
  return r === 'qa' || r === 'dev' || r === 'admin';
}

/** Permisos efectivos del principal (para `/auth/me` y para decidir autorización). */
export function effectivePermissions(p: Principal): Permission[] {
  switch (p.kind) {
    case 'panel_user':
      return permissionsForRole(p.role);
    case 'api_token':
      return permissionsForRole(p.role).filter((x) => p.scopes.includes(x));
    case 'service':
      return SERVICE_PERMISSIONS.filter((x) => p.scopes.includes(x) && x === 'worker.claim');
    case 'lease':
      return ['worker.callback'];
    case 'device':
      return permissionsForRole(p.role).filter((x) => DEVICE_PERMISSIONS.includes(x));
  }
}

export function hasPermission(p: Principal | undefined, permission: Permission): boolean {
  if (!p) return false;
  switch (p.kind) {
    case 'panel_user':
      return can(p.role, permission);
    case 'api_token':
      return canWithScopes(p.role, p.scopes as Permission[], permission);
    case 'service':
      return permission === 'worker.claim' && p.scopes.includes(permission);
    case 'lease':
      return permission === 'worker.callback';
    case 'device':
      return DEVICE_PERMISSIONS.includes(permission) && can(p.role, permission);
  }
}

/** ID de usuario del panel detrás del principal (sesión o dispositivo); `null` para tokens/servicio/lease. */
export function principalUserId(p: Principal | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'panel_user') return p.id;
  if (p.kind === 'device') return p.userId;
  return null;
}

/** ¿Es admin (para autorización por recurso: propietario o admin)? */
export function isAdmin(p: Principal | undefined): boolean {
  return !!p && (p.kind === 'panel_user' || p.kind === 'api_token' || p.kind === 'device') && p.role === 'admin';
}

function deny(request: FastifyRequest): never {
  if (!request.principal) throw new KatalystError(request.authError ?? 'UNAUTHENTICATED');
  throw new KatalystError('FORBIDDEN');
}

export function requirePermission(permission: Permission): preHandlerHookHandler {
  return async function permissionGuard(request: FastifyRequest, _reply: FastifyReply) {
    if (!hasPermission(request.principal, permission)) {
      if (request.principal) metrics.authFailures.inc({ reason: 'forbidden' });
      deny(request);
    }
  };
}

/** Cualquier usuario del panel (sesión, token API o dispositivo). */
export function requireAuthenticated(): preHandlerHookHandler {
  return async function authenticatedGuard(request: FastifyRequest) {
    const p = request.principal;
    if (!p || !(p.kind === 'panel_user' || p.kind === 'api_token' || p.kind === 'device')) deny(request);
  };
}

/** Solo sesión del panel (cookie). */
export function requireSession(): preHandlerHookHandler {
  return async function sessionGuard(request: FastifyRequest) {
    if (request.principal?.kind !== 'panel_user') deny(request);
  };
}

export function requireAccess(access: RouteAccess): preHandlerHookHandler | undefined {
  if (access === 'public') return undefined;
  if (access === 'authenticated') return requireAuthenticated();
  return requirePermission(access);
}

/**
 * Guardia de la ruta según el inventario `ROUTES` (path relativo a /api/v1 con sintaxis `:param`) como `preHandler`.
 * Lanza si la ruta no está inventariada: los módulos solo pueden registrar rutas de `ROUTES`.
 */
export function routeGuard(method: HttpMethod, path: string): { preHandler: preHandlerHookHandler[] } {
  const spec = findRoute(method, path);
  if (!spec) throw new Error(`Ruta no inventariada en ROUTES: ${method} ${path}`);
  const guard = requireAccess(spec.access);
  return { preHandler: guard ? [guard] : [] };
}

/**
 * Igual que `routeGuard` pero en `preValidation`: responde 401/403 ANTES de validar cuerpo/query (no expone el esquema
 * ni errores de validación a anónimos). Recomendado para rutas nuevas.
 */
export function routeAuth(method: HttpMethod, path: string): { preValidation: preValidationHookHandler[] } {
  const { preHandler } = routeGuard(method, path);
  return { preValidation: preHandler as unknown as preValidationHookHandler[] };
}

export { ROUTES };

// ---------------------------------------------------------------------------
// Resolución de principales
// ---------------------------------------------------------------------------

interface ResolveDeps {
  prisma: import('@prisma/client').PrismaClient;
  now?: () => Date;
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export async function resolveBearer(
  deps: ResolveDeps,
  token: string,
): Promise<{ principal: Principal } | { error: ErrorCode }> {
  const kind = tokenKindOf(token);
  const now = deps.now?.() ?? new Date();
  if (!kind) return { error: 'TOKEN_REVOKED' };
  const tokenHash = hashToken(token);
  if (kind === 'lease') {
    const lease = await deps.prisma.workerLease.findUnique({
      where: { tokenHash },
      select: { id: true, generation: true, createdAt: true, runShardId: true, runShard: { select: { runId: true } } },
    });
    if (!lease || now.getTime() - lease.createdAt.getTime() > LEASE_TOKEN_AUTH_WINDOW_MS) {
      return { error: 'TOKEN_REVOKED' };
    }
    return {
      principal: {
        kind: 'lease',
        id: lease.id,
        leaseId: lease.id,
        shardId: lease.runShardId,
        runId: lease.runShard.runId,
        generation: lease.generation,
      },
    };
  }
  if (kind !== 'apiToken' && kind !== 'service' && kind !== 'device') return { error: 'TOKEN_REVOKED' };
  const cred = await deps.prisma.apiCredential.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      kind: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      principal: { select: { id: true, role: true, disabledAt: true } },
      device: { select: { id: true, revokedAt: true, expiresAt: true } },
    },
  });
  if (!cred || cred.revokedAt || (cred.expiresAt && cred.expiresAt <= now)) return { error: 'TOKEN_REVOKED' };
  if (!cred.lastUsedAt || now.getTime() - cred.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    void deps.prisma.apiCredential
      .update({ where: { id: cred.id }, data: { lastUsedAt: now } })
      .catch(() => undefined);
  }
  if (kind === 'service') {
    if (cred.kind !== 'servicio_supervisor') return { error: 'TOKEN_REVOKED' };
    return { principal: { kind: 'service', id: cred.id, scopes: cred.scopes } };
  }
  if (!cred.principal || cred.principal.disabledAt) return { error: 'USER_DISABLED' };
  if (kind === 'apiToken') {
    if (cred.kind !== 'token_api') return { error: 'TOKEN_REVOKED' };
    return { principal: { kind: 'api_token', id: cred.id, role: cred.principal.role, scopes: cred.scopes } };
  }
  if (cred.kind !== 'dispositivo' || !cred.device || cred.device.revokedAt) return { error: 'TOKEN_REVOKED' };
  if (cred.device.expiresAt && cred.device.expiresAt <= now) return { error: 'TOKEN_REVOKED' };
  return { principal: { kind: 'device', id: cred.device.id, userId: cred.principal.id, role: cred.principal.role } };
}

const SESSION_TOUCH_MS = 60 * 1000;

export async function resolveSession(
  deps: ResolveDeps,
  token: string,
): Promise<{ principal: Principal; csrfHash: string } | { error: ErrorCode }> {
  if (tokenKindOf(token) !== 'session') return { error: 'UNAUTHENTICATED' };
  const now = deps.now?.() ?? new Date();
  const session = await deps.prisma.panelSession.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      csrfHash: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: { select: { id: true, email: true, role: true, disabledAt: true } },
    },
  });
  if (!session || session.revokedAt) return { error: 'UNAUTHENTICATED' };
  if (session.expiresAt <= now) return { error: 'SESSION_EXPIRED' };
  if (session.user.disabledAt) return { error: 'USER_DISABLED' };
  if (!session.lastSeenAt || now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    void deps.prisma.panelSession
      .update({ where: { id: session.id }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }
  return {
    principal: {
      kind: 'panel_user',
      id: session.user.id,
      role: session.user.role,
      email: session.user.email,
      sessionId: session.id,
    },
    csrfHash: session.csrfHash,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** ¿El Origin/Referer de una solicitud no segura es aceptable? (ESP §13.7: CSRF con cookies y CORS cerrado). */
export function originAllowed(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return allowed.has(origin);
  if (origin === 'null') return false;
  const referer = request.headers.referer;
  if (typeof referer === 'string') {
    const o = originOf(referer);
    return o !== null && allowed.has(o);
  }
  // Sin Origin ni Referer (clientes no navegador): se acepta; el CSRF token sigue siendo obligatorio con cookie.
  return true;
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const config = app.deps.config;
  const cookieName = sessionCookieName(config);
  const csrfHeader = config.CSRF_HEADER_NAME.toLowerCase();
  const allowedOrigins = new Set(
    [config.PUBLIC_BASE_URL, ...config.CORS_ALLOWED_ORIGINS, ...(opts.extraAllowedOrigins ?? [])]
      .map(originOf)
      .filter((o): o is string => !!o),
  );
  const deps: ResolveDeps = { prisma: app.deps.prisma };

  if (!app.hasRequestDecorator('principal')) app.decorateRequest('principal', undefined);
  if (!app.hasRequestDecorator('authError')) app.decorateRequest('authError', undefined);
  if (!app.hasRequestDecorator('sessionToken')) app.decorateRequest('sessionToken', undefined);

  app.addHook('onRequest', async (request) => {
    const unsafe = UNSAFE_METHODS.has(request.method);
    const authz = request.headers.authorization;
    if (typeof authz === 'string' && authz.length > 0) {
      const m = /^Bearer\s+(\S+)$/i.exec(authz);
      if (!m) {
        metrics.authFailures.inc({ reason: 'bearer_malformed' });
        throw new KatalystError('UNAUTHENTICATED');
      }
      const r = await resolveBearer(deps, m[1]!);
      if ('error' in r) {
        metrics.authFailures.inc({ reason: 'bearer_invalid' });
        throw new KatalystError(r.error);
      }
      request.principal = r.principal;
      return;
    }

    // Login y demás rutas públicas no seguras: verificación de origen (login CSRF).
    if (unsafe && !originAllowed(request, allowedOrigins)) {
      metrics.authFailures.inc({ reason: 'origin' });
      throw new KatalystError('CSRF_INVALID');
    }

    const cookie = request.cookies?.[cookieName];
    if (!cookie) return;
    const r = await resolveSession(deps, cookie);
    if ('error' in r) {
      request.authError = r.error;
      return;
    }
    if (unsafe) {
      const header = request.headers[csrfHeader];
      const supplied = typeof header === 'string' ? header : '';
      if (!supplied || !safeEqual(hashToken(supplied), r.csrfHash) || !safeEqual(supplied, csrfTokenFor(cookie))) {
        metrics.authFailures.inc({ reason: 'csrf' });
        throw new KatalystError('CSRF_INVALID');
      }
    }
    request.principal = r.principal;
    request.sessionToken = cookie;
  });
};

export const authPlugin = fp(authPluginImpl, { name: 'katalyst-auth', fastify: '5.x' });

/** Comprueba que cada ruta registrada bajo /api/v1 esté en ROUTES y viceversa (para pruebas). */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
