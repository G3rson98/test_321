/**
 * Módulo runs: vista previa, creación idempotente (Idempotency-Key por actor), lista/detalle con resultados por
 * intento/test/caso, destinos TestRail y cancelación idempotente.
 * RF-EJE-01, RF-EJE-03, RF-EJE-06, RF-EJE-07, RF-RES-01, RF-RES-05, RF-TR-04, RF-TR-08.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CaseResultSchema,
  CursorQuerySchema,
  HomeSummaryQuerySchema,
  HomeSummarySchema,
  IdParamsSchema,
  IdempotencyKeySchema,
  KatalystError,
  RunCancelRequestSchema,
  RunCancelResponseSchema,
  RunCreateRequestSchema,
  RunDetailSchema,
  RunListQuerySchema,
  RunPreviewRequestSchema,
  RunPreviewResponseSchema,
  RunResultListQuerySchema,
  RunResultParamsSchema,
  RunResultSchema,
  RunSummarySchema,
  RunTestRailTargetSchema,
  TestAttemptSchema,
  normalizeSelection,
  pageSchema,
} from '@katalyst/shared';
import { hasPermission, routeGuard } from '../../lib/auth.js';
import { resolvePlan } from '../../services/run-planner.js';
import { admitPendingShards, createRunIdempotent } from '../../services/run-admission.js';
import { requestCancel } from '../../services/cancellation.js';
import { getRunSummary } from '../../services/results.js';
import { registerRunMetrics } from '../../control/lease-watchdog.js';
import { cancelDepsOf, principalOf, runDepsOf } from './deps.js';
import { getHomeSummary } from './summary.js';
import { getRunDetail, listAttempts, listCaseResults, listResults, listRuns, listTargets } from './queries.js';

const TAGS = ['runs'];

export const runsRoutes: FastifyPluginAsyncZod = async (app) => {
  // Métricas de cola/leases/almacenamiento también en el `/metrics` de la API (colector idempotente por nombre).
  registerRunMetrics(app.deps.prisma);
  app.post(
    '/runs/preview',
    {
      ...routeGuard('POST', '/runs/preview'),
      schema: {
        tags: TAGS,
        summary: 'Plan resuelto sin ejecutar (RF-EJE-07)',
        body: RunPreviewRequestSchema,
        response: { 200: RunPreviewResponseSchema },
      },
    },
    async (request) => {
      const b = request.body;
      const plan = await resolvePlan(app.deps.prisma, {
        selection: normalizeSelection(b),
        environmentId: b.environmentId,
        retries: b.retries,
        excludeFlaky: b.excludeFlaky,
        testrail: b.testrail,
        trigger: 'manual',
      });
      return plan.preview;
    },
  );

  app.post(
    '/runs',
    {
      ...routeGuard('POST', '/runs'),
      schema: {
        tags: TAGS,
        summary: 'Ejecutar ahora (Idempotency-Key obligatorio)',
        body: RunCreateRequestSchema,
        response: { 200: RunSummarySchema, 201: RunSummarySchema },
      },
    },
    async (request, reply) => {
      const raw = request.headers['idempotency-key'];
      const key = IdempotencyKeySchema.safeParse(typeof raw === 'string' ? raw : undefined);
      if (!key.success) throw new KatalystError('IDEMPOTENCY_KEY_REQUIRED');
      const deps = runDepsOf(app);
      const res = await createRunIdempotent(deps, {
        body: request.body,
        idempotencyKey: key.data,
        actor: principalOf(request),
        requestId: request.requestId,
      });
      if (res.created) {
        // Admisión inmediata (best effort); el proceso de control reintenta mientras no haya capacidad.
        await admitPendingShards(deps, new Date(), { runId: res.runId }).catch((err: unknown) =>
          request.log.warn({ err, runId: res.runId }, 'admisión diferida'),
        );
      }
      request.log.info({ runId: res.runId, created: res.created }, 'corrida solicitada');
      const run = res.created ? await getRunSummary(app.deps.prisma, res.runId) : res.run;
      return reply.status(res.created ? 201 : 200).send(run);
    },
  );

  app.get(
    '/runs',
    {
      ...routeGuard('GET', '/runs'),
      schema: { tags: TAGS, querystring: RunListQuerySchema, response: { 200: pageSchema(RunSummarySchema) } },
    },
    async (request) => listRuns(app.deps.prisma, request.query),
  );

  app.get(
    '/runs/summary',
    {
      ...routeGuard('GET', '/runs/summary'),
      schema: {
        tags: TAGS,
        summary: 'Resumen del inicio: éxito 7 días, corridas de hoy, activas y próximas programaciones',
        querystring: HomeSummaryQuerySchema,
        response: { 200: HomeSummarySchema },
      },
    },
    async (request) =>
      getHomeSummary(app.deps.prisma, {
        todayFrom: request.query.todayFrom,
        includeSchedules: hasPermission(request.principal, 'schedules.read'),
      }),
  );

  app.get(
    '/runs/:id',
    {
      ...routeGuard('GET', '/runs/:id'),
      schema: { tags: TAGS, params: IdParamsSchema, response: { 200: RunDetailSchema } },
    },
    async (request) => getRunDetail(app.deps.prisma, request.params.id),
  );

  app.get(
    '/runs/:id/results',
    {
      ...routeGuard('GET', '/runs/:id/results'),
      schema: {
        tags: TAGS,
        params: IdParamsSchema,
        querystring: RunResultListQuerySchema,
        response: { 200: pageSchema(RunResultSchema) },
      },
    },
    async (request) => listResults(app.deps.prisma, request.params.id, request.query),
  );

  app.get(
    '/runs/:id/results/:resultId/attempts',
    {
      ...routeGuard('GET', '/runs/:id/results/:resultId/attempts'),
      schema: {
        tags: TAGS,
        params: RunResultParamsSchema,
        response: { 200: z.object({ items: z.array(TestAttemptSchema) }) },
      },
    },
    async (request) => listAttempts(app.deps.prisma, request.params.id, request.params.resultId),
  );

  app.get(
    '/runs/:id/case-results',
    {
      ...routeGuard('GET', '/runs/:id/case-results'),
      schema: {
        tags: TAGS,
        params: IdParamsSchema,
        querystring: CursorQuerySchema,
        response: { 200: pageSchema(CaseResultSchema) },
      },
    },
    async (request) => listCaseResults(app.deps.prisma, request.params.id, request.query),
  );

  app.get(
    '/runs/:id/targets',
    {
      ...routeGuard('GET', '/runs/:id/targets'),
      schema: {
        tags: TAGS,
        params: IdParamsSchema,
        response: { 200: z.object({ items: z.array(RunTestRailTargetSchema) }) },
      },
    },
    async (request) => {
      const exists = await app.deps.prisma.run.count({ where: { id: request.params.id } });
      if (!exists) throw new KatalystError('NOT_FOUND');
      return { items: await listTargets(app.deps.prisma, request.params.id) };
    },
  );

  app.post(
    '/runs/:id/cancel',
    {
      ...routeGuard('POST', '/runs/:id/cancel'),
      schema: {
        tags: TAGS,
        summary: 'Cancelar (idempotente, ≤ 30 s)',
        params: IdParamsSchema,
        body: RunCancelRequestSchema.optional(),
        response: { 200: RunCancelResponseSchema },
      },
    },
    async (request) => {
      const res = await requestCancel(cancelDepsOf(app), request.params.id, principalOf(request), {
        ...(request.body?.reason ? { reason: request.body.reason } : {}),
        requestId: request.requestId,
      });
      request.log.info({ runId: request.params.id, stopConfirmed: res.stopConfirmed }, 'cancelación solicitada');
      return res;
    },
  );
};

export default runsRoutes;
