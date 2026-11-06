/**
 * Módulo schedules: CRUD con editor visual/cron, vista previa con la misma política DST que la admisión, próximas N,
 * pausar/reanudar/duplicar/borrar lógico, historial de revisiones con autor, ocurrencias y ventanas de exclusión.
 * RF-PRG-01, RF-PRG-02, RF-PRG-03, RF-PRG-04, RF-PRG-05.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ExclusionWindowCreateSchema,
  ExclusionWindowListQuerySchema,
  ExclusionWindowSchema,
  IdParamsSchema,
  KatalystError,
  ScheduleCreateSchema,
  ScheduleDuplicateRequestSchema,
  ScheduleListQuerySchema,
  ScheduleNextQuerySchema,
  ScheduleNextResponseSchema,
  ScheduleOccurrenceListQuerySchema,
  ScheduleOccurrenceSchema,
  SchedulePreviewRequestSchema,
  SchedulePreviewResponseSchema,
  ScheduleRevisionSchema,
  ScheduleSchema,
  ScheduleUpdateSchema,
  CursorQuerySchema,
  pageSchema,
  previewOccurrences,
  OkResponseSchema,
} from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { recordAudit } from '../../lib/audit.js';
import { runInTransaction } from '../../lib/events-publish.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, parseSort } from '../../lib/pagination.js';
import { loadRuntimeSettings } from '../../services/run-planner.js';
import {
  compileSchedule,
  createSchedule,
  deleteSchedule,
  duplicateSchedule,
  getSchedule,
  scheduleNext,
  setSchedulePaused,
  toScheduleDto,
  lastOccurrencesFor,
  updateSchedule,
} from '../../services/scheduler.js';
import { principalOf, scheduleDepsOf } from '../runs/deps.js';
import { closeScheduleTriggers, notifyScheduleChanged } from './triggers.js';

const TAGS = ['schedules'];

export const schedulesRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = () => ({ ...scheduleDepsOf(app), onChanged: (id: string) => notifyScheduleChanged(app, id) });
  app.addHook('onClose', async () => closeScheduleTriggers(app));

  app.post(
    '/schedules/preview',
    {
      ...routeGuard('POST', '/schedules/preview'),
      schema: { tags: TAGS, body: SchedulePreviewRequestSchema, response: { 200: SchedulePreviewResponseSchema } },
    },
    async (request) => {
      const b = request.body;
      const settings = await loadRuntimeSettings(app.deps.prisma);
      const after = b.after ? new Date(b.after) : new Date();
      try {
        const c = compileSchedule(b, settings.schedule.minIntervalMinutes);
        return {
          cronExpressions: c.cronExpressions,
          description: c.description,
          timezone: b.timezone,
          occurrences: previewOccurrences(c.cronExpressions, b.timezone, after, b.count),
          issues: [],
        };
      } catch (err) {
        if (!(err instanceof KatalystError)) throw err;
        return {
          cronExpressions: b.cronExpressions ?? [],
          description: null,
          timezone: b.timezone,
          occurrences: [],
          issues: [{ code: err.code, message: err.message }],
        };
      }
    },
  );

  app.get(
    '/schedules',
    {
      ...routeGuard('GET', '/schedules'),
      schema: { tags: TAGS, querystring: ScheduleListQuerySchema, response: { 200: pageSchema(ScheduleSchema) } },
    },
    async (request) => {
      const q = request.query;
      const sort = parseSort(q.sort, { name: 'string', createdAt: 'date', updatedAt: 'date' });
      const after = decodePageCursor(q.cursor, sort);
      const rows = await app.deps.prisma.schedule.findMany({
        where: {
          AND: [
            {
              deletedAt: null,
              ...(q.environmentId ? { environmentId: q.environmentId } : {}),
              ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
              ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
            },
            keysetWhere(sort, after),
          ],
        },
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      const now = new Date();
      const page = paginateMapped(rows, q.limit, sort, (r) => r);
      // Últimas ocurrencias en una sola consulta (sin N+1, RNF-OPT-05).
      const lasts = await lastOccurrencesFor(app.deps.prisma, page.items.map((r) => r.id));
      return { ...page, items: await Promise.all(page.items.map((r) => toScheduleDto(app.deps.prisma, r, now, lasts.get(r.id) ?? null))) };
    },
  );

  app.post(
    '/schedules',
    {
      ...routeGuard('POST', '/schedules'),
      schema: { tags: TAGS, body: ScheduleCreateSchema, response: { 201: ScheduleSchema } },
    },
    async (request, reply) => {
      const s = await createSchedule(deps(), request.body, principalOf(request), new Date(), request.requestId);
      return reply.status(201).send(s);
    },
  );

  app.get(
    '/schedules/:id',
    { ...routeGuard('GET', '/schedules/:id'), schema: { tags: TAGS, params: IdParamsSchema, response: { 200: ScheduleSchema } } },
    async (request) => getSchedule(app.deps.prisma, request.params.id),
  );

  app.put(
    '/schedules/:id',
    {
      ...routeGuard('PUT', '/schedules/:id'),
      schema: { tags: TAGS, params: IdParamsSchema, body: ScheduleUpdateSchema, response: { 200: ScheduleSchema } },
    },
    async (request) => updateSchedule(deps(), request.params.id, request.body, principalOf(request), new Date(), request.requestId),
  );

  app.delete(
    '/schedules/:id',
    { ...routeGuard('DELETE', '/schedules/:id'), schema: { tags: TAGS, params: IdParamsSchema, response: { 200: OkResponseSchema } } },
    async (request) => {
      await deleteSchedule(deps(), request.params.id, principalOf(request), new Date(), request.requestId);
      return { ok: true as const };
    },
  );

  app.post(
    '/schedules/:id/pause',
    { ...routeGuard('POST', '/schedules/:id/pause'), schema: { tags: TAGS, params: IdParamsSchema, response: { 200: ScheduleSchema } } },
    async (request) => setSchedulePaused(deps(), request.params.id, true, principalOf(request), new Date(), request.requestId),
  );

  app.post(
    '/schedules/:id/resume',
    { ...routeGuard('POST', '/schedules/:id/resume'), schema: { tags: TAGS, params: IdParamsSchema, response: { 200: ScheduleSchema } } },
    async (request) => setSchedulePaused(deps(), request.params.id, false, principalOf(request), new Date(), request.requestId),
  );

  app.post(
    '/schedules/:id/duplicate',
    {
      ...routeGuard('POST', '/schedules/:id/duplicate'),
      schema: { tags: TAGS, params: IdParamsSchema, body: ScheduleDuplicateRequestSchema.optional(), response: { 201: ScheduleSchema } },
    },
    async (request, reply) => {
      const s = await duplicateSchedule(deps(), request.params.id, request.body?.name, principalOf(request), new Date(), request.requestId);
      return reply.status(201).send(s);
    },
  );

  app.get(
    '/schedules/:id/next',
    {
      ...routeGuard('GET', '/schedules/:id/next'),
      schema: { tags: TAGS, params: IdParamsSchema, querystring: ScheduleNextQuerySchema, response: { 200: ScheduleNextResponseSchema } },
    },
    async (request) =>
      scheduleNext(app.deps.prisma, request.params.id, request.query.count, request.query.after ? new Date(request.query.after) : new Date()),
  );

  app.get(
    '/schedules/:id/revisions',
    {
      ...routeGuard('GET', '/schedules/:id/revisions'),
      schema: { tags: TAGS, params: IdParamsSchema, querystring: CursorQuerySchema, response: { 200: pageSchema(ScheduleRevisionSchema) } },
    },
    async (request) => {
      const exists = await app.deps.prisma.schedule.count({ where: { id: request.params.id } });
      if (!exists) throw new KatalystError('NOT_FOUND');
      const sort = parseSort('-revision', { revision: 'number' });
      const after = decodePageCursor(request.query.cursor, sort);
      const rows = await app.deps.prisma.scheduleRevision.findMany({
        where: { AND: [{ scheduleId: request.params.id }, keysetWhere(sort, after)] },
        include: { changedBy: { select: { id: true, name: true } } },
        orderBy: keysetOrderBy(sort),
        take: request.query.limit + 1,
      });
      return paginateMapped(rows, request.query.limit, sort, (r) => ({
        scheduleId: r.scheduleId,
        revision: r.revision,
        changedBy: r.changedBy
          ? { id: r.changedBy.id, kind: 'panel_user' as const, displayName: r.changedBy.name }
          : { id: null, kind: 'sistema' as const, displayName: 'sistema' },
        changedAt: r.createdAt.toISOString(),
        action: r.action as z.infer<typeof ScheduleRevisionSchema>['action'],
        diff: (r.diff ?? {}) as Record<string, unknown>,
      }));
    },
  );

  app.get(
    '/schedules/:id/occurrences',
    {
      ...routeGuard('GET', '/schedules/:id/occurrences'),
      schema: {
        tags: TAGS,
        params: IdParamsSchema,
        querystring: ScheduleOccurrenceListQuerySchema,
        response: { 200: pageSchema(ScheduleOccurrenceSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const exists = await app.deps.prisma.schedule.count({ where: { id: request.params.id } });
      if (!exists) throw new KatalystError('NOT_FOUND');
      const sort = parseSort('-scheduledFor', { scheduledFor: 'date' });
      const after = decodePageCursor(q.cursor, sort);
      const rows = await app.deps.prisma.scheduleOccurrence.findMany({
        where: {
          AND: [
            {
              scheduleId: request.params.id,
              ...(q.status ? { status: q.status } : {}),
              ...(q.from || q.to
                ? { scheduledFor: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } }
                : {}),
            },
            keysetWhere(sort, after),
          ],
        },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, sort, (o) => ({
        id: o.id,
        scheduleId: o.scheduleId,
        scheduleRevision: o.scheduleRevision,
        scheduledFor: o.scheduledFor.toISOString(),
        status: o.status,
        reason: o.reason,
        runId: o.runId,
        admissionDelayMs: o.admittedAt ? o.admittedAt.getTime() - o.scheduledFor.getTime() : null,
        createdAt: o.createdAt.toISOString(),
      }));
    },
  );

  // --- Ventanas de exclusión (RF-PRG-05) -------------------------------------------------------------------------
  const windowDto = (w: {
    id: string;
    environmentId: string | null;
    scheduleId: string | null;
    startsAt: Date;
    endsAt: Date;
    reason: string;
    createdAt: Date;
    createdBy: { id: string; name: string } | null;
  }) => ({
    id: w.id,
    environmentId: w.environmentId,
    scheduleId: w.scheduleId,
    startsAt: w.startsAt.toISOString(),
    endsAt: w.endsAt.toISOString(),
    reason: w.reason,
    createdBy: w.createdBy
      ? { id: w.createdBy.id, kind: 'panel_user' as const, displayName: w.createdBy.name }
      : { id: null, kind: 'sistema' as const, displayName: 'sistema' },
    createdAt: w.createdAt.toISOString(),
  });

  app.get(
    '/exclusion-windows',
    {
      ...routeGuard('GET', '/exclusion-windows'),
      schema: { tags: TAGS, querystring: ExclusionWindowListQuerySchema, response: { 200: pageSchema(ExclusionWindowSchema) } },
    },
    async (request) => {
      const q = request.query;
      const sort = parseSort('-startsAt', { startsAt: 'date' });
      const after = decodePageCursor(q.cursor, sort);
      const at = q.activeAt ? new Date(q.activeAt) : null;
      const rows = await app.deps.prisma.exclusionWindow.findMany({
        where: {
          AND: [
            {
              deletedAt: null,
              ...(q.environmentId ? { environmentId: q.environmentId } : {}),
              ...(q.scheduleId ? { scheduleId: q.scheduleId } : {}),
              ...(at ? { startsAt: { lte: at }, endsAt: { gt: at } } : {}),
            },
            keysetWhere(sort, after),
          ],
        },
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, sort, windowDto);
    },
  );

  app.post(
    '/exclusion-windows',
    {
      ...routeGuard('POST', '/exclusion-windows'),
      schema: { tags: TAGS, body: ExclusionWindowCreateSchema, response: { 201: ExclusionWindowSchema } },
    },
    async (request, reply) => {
      const b = request.body;
      const actor = principalOf(request);
      const w = await runInTransaction(app.deps.prisma, async (tx) => {
        if (b.environmentId && !(await tx.environment.count({ where: { id: b.environmentId } }))) {
          throw new KatalystError('SELECTION_FOREIGN_IDS', undefined, { reasons: ['environmentId'] });
        }
        if (b.scheduleId && !(await tx.schedule.count({ where: { id: b.scheduleId, deletedAt: null } }))) {
          throw new KatalystError('SELECTION_FOREIGN_IDS', undefined, { reasons: ['scheduleId'] });
        }
        const row = await tx.exclusionWindow.create({
          data: {
            environmentId: b.environmentId,
            scheduleId: b.scheduleId,
            startsAt: new Date(b.startsAt),
            endsAt: new Date(b.endsAt),
            reason: b.reason,
            createdById: actor.kind === 'panel_user' ? actor.id : null,
          },
          include: { createdBy: { select: { id: true, name: true } } },
        });
        await recordAudit(tx, {
          actor,
          action: 'exclusion_window.create',
          entity: 'exclusion_window',
          entityId: row.id,
          diff: b,
          requestId: request.requestId,
        });
        return row;
      });
      return reply.status(201).send(windowDto(w));
    },
  );

  app.delete(
    '/exclusion-windows/:id',
    {
      ...routeGuard('DELETE', '/exclusion-windows/:id'),
      schema: { tags: TAGS, params: IdParamsSchema, response: { 200: OkResponseSchema } },
    },
    async (request) => {
      const actor = principalOf(request);
      await runInTransaction(app.deps.prisma, async (tx) => {
        const w = await tx.exclusionWindow.findUnique({ where: { id: request.params.id } });
        if (!w || w.deletedAt) throw new KatalystError('NOT_FOUND');
        await tx.exclusionWindow.update({ where: { id: w.id }, data: { deletedAt: new Date() } });
        await recordAudit(tx, {
          actor,
          action: 'exclusion_window.delete',
          entity: 'exclusion_window',
          entityId: w.id,
          requestId: request.requestId,
        });
      });
      return { ok: true as const };
    },
  );
};

export default schedulesRoutes;
