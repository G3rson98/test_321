/**
 * Suites guardadas (RF-CAT-03): selector JSON (casos, etiquetas, secciones con descendientes; unión OR) validado contra
 * el catálogo vigente. La suite es dinámica: se resuelve al usarla; las corridas aceptadas congelan su snapshot
 * (ESP §13.1), por lo que editar una suite no altera el historial.
 */
import type { Prisma, PrismaClient, Suite } from '@prisma/client';
import { KatalystError, SuiteSelectorSchema, type SuiteSelector } from '@katalyst/shared';
import { sectionWithDescendants } from '../testrail/cases.js';
import { FLAKY_WHERE } from '../catalog/service.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Valida IDs del selector: casos existentes y no archivados, secciones existentes. */
export async function validateSuiteSelector(db: Db, s: SuiteSelector): Promise<void> {
  if (s.caseIds?.length) {
    const found = await db.testRailCase.findMany({ where: { id: { in: s.caseIds } }, select: { id: true, archivedAt: true } });
    if (found.length !== s.caseIds.length) throw new KatalystError('SELECTION_FOREIGN_IDS');
    if (found.some((c) => c.archivedAt)) throw new KatalystError('CASE_ARCHIVED');
  }
  if (s.sectionIds?.length) {
    const n = await db.testRailSection.count({ where: { id: { in: s.sectionIds } } });
    if (n !== s.sectionIds.length) throw new KatalystError('SELECTION_FOREIGN_IDS');
  }
}

export interface ResolvedSuite {
  caseIds: string[];
  testIds: string[];
  excludedFlakyTestIds: string[];
}

/**
 * Resuelve la suite contra el catálogo vigente: casos = explícitos ∪ secciones (con descendientes) ∪ casos vinculados a
 * tests con las etiquetas; tests = aprobados vinculados a esos casos ∪ aprobados con las etiquetas. `excludeFlaky`
 * descarta tests flaky (RF-CAT-04). Casos archivados y tests retirados no entran.
 */
export async function resolveSuiteSelector(db: Db, raw: unknown): Promise<ResolvedSuite> {
  const s = SuiteSelectorSchema.parse(raw);
  const caseIds = new Set<string>(s.caseIds ?? []);
  if (s.sectionIds?.length) {
    const sections = await sectionWithDescendants(db, s.sectionIds);
    for (const c of await db.testRailCase.findMany({ where: { sectionId: { in: sections }, archivedAt: null }, select: { id: true } })) {
      caseIds.add(c.id);
    }
  }
  const tagTests = s.tags?.length
    ? await db.automatedTest.findMany({
        where: { status: 'aprobado', tags: { hasSome: s.tags } },
        select: { id: true, links: { select: { caseId: true, case: { select: { archivedAt: true } } } } },
      })
    : [];
  for (const t of tagTests) for (const l of t.links) if (!l.case.archivedAt) caseIds.add(l.caseId);
  const archived = caseIds.size
    ? await db.testRailCase.findMany({ where: { id: { in: [...caseIds] }, archivedAt: { not: null } }, select: { id: true } })
    : [];
  for (const a of archived) caseIds.delete(a.id);
  const linked = caseIds.size
    ? await db.automatedTest.findMany({
        where: { status: 'aprobado', links: { some: { caseId: { in: [...caseIds] } } } },
        select: { id: true },
      })
    : [];
  const testIds = new Set([...tagTests.map((t) => t.id), ...linked.map((t) => t.id)]);
  let excluded: string[] = [];
  if (s.excludeFlaky && testIds.size) {
    excluded = (await db.automatedTest.findMany({ where: { id: { in: [...testIds] }, ...FLAKY_WHERE }, select: { id: true } })).map((t) => t.id);
    for (const id of excluded) testIds.delete(id);
  }
  return { caseIds: [...caseIds].sort(), testIds: [...testIds].sort(), excludedFlakyTestIds: excluded.sort() };
}

export function toSuiteDto(s: Suite, resolved?: ResolvedSuite) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    selector: SuiteSelectorSchema.parse(s.selector),
    createdBy: s.createdById,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    deletedAt: s.deletedAt?.toISOString() ?? null,
    version: s.version,
    ...(resolved ? { resolved: { cases: resolved.caseIds.length, tests: resolved.testIds.length } } : {}),
  };
}
