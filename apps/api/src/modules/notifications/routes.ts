/**
 * Módulo notifications: canales del equipo (admin; secretos solo por referencia), prueba de envío y preferencias
 * personales (programaciones/alertas que recibe cada usuario). RF-NOT-01, RF-NOT-02, RF-NOT-03.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  NotificationChannelParamsSchema,
  NotificationChannelSchema,
  NotificationChannelTestResponseSchema,
  NotificationChannelUpdateSchema,
  NotificationPreferencesSchema,
  NotificationPreferencesUpdateSchema,
} from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { assertSecretRefAdministrable } from '../environments/service.js';
import { actorUserId } from '../recordings/service.js';
import { listChannels, testChannel, toChannelDto, updateChannel } from './channels.js';
import { getPreferences, updatePreferences } from './preferences.js';

export const notificationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const tags = ['notifications'];

  app.get(
    '/notifications/channels',
    {
      ...routeGuard('GET', '/notifications/channels'),
      schema: { tags, summary: 'Canales de notificación', response: { 200: z.object({ items: z.array(NotificationChannelSchema) }) } },
    },
    async () => ({ items: (await listChannels(prisma, config)).map(toChannelDto) }),
  );

  app.put(
    '/notifications/channels/:kind',
    {
      ...routeGuard('PUT', '/notifications/channels/:kind'),
      schema: {
        tags,
        summary: 'Configurar canal (correo SMTP, Slack o Teams; webhook/credencial por referencia)',
        params: NotificationChannelParamsSchema,
        body: NotificationChannelUpdateSchema,
        response: { 200: NotificationChannelSchema },
      },
    },
    async (request) => {
      if (request.body.secretRef) assertSecretRefAdministrable(request.body.secretRef);
      const c = await updateChannel(prisma, config, request.principal!, request.params.kind, request.body, String(request.id));
      return toChannelDto(c);
    },
  );

  app.post(
    '/notifications/channels/:kind/test',
    {
      ...routeGuard('POST', '/notifications/channels/:kind/test'),
      schema: { tags, summary: 'Enviar mensaje de prueba', params: NotificationChannelParamsSchema, response: { 200: NotificationChannelTestResponseSchema } },
    },
    async (request) => testChannel(prisma, config, request.principal!, request.params.kind, { requestId: String(request.id) }),
  );

  app.get(
    '/notifications/preferences',
    {
      ...routeGuard('GET', '/notifications/preferences'),
      schema: { tags, summary: 'Mis preferencias de notificación', response: { 200: NotificationPreferencesSchema } },
    },
    async (request) => getPreferences(prisma, await actorUserId(prisma, request.principal!)),
  );

  app.put(
    '/notifications/preferences',
    {
      ...routeGuard('PUT', '/notifications/preferences'),
      schema: { tags, summary: 'Actualizar mis preferencias', body: NotificationPreferencesUpdateSchema, response: { 200: NotificationPreferencesSchema } },
    },
    async (request) => {
      const userId = await actorUserId(prisma, request.principal!);
      return updatePreferences(prisma, request.principal!, userId, request.body, String(request.id));
    },
  );
};

export default notificationsRoutes;
