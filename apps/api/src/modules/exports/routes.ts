/**
 * Módulo exports: CSV/PDF en servidor con los mismos permisos y filtros que los listados; página vs conjunto
 * completo explícito; grandes exportaciones como trabajo con archivo privado y vencimiento. RF-RES-04 (ESP §17.3/4).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ExportCreateSchema, ExportDownloadResponseSchema, ExportJobSchema, IdParamsSchema } from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { createExport, downloadExport, getExport } from './service.js';

export const exportsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const deps = { config, logger: app.log as never };
  const tags = ['exports'];

  app.post(
    '/exports',
    {
      ...routeGuard('POST', '/exports'),
      schema: {
        tags,
        summary: 'Exportar resultados (CSV/PDF)',
        description: '`pagina` se genera en línea (201, `listo`); `completo` crea un trabajo diferido (202, `pendiente`).',
        body: ExportCreateSchema,
        response: { 201: ExportJobSchema, 202: ExportJobSchema },
      },
    },
    async (request, reply) => {
      const r = await createExport(prisma, deps, request.principal!, request.body, String(request.id));
      return reply.status(r.deferred ? 202 : 201).send(r.job);
    },
  );

  app.get(
    '/exports/:id',
    {
      ...routeGuard('GET', '/exports/:id'),
      schema: { tags, summary: 'Estado de la exportación', params: IdParamsSchema, response: { 200: ExportJobSchema } },
    },
    async (request) => getExport(prisma, request.principal!, request.params.id),
  );

  app.get(
    '/exports/:id/download',
    {
      ...routeGuard('GET', '/exports/:id/download'),
      schema: { tags, summary: 'URL firmada de descarga (≤ 5 min)', params: IdParamsSchema, response: { 200: ExportDownloadResponseSchema } },
    },
    async (request) => downloadExport(prisma, deps, request.principal!, request.params.id),
  );
};

export default exportsRoutes;
