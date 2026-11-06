/**
 * Sincronización TestRail → BD (RF-TR-02, RF-TR-07, ESP §8, §13.1).
 * 1. Recorre proyectos, suites, secciones y TODAS las páginas de casos, guardando cada página en
 *    `testrail_case_staging` (contenido sanitizado + content_hash). Ningún cambio al catálogo durante esta fase.
 * 2. Si cualquier llamada falla: la corrida queda `fallida`, se borra el staging y el catálogo NO cambia (no se archiva
 *    ni se reemplaza parcialmente).
 * 3. Si todo terminó: aplica en UNA transacción: upsert de proyectos/suites/árbol de secciones/casos; nuevo
 *    `content_hash` (pasos, esperado, precondiciones, campos de negocio) ⇒ `revision+1`, `case_revision` inmutable y
 *    vínculos `vigente → requiere_revision`; cambio de título/refs/prioridad/tipo solo actualiza metadatos; archiva
 *    casos/secciones/suites desaparecidos SOLO tras la sincronización completa exitosa; un caso que reaparece se
 *    desarchiva. Campos personalizados no soportados se registran (nombres) y se conservan sanitizados.
 */
import type { Prisma, PrismaClient, TestRailSyncRun } from '@prisma/client';
import type { Logger } from 'pino';
import { canonicalJson, KatalystError, sanitizeErrorMessage, sanitizeJson, sha256Hex } from '@katalyst/shared';
import type { TestRailClient, TrCase, TrSection } from '../../adapters/testrail/types.js';
import type { TestRailClientFactory } from '../../adapters/testrail/index.js';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';
import { publishEvent, runInTransaction } from '../../lib/events-publish.js';
import { metrics } from '../../lib/metrics.js';

/** Campos del caso que Katalyst interpreta (el resto `custom_*` se registra como no soportado). */
export const KNOWN_CASE_FIELDS = new Set([
  'id',
  'title',
  'section_id',
  'suite_id',
  'template_id',
  'type_id',
  'priority_id',
  'milestone_id',
  'refs',
  'created_by',
  'created_on',
  'updated_by',
  'updated_on',
  'estimate',
  'estimate_forecast',
  'display_order',
  'is_deleted',
  'labels',
  'custom_steps',
  'custom_expected',
  'custom_preconds',
  'custom_steps_separated',
  'custom_testrail_bdd_scenario',
]);

export const STALE_SYNC_MS = 2 * 3600_000;

export interface CaseStep {
  content: string;
  expected: string | null;
  additionalInfo?: string | null;
  sharedStepId?: number | null;
}

export interface CaseContent {
  steps: CaseStep[];
  expected: string | null;
  preconds: string | null;
  business: Record<string, unknown>;
}

export interface ExtractedCase {
  content: CaseContent;
  customFields: Record<string, unknown>;
  unsupported: string[];
  contentHash: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Extrae y sanitiza el contenido versionado del caso. `businessFields`: campos personalizados que entran al hash. */
export function extractCaseContent(c: TrCase, businessFields: readonly string[] = []): ExtractedCase {
  const unsupported = new Set<string>();
  let steps: CaseStep[] = [];
  if (Array.isArray(c.custom_steps_separated)) {
    steps = c.custom_steps_separated.map((s) => {
      if (s.shared_step_id) unsupported.add('custom_steps_separated.shared_step_id');
      return {
        content: s.content ?? '',
        expected: str(s.expected),
        ...(str(s.additional_info) ? { additionalInfo: str(s.additional_info) } : {}),
        ...(s.shared_step_id ? { sharedStepId: s.shared_step_id } : {}),
      };
    });
  } else if (c.custom_steps_separated !== undefined && c.custom_steps_separated !== null) {
    unsupported.add('custom_steps_separated');
  }
  if (steps.length === 0 && str(c.custom_steps)) steps = [{ content: str(c.custom_steps)!, expected: null }];
  if (steps.length === 0 && str(c.custom_testrail_bdd_scenario)) {
    steps = [{ content: str(c.custom_testrail_bdd_scenario)!, expected: null }];
  }
  const business: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (KNOWN_CASE_FIELDS.has(k)) continue;
    if (!k.startsWith('custom_')) continue;
    if (businessFields.includes(k)) business[k] = v ?? null;
    else if (v !== null && v !== undefined && v !== '') unsupported.add(k);
    customFields[k] = v ?? null;
  }
  const raw: CaseContent = {
    steps,
    expected: str(c.custom_expected),
    preconds: str(c.custom_preconds),
    business,
  };
  const content = sanitizeJson(raw, { maxDepth: 16 }).value;
  const custom = sanitizeJson(customFields, { maxDepth: 16 }).value;
  return {
    content,
    customFields: custom,
    unsupported: [...unsupported].sort(),
    contentHash: sha256Hex(canonicalJson(content)),
  };
}

export interface SyncStats {
  projects: number;
  suites: number;
  sections: number;
  casesSeen: number;
  casesCreated: number;
  casesUpdated: number;
  casesNewRevision: number;
  casesArchived: number;
  linksRequiringReview: number;
  pages: number;
  unsupportedFields: string[];
}

export function emptyStats(): SyncStats {
  return {
    projects: 0,
    suites: 0,
    sections: 0,
    casesSeen: 0,
    casesCreated: 0,
    casesUpdated: 0,
    casesNewRevision: 0,
    casesArchived: 0,
    linksRequiringReview: 0,
    pages: 0,
    unsupportedFields: [],
  };
}

export interface SyncDeps {
  prisma: PrismaClient;
  logger: Logger;
  clientFactory: TestRailClientFactory;
  businessFields?: readonly string[];
  now?: () => Date;
}

export interface StartSyncInput {
  connectionId?: string;
  trigger: 'manual' | 'programada';
  actor: Principal | 'system';
  suiteExternalIds?: number[];
  requestId?: string;
}

/** Conexión única configurada (la más antigua). */
export async function getConnection(prisma: PrismaClient | Prisma.TransactionClient) {
  return prisma.testRailConnection.findFirst({ orderBy: { createdAt: 'asc' } });
}

/**
 * Crea la corrida de sincronización `en_curso` (una por conexión a la vez; las `en_curso` de más de 2 h se dan por
 * fallidas). Lanza TESTRAIL_SYNC_IN_PROGRESS si hay otra vigente.
 */
export async function startSync(deps: SyncDeps, input: StartSyncInput): Promise<TestRailSyncRun> {
  const now = deps.now?.() ?? new Date();
  return deps.prisma.$transaction(async (tx) => {
    const conn = input.connectionId
      ? await tx.testRailConnection.findUnique({ where: { id: input.connectionId } })
      : await getConnection(tx);
    if (!conn) throw new KatalystError('TESTRAIL_CONNECTION_INVALID', 'No hay conexión de TestRail configurada.');
    if (!conn.enabled) throw new KatalystError('TESTRAIL_CONNECTION_INVALID', 'La conexión de TestRail está deshabilitada.');
    if (!conn.projectExternalId) throw new KatalystError('TESTRAIL_CONNECTION_INVALID', 'Falta el proyecto de TestRail.');
    await tx.$queryRaw`SELECT "id" FROM "testrail_connection" WHERE "id" = ${conn.id}::uuid FOR UPDATE`;
    await tx.testRailSyncRun.updateMany({
      where: { connectionId: conn.id, status: 'en_curso', startedAt: { lt: new Date(now.getTime() - STALE_SYNC_MS) } },
      data: { status: 'fallida', finishedAt: now, error: 'Sincronización abandonada (proceso interrumpido).' },
    });
    const running = await tx.testRailSyncRun.findFirst({ where: { connectionId: conn.id, status: 'en_curso' } });
    if (running) throw new KatalystError('TESTRAIL_SYNC_IN_PROGRESS');
    const run = await tx.testRailSyncRun.create({
      data: {
        connectionId: conn.id,
        status: 'en_curso',
        trigger: input.trigger,
        startedAt: now,
        stats: emptyStats() as unknown as Prisma.InputJsonValue,
        createdById: input.actor !== 'system' && input.actor.kind === 'panel_user' ? input.actor.id : null,
      },
    });
    await tx.testRailConnection.update({ where: { id: conn.id }, data: { lastSyncStatus: 'en_curso' } });
    await publishEvent(tx, {
      type: 'testrail.sync',
      entity: 'testrail_sync_run',
      entityId: run.id,
      version: 0,
      data: { status: 'en_curso', trigger: input.trigger },
    });
    return run;
  });
}

interface StagedSuite {
  externalId: number;
  name: string;
  sections: TrSection[];
}

/** Fase 1: lectura completa con staging. Lanza ante cualquier fallo. */
async function fetchToStaging(
  deps: SyncDeps,
  client: TestRailClient,
  run: TestRailSyncRun,
  projectId: number,
  suiteFilter: number[] | undefined,
  stats: SyncStats,
): Promise<{
  projects: { id: number; name: string }[];
  suites: StagedSuite[];
  allSuiteIds: number[];
  priorities: Map<number, string>;
  types: Map<number, string>;
}> {
  const projects = await client.getProjects();
  if (!projects.some((p) => p.id === projectId)) {
    throw new KatalystError('TESTRAIL_CONNECTION_INVALID', 'El proyecto configurado no existe en TestRail.');
  }
  const allSuites = await client.getSuites(projectId);
  const suites = suiteFilter && suiteFilter.length > 0 ? allSuites.filter((s) => suiteFilter.includes(s.id)) : allSuites;
  const priorities = new Map((await client.getPriorities()).map((p) => [p.id, p.name]));
  const types = new Map((await client.getCaseTypes()).map((t) => [t.id, t.name]));
  const unsupported = new Set<string>();
  const out: StagedSuite[] = [];
  for (const s of suites) {
    const sections: TrSection[] = [];
    for await (const page of client.getSectionsPages(projectId, s.id)) {
      stats.pages++;
      sections.push(...page);
    }
    for await (const page of client.getCasesPages(projectId, s.id)) {
      stats.pages++;
      const rows = page.map((c) => {
        const ex = extractCaseContent(c, deps.businessFields ?? []);
        for (const u of ex.unsupported) unsupported.add(u);
        const payload = {
          title: sanitizeErrorMessage(c.title ?? '', 1000),
          refs: c.refs ?? null,
          priority: c.priority_id ?? null,
          type: c.type_id ?? null,
          content: ex.content,
          customFields: ex.customFields,
        };
        return {
          syncRunId: run.id,
          trCaseId: c.id,
          trSectionId: c.section_id,
          trSuiteId: s.id,
          payload: payload as unknown as Prisma.InputJsonValue,
          contentHash: ex.contentHash,
        };
      });
      if (rows.length > 0) await deps.prisma.testRailCaseStaging.createMany({ data: rows, skipDuplicates: true });
    }
    out.push({ externalId: s.id, name: s.name, sections });
  }
  stats.unsupportedFields = [...unsupported].sort();
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    suites: out,
    allSuiteIds: allSuites.map((s) => s.id),
    priorities,
    types,
  };
}

interface StagedPayload {
  title: string;
  refs: string | null;
  priority: number | null;
  type: number | null;
  content: CaseContent;
  customFields: Record<string, unknown>;
}

/** Fase 2: aplica todo en una transacción. */
async function applyStaging(
  deps: SyncDeps,
  tx: Prisma.TransactionClient,
  run: TestRailSyncRun,
  conn: { id: string; projectExternalId: number },
  fetched: Awaited<ReturnType<typeof fetchToStaging>>,
  stats: SyncStats,
  now: Date,
): Promise<void> {
  // Proyectos (todos los visibles; los desaparecidos se archivan).
  const projectIds = new Map<number, string>();
  for (const p of fetched.projects) {
    const row = await tx.testRailProject.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: p.id } },
      create: { connectionId: conn.id, externalId: p.id, name: p.name },
      update: { name: p.name, archivedAt: null },
      select: { id: true },
    });
    projectIds.set(p.id, row.id);
  }
  stats.projects = fetched.projects.length;
  await tx.testRailProject.updateMany({
    where: { connectionId: conn.id, archivedAt: null, externalId: { notIn: fetched.projects.map((p) => p.id) } },
    data: { archivedAt: now },
  });
  const projectId = projectIds.get(conn.projectExternalId)!;

  // Suites desaparecidas del proyecto → archivadas con sus secciones y casos.
  const goneSuites = await tx.testRailSuite.findMany({
    where: { connectionId: conn.id, projectId, archivedAt: null, externalId: { notIn: fetched.allSuiteIds } },
    select: { id: true },
  });
  if (goneSuites.length > 0) {
    const ids = goneSuites.map((s) => s.id);
    await tx.testRailSuite.updateMany({ where: { id: { in: ids } }, data: { archivedAt: now } });
    await tx.testRailSection.updateMany({ where: { suiteId: { in: ids }, archivedAt: null }, data: { archivedAt: now } });
    const r = await tx.testRailCase.updateMany({ where: { suiteId: { in: ids }, archivedAt: null }, data: { archivedAt: now } });
    stats.casesArchived += r.count;
  }

  const existingCases = new Map(
    (
      await tx.testRailCase.findMany({
        where: { connectionId: conn.id },
        select: { id: true, trCaseId: true, contentHash: true, revision: true, title: true, refs: true, priority: true, type: true, sectionId: true, suiteId: true, archivedAt: true, customFields: true },
      })
    ).map((c) => [c.trCaseId, c]),
  );

  for (const s of fetched.suites) {
    const suite = await tx.testRailSuite.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: s.externalId } },
      create: { connectionId: conn.id, projectId, externalId: s.externalId, name: s.name },
      update: { name: s.name, projectId, archivedAt: null },
      select: { id: true },
    });
    stats.suites++;

    // Árbol de secciones (padres primero).
    const sectionIds = new Map<number, string>();
    const existingSections = new Map(
      (await tx.testRailSection.findMany({ where: { connectionId: conn.id }, select: { id: true, trSectionId: true, suiteId: true } })).map(
        (x) => [x.trSectionId, x],
      ),
    );
    const ordered = [...s.sections].sort((a, b) => a.depth - b.depth || a.display_order - b.display_order);
    for (const sec of ordered) {
      const parentId = sec.parent_id ? (sectionIds.get(sec.parent_id) ?? null) : null;
      const data = {
        name: sanitizeErrorMessage(sec.name ?? '', 500),
        suiteId: suite.id,
        parentId,
        depth: sec.depth ?? 0,
        displayOrder: sec.display_order ?? 0,
        archivedAt: null,
      };
      const ex = existingSections.get(sec.id);
      const row = ex
        ? await tx.testRailSection.update({ where: { id: ex.id }, data, select: { id: true } })
        : await tx.testRailSection.create({ data: { connectionId: conn.id, trSectionId: sec.id, ...data }, select: { id: true } });
      sectionIds.set(sec.id, row.id);
    }
    stats.sections += s.sections.length;
    await tx.testRailSection.updateMany({
      where: { suiteId: suite.id, archivedAt: null, trSectionId: { notIn: s.sections.map((x) => x.id) } },
      data: { archivedAt: now },
    });

    // Casos del staging de esta suite.
    const staged = await tx.testRailCaseStaging.findMany({ where: { syncRunId: run.id, trSuiteId: s.externalId } });
    const seen: number[] = [];
    const unchangedIds: string[] = [];
    for (const st of staged) {
      const p = st.payload as unknown as StagedPayload;
      const sectionId = sectionIds.get(st.trSectionId);
      if (!sectionId) throw new Error(`Caso C${st.trCaseId} referencia una sección inexistente`);
      seen.push(st.trCaseId);
      stats.casesSeen++;
      const priority = p.priority !== null ? (fetched.priorities.get(p.priority) ?? String(p.priority)) : null;
      const type = p.type !== null ? (fetched.types.get(p.type) ?? String(p.type)) : null;
      const meta = { title: p.title, refs: p.refs, priority, type, sectionId, suiteId: suite.id };
      const ex = existingCases.get(st.trCaseId);
      if (!ex) {
        const created = await tx.testRailCase.create({
          data: {
            connectionId: conn.id,
            trCaseId: st.trCaseId,
            ...meta,
            steps: p.content.steps as unknown as Prisma.InputJsonValue,
            expected: p.content.expected,
            customFields: p.customFields as Prisma.InputJsonValue,
            contentHash: st.contentHash,
            revision: 1,
            syncedAt: now,
          },
          select: { id: true },
        });
        await tx.caseRevision.create({
          data: { caseId: created.id, revision: 1, contentHash: st.contentHash, content: p.content as unknown as Prisma.InputJsonValue },
        });
        stats.casesCreated++;
        continue;
      }
      if (ex.contentHash !== st.contentHash) {
        const revision = ex.revision + 1;
        await tx.testRailCase.update({
          where: { id: ex.id },
          data: {
            ...meta,
            steps: p.content.steps as unknown as Prisma.InputJsonValue,
            expected: p.content.expected,
            customFields: p.customFields as Prisma.InputJsonValue,
            contentHash: st.contentHash,
            revision,
            archivedAt: null,
            syncedAt: now,
          },
        });
        await tx.caseRevision.create({
          data: { caseId: ex.id, revision, contentHash: st.contentHash, content: p.content as unknown as Prisma.InputJsonValue },
        });
        const links = await tx.testCaseLink.updateMany({
          where: { caseId: ex.id, reviewStatus: 'vigente' },
          data: { reviewStatus: 'requiere_revision' },
        });
        stats.casesNewRevision++;
        stats.linksRequiringReview += links.count;
        continue;
      }
      const metaChanged =
        ex.title !== meta.title ||
        ex.refs !== meta.refs ||
        ex.priority !== meta.priority ||
        ex.type !== meta.type ||
        ex.sectionId !== meta.sectionId ||
        ex.suiteId !== meta.suiteId ||
        ex.archivedAt !== null ||
        canonicalJson(ex.customFields) !== canonicalJson(p.customFields);
      if (metaChanged) {
        // Título/refs/prioridad/tipo/sección: metadatos, sin invalidar revisión (ESP §13.1).
        await tx.testRailCase.update({
          where: { id: ex.id },
          data: { ...meta, customFields: p.customFields as Prisma.InputJsonValue, archivedAt: null, syncedAt: now },
        });
        stats.casesUpdated++;
      } else {
        unchangedIds.push(ex.id);
      }
    }
    if (unchangedIds.length > 0) await tx.testRailCase.updateMany({ where: { id: { in: unchangedIds } }, data: { syncedAt: now } });
    // Archivado de desaparecidos: solo tras staging completo de TODAS las suites (esta fase).
    const archived = await tx.testRailCase.updateMany({
      where: { suiteId: suite.id, archivedAt: null, trCaseId: { notIn: seen } },
      data: { archivedAt: now },
    });
    stats.casesArchived += archived.count;
  }
}

/** Ejecuta una corrida creada con `startSync`. Nunca lanza: deja la corrida `exitosa` o `fallida`. */
export async function executeSync(deps: SyncDeps, runId: string, actor: Principal | 'system' = 'system'): Promise<TestRailSyncRun> {
  const { prisma, logger } = deps;
  const run = await prisma.testRailSyncRun.findUniqueOrThrow({ where: { id: runId }, include: { connection: true } });
  const conn = run.connection;
  const stats = emptyStats();
  const log = logger.child({ syncRunId: run.id });
  const t0 = Date.now();
  try {
    const client = await deps.clientFactory({ baseUrl: conn.baseUrl, username: conn.username, secretRef: conn.secretRef });
    const fetched = await fetchToStaging(deps, client, run, conn.projectExternalId!, conn.suiteExternalIds, stats);
    const now = deps.now?.() ?? new Date();
    const done = await runInTransaction(
      prisma,
      async (tx) => {
        await applyStaging(deps, tx, run, { id: conn.id, projectExternalId: conn.projectExternalId! }, fetched, stats, now);
        await tx.testRailCaseStaging.deleteMany({ where: { syncRunId: run.id } });
        const r = await tx.testRailSyncRun.update({
          where: { id: run.id },
          data: { status: 'exitosa', finishedAt: now, stats: stats as unknown as Prisma.InputJsonValue, error: null },
        });
        await tx.testRailConnection.update({ where: { id: conn.id }, data: { lastSyncAt: now, lastSyncStatus: 'exitosa' } });
        await recordAudit(tx, {
          actor,
          action: 'testrail.sync',
          entity: 'testrail_sync_run',
          entityId: run.id,
          diff: { status: 'exitosa', trigger: run.trigger, stats },
        });
        await publishEvent(tx, {
          type: 'testrail.sync',
          entity: 'testrail_sync_run',
          entityId: run.id,
          version: 1,
          data: { status: 'exitosa', stats },
        });
        return r;
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
    metrics.testrailSyncs.inc({ status: 'exitosa', trigger: run.trigger });
    metrics.testrailLastSuccessfulSync.set(now.getTime() / 1000);
    log.info({ stats, ms: Date.now() - t0 }, 'sincronización TestRail exitosa');
    return done;
  } catch (e) {
    const message = sanitizeErrorMessage(e instanceof Error ? e.message : String(e), 1000);
    log.warn({ err: e, stats }, 'sincronización TestRail fallida; el catálogo no cambia');
    const now = deps.now?.() ?? new Date();
    await prisma.testRailCaseStaging.deleteMany({ where: { syncRunId: run.id } });
    const failed = await runInTransaction(prisma, async (tx) => {
      const r = await tx.testRailSyncRun.update({
        where: { id: run.id },
        data: { status: 'fallida', finishedAt: now, error: message, stats: stats as unknown as Prisma.InputJsonValue },
      });
      await tx.testRailConnection.update({ where: { id: conn.id }, data: { lastSyncAt: now, lastSyncStatus: 'fallida' } });
      await recordAudit(tx, {
        actor,
        action: 'testrail.sync',
        entity: 'testrail_sync_run',
        entityId: run.id,
        diff: { status: 'fallida', trigger: run.trigger, error: message },
      });
      await publishEvent(tx, {
        type: 'testrail.sync',
        entity: 'testrail_sync_run',
        entityId: run.id,
        version: 1,
        data: { status: 'fallida', error: message },
      });
      return r;
    });
    metrics.testrailSyncs.inc({ status: 'fallida', trigger: run.trigger });
    return failed;
  }
}

/** Sincroniza de punta a punta (inicio + ejecución). */
export async function syncNow(deps: SyncDeps, input: StartSyncInput): Promise<TestRailSyncRun> {
  const run = await startSync(deps, input);
  return executeSync(deps, run.id, input.actor);
}

export function toSyncRunDto(r: TestRailSyncRun) {
  const s = { ...emptyStats(), ...((r.stats as Partial<SyncStats> | null) ?? {}) };
  return {
    id: r.id,
    connectionId: r.connectionId,
    status: r.status,
    trigger: (r.trigger === 'programada' ? 'programada' : 'manual') as 'manual' | 'programada',
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    stats: s,
    error: r.error,
    createdBy: r.createdById,
  };
}
