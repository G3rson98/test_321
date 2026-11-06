/**
 * Módulo alerts: consulta de alertas de umbral y de corridas (activas/recuperadas, último envío, entregas).
 * RF-REN-03, RF-NOT-01, RF-NOT-02. La evaluación vive en `src/control/perf-evaluator.ts`.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AlertListQuerySchema, AlertSchema, IdParamsSchema, pageSchema } from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { getAlert, listAlerts } from './service.js';

export const alertsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma } = app.deps;
  app.get(
    '/alerts',
    {
      ...routeGuard('GET', '/alerts'),
      schema: { tags: ['alerts'], summary: 'Alertas', querystring: AlertListQuerySchema, response: { 200: pageSchema(AlertSchema) } },
    },
    async (request) => listAlerts(prisma, request.query),
  );
  app.get(
    '/alerts/:id',
    {
      ...routeGuard('GET', '/alerts/:id'),
      schema: { tags: ['alerts'], summary: 'Detalle de alerta', params: IdParamsSchema, response: { 200: AlertSchema } },
    },
    async (request) => getAlert(prisma, request.params.id),
  );
};

export default alertsRoutes;
