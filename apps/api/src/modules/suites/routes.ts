/**
 * Suites con nombre (RF-CAT-03): CRUD con selector validado, auditoría, concurrencia optimista y borrado lógico
 * (las corridas/programaciones históricas conservan la referencia).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Prisma } from '@prisma/client';
import {
  IdParamsSchema,
  KatalystError,
  SuiteCreateSchema,
  SuiteListQuerySchema,
  SuiteSchema,
  SuiteUpdateSchema,
  pageSchema,
} from '@katalyst/shared';
import { routeAuth } from '../../lib/auth.js';
import { recordAudit, shallowDiff } from '../../lib/audit.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';
import { resolveSuiteSelector, toSuiteDto, validateSuiteSelector } from './service.js';

export const suitesRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/suites',
    {
      ...routeAuth('GET', '/suites'),
      schema: { tags: ['suites'], summary: 'Suites guardadas', querystring: SuiteListQuerySchema, response: { 200: pageSchema(SuiteSchema) } },
    },
    async (request) => {
      const q = request.query;
      const sort = parseSort(q.sort, { name: 'string', updatedAt: 'date' });
      const after = decodePageCursor(q.cursor, sort);
      const rows = await prisma.suite.findMany({
        where: {
          AND: [{ deletedAt: null }, q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}, keysetWhere(sort, after)],
        },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      const page = paginate(rows, q.limit, sort);
      return { ...page, items: page.items.map((s) => toSuiteDto(s)) };
    },
  );

  app.post(
    '/suites',
    {
      ...routeAuth('POST', '/suites'),
      schema: { tags: ['suites'], summary: 'Crear suite', body: SuiteCreateSchema, response: { 201: SuiteSchema } },
    },
    async (request, reply) => {
      const b = request.body;
      const createdById = request.principal?.kind === 'panel_user' ? request.principal.id : null;
      const out = await prisma.$transaction(async (tx) => {
        await validateSuiteSelector(tx, b.selector);
        const s = await tx.suite.create({
          data: { name: b.name, description: b.description ?? null, selector: b.selector as Prisma.InputJsonValue, createdById },
        });
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'suite.create',
          entity: 'suite',
          entityId: s.id,
          diff: { name: b.name, selector: b.selector },
          requestId: request.requestId,
        });
        return { s, resolved: await resolveSuiteSelector(tx, s.selector) };
      });
      return reply.status(201).send(toSuiteDto(out.s, out.resolved));
    },
  );

  app.get(
    '/suites/:id',
    {
      ...routeAuth('GET', '/suites/:id'),
      schema: { tags: ['suites'], summary: 'Detalle con conteos resueltos (informativos)', params: IdParamsSchema, response: { 200: SuiteSchema } },
    },
    async (request) => {
      const s = await prisma.suite.findUnique({ where: { id: request.params.id } });
      if (!s) throw new KatalystError('NOT_FOUND');
      return toSuiteDto(s, s.deletedAt ? undefined : await resolveSuiteSelector(prisma, s.selector));
    },
  );

  app.put(
    '/suites/:id',
    {
      ...routeAuth('PUT', '/suites/:id'),
      schema: { tags: ['suites'], summary: 'Actualizar suite (versión optimista)', params: IdParamsSchema, body: SuiteUpdateSchema, response: { 200: SuiteSchema } },
    },
    async (request) => {
      const b = request.body;
      const out = await prisma.$transaction(async (tx) => {
        const cur = await tx.suite.findUnique({ where: { id: request.params.id } });
        if (!cur || cur.deletedAt) throw new KatalystError('NOT_FOUND');
        if (cur.version !== b.version) throw new KatalystError('VERSION_CONFLICT');
        await validateSuiteSelector(tx, b.selector);
        const r = await tx.suite.updateMany({
          where: { id: cur.id, version: b.version },
          data: {
            name: b.name,
            description: b.description ?? null,
            selector: b.selector as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
        if (r.count === 0) throw new KatalystError('VERSION_CONFLICT');
        const after = await tx.suite.findUniqueOrThrow({ where: { id: cur.id } });
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'suite.update',
          entity: 'suite',
          entityId: cur.id,
          diff: shallowDiff(
            { name: cur.name, description: cur.description, selector: cur.selector },
            { name: after.name, description: after.description, selector: after.selector },
            ['name', 'description', 'selector'],
          ),
          requestId: request.requestId,
        });
        return { s: after, resolved: await resolveSuiteSelector(tx, after.selector) };
      });
      return toSuiteDto(out.s, out.resolved);
    },
  );

  app.delete(
    '/suites/:id',
    {
      ...routeAuth('DELETE', '/suites/:id'),
      schema: { tags: ['suites'], summary: 'Borrado lógico (conserva historial)', params: IdParamsSchema, response: { 200: SuiteSchema } },
    },
    async (request) => {
      const s = await prisma.$transaction(async (tx) => {
        const cur = await tx.suite.findUnique({ where: { id: request.params.id } });
        if (!cur || cur.deletedAt) throw new KatalystError('NOT_FOUND');
        const inUse = await tx.schedule.count({ where: { suiteId: cur.id, deletedAt: null } });
        if (inUse > 0) throw new KatalystError('CONFLICT', 'La suite está en uso por programaciones activas.');
        const after = await tx.suite.update({ where: { id: cur.id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
        await recordAudit(tx, { actor: request.principal!, action: 'suite.delete', entity: 'suite', entityId: cur.id, diff: { name: cur.name }, requestId: request.requestId });
        return after;
      });
      return toSuiteDto(s);
    },
  );
};

export default suitesRoutes;
