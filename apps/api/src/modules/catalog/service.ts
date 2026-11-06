/**
 * Catálogo de tests automatizados (RF-CAT-01, RF-CAT-04, RF-CAT-05, RF-TR-03, RF-TR-07, ESP §4, §10 regla 9, §13.1).
 * - `requestCatalogRefresh`: resuelve el SHA de la rama protegida en servidor (sin refs del cliente), crea una
 *   `catalog_revision` `en_curso` y encola `catalog-listing` para el RUNNER (contenedor aislado sin secretos). La API
 *   NO ejecuta ni importa código de tests.
 * - `ingestCatalogListing`: recibe manifiesto + `playwright --list --reporter=json`, valida con `validateManifest`
 *   (unicidad UUID, correspondencia, casos existentes, clasificación) y, solo si es válido, aplica una revisión
 *   consistente: identidad por `stableKey` (renombrar no cambia identidad), vínculos N:M por caso, tests que salen del
 *   manifiesto quedan `retirado`. Una revisión inválida no modifica el catálogo.
 * - Flaky score histórico (§13.1): últimas 20 ejecuciones completas por test.
 */
import type { AutomatedTest, Prisma, PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  FLAKY_MIN_OBSERVATIONS,
  FLAKY_THRESHOLD,
  KatalystError,
  effectiveTags,
  flakyScore,
  sanitizeErrorMessage,
  sanitizeJson,
  validateManifest,
  type CatalogListingJobPayload,
  type ManifestIssue,
  type RunResultStatus,
} from '@katalyst/shared';
import type { Config } from '../../config.js';
import type { GitRepoReader } from '../../adapters/git/index.js';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';
import { publishEvent, runInTransaction } from '../../lib/events-publish.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Revisión `en_curso` más antigua que esto se considera abandonada. */
export const STALE_REVISION_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Encolado del listado aislado
// ---------------------------------------------------------------------------

export type CatalogListingEnqueuer = (payload: CatalogListingJobPayload) => Promise<void>;

let enqueuer: CatalogListingEnqueuer | undefined;
let queue: Queue | undefined;

export function setCatalogListingEnqueuer(e: CatalogListingEnqueuer | undefined): void {
  enqueuer = e;
}

function bullConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number(u.pathname.replace('/', '') || 0),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export function bullmqCatalogEnqueuer(config: Pick<Config, 'REDIS_URL' | 'QUEUE_PREFIX' | 'CATALOG_LISTING_QUEUE'>): CatalogListingEnqueuer {
  return async (payload) => {
    queue ??= new Queue(config.CATALOG_LISTING_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: config.QUEUE_PREFIX });
    await queue.add('catalog-listing', payload, {
      jobId: payload.catalogRevisionId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 86_400, count: 100 },
      removeOnFail: { age: 7 * 86_400 },
    });
  };
}

export async function closeCatalogQueue(): Promise<void> {
  const q = queue;
  queue = undefined;
  if (q) await q.close();
}

export async function requestCatalogRefresh(
  deps: { prisma: PrismaClient; config: Config; git: GitRepoReader | null },
  actor: Principal,
  requestId?: string,
) {
  if (!deps.git) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE', 'No hay plataforma Git configurada (ESP §12).');
  const gitCommit = await deps.git.resolveProtectedCommit();
  const now = new Date();
  const createdById = actor.kind === 'panel_user' ? actor.id : null;
  const rev = await runInTransaction(deps.prisma, async (tx) => {
    await tx.catalogRevision.updateMany({
      where: { status: 'en_curso', startedAt: { lt: new Date(now.getTime() - STALE_REVISION_MS) } },
      data: { status: 'fallida', finishedAt: now, errors: [{ code: 'ABANDONADA', message: 'El listado no respondió a tiempo.', stableKey: null }] },
    });
    const running = await tx.catalogRevision.findFirst({ where: { status: 'en_curso' } });
    if (running) throw new KatalystError('CONFLICT', 'Ya hay un refresco del catálogo en curso.');
    const r = await tx.catalogRevision.create({ data: { status: 'en_curso', gitCommit, startedAt: now, createdById } });
    await recordAudit(tx, {
      actor,
      action: 'catalog.refresh',
      entity: 'catalog_revision',
      entityId: r.id,
      diff: { gitCommit, branch: deps.git!.branch },
      ...(requestId ? { requestId } : {}),
    });
    await publishEvent(tx, { type: 'catalog.updated', entity: 'catalog_revision', entityId: r.id, version: 0, data: { status: 'en_curso' } });
    return r;
  });
  try {
    await (enqueuer ?? bullmqCatalogEnqueuer(deps.config))({ catalogRevisionId: rev.id, gitCommit });
  } catch {
    await deps.prisma.catalogRevision.update({
      where: { id: rev.id },
      data: { status: 'fallida', finishedAt: new Date(), errors: [{ code: 'COLA_NO_DISPONIBLE', message: 'No se pudo encolar el listado.', stableKey: null }] },
    });
    throw new KatalystError('DEPENDENCY_UNAVAILABLE');
  }
  return rev;
}

// ---------------------------------------------------------------------------
// Ingesta del listado (llamada desde POST /worker/catalog/listing)
// ---------------------------------------------------------------------------

export interface CatalogListingInput {
  catalogRevisionId: string;
  gitCommit: string;
  manifest: unknown;
  playwrightList: unknown;
  error: string | null;
}

const issueDto = (i: ManifestIssue) => ({ code: i.code, message: sanitizeErrorMessage(i.message, 500), stableKey: i.stableKey });

export async function ingestCatalogListing(
  prisma: PrismaClient,
  actor: Principal | 'system',
  body: CatalogListingInput,
): Promise<{ ok: true; status: string }> {
  const rev = await prisma.catalogRevision.findUnique({ where: { id: body.catalogRevisionId } });
  if (!rev) throw new KatalystError('NOT_FOUND');
  if (rev.status !== 'en_curso') return { ok: true, status: rev.status }; // repetición: acuse idempotente
  if (rev.gitCommit !== body.gitCommit) throw new KatalystError('CONFLICT', 'El commit no corresponde a la revisión solicitada.');
  const now = new Date();
  const fail = async (errors: { code: string; message: string; stableKey: string | null }[], warnings: unknown[] = []) => {
    await runInTransaction(prisma, async (tx) => {
      await tx.catalogRevision.update({
        where: { id: rev.id },
        data: { status: 'fallida', finishedAt: now, errors: errors as Prisma.InputJsonValue, warnings: warnings as Prisma.InputJsonValue },
      });
      await recordAudit(tx, { actor, action: 'catalog.refresh', entity: 'catalog_revision', entityId: rev.id, diff: { status: 'fallida', errors: errors.length } });
      await publishEvent(tx, { type: 'catalog.updated', entity: 'catalog_revision', entityId: rev.id, version: 1, data: { status: 'fallida' } });
    });
    return { ok: true as const, status: 'fallida' };
  };
  if (body.error) return fail([{ code: 'LISTADO_FALLIDO', message: sanitizeErrorMessage(body.error, 2000), stableKey: null }]);

  const known = await prisma.testRailCase.findMany({ where: { archivedAt: null }, select: { id: true, trCaseId: true, revision: true } });
  const byRef = new Map(known.map((c) => [`C${c.trCaseId}`, c]));
  const v = validateManifest(body.manifest, { playwrightList: body.playwrightList, knownCaseRefs: new Set(byRef.keys()), mode: 'catalog' });
  if (!v.ok || !v.manifest) return fail(v.errors.map(issueDto), v.warnings.map(issueDto));
  const manifest = v.manifest;

  const applied = await runInTransaction(
    prisma,
    async (tx) => {
      const seen: string[] = [];
      const touched: string[] = [];
      for (const t of manifest.tests) {
        seen.push(t.stableKey);
        const data = {
          filePath: t.file,
          title: t.title,
          tags: effectiveTags(t),
          classification: t.classification,
          status: t.status,
          parameterKeys: t.parameterKeys,
          writeIdempotencyApproved: t.writeIdempotencyApproved,
          owner: t.owner,
          manifestCommit: body.gitCommit,
          catalogRevisionId: rev.id,
        };
        const test = await tx.automatedTest.upsert({
          where: { stableKey: t.stableKey },
          create: { stableKey: t.stableKey, ...data },
          update: data,
          select: { id: true },
        });
        touched.push(test.id);
        const wanted = t.cases.map((ref) => byRef.get(ref)!).filter(Boolean);
        const existing = await tx.testCaseLink.findMany({ where: { automatedTestId: test.id }, select: { id: true, caseId: true } });
        const wantedIds = new Set(wanted.map((c) => c.id));
        const stale = existing.filter((l) => !wantedIds.has(l.caseId));
        if (stale.length > 0) await tx.testCaseLink.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } });
        const have = new Set(existing.map((l) => l.caseId));
        for (const c of wanted) {
          if (have.has(c.id)) continue;
          // Vínculo nuevo aprobado por PR: revisado contra la revisión vigente del caso.
          await tx.testCaseLink.create({
            data: { automatedTestId: test.id, caseId: c.id, reviewStatus: 'vigente', reviewedCaseRevision: c.revision },
          });
        }
      }
      // Tests que salieron del manifiesto: retirados (no entran en nuevas selecciones; historial intacto).
      const retired = await tx.automatedTest.updateMany({
        where: { stableKey: { notIn: seen }, status: { not: 'retirado' } },
        data: { status: 'retirado', catalogRevisionId: rev.id },
      });
      const r = await tx.catalogRevision.update({
        where: { id: rev.id },
        data: {
          status: 'completa',
          finishedAt: now,
          manifestHash: v.hash,
          manifest: manifest as unknown as Prisma.InputJsonValue,
          playwrightList: sanitizeJson(body.playwrightList ?? null, { maxDepth: 32 }).value as Prisma.InputJsonValue,
          testCount: manifest.tests.length,
          errors: [],
          warnings: v.warnings.map(issueDto) as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, {
        actor,
        action: 'catalog.refresh',
        entity: 'catalog_revision',
        entityId: rev.id,
        diff: { status: 'completa', tests: manifest.tests.length, retired: retired.count, manifestHash: v.hash },
      });
      await publishEvent(tx, { type: 'catalog.updated', entity: 'catalog_revision', entityId: rev.id, version: 1, data: { status: 'completa', tests: manifest.tests.length } });
      return { revision: r, touched };
    },
    { timeout: 120_000 },
  );
  await recomputeFlakyScores(prisma, applied.touched);
  return { ok: true, status: applied.revision.status };
}

// ---------------------------------------------------------------------------
// Flaky score (RF-CAT-04, ESP §13.1)
// ---------------------------------------------------------------------------

export async function flakyObservations(db: Db, testIds: string[], environmentId?: string) {
  if (testIds.length === 0) return new Map<string, { status: RunResultStatus; finishedAt: Date; environmentId: string }[]>();
  const rows = await db.$queryRaw<{ automated_test_id: string; status: RunResultStatus; finished_at: Date; environment_id: string }[]>`
    SELECT x."automated_test_id"::text AS "automated_test_id", x."status"::text AS "status", x."finished_at", x."environment_id"::text AS "environment_id"
      FROM (
        SELECT rr."automated_test_id", rr."status", r."finished_at", r."environment_id",
               row_number() OVER (PARTITION BY rr."automated_test_id" ORDER BY r."finished_at" DESC, rr."id" DESC) AS n
          FROM "run_result" rr JOIN "run" r ON r."id" = rr."run_id"
         WHERE rr."automated_test_id" = ANY(${testIds}::uuid[])
           AND rr."status" IN ('pasado', 'inestable', 'fallido')
           AND r."finished_at" IS NOT NULL
           AND (${environmentId ?? null}::uuid IS NULL OR r."environment_id" = ${environmentId ?? null}::uuid)
      ) x WHERE x.n <= 20`;
  const out = new Map<string, { status: RunResultStatus; finishedAt: Date; environmentId: string }[]>();
  for (const r of rows) {
    const list = out.get(r.automated_test_id) ?? [];
    list.push({ status: r.status, finishedAt: r.finished_at, environmentId: r.environment_id });
    out.set(r.automated_test_id, list);
  }
  return out;
}

/** Recalcula y persiste `flaky_score` (lo invoca la ingesta y API-B al finalizar resultados). */
export async function recomputeFlakyScores(db: Db, testIds: string[]): Promise<void> {
  const obs = await flakyObservations(db, testIds);
  for (const id of testIds) {
    const f = flakyScore(obs.get(id) ?? []);
    await db.automatedTest.update({
      where: { id },
      data: { flakyScore: f.score, flakyNumerator: f.numerator, flakyDenominator: f.denominator },
    });
  }
}

/** Recalcula el flaky score de los tests de una corrida (API-B lo invoca al finalizarla, dentro de su transacción). */
export async function recomputeFlakyForRun(db: Db, runId: string): Promise<number> {
  const rows = await db.runResult.findMany({ where: { runId }, select: { automatedTestId: true }, distinct: ['automatedTestId'] });
  await recomputeFlakyScores(db, rows.map((r) => r.automatedTestId));
  return rows.length;
}

/**
 * Red de seguridad horaria (proceso de control): recalcula tests con resultados en corridas finalizadas desde `since`.
 * Garantiza consistencia eventual del score persistido aunque la finalización no lo haya recalculado.
 */
export async function recomputeRecentFlakyScores(db: Db, since: Date): Promise<number> {
  const rows = await db.runResult.findMany({
    where: { run: { finishedAt: { gte: since } } },
    select: { automatedTestId: true },
    distinct: ['automatedTestId'],
    take: 5000,
  });
  await recomputeFlakyScores(db, rows.map((r) => r.automatedTestId));
  return rows.length;
}

export function isFlakyRow(t: Pick<AutomatedTest, 'flakyScore' | 'flakyDenominator'>): boolean {
  return t.flakyDenominator >= FLAKY_MIN_OBSERVATIONS && t.flakyScore !== null && t.flakyScore >= FLAKY_THRESHOLD;
}

/** Filtro Prisma de tests marcados flaky (persistido). */
export const FLAKY_WHERE: Prisma.AutomatedTestWhereInput = {
  flakyDenominator: { gte: FLAKY_MIN_OBSERVATIONS },
  flakyScore: { gte: FLAKY_THRESHOLD },
};
