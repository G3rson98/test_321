/**
 * Consultas del catálogo de casos (RF-TR-03, RF-CAT-02): filtros por sección con descendientes, etiqueta/estado del
 * último resultado, texto (título con índice pg_trgm; `C123`/`123` busca por ID) y automatización; paginación de
 * servidor por cursor (25 por defecto, máx. 100) sin N+1: la página se enriquece con 2 consultas agregadas.
 */
import type { Prisma, PrismaClient, TestRailCase } from '@prisma/client';
import { CASE_RESULT_STATUSES, KatalystError, type Classification, type Page } from '@katalyst/shared';
import { isFlakyRow } from '../catalog/service.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';

/** Valor del filtro `lastResult` para casos que nunca tuvieron un resultado local. */
export const SIN_EJECUTAR = 'sin_ejecutar';

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
  /** Estado del último resultado o `SIN_EJECUTAR` (casos sin ningún `case_result`). */
  lastResult?: string | undefined;
  /** Selección por ID (máx. 100): se combina (AND) con el resto de filtros. */
  ids?: string[] | undefined;
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
  if (f.ids) and.push({ id: { in: f.ids } });
  if (f.lastResult === SIN_EJECUTAR) {
    and.push({ caseResults: { none: {} } });
  } else if (f.lastResult) {
    if (!(CASE_RESULT_STATUSES as readonly string[]).includes(f.lastResult)) {
      throw new KatalystError('VALIDATION_FAILED', 'Estado de último resultado desconocido.');
    }
    and.push({ id: { in: await casesWithLastResult(prisma, f.lastResult) } });
  }
  return { AND: and };
}

/** Peor inestabilidad entre los tests vinculados (misma forma que `AutomatedTest.flaky`). */
export interface CaseFlaky {
  score: number | null;
  numerator: number;
  denominator: number;
  isFlaky: boolean;
  environmentId: null;
}

export interface CaseEnrichment {
  automatedTestCount: number;
  linksRequiringReview: number;
  tags: string[];
  classification: Classification | null;
  flaky: CaseFlaky | null;
  lastResult: { status: string; runId: string; finishedAt: string | null } | null;
}

/** Más alto = más restrictivo: escritura > sin_clasificar > lectura. */
const CLASSIFICATION_RANK: Record<Classification, number> = { lectura: 0, sin_clasificar: 1, escritura: 2 };

export async function enrichCases(prisma: PrismaClient, ids: string[]): Promise<Map<string, CaseEnrichment>> {
  const out = new Map<string, CaseEnrichment>(
    ids.map((id): [string, CaseEnrichment] => [
      id,
      { automatedTestCount: 0, linksRequiringReview: 0, tags: [], classification: null, flaky: null, lastResult: null },
    ]),
  );
  if (ids.length === 0) return out;
  const links = await prisma.testCaseLink.findMany({
    where: { caseId: { in: ids }, automatedTest: { status: { not: 'retirado' } } },
    select: {
      caseId: true,
      reviewStatus: true,
      automatedTest: {
        select: { status: true, tags: true, classification: true, flakyScore: true, flakyNumerator: true, flakyDenominator: true },
      },
    },
  });
  const tagSets = new Map<string, Set<string>>();
  for (const l of links) {
    const e = out.get(l.caseId)!;
    const t = l.automatedTest;
    if (t.status === 'aprobado') e.automatedTestCount++;
    if (l.reviewStatus === 'requiere_revision') e.linksRequiringReview++;
    // Agregado de los tests vigentes (no retirados): etiquetas (unión), clasificación más restrictiva y peor flaky.
    const set = tagSets.get(l.caseId) ?? new Set<string>();
    for (const tag of t.tags) set.add(tag);
    tagSets.set(l.caseId, set);
    const cls = t.classification as Classification;
    if (e.classification === null || CLASSIFICATION_RANK[cls] > CLASSIFICATION_RANK[e.classification]) e.classification = cls;
    const f: CaseFlaky = {
      score: t.flakyScore,
      numerator: t.flakyNumerator,
      denominator: t.flakyDenominator,
      isFlaky: isFlakyRow(t),
      environmentId: null,
    };
    if (e.flaky === null || (f.score ?? -1) > (e.flaky.score ?? -1)) e.flaky = f;
  }
  for (const [caseId, set] of tagSets) out.get(caseId)!.tags = [...set].sort();
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
    tags: e.tags,
    classification: e.classification,
    flaky: e.flaky,
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

