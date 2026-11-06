/**
 * Módulo devices: flujo de dispositivo del asistente local (ESP §13.6, documentado en OpenAPI) y estado del
 * asistente vinculado. RF-GRB-01, RNF-SEG-01.
 *
 * Contrato (resumen para RECORDER y WEB):
 * - `POST /devices/authorize` (público, rate limit 10/min/IP) → `{deviceCode, userCode, verificationUri,
 *   verificationUriComplete, expiresIn: 300, interval: 5}`.
 * - `POST /devices/token {deviceCode}` (público, rate limit 30/min/IP y por código: intervalo ≥ `interval`):
 *   400 DEVICE_AUTHORIZATION_PENDING | 429 DEVICE_SLOW_DOWN (+5 s) | 400 DEVICE_CODE_EXPIRED | 403 DEVICE_ACCESS_DENIED |
 *   400 DEVICE_CODE_INVALID (incluye código ya consumido) | 200 `{accessToken: 'kdv_…', tokenType: 'Bearer', deviceId, expiresAt}`.
 * - Panel (cookie de sesión obligatoria): `GET /devices/authorizations/:userCode`, `POST /devices/approve|deny {userCode}`.
 * - `GET /devices`, `DELETE /devices/:id` (revoca la credencial), `GET /devices/status`, `POST /devices/heartbeat`
 *   (solo credencial de dispositivo).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DeviceApproveRequestSchema,
  DeviceAuthorizationViewSchema,
  DeviceAuthorizeRequestSchema,
  DeviceAuthorizeResponseSchema,
  DeviceHeartbeatRequestSchema,
  DeviceSchema,
  DeviceStatusResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  DeviceUserCodeParamsSchema,
  IdParamsSchema,
  KatalystError,
  OkResponseSchema,
} from '@katalyst/shared';
import type { FastifyRequest } from 'fastify';
import { hasPermission, isAdmin, requireSession, routeGuard } from '../../lib/auth.js';
import { actorUserId } from '../recordings/service.js';
import {
  decideAuthorization,
  deviceHeartbeat,
  deviceStatus,
  listDevices,
  pollDeviceToken,
  revokeDevice,
  startDeviceAuthorization,
  viewAuthorization,
} from './service.js';

export const devicesRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const tags = ['devices'];
  const sessionGuard = requireSession();
  const withSession = (method: 'GET' | 'POST', path: string) => {
    const g = routeGuard(method, path);
    return { preHandler: [...g.preHandler, sessionGuard] };
  };

  app.post(
    '/devices/authorize',
    {
      ...routeGuard('POST', '/devices/authorize'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: 'Iniciar vínculo del asistente local (flujo de dispositivo)',
        description: 'Devuelve un device_code (secreto del asistente) y un user_code de un solo uso que vence en 5 min.',
        security: [],
        body: DeviceAuthorizeRequestSchema,
        response: { 200: DeviceAuthorizeResponseSchema },
      },
    },
    async (request) => startDeviceAuthorization(prisma, config.PUBLIC_BASE_URL, request.body),
  );

  app.post(
    '/devices/token',
    {
      ...routeGuard('POST', '/devices/token'),
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: 'Consultar la autorización (polling limitado por código)',
        description:
          'Errores: DEVICE_AUTHORIZATION_PENDING (400), DEVICE_SLOW_DOWN (429, Retry-After), DEVICE_CODE_EXPIRED (400), ' +
          'DEVICE_ACCESS_DENIED (403), DEVICE_CODE_INVALID (400). Al aprobarse emite UNA vez la credencial revocable.',
        security: [],
        body: DeviceTokenRequestSchema,
        response: { 200: DeviceTokenResponseSchema },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return pollDeviceToken(prisma, request.body.deviceCode);
    },
  );

  app.get(
    '/devices/authorizations/:userCode',
    {
      ...withSession('GET', '/devices/authorizations/:userCode'),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: 'Ver solicitud de vínculo por código (sesión del panel)',
        params: DeviceUserCodeParamsSchema,
        response: { 200: DeviceAuthorizationViewSchema },
      },
    },
    async (request) => viewAuthorization(prisma, request.params.userCode),
  );

  for (const [path, decision] of [
    ['/devices/approve', 'aprobada'],
    ['/devices/deny', 'denegada'],
  ] as const) {
    app.post(
      path,
      {
        ...withSession('POST', path),
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
        schema: {
          tags,
          summary: decision === 'aprobada' ? 'Aprobar el vínculo (sesión del panel)' : 'Denegar el vínculo (sesión del panel)',
          body: DeviceApproveRequestSchema,
          response: { 200: OkResponseSchema },
        },
      },
      async (request) => {
        const p = request.principal;
        if (p?.kind !== 'panel_user') throw new KatalystError('FORBIDDEN');
        return decideAuthorization(prisma, p, request.body.userCode, decision, String(request.id));
      },
    );
  }

  app.get(
    '/devices',
    {
      ...routeGuard('GET', '/devices'),
      schema: { tags, summary: 'Mis asistentes vinculados', response: { 200: z.object({ items: z.array(DeviceSchema) }) } },
    },
    async (request) => ({ items: await listDevices(prisma, await actorUserId(prisma, request.principal!)) }),
  );

  app.delete(
    '/devices/:id',
    {
      // devices.approve (dueño/admin) o el propio asistente desvinculándose (credencial de ese dispositivo).
      preHandler: [
        async (request: FastifyRequest) => {
          const p = request.principal;
          const self = p?.kind === 'device' && p.id === (request.params as { id?: string }).id;
          if (!self && !hasPermission(p, 'devices.approve')) {
            throw new KatalystError(p ? 'FORBIDDEN' : (request.authError ?? 'UNAUTHENTICATED'));
          }
        },
      ],
      schema: { tags, summary: 'Revocar asistente vinculado', params: IdParamsSchema, response: { 200: OkResponseSchema } },
    },
    async (request) => {
      const p = request.principal!;
      // El propio asistente puede revocarse (desvincular) aunque su credencial no tenga devices.approve.
      const uid = await actorUserId(prisma, p);
      await revokeDevice(prisma, p, request.params.id, (owner) => owner === uid || isAdmin(p), String(request.id));
      return { ok: true as const };
    },
  );

  app.get(
    '/devices/status',
    {
      ...routeGuard('GET', '/devices/status'),
      schema: { tags, summary: 'Disponibilidad del asistente vinculado', response: { 200: DeviceStatusResponseSchema } },
    },
    async (request) => deviceStatus(prisma, await actorUserId(prisma, request.principal!)),
  );

  app.post(
    '/devices/heartbeat',
    {
      ...routeGuard('POST', '/devices/heartbeat'),
      schema: { tags, summary: 'Latido del asistente (credencial de dispositivo)', body: DeviceHeartbeatRequestSchema, response: { 200: OkResponseSchema } },
    },
    async (request) => {
      const p = request.principal;
      if (p?.kind !== 'device') throw new KatalystError('FORBIDDEN');
      return deviceHeartbeat(prisma, p.id, request.body);
    },
  );
};

export default devicesRoutes;
