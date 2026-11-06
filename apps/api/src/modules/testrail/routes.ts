/**
 * Módulo TestRail: conexión (solo referencias de secretos), prueba de conexión, sincronización bajo demanda,
 * árbol/casos del catálogo, historial por caso y lectura de planes/corridas existentes (RF-TR-06).
 * RF-TR-01, RF-TR-02, RF-TR-03, RF-TR-06, RF-TR-07, RF-CAT-02, RF-RES-03.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Prisma, TestRailConnection } from '@prisma/client';
import {
  CursorQuerySchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  IdParamsSchema,
  KatalystError,
  TagSchema,
  TestRailCaseDetailSchema,
  TestRailCaseListQuerySchema,
  TestRailCaseSummarySchema,
  TestRailConnectionSchema,
  TestRailConnectionTestRequestSchema,
  TestRailConnectionTestResponseSchema,
  TestRailConnectionUpdateSchema,
  TestRailPlanSchema,
  TestRailProjectSchema,
  TestRailRunTestsSchema,
  TestRailSectionSchema,
  TestRailSectionsQuerySchema,
  TestRailSuiteSchema,
  TestRailSyncRequestSchema,
  TestRailSyncRunSchema,
  pageSchema,
} from '@katalyst/shared';
import { getTestRailClientFactory } from '../../adapters/testrail/index.js';
import { TestRailError } from '../../adapters/testrail/types.js';
import { routeAuth } from '../../lib/auth.js';
import { recordAudit, shallowDiff } from '../../lib/audit.js';
import { QueryBool, decodePageCursor, keysetOrderBy, keysetWhere, paginate, paginateMapped, type SortSpec } from '../../lib/pagination.js';
import { getSecretProvider, SecretUnavailableError } from '../../lib/secrets.js';
import { policyFromConfig, SsrfBlockedError } from '../../lib/ssrf.js';
import { assertSecretRefAdministrable, validateTargetUrl } from '../environments/service.js';
import { listCases, toCaseSummary, enrichCases } from './cases.js';
import { executeSync, getConnection, startSync, toSyncRunDto, type SyncDeps } from './sync.js';
import { registerTestRailMetrics } from './metrics.js';

export function toConnectionDto(c: TestRailConnection) {
  return {
    id: c.id,
    baseUrl: c.baseUrl,
    username: c.username,
    secretRef: c.secretRef,
    projectExternalId: c.projectExternalId,
    suiteExternalIds: c.suiteExternalIds,
    enabled: c.enabled,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: c.lastSyncStatus,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
}

const CaseListQuery = TestRailCaseListQuerySchema.extend({
  includeDescendants: QueryBool.default(true),
  includeArchived: QueryBool.default(false),
  tag: z.union([TagSchema, z.array(TagSchema)]).optional(),
});
const SyncRunsQuery = CursorQuerySchema;
const PlanParams = z.object({ planId: z.coerce.number().int().positive() });
const TrRunParams = z.object({ trRunId: z.coerce.number().int().positive() });
const START_SORT: SortSpec = { field: 'startedAt', direction: 'desc', type: 'date' };
const NAME_SORT: SortSpec = { field: 'name', direction: 'asc', type: 'string' };
const CREATED_DESC: SortSpec = { field: 'createdAt', direction: 'desc', type: 'date' };

function testErrorCode(e: unknown): { code: string; message: string } {
  if (e instanceof SsrfBlockedError) return { code: 'HOST_NOT_ALLOWED', message: 'El host o esquema de la URL no está permitido.' };
  if (e instanceof SecretUnavailableError) return { code: 'SECRET_REF_INVALID', message: 'La referencia de la API key no pudo resolverse.' };
  if (e instanceof TestRailError) {
    if (e.kind === 'auth' || e.kind === 'forbidden') return { code: 'TESTRAIL_AUTH_FAILED', message: 'TestRail rechazó las credenciales del usuario de servicio.' };
    if (e.kind === 'blocked') return { code: 'HOST_NOT_ALLOWED', message: 'El host de TestRail no está permitido.' };
    return { code: 'TESTRAIL_UNAVAILABLE', message: `TestRail no respondió correctamente (${e.kind}).` };
  }
  return { code: 'TESTRAIL_UNAVAILABLE', message: 'TestRail no respondió.' };
}

export const testrailRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config, logger } = app.deps;
  const policy = policyFromConfig(config);
  const secrets = getSecretProvider();
  const syncDeps = (): SyncDeps => ({
    prisma,
    logger,
    clientFactory: getTestRailClientFactory(config, secrets),
    businessFields: config.TESTRAIL_BUSINESS_FIELDS,
  });
  registerTestRailMetrics(prisma);

  // -------------------------------------------------------------------------
  // Conexión (RF-TR-01)
  // -------------------------------------------------------------------------

  app.get(
    '/testrail/connection',
    {
      ...routeAuth('GET', '/testrail/connection'),
      schema: { tags: ['testrail'], summary: 'Conexión TestRail (solo referencia de la API key)', response: { 200: TestRailConnectionSchema } },
    },
    async () => {
      const c = await getConnection(prisma);
      if (!c) throw new KatalystError('NOT_FOUND', 'TestRail no está configurado.');
      return toConnectionDto(c);
    },
  );

  app.put(
    '/testrail/connection',
    {
      ...routeAuth('PUT', '/testrail/connection'),
      schema: {
        tags: ['testrail'],
        summary: 'Configurar conexión TestRail (admin, auditado)',
        body: TestRailConnectionUpdateSchema,
        response: { 200: TestRailConnectionSchema },
      },
    },
    async (request) => {
      const b = request.body;
      assertSecretRefAdministrable(b.secretRef);
      await validateTargetUrl(b.baseUrl, policy);
      const data = {
        baseUrl: b.baseUrl.replace(/\/+$/, ''),
        username: b.username,
        secretRef: b.secretRef,
        projectExternalId: b.projectExternalId,
        suiteExternalIds: [...new Set(b.suiteExternalIds)],
        enabled: b.enabled,
      };
      const saved = await prisma.$transaction(async (tx) => {
        const cur = await getConnection(tx);
        let row: TestRailConnection;
        if (!cur) {
          row = await tx.testRailConnection.create({ data });
        } else {
          if (b.version !== undefined && b.version !== cur.version) throw new KatalystError('VERSION_CONFLICT');
          const r = await tx.testRailConnection.updateMany({
            where: { id: cur.id, version: cur.version },
            data: { ...data, version: { increment: 1 } },
          });
          if (r.count === 0) throw new KatalystError('VERSION_CONFLICT');
          row = await tx.testRailConnection.findUniqueOrThrow({ where: { id: cur.id } });
        }
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'testrail_connection.update',
          entity: 'testrail_connection',
          entityId: row.id,
          diff: shallowDiff(cur ? toConnectionDto(cur) : null, toConnectionDto(row), [
            'baseUrl',
            'username',
            'secretRef',
            'projectExternalId',
            'suiteExternalIds',
            'enabled',
          ]),
          requestId: request.requestId,
        });
        return row;
      });
      return toConnectionDto(saved);
    },
  );

  app.post(
    '/testrail/connection/test',
    {
      ...routeAuth('POST', '/testrail/connection/test'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags: ['testrail'],
        summary: 'Probar conexión guardada o candidata (sin guardar)',
        body: TestRailConnectionTestRequestSchema,
        response: { 200: TestRailConnectionTestResponseSchema },
      },
    },
    async (request) => {
      const cur = await getConnection(prisma);
      const cand = {
        baseUrl: request.body.baseUrl ?? cur?.baseUrl,
        username: request.body.username ?? cur?.username,
        secretRef: request.body.secretRef ?? cur?.secretRef,
      };
      let result: z.infer<typeof TestRailConnectionTestResponseSchema>;
      if (!cand.baseUrl || !cand.username || !cand.secretRef) {
        result = { ok: false, errorCode: 'TESTRAIL_CONNECTION_INVALID', message: 'Faltan URL, usuario o referencia de API key.', testrailVersion: null, projects: [], latencyMs: null };
      } else {
        const t0 = performance.now();
        try {
          assertSecretRefAdministrable(cand.secretRef);
          await validateTargetUrl(cand.baseUrl, policy);
          const client = await getTestRailClientFactory(config, secrets)({
            baseUrl: cand.baseUrl.replace(/\/+$/, ''),
            username: cand.username,
            secretRef: cand.secretRef,
          });
          const projects = await client.getProjects();
          result = {
            ok: true,
            errorCode: null,
            message: 'Conexión correcta.',
            testrailVersion: null,
            projects: projects.slice(0, 500).map((p) => ({ externalId: p.id, name: p.name })),
            latencyMs: Math.round(performance.now() - t0),
          };
        } catch (e) {
          if (e instanceof KatalystError && e.code === 'SECRET_REF_INVALID') {
            result = { ok: false, errorCode: e.code, message: e.message, testrailVersion: null, projects: [], latencyMs: null };
          } else {
            const { code, message } = testErrorCode(e);
            result = { ok: false, errorCode: code, message, testrailVersion: null, projects: [], latencyMs: Math.round(performance.now() - t0) };
          }
        }
      }
      await recordAudit(prisma, {
        actor: request.principal!,
        action: 'testrail_connection.test',
        entity: 'testrail_connection',
        ...(cur ? { entityId: cur.id } : {}),
        diff: { ok: result.ok, errorCode: result.errorCode, candidate: request.body.baseUrl !== undefined },
        requestId: request.requestId,
      });
      return result;
    },
  );

  // -------------------------------------------------------------------------
  // Sincronización (RF-TR-02)
  // -------------------------------------------------------------------------

  app.post(
    '/testrail/sync',
    {
      ...routeAuth('POST', '/testrail/sync'),
      schema: {
        tags: ['testrail'],
        summary: 'Sincronizar ahora (202; consultar /testrail/sync-runs/{id})',
        body: TestRailSyncRequestSchema.optional(),
        response: { 202: TestRailSyncRunSchema },
      },
    },
    async (request, reply) => {
      const deps = syncDeps();
      const run = await startSync(deps, {
        trigger: 'manual',
        actor: request.principal!,
        ...(request.body?.suiteExternalIds ? { suiteExternalIds: request.body.suiteExternalIds } : {}),
        requestId: request.requestId,
      });
      // Ejecución en segundo plano; el resultado queda en testrail_sync_run (y evento `testrail.sync`).
      void executeSync(deps, run.id, request.principal!).catch((err: unknown) => logger.error({ err }, 'sync TestRail'));
      return reply.status(202).send(toSyncRunDto(run));
    },
  );

  app.get(
    '/testrail/sync-runs',
    {
      ...routeAuth('GET', '/testrail/sync-runs'),
      schema: { tags: ['testrail'], summary: 'Historial de sincronizaciones', querystring: SyncRunsQuery, response: { 200: pageSchema(TestRailSyncRunSchema) } },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, START_SORT);
      const rows = await prisma.testRailSyncRun.findMany({ where: keysetWhere(START_SORT, after), orderBy: keysetOrderBy(START_SORT), take: q.limit + 1 });
      return paginateMapped(rows, q.limit, START_SORT, toSyncRunDto);
    },
  );

  app.get(
    '/testrail/sync-runs/:id',
    {
      ...routeAuth('GET', '/testrail/sync-runs/:id'),
      schema: { tags: ['testrail'], summary: 'Detalle de sincronización', params: IdParamsSchema, response: { 200: TestRailSyncRunSchema } },
    },
    async (request) => {
      const r = await prisma.testRailSyncRun.findUnique({ where: { id: request.params.id } });
      if (!r) throw new KatalystError('NOT_FOUND');
      return toSyncRunDto(r);
    },
  );

  // -------------------------------------------------------------------------
  // Árbol y casos
  // -------------------------------------------------------------------------

  app.get(
    '/testrail/projects',
    {
      ...routeAuth('GET', '/testrail/projects'),
      schema: { tags: ['testrail'], summary: 'Proyectos sincronizados', querystring: CursorQuerySchema, response: { 200: pageSchema(TestRailProjectSchema) } },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, NAME_SORT);
      const rows = await prisma.testRailProject.findMany({ where: keysetWhere(NAME_SORT, after), orderBy: keysetOrderBy(NAME_SORT), take: q.limit + 1 });
      return paginateMapped(rows, q.limit, NAME_SORT, (p) => ({
        id: p.id,
        externalId: p.externalId,
        name: p.name,
        archivedAt: p.archivedAt?.toISOString() ?? null,
      }));
    },
  );

  app.get(
    '/testrail/suites',
    {
      ...routeAuth('GET', '/testrail/suites'),
      schema: {
        tags: ['testrail'],
        summary: 'Suites sincronizadas',
        querystring: CursorQuerySchema.extend({ includeArchived: QueryBool.default(false) }),
        response: { 200: pageSchema(TestRailSuiteSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, NAME_SORT);
      const rows = await prisma.testRailSuite.findMany({
        where: { AND: [q.includeArchived ? {} : { archivedAt: null }, keysetWhere(NAME_SORT, after)] },
        orderBy: keysetOrderBy(NAME_SORT),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, NAME_SORT, (s) => ({
        id: s.id,
        projectId: s.projectId,
        externalId: s.externalId,
        name: s.name,
        archivedAt: s.archivedAt?.toISOString() ?? null,
      }));
    },
  );

  app.get(
    '/testrail/sections',
    {
      ...routeAuth('GET', '/testrail/sections'),
      schema: {
        tags: ['testrail'],
        summary: 'Árbol de secciones con conteos de casos y automatización',
        querystring: TestRailSectionsQuerySchema.extend(CursorQuerySchema.shape).extend({ includeArchived: QueryBool.default(false) }),
        response: { 200: pageSchema(TestRailSectionSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const sort: SortSpec = { field: 'id', direction: 'asc', type: 'string' };
      const after = decodePageCursor(q.cursor, sort);
      const rows = await prisma.testRailSection.findMany({
        where: {
          AND: [q.suiteId ? { suiteId: q.suiteId } : {}, q.includeArchived ? {} : { archivedAt: null }, keysetWhere(sort, after)],
        },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      const page = paginate(rows, q.limit, sort);
      const ids = page.items.map((s) => s.id);
      const counts = ids.length
        ? await prisma.$queryRaw<{ section_id: string; total: bigint; automated: bigint }[]>`
            SELECT c."section_id"::text AS "section_id", count(*)::bigint AS "total",
                   count(*) FILTER (WHERE EXISTS (
                     SELECT 1 FROM "test_case_link" l JOIN "automated_test" t ON t."id" = l."automated_test_id"
                      WHERE l."case_id" = c."id" AND t."status" = 'aprobado'))::bigint AS "automated"
              FROM "testrail_case" c
             WHERE c."section_id" = ANY(${ids}::uuid[]) AND c."archived_at" IS NULL
             GROUP BY c."section_id"`
        : [];
      const byId = new Map(counts.map((c) => [c.section_id, c]));
      return {
        ...page,
        items: page.items.map((s) => ({
          id: s.id,
          suiteId: s.suiteId,
          externalId: s.trSectionId,
          name: s.name,
          parentId: s.parentId,
          depth: s.depth,
          archivedAt: s.archivedAt?.toISOString() ?? null,
          caseCount: Number(byId.get(s.id)?.total ?? 0),
          automatedCount: Number(byId.get(s.id)?.automated ?? 0),
        })),
      };
    },
  );

  app.get(
    '/testrail/cases',
    {
      ...routeAuth('GET', '/testrail/cases'),
      schema: {
        tags: ['testrail'],
        summary: 'Catálogo de casos con estado de automatización (paginación de servidor)',
        querystring: CaseListQuery,
        response: { 200: pageSchema(TestRailCaseSummarySchema) },
      },
    },
    async (request) => {
      const q = request.query;
      return listCases(prisma, {
        limit: q.limit,
        cursor: q.cursor,
        sort: q.sort,
        section: q.section,
        suiteId: q.suiteId,
        includeDescendants: q.includeDescendants,
        q: q.q,
        automated: q.automated,
        includeArchived: q.includeArchived,
        lastResult: q.lastResult,
        ids: q.ids === undefined ? undefined : Array.isArray(q.ids) ? q.ids : [q.ids],
        tags: q.tag === undefined ? undefined : Array.isArray(q.tag) ? q.tag : [q.tag],
      });
    },
  );

  app.get(
    '/testrail/cases/:id',
    {
      ...routeAuth('GET', '/testrail/cases/:id'),
      schema: { tags: ['testrail'], summary: 'Detalle de caso (pasos, revisiones, vínculos)', params: IdParamsSchema, response: { 200: TestRailCaseDetailSchema } },
    },
    async (request) => {
      const c = await prisma.testRailCase.findUnique({
        where: { id: request.params.id },
        include: {
          links: { include: { automatedTest: { select: { id: true, stableKey: true, title: true } } } },
          revisions: { orderBy: { revision: 'desc' }, take: 50, select: { revision: true, contentHash: true, createdAt: true } },
        },
      });
      if (!c) throw new KatalystError('NOT_FOUND');
      const e = (await enrichCases(prisma, [c.id])).get(c.id)!;
      const steps = Array.isArray(c.steps) ? (c.steps as { content?: string; expected?: string | null }[]) : [];
      return {
        ...toCaseSummary(c, e),
        steps: steps.map((s) => ({ content: String(s.content ?? ''), expected: s.expected ?? null })),
        expected: c.expected,
        contentHash: c.contentHash,
        customFields: (c.customFields as Record<string, unknown>) ?? {},
        links: c.links.map((l) => ({
          automatedTestId: l.automatedTestId,
          stableKey: l.automatedTest.stableKey,
          title: l.automatedTest.title,
          reviewStatus: l.reviewStatus,
          reviewedCaseRevision: l.reviewedCaseRevision,
        })),
        revisions: c.revisions.map((r) => ({ revision: r.revision, contentHash: r.contentHash, createdAt: r.createdAt.toISOString() })),
      };
    },
  );

  app.get(
    '/testrail/cases/:id/history',
    {
      ...routeAuth('GET', '/testrail/cases/:id/history'),
      schema: {
        tags: ['testrail'],
        summary: 'Historial por caso con tendencia (RF-RES-03)',
        params: IdParamsSchema,
        querystring: HistoryQuerySchema,
        response: { 200: HistoryResponseSchema },
      },
    },
    async (request) => {
      const exists = await prisma.testRailCase.findUnique({ where: { id: request.params.id }, select: { id: true } });
      if (!exists) throw new KatalystError('NOT_FOUND');
      const q = request.query;
      const after = decodePageCursor(q.cursor, CREATED_DESC);
      const where: Prisma.CaseResultWhereInput = {
        caseId: exists.id,
        ...(q.environmentId || q.from || q.to
          ? {
              run: {
                ...(q.environmentId ? { environmentId: q.environmentId } : {}),
                ...(q.from || q.to
                  ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } }
                  : {}),
              },
            }
          : {}),
      };
      const rows = await prisma.caseResult.findMany({
        where: { AND: [where, keysetWhere(CREATED_DESC, after)] },
        orderBy: keysetOrderBy(CREATED_DESC),
        take: q.limit + 1,
        include: { run: { select: { environmentId: true, finishedAt: true } } },
      });
      const page = paginateMapped(rows, q.limit, CREATED_DESC, (r) => ({
        runId: r.runId,
        environmentId: r.run.environmentId,
        status: r.status,
        durationMs: r.durationMs,
        retryCount: 0,
        finishedAt: r.run.finishedAt?.toISOString() ?? null,
      }));
      const recent = await prisma.caseResult.findMany({
        where: { ...where, status: { in: ['pasado', 'inestable', 'fallido'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { status: true, durationMs: true },
      });
      const ok = recent.filter((r) => r.status !== 'fallido').length;
      const durations = recent.map((r) => r.durationMs).filter((d): d is number => d !== null);
      return {
        ...page,
        trend: {
          successRate: recent.length ? ok / recent.length : null,
          avgDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
          observations: recent.length,
        },
        flaky: null,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Planes y corridas existentes (RF-TR-06)
  // -------------------------------------------------------------------------

  async function liveClient() {
    const c = await getConnection(prisma);
    if (!c || !c.enabled) throw new KatalystError('TESTRAIL_CONNECTION_INVALID', 'TestRail no está configurado.');
    return getTestRailClientFactory(config, secrets)({ baseUrl: c.baseUrl, username: c.username, secretRef: c.secretRef });
  }

  function liveError(e: unknown): never {
    if (e instanceof TestRailError) {
      if (e.kind === 'not_found') throw new KatalystError('NOT_FOUND');
      if (e.kind === 'auth' || e.kind === 'forbidden') throw new KatalystError('TESTRAIL_AUTH_FAILED');
      throw new KatalystError('TESTRAIL_UNAVAILABLE');
    }
    throw e;
  }

  app.get(
    '/testrail/plans/:planId',
    {
      ...routeAuth('GET', '/testrail/plans/:planId'),
      schema: { tags: ['testrail'], summary: 'Plan de TestRail existente (RF-TR-06)', params: PlanParams, response: { 200: TestRailPlanSchema } },
    },
    async (request) => {
      try {
        const plan = await (await liveClient()).getPlan(request.params.planId);
        return {
          planId: plan.id,
          name: plan.name,
          entries: (plan.entries ?? []).map((e) => ({
            suiteExternalId: e.suite_id,
            runs: (e.runs ?? []).map((r) => ({ trRunId: r.id, name: r.name, isCompleted: !!r.is_completed })),
          })),
        };
      } catch (e) {
        return liveError(e);
      }
    },
  );

  app.get(
    '/testrail/runs/:trRunId/tests',
    {
      ...routeAuth('GET', '/testrail/runs/:trRunId/tests'),
      schema: { tags: ['testrail'], summary: 'Tests de una corrida existente (RF-TR-06)', params: TrRunParams, response: { 200: TestRailRunTestsSchema } },
    },
    async (request) => {
      try {
        const tests = await (await liveClient()).getTests(request.params.trRunId);
        return {
          trRunId: request.params.trRunId,
          tests: tests.map((t) => ({ trTestId: t.id, trCaseId: t.case_id, title: t.title })),
        };
      } catch (e) {
        return liveError(e);
      }
    },
  );
};

export default testrailRoutes;
