/**
 * Catálogo de tests: listado con filtros de servidor, detalle, historial con flaky score, refresco aislado del
 * repositorio (encola `catalog-listing` para el runner; la API no ejecuta tests), revisiones del catálogo y revisión de
 * vínculos test↔caso tras cambios de versión del caso (no aprueba código).
 * RF-CAT-01, RF-CAT-02, RF-CAT-04, RF-CAT-05, RF-TR-03, RF-TR-07, RF-RES-03.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AutomatedTest, CatalogRevision, Prisma, PrismaClient } from '@prisma/client';
import {
  AutomatedTestListQuerySchema,
  AutomatedTestSchema,
  CaseLinkReviewParamsSchema,
  CaseLinkReviewRequestSchema,
  CaseLinkSchema,
  CatalogRefreshRequestSchema,
  CatalogRevisionSchema,
  CursorQuerySchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  IdParamsSchema,
  KatalystError,
  RUN_RESULT_STATUSES,
  flakyScore,
  pageSchema,
  type Classification,
  type RunResultStatus,
} from '@katalyst/shared';
import { getGitRepoReader } from '../../adapters/git/index.js';
import { routeAuth, type Principal } from '../../lib/auth.js';
import { recordAudit } from '../../lib/audit.js';
import { runInTransaction } from '../../lib/events-publish.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, paginateMapped, parseSort, type SortSpec } from '../../lib/pagination.js';
import { getSecretProvider } from '../../lib/secrets.js';
import { sectionWithDescendants } from '../testrail/cases.js';
import { FLAKY_WHERE, flakyObservations, isFlakyRow, requestCatalogRefresh } from './service.js';

const TEST_SORTS = { title: 'string', filePath: 'string', updatedAt: 'date' } as const;
const CREATED_DESC: SortSpec = { field: 'createdAt', direction: 'desc', type: 'date' };
const STARTED_DESC: SortSpec = { field: 'startedAt', direction: 'desc', type: 'date' };

type IssueJson = { code: string; message: string; stableKey: string | null }[];

export function toRevisionDto(r: CatalogRevision) {
  return {
    id: r.id,
    status: r.status,
    gitCommit: r.gitCommit,
    manifestHash: r.manifestHash,
    testCount: r.testCount,
    errors: (Array.isArray(r.errors) ? r.errors : []) as IssueJson,
    warnings: (Array.isArray(r.warnings) ? r.warnings : []) as IssueJson,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdBy: r.createdById,
  };
}

async function latestResults(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, { status: RunResultStatus; runId: string; finishedAt: string | null }>();
  const rows = await prisma.$queryRaw<{ automated_test_id: string; status: RunResultStatus; run_id: string; finished_at: Date | null }[]>`
    SELECT DISTINCT ON (rr."automated_test_id") rr."automated_test_id"::text AS "automated_test_id",
           rr."status"::text AS "status", rr."run_id"::text AS "run_id", r."finished_at"
      FROM "run_result" rr JOIN "run" r ON r."id" = rr."run_id"
     WHERE rr."automated_test_id" = ANY(${ids}::uuid[])
     ORDER BY rr."automated_test_id", rr."created_at" DESC, rr."id" DESC`;
  return new Map(rows.map((r) => [r.automated_test_id, { status: r.status, runId: r.run_id, finishedAt: r.finished_at?.toISOString() ?? null }]));
}

async function linksFor(prisma: PrismaClient, ids: string[]) {
  const links = ids.length
    ? await prisma.testCaseLink.findMany({
        where: { automatedTestId: { in: ids } },
        include: { case: { select: { id: true, trCaseId: true, title: true, revision: true } } },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const map = new Map<string, ReturnType<typeof toLinkDto>[]>();
  for (const l of links) {
    const list = map.get(l.automatedTestId) ?? [];
    list.push(toLinkDto(l));
    map.set(l.automatedTestId, list);
  }
  return map;
}

function toLinkDto(l: {
  caseId: string;
  reviewStatus: 'vigente' | 'requiere_revision';
  reviewedCaseRevision: number | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  case: { trCaseId: number; title: string; revision: number };
}) {
  return {
    caseId: l.caseId,
    ref: `C${l.case.trCaseId}`,
    title: l.case.title,
    reviewStatus: l.reviewStatus,
    reviewedCaseRevision: l.reviewedCaseRevision,
    currentCaseRevision: l.case.revision,
    reviewedBy: l.reviewedById,
    reviewedAt: l.reviewedAt?.toISOString() ?? null,
  };
}

export async function toTestDtos(prisma: PrismaClient, rows: AutomatedTest[]) {
  const ids = rows.map((r) => r.id);
  const [links, last] = await Promise.all([linksFor(prisma, ids), latestResults(prisma, ids)]);
  return rows.map((t) => ({
    id: t.id,
    stableKey: t.stableKey,
    filePath: t.filePath,
    title: t.title,
    tags: t.tags,
    classification: t.classification as Classification,
    status: t.status,
    parameterKeys: t.parameterKeys,
    writeIdempotencyApproved: t.writeIdempotencyApproved,
    owner: t.owner,
    manifestCommit: t.manifestCommit,
    flaky: {
      score: t.flakyScore,
      numerator: t.flakyNumerator,
      denominator: t.flakyDenominator,
      isFlaky: isFlakyRow(t),
      environmentId: null,
    },
    caseLinks: links.get(t.id) ?? [],
    lastResult: last.get(t.id) ?? null,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

async function reviewerUserId(prisma: PrismaClient, p: Principal): Promise<string | null> {
  if (p.kind === 'panel_user') return p.id;
  if (p.kind === 'device') return p.userId;
  if (p.kind === 'api_token') {
    const c = await prisma.apiCredential.findUnique({ where: { id: p.id }, select: { principalId: true } });
    return c?.principalId ?? null;
  }
  return null;
}

export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;

  app.get(
    '/tests',
    {
      ...routeAuth('GET', '/tests'),
      schema: {
        tags: ['catalog'],
        summary: 'Tests automatizados (filtros y paginación de servidor)',
        querystring: AutomatedTestListQuerySchema,
        response: { 200: pageSchema(AutomatedTestSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const sort = parseSort(q.sort, TEST_SORTS);
      const after = decodePageCursor(q.cursor, sort);
      const and: Prisma.AutomatedTestWhereInput[] = [q.status ? { status: q.status } : { status: { not: 'retirado' } }];
      const tags = q.tag === undefined ? [] : Array.isArray(q.tag) ? q.tag : [q.tag];
      if (tags.length > 0) and.push({ tags: { hasSome: tags } });
      if (q.case) and.push({ links: { some: { case: { trCaseId: Number(q.case.slice(1)) } } } });
      if (q.caseId) and.push({ links: { some: { caseId: q.caseId } } });
      if (q.section) {
        const sections = await sectionWithDescendants(prisma, [q.section]);
        and.push({ links: { some: { case: { sectionId: { in: sections } } } } });
      }
      if (q.classification) and.push({ classification: q.classification });
      if (q.flaky === true) and.push(FLAKY_WHERE);
      if (q.flaky === false) and.push({ NOT: FLAKY_WHERE });
      if (q.q) {
        and.push({ OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { filePath: { contains: q.q, mode: 'insensitive' } }] });
      }
      if (q.lastResult) {
        if (!(RUN_RESULT_STATUSES as readonly string[]).includes(q.lastResult)) throw new KatalystError('VALIDATION_FAILED');
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT x."automated_test_id"::text AS "id" FROM (
            SELECT DISTINCT ON ("automated_test_id") "automated_test_id", "status"::text AS "status"
              FROM "run_result" ORDER BY "automated_test_id", "created_at" DESC, "id" DESC
          ) x WHERE x."status" = ${q.lastResult}`;
        and.push({ id: { in: rows.map((r) => r.id) } });
      }
      const rows = await prisma.automatedTest.findMany({
        where: { AND: [...and, keysetWhere(sort, after)] },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      const page = paginate(rows, q.limit, sort);
      return { ...page, items: await toTestDtos(prisma, page.items) };
    },
  );

  app.get(
    '/tests/:id',
    {
      ...routeAuth('GET', '/tests/:id'),
      schema: { tags: ['catalog'], summary: 'Detalle de test (identidad estable por UUID)', params: IdParamsSchema, response: { 200: AutomatedTestSchema } },
    },
    async (request) => {
      const t = await prisma.automatedTest.findUnique({ where: { id: request.params.id } });
      if (!t) throw new KatalystError('NOT_FOUND');
      return (await toTestDtos(prisma, [t]))[0]!;
    },
  );

  app.get(
    '/tests/:id/history',
    {
      ...routeAuth('GET', '/tests/:id/history'),
      schema: {
        tags: ['catalog'],
        summary: 'Historial del test con tendencia y flaky score (RF-RES-03, RF-CAT-04)',
        params: IdParamsSchema,
        querystring: HistoryQuerySchema,
        response: { 200: HistoryResponseSchema },
      },
    },
    async (request) => {
      const t = await prisma.automatedTest.findUnique({ where: { id: request.params.id }, select: { id: true } });
      if (!t) throw new KatalystError('NOT_FOUND');
      const q = request.query;
      const after = decodePageCursor(q.cursor, CREATED_DESC);
      const runFilter: Prisma.RunWhereInput = {
        ...(q.environmentId ? { environmentId: q.environmentId } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      };
      const rows = await prisma.runResult.findMany({
        where: { AND: [{ automatedTestId: t.id, run: runFilter }, keysetWhere(CREATED_DESC, after)] },
        orderBy: keysetOrderBy(CREATED_DESC),
        take: q.limit + 1,
        include: { run: { select: { environmentId: true, finishedAt: true } } },
      });
      const page = paginateMapped(rows, q.limit, CREATED_DESC, (r) => ({
        runId: r.runId,
        environmentId: r.run.environmentId,
        status: r.status,
        durationMs: r.durationMs,
        retryCount: r.retryCount,
        finishedAt: r.run.finishedAt?.toISOString() ?? null,
      }));
      const obs = (await flakyObservations(prisma, [t.id], q.environmentId)).get(t.id) ?? [];
      const f = flakyScore(obs, q.environmentId);
      const durations = await prisma.runResult.findMany({
        where: { automatedTestId: t.id, run: runFilter, status: { in: ['pasado', 'inestable', 'fallido'] }, durationMs: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { durationMs: true },
      });
      const ok = obs.filter((o) => o.status !== 'fallido').length;
      return {
        ...page,
        trend: {
          successRate: obs.length ? ok / obs.length : null,
          avgDurationMs: durations.length ? durations.reduce((a, b) => a + (b.durationMs ?? 0), 0) / durations.length : null,
          observations: obs.length,
        },
        flaky: { score: f.score, numerator: f.numerator, denominator: f.denominator, isFlaky: f.isFlaky, environmentId: f.environmentId },
      };
    },
  );

  app.post(
    '/tests/refresh',
    {
      ...routeAuth('POST', '/tests/refresh'),
      schema: {
        tags: ['catalog'],
        summary: 'Releer el repositorio (listado aislado en el runner; 202)',
        body: CatalogRefreshRequestSchema.optional(),
        response: { 202: CatalogRevisionSchema },
      },
    },
    async (request, reply) => {
      const rev = await requestCatalogRefresh(
        { prisma, config, git: getGitRepoReader(config, getSecretProvider()) },
        request.principal!,
        request.requestId,
      );
      return reply.status(202).send(toRevisionDto(rev));
    },
  );

  app.get(
    '/catalog/revisions',
    {
      ...routeAuth('GET', '/catalog/revisions'),
      schema: { tags: ['catalog'], summary: 'Revisiones del catálogo', querystring: CursorQuerySchema, response: { 200: pageSchema(CatalogRevisionSchema) } },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, STARTED_DESC);
      const rows = await prisma.catalogRevision.findMany({ where: keysetWhere(STARTED_DESC, after), orderBy: keysetOrderBy(STARTED_DESC), take: q.limit + 1 });
      return paginateMapped(rows, q.limit, STARTED_DESC, toRevisionDto);
    },
  );

  app.get(
    '/catalog/revisions/:id',
    {
      ...routeAuth('GET', '/catalog/revisions/:id'),
      schema: { tags: ['catalog'], summary: 'Detalle de revisión del catálogo', params: IdParamsSchema, response: { 200: CatalogRevisionSchema } },
    },
    async (request) => {
      const r = await prisma.catalogRevision.findUnique({ where: { id: request.params.id } });
      if (!r) throw new KatalystError('NOT_FOUND');
      return toRevisionDto(r);
    },
  );

  app.put(
    '/tests/:id/case-links/:caseId/review',
    {
      ...routeAuth('PUT', '/tests/:id/case-links/:caseId/review'),
      schema: {
        tags: ['catalog'],
        summary: 'Confirmar que el test cubre la revisión vigente del caso (no aprueba código)',
        params: CaseLinkReviewParamsSchema,
        body: CaseLinkReviewRequestSchema,
        response: { 200: CaseLinkSchema },
      },
    },
    async (request) => {
      const { id, caseId } = request.params;
      const reviewer = await reviewerUserId(prisma, request.principal!);
      const link = await runInTransaction(prisma, async (tx) => {
        const l = await tx.testCaseLink.findUnique({
          where: { automatedTestId_caseId: { automatedTestId: id, caseId } },
          include: { case: { select: { trCaseId: true, title: true, revision: true, archivedAt: true } } },
        });
        if (!l) throw new KatalystError('NOT_FOUND');
        if (l.case.archivedAt) throw new KatalystError('CASE_ARCHIVED');
        if (request.body.caseRevision !== l.case.revision) {
          throw new KatalystError('VERSION_CONFLICT', 'La revisión indicada no es la vigente del caso.');
        }
        const now = new Date();
        const updated = await tx.testCaseLink.update({
          where: { id: l.id },
          data: { reviewStatus: 'vigente', reviewedCaseRevision: l.case.revision, reviewedById: reviewer, reviewedAt: now },
          include: { case: { select: { trCaseId: true, title: true, revision: true } } },
        });
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'test_case_link.review',
          entity: 'test_case_link',
          entityId: l.id,
          diff: {
            automatedTestId: id,
            caseId,
            reviewStatus: { from: l.reviewStatus, to: 'vigente' },
            caseRevision: l.case.revision,
            comment: request.body.comment ?? null,
          },
          requestId: request.requestId,
        });
        return updated;
      });
      return toLinkDto(link);
    },
  );
};

export default catalogRoutes;
