/**
 * Consulta del registro de auditoría (admin) con filtros y paginación por cursor (más reciente primero, desempate
 * por UUID; índice `(created_at, id)`). RF-USR-02.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuditLog, Prisma } from '@prisma/client';
import { AuditEntrySchema, AuditListQuerySchema, pageSchema } from '@katalyst/shared';
import { routeAuth } from '../../lib/auth.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, type SortSpec } from '../../lib/pagination.js';

const SORT: SortSpec = { field: 'createdAt', direction: 'desc', type: 'date' };

export function toAuditDto(a: AuditLog) {
  return {
    id: a.id,
    actorKind: a.actorKind,
    actorId: a.actorId,
    actorDisplay: a.actorDisplay,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    diff: a.diff && typeof a.diff === 'object' && !Array.isArray(a.diff) ? (a.diff as Record<string, unknown>) : null,
    requestId: a.requestId,
    createdAt: a.createdAt.toISOString(),
  };
}

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma } = app.deps;
  app.get(
    '/audit-log',
    {
      ...routeAuth('GET', '/audit-log'),
      schema: {
        tags: ['audit'],
        summary: 'Registro de auditoría (admin)',
        querystring: AuditListQuerySchema,
        response: { 200: pageSchema(AuditEntrySchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, SORT);
      const where: Prisma.AuditLogWhereInput = {
        AND: [
          q.actorId ? { actorId: q.actorId } : {},
          q.action ? { action: q.action } : {},
          q.entity ? { entity: q.entity } : {},
          q.entityId ? { entityId: q.entityId } : {},
          q.from ? { createdAt: { gte: new Date(q.from) } } : {},
          q.to ? { createdAt: { lt: new Date(q.to) } } : {},
          keysetWhere(SORT, after),
        ],
      };
      const rows = await prisma.auditLog.findMany({ where, orderBy: keysetOrderBy(SORT), take: q.limit + 1 });
      return paginateMapped(rows, q.limit, SORT, toAuditDto);
    },
  );
};

export default auditRoutes;
