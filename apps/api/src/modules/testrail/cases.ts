/**
 * Consultas del catálogo de casos (RF-TR-03, RF-CAT-02): filtros por sección con descendientes, etiqueta/estado del
 * último resultado, texto (título con índice pg_trgm; `C123`/`123` busca por ID) y automatización; paginación de
 * servidor por cursor (25 por defecto, máx. 100) sin N+1: la página se enriquece con 2 consultas agregadas.
 */
import type { Prisma, PrismaClient, TestRailCase } from '@prisma/client';
import { CASE_RESULT_STATUSES, KatalystError, type Page } from '@katalyst/shared';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';

export const CASE_SORTS = {
  title: 'string',
  trCaseId: 'number',
  syncedAt: 'date',
} as const;

export interface CaseListFilters {
  limit: number;
  cursor?: string | undefined;
  sort: string;
  section?: string | undefined;
  suiteId?: string | undefined;
  includeDescendants: boolean;
  q?: string | undefined;
  automated?: boolean | undefined;
  includeArchived: boolean;
  lastResult?: string | undefined;
  /** Casos vinculados a tests con alguna de estas etiquetas (OR). */
  tags?: string[] | undefined;
}

/** IDs de la sección y todos sus descendientes (CTE recursiva sobre el árbol local). */
export async function sectionWithDescendants(prisma: PrismaClient | Prisma.TransactionClient, sectionIds: string[]): Promise<string[]> {
  if (sectionIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE t AS (
      SELECT "id" FROM "testrail_section" WHERE "id" = ANY(${sectionIds}::uuid[])
      UNION
      SELECT s."id" FROM "testrail_section" s JOIN t ON s."parent_id" = t."id"
    ) SELECT "id"::text AS "id" FROM t`;
  return rows.map((r) => r.id);
}

/** Casos cuyo ÚLTIMO case_result tiene el estado dado. */
async function casesWithLastResult(prisma: PrismaClient, status: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ case_id: string }[]>`
    SELECT x."case_id"::text AS "case_id" FROM (
      SELECT DISTINCT ON ("case_id") "case_id", "status"::text AS "status"
        FROM "case_result" ORDER BY "case_id", "created_at" DESC, "id" DESC
    ) x WHERE x."status" = ${status}`;
  return rows.map((r) => r.case_id);
}

export async function buildCaseWhere(prisma: PrismaClient, f: CaseListFilters): Promise<Prisma.TestRailCaseWhereInput> {
  const and: Prisma.TestRailCaseWhereInput[] = [];
  if (!f.includeArchived) and.push({ archivedAt: null });
  if (f.suiteId) and.push({ suiteId: f.suiteId });
  if (f.section) {
    const ids = f.includeDescendants ? await sectionWithDescendants(prisma, [f.section]) : [f.section];
    and.push({ sectionId: { in: ids } });
  }
  if (f.q) {
    const q = f.q.trim();
    const idMatch = /^[Cc]?(\d{1,9})$/.exec(q);
    and.push(
      idMatch
        ? { OR: [{ trCaseId: Number(idMatch[1]) }, { title: { contains: q, mode: 'insensitive' } }] }
        : { title: { contains: q, mode: 'insensitive' } },
    );
  }
  const approvedLink = { automatedTest: { status: 'aprobado' as const } };
  if (f.automated === true) and.push({ links: { some: approvedLink } });
  if (f.automated === false) and.push({ links: { none: approvedLink } });
  if (f.tags && f.tags.length > 0) and.push({ links: { some: { automatedTest: { tags: { hasSome: f.tags } } } } });
  if (f.lastResult) {
    if (!(CASE_RESULT_STATUSES as readonly string[]).includes(f.lastResult)) {
      throw new KatalystError('VALIDATION_FAILED', 'Estado de último resultado desconocido.');
    }
    and.push({ id: { in: await casesWithLastResult(prisma, f.lastResult) } });
  }
  return { AND: and };
}

export interface CaseEnrichment {
  automatedTestCount: number;
  linksRequiringReview: number;
  lastResult: { status: string; runId: string; finishedAt: string | null } | null;
}

export async function enrichCases(prisma: PrismaClient, ids: string[]): Promise<Map<string, CaseEnrichment>> {
  const out = new Map<string, CaseEnrichment>(ids.map((id) => [id, { automatedTestCount: 0, linksRequiringReview: 0, lastResult: null }]));
  if (ids.length === 0) return out;
  const links = await prisma.testCaseLink.findMany({
    where: { caseId: { in: ids }, automatedTest: { status: { not: 'retirado' } } },
    select: { caseId: true, reviewStatus: true, automatedTest: { select: { status: true } } },
  });
  for (const l of links) {
    const e = out.get(l.caseId)!;
    if (l.automatedTest.status === 'aprobado') e.automatedTestCount++;
    if (l.reviewStatus === 'requiere_revision') e.linksRequiringReview++;
  }
  const last = await prisma.$queryRaw<{ case_id: string; status: string; run_id: string; finished_at: Date | null }[]>`
    SELECT DISTINCT ON (cr."case_id") cr."case_id"::text AS "case_id", cr."status"::text AS "status",
           cr."run_id"::text AS "run_id", r."finished_at" AS "finished_at"
      FROM "case_result" cr JOIN "run" r ON r."id" = cr."run_id"
     WHERE cr."case_id" = ANY(${ids}::uuid[])
     ORDER BY cr."case_id", cr."created_at" DESC, cr."id" DESC`;
  for (const r of last) {
    out.get(r.case_id)!.lastResult = { status: r.status, runId: r.run_id, finishedAt: r.finished_at?.toISOString() ?? null };
  }
  return out;
}

export function toCaseSummary(c: TestRailCase, e: CaseEnrichment) {
  return {
    id: c.id,
    trCaseId: c.trCaseId,
    ref: `C${c.trCaseId}`,
    sectionId: c.sectionId,
    suiteId: c.suiteId,
    title: c.title,
    priority: c.priority,
    type: c.type,
    refs: c.refs,
    revision: c.revision,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    syncedAt: c.syncedAt.toISOString(),
    automated: e.automatedTestCount > 0,
    automatedTestCount: e.automatedTestCount,
    linksRequiringReview: e.linksRequiringReview,
    lastResult: e.lastResult,
  };
}

export async function listCases(prisma: PrismaClient, f: CaseListFilters): Promise<Page<ReturnType<typeof toCaseSummary>>> {
  const sort = parseSort(f.sort, CASE_SORTS);
  const after = decodePageCursor(f.cursor, sort);
  const where = await buildCaseWhere(prisma, f);
  const rows = await prisma.testRailCase.findMany({
    where: { AND: [where, keysetWhere(sort, after)] },
    orderBy: keysetOrderBy(sort),
    take: f.limit + 1,
  });
  const page = paginate(rows, f.limit, sort);
  const enrich = await enrichCases(prisma, page.items.map((c) => c.id));
  return { ...page, items: page.items.map((c) => toCaseSummary(c, enrich.get(c.id)!)) };
}

