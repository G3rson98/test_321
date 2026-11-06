/**
 * Resultados, intentos y finalización (ESP §13.2, §13.3, §13.4; RF-EJE-05, RF-EJE-08, RF-RES-01, RF-RES-03,
 * RF-RES-05, RF-TR-04, RF-TR-05, RF-NOT-01).
 * - Callbacks del ejecutor idempotentes por `(runResultId, attemptNo)`: repetir el mismo mensaje devuelve el acuse
 *   original sin mutar (aunque el lease ya haya terminado); mismo par con contenido distinto ⇒ 409 CALLBACK_CONFLICT.
 * - Retries funcionales (0..2) y recuperación de infraestructura (máx. 1) son contadores distintos; escritura sin
 *   idempotencia aprobada nunca se reintenta. Pasar tras retry ⇒ `inestable`.
 * - Finalización: `finalizando` ≤ 60 s espera solo persistencia/sanitización/artefactos; agregado por caso con
 *   `aggregateCase`, outcome con `computeRunOutcome`, outbox de TestRail (crear → resultados → adjuntos → cerrar) y de
 *   notificación en la MISMA transacción. `sync_status` es una dimensión separada.
 * - Una corrida terminal no se reabre por callbacks tardíos.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  TERMINAL_RUN_RESULT_STATUSES,
  TERMINAL_RUN_STATUSES,
  KatalystError,
  aggregateCase,
  buildTestRailComment,
  canRetry,
  canonicalJson,
  computeRunOutcome,
  finalResultFromAttempts,
  flakyScore,
  isFunctionalFailure,
  passedOnRetryNumber,
  reasonText,
  sanitizeErrorMessage,
  sha256Hex,
  verifySanitized,
  type AttemptKind,
  type AttemptStatus,
  type CaseResultStatus,
  type ErrorCategory,
  type ResultReason,
  type RunResultStatus,
  type RunSnapshot,
  type RunStatus,
  type RunSummary,
  type StatusCounts,
  type WorkerResultRequest,
} from '@katalyst/shared';
import type { z } from 'zod';
import type {
  WorkerAttemptStartRequestSchema,
  WorkerCompleteRequestSchema,
  WorkerAttemptStartResponseSchema,
  WorkerResultResponseSchema,
} from '@katalyst/shared';
import type { Principal } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { publishEvent, runInTransaction } from '../lib/events-publish.js';
import { releaseRunCapacity, releaseShardCapacity } from './capacity.js';
import { validateLease } from './leases.js';
import { getConfig } from '../config.js';
import { enqueueRunFinishedNotification } from '../modules/notifications/dispatch.js';
import { enqueueTestRailPublication } from '../modules/testrail/publication.js';
import { recomputeFlakyForRun } from '../modules/catalog/service.js';

type Db = Prisma.TransactionClient;
export type RunSummaryDto = RunSummary;

const TERMINAL_RUN = TERMINAL_RUN_STATUSES as readonly RunStatus[];
const TERMINAL_RESULT = TERMINAL_RUN_RESULT_STATUSES as readonly RunResultStatus[];

export function isTerminalRun(s: RunStatus): boolean {
  return TERMINAL_RUN.includes(s);
}

export function snapshotOf(run: { selectionSnapshot: unknown }): RunSnapshot {
  return run.selectionSnapshot as RunSnapshot;
}

function emptyCounts(): StatusCounts {
  return {
    total: 0,
    pendiente: 0,
    corriendo: 0,
    pasado: 0,
    inestable: 0,
    fallido: 0,
    bloqueado: 0,
    omitido: 0,
    cancelado: 0,
    error_infraestructura: 0,
  };
}

// =================================================================================================================
// Lecturas (RF-RES-01, RF-RES-05)
// =================================================================================================================

type RunRow = Prisma.RunGetPayload<{
  include: {
    environment: { select: { id: true; name: true; isProduction: true; enabled: true; recordingAllowed: true } };
    suite: { select: { name: true } };
    schedule: { select: { name: true } };
    createdBy: { select: { id: true; name: true } };
    createdByCredential: { select: { id: true; name: true } };
  };
}>;

export const RUN_SUMMARY_INCLUDE = {
  environment: { select: { id: true, name: true, isProduction: true, enabled: true, recordingAllowed: true } },
  suite: { select: { name: true } },
  schedule: { select: { name: true } },
  createdBy: { select: { id: true, name: true } },
  createdByCredential: { select: { id: true, name: true } },
} as const;

/** Conteos por run (un groupBy para N corridas: sin N+1). */
export async function countsFor(
  db: Db,
  runIds: string[],
): Promise<{ results: Map<string, StatusCounts>; cases: Map<string, RunSummary['caseCounts']> }> {
  const results = new Map<string, StatusCounts>();
  const cases = new Map<string, RunSummary['caseCounts']>();
  if (runIds.length === 0) return { results, cases };
  const [rg, cg] = await Promise.all([
    db.runResult.groupBy({ by: ['runId', 'status'], where: { runId: { in: runIds } }, _count: { _all: true } }),
    db.caseResult.groupBy({ by: ['runId', 'status'], where: { runId: { in: runIds } }, _count: { _all: true } }),
  ]);
  for (const id of runIds) {
    results.set(id, emptyCounts());
    cases.set(id, { total: 0, pasado: 0, inestable: 0, fallido: 0, bloqueado: 0, no_ejecutado: 0, pendiente: 0 });
  }
  for (const g of rg) {
    const c = results.get(g.runId)!;
    c[g.status] += g._count._all;
    c.total += g._count._all;
  }
  for (const g of cg) {
    const c = cases.get(g.runId)!;
    c[g.status as CaseResultStatus] += g._count._all;
    c.total += g._count._all;
  }
  return { results, cases };
}

export function toRunSummary(
  r: RunRow,
  counts: StatusCounts,
  caseCounts: RunSummary['caseCounts'],
): RunSummary {
  const createdBy: RunSummary['createdBy'] = r.createdBy
    ? { id: r.createdBy.id, kind: 'panel_user', displayName: r.createdBy.name }
    : r.createdByCredential
      ? { id: r.createdByCredential.id, kind: 'api_credential', displayName: r.createdByCredential.name }
      : { id: null, kind: 'sistema', displayName: r.trigger === 'programada' ? 'programación' : 'sistema' };
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    outcome: r.outcome,
    syncStatus: r.syncStatus,
    reason: r.reason,
    environment: r.environment,
    suiteId: r.suiteId,
    suiteName: r.suite?.name ?? null,
    scheduleId: r.scheduleId,
    scheduleName: r.schedule?.name ?? null,
    counts,
    caseCounts,
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
    queuedAt: r.queuedAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: r.cancelRequestedAt?.toISOString() ?? null,
    durationMs:
      r.startedAt && r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
    gitCommit: r.gitCommit,
    createdBy,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}

export async function getRunSummary(db: Db, runId: string): Promise<RunSummary> {
  const r = await db.run.findUnique({ where: { id: runId }, include: RUN_SUMMARY_INCLUDE });
  if (!r) throw new KatalystError('NOT_FOUND');
  const { results, cases } = await countsFor(db, [runId]);
  return toRunSummary(r, results.get(runId)!, cases.get(runId)!);
}

export async function runCountsOf(db: Db, runId: string): Promise<StatusCounts> {
  return (await countsFor(db, [runId])).results.get(runId)!;
}

// =================================================================================================================
// Eventos de corrida
// =================================================================================================================

export async function bumpRun(
  tx: Db,
  runId: string,
  data: Prisma.RunUpdateInput,
): Promise<{ id: string; version: number; status: RunStatus; environmentId: string }> {
  const r = await tx.run.update({
    where: { id: runId },
    data: { ...data, version: { increment: 1 } },
    select: {
      id: true,
      version: true,
      status: true,
      outcome: true,
      syncStatus: true,
      environmentId: true,
      startedAt: true,
      finishedAt: true,
      cancelRequestedAt: true,
    },
  });
  await publishEvent(tx, {
    type: 'run.updated',
    entity: 'run',
    entityId: r.id,
    version: r.version,
    runId: r.id,
    environmentId: r.environmentId,
    data: {
      status: r.status,
      outcome: r.outcome,
      syncStatus: r.syncStatus,
      counts: await runCountsOf(tx, r.id),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      cancelRequestedAt: r.cancelRequestedAt?.toISOString() ?? null,
    },
  });
  return r;
}

async function publishResult(
  tx: Db,
  rr: { id: string; runId: string; status: RunResultStatus; version: number; reason: ResultReason | null },
  environmentId: string,
): Promise<void> {
  await publishEvent(tx, {
    type: 'run_result.updated',
    entity: 'run_result',
    entityId: rr.id,
    version: rr.version,
    runId: rr.runId,
    environmentId,
    data: { status: rr.status, reason: rr.reason },
  });
}

// =================================================================================================================
// Finalización (ESP §13.2, §13.4)
// =================================================================================================================

export interface FinalizeArgs {
  /** `false` desactiva la notificación de fin (solo pruebas unitarias de agregación). */
  notify?: boolean;
  runId: string;
  terminal: 'terminada' | 'cancelada' | 'interrumpida' | 'omitida';
  reason: ResultReason | null;
  now: Date;
  publicBaseUrl: string;
}

/** Cierra resultados/intentos no terminales según el tipo de terminación. */
async function closeOpenWork(tx: Db, a: FinalizeArgs, runReason: ResultReason | null): Promise<void> {
  const open = await tx.runResult.findMany({
    where: { runId: a.runId, status: { in: ['pendiente', 'corriendo'] } },
    select: {
      id: true,
      status: true,
      automatedTest: { select: { classification: true } },
      attempts: { select: { id: true, status: true, durationMs: true } },
    },
  });
  for (const r of open) {
    const running = r.attempts.filter((x) => x.status === 'corriendo');
    let status: RunResultStatus;
    let reason: ResultReason;
    let attemptStatus: AttemptStatus;
    let category: ErrorCategory;
    if (a.terminal === 'cancelada') {
      status = 'cancelado';
      reason = runReason ?? 'cancelado_por_usuario';
      attemptStatus = 'cancelado';
      category = 'cancelacion';
    } else if (a.terminal === 'omitida') {
      status = 'omitido';
      reason = a.reason ?? 'sin_capacidad';
      attemptStatus = 'cancelado';
      category = 'cancelacion';
    } else {
      status = 'error_infraestructura';
      const write = r.automatedTest.classification !== 'lectura';
      reason = running.length && write ? 'escritura_resultado_desconocido' : (a.reason ?? 'error_interno');
      attemptStatus = 'error_infraestructura';
      category = a.reason === 'timeout_corrida' ? 'timeout_corrida' : write ? 'resultado_desconocido' : 'infraestructura';
    }
    for (const att of running) {
      await tx.testAttempt.update({
        where: { id: att.id },
        data: { status: attemptStatus, errorCategory: category, finishedAt: a.now },
      });
    }
    const durations = r.attempts.map((x) => x.durationMs).filter((d): d is number => typeof d === 'number');
    await tx.runResult.update({
      where: { id: r.id },
      data: {
        status,
        reason,
        reasonText: reasonText(reason),
        durationMs: durations.length ? durations.reduce((x, y) => x + y, 0) : null,
        ownerLeaseId: null,
        version: { increment: 1 },
      },
    });
  }
}

/**
 * Lleva la corrida a su estado terminal dentro de la transacción del llamador. Idempotente: si ya es terminal,
 * no hace nada y devuelve `false`.
 */
export async function finalizeRun(tx: Db, a: FinalizeArgs): Promise<boolean> {
  const locked = await tx.$queryRaw<{ status: RunStatus }[]>`
    SELECT status::text AS status FROM run WHERE id = ${a.runId}::uuid FOR NO KEY UPDATE`;
  const current = locked[0];
  if (!current || isTerminalRun(current.status)) return false;
  const run = await tx.run.findUniqueOrThrow({
    where: { id: a.runId },
    include: { environment: { select: { name: true } }, schedule: { select: { notify: true } } },
  });
  const snap = snapshotOf(run);
  const runReason = a.reason ?? run.reason;
  await closeOpenWork(tx, a, runReason);

  // --- Agregado por caso ------------------------------------------------------------------------------------------
  const results = await tx.runResult.findMany({
    where: { runId: a.runId },
    select: {
      id: true,
      status: true,
      reason: true,
      durationMs: true,
      parameterKey: true,
      automatedTest: { select: { stableKey: true, title: true } },
      attempts: {
        select: { attemptNo: true, kind: true, status: true, errorCategory: true, error: true, durationMs: true },
        orderBy: { attemptNo: 'asc' },
      },
    },
  });
  const byVariant = new Map(results.map((r) => [`${r.automatedTest.stableKey}#${r.parameterKey}`, r]));
  const caseRows = await tx.caseResult.findMany({ where: { runId: a.runId } });
  const caseRowByCase = new Map(caseRows.map((c) => [c.caseId, c]));
  const captures = await tx.artifact.findMany({
    where: { runId: a.runId, kind: 'captura', sanitizationStatus: 'sanitizado', uploadedAt: { not: null } },
    select: { id: true, runResultId: true },
  });
  const captureEnabled = snap.artifactPolicy.enabledKinds.includes('captura');
  const runUrl = `${a.publicBaseUrl.replace(/\/$/, '')}/runs/${a.runId}`;
  const aggregates: { status: CaseResultStatus; coverage: 'completa' | 'parcial' | 'ninguna' }[] = [];

  for (const pc of snap.cases) {
    const row = caseRowByCase.get(pc.caseId);
    if (!row) continue;
    const contributing = pc.requiredTests
      .map((v) => byVariant.get(`${v.stableKey}#${v.parameterKey}`))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const planBlockReason = !pc.executable ? (pc.blockReasons[0] ?? null) : null;
    const agg = aggregateCase({
      runStatus: a.terminal,
      required: pc.requiredTests,
      planBlockReason,
      results: contributing.map((r) => ({
        stableKey: r.automatedTest.stableKey,
        parameterKey: r.parameterKey,
        runResultId: r.id,
        status: r.status,
        reason: r.reason,
        passedOnRetry: passedOnRetryNumber(r.attempts),
        durationMs: r.durationMs,
        title: r.automatedTest.title,
      })),
    });
    const publishable = a.terminal !== 'omitida' && agg.publishable;
    const failedResults = contributing.filter((r) => r.status === 'fallido');
    const firstError = failedResults
      .flatMap((r) => r.attempts.filter((x) => isFunctionalFailure(x)).map((x) => x.error))
      .find((e): e is string => !!e);
    const hasCapture = failedResults.some((r) => captures.some((c) => c.runResultId === r.id));
    const evidenceNote =
      agg.status !== 'fallido'
        ? null
        : !captureEnabled
          ? (snap.artifactPolicy.disabledReasons['captura'] ?? 'captura deshabilitada por la política del ambiente')
          : hasCapture
            ? null
            : 'evidencia incompleta (sin captura sanitizada)';
    const comment = buildTestRailComment(agg, {
      runId: a.runId,
      runUrl,
      environmentName: run.environment.name,
      sanitizedError: firstError ?? null,
      evidenceNote,
      requiredCount: pc.requiredTests.length,
    });
    await tx.caseResult.update({
      where: { id: row.id },
      data: {
        status: agg.status,
        coverage: agg.coverage,
        contributingResults: contributing.map((r) => ({
          runResultId: r.id,
          stableKey: r.automatedTest.stableKey,
          parameterKey: r.parameterKey,
          status: r.status,
        })),
        durationMs: agg.durationMs,
        comment,
        publishable,
        syncStatus: 'no_aplica',
      },
    });
    aggregates.push({ status: agg.status, coverage: agg.coverage });
  }

  // --- Outcome y estado terminal ----------------------------------------------------------------------------------
  const finalResults = await tx.runResult.findMany({ where: { runId: a.runId }, select: { status: true } });
  const outcome = computeRunOutcome({ status: a.terminal, results: finalResults, cases: aggregates });
  const pendingArtifacts = await tx.artifact.updateMany({
    where: { runId: a.runId, sanitizationStatus: 'pendiente' },
    data: { sanitizationStatus: 'fallido', sanitizationReason: 'no se manifestó antes de finalizar la corrida' },
  });
  await tx.workerLease.updateMany({
    where: { runShard: { runId: a.runId }, revokedAt: null, releasedAt: null },
    data: { releasedAt: a.now },
  });
  await tx.runShard.updateMany({
    where: { runId: a.runId, status: { in: ['pendiente', 'asignado', 'corriendo'] } },
    data: {
      status: a.terminal === 'cancelada' || a.terminal === 'omitida' ? 'cancelado' : a.terminal === 'interrumpida' ? 'interrumpido' : 'completado',
      updatedAt: a.now,
    },
  });
  await tx.outboxDelivery.updateMany({
    where: { runId: a.runId, operation: 'run.dispatch_shard', status: 'pendiente' },
    data: { status: 'cancelada', lastError: 'corrida terminal' },
  });
  await releaseRunCapacity(tx, a.runId, a.now);
  await bumpRun(tx, a.runId, {
    status: a.terminal,
    outcome,
    reason: runReason,
    finishedAt: a.now,
    ...(pendingArtifacts.count > 0 ? { evidenceIncomplete: true } : {}),
  });

  if (a.terminal === 'omitida' && run.scheduleId) {
    await tx.scheduleOccurrence.updateMany({
      where: { runId: a.runId },
      data: { status: 'omitida', reason: a.reason === 'sin_capacidad' ? 'sin_capacidad' : 'configuracion_invalida' },
    });
  }

  // --- Notificación de fin con fallas o interrupción (RF-NOT-01): el módulo de notificaciones (API-C) crea la alerta
  // deduplicada y la entrega `notification.run_finished` en ESTA transacción; el envío lo hace su handler.
  if (a.notify !== false) await enqueueRunFinishedNotification(tx, a.runId, getConfig());
  // --- Publicación TestRail (API-A): crear → resultados → adjuntos → cerrar, en ESTA transacción. Una corrida omitida
  // antes de iniciar no tiene casos publicables y no crea destino externo (`no_aplica`).
  await enqueueTestRailPublication(tx, a.runId);
  // --- Flaky score persistido (RF-CAT-04, ESP §13.1): recalcular con el historial ya incluido en esta corrida.
  // El bucle horario de control es solo red de seguridad (D-050).
  await recomputeFlakyForRun(tx, a.runId);
  return true;
}

/** Si todos los shards terminaron, decide el estado terminal (o pasa a `finalizando` si hay artefactos en curso). */
export async function settleRunIfDone(tx: Db, runId: string, now: Date, publicBaseUrl: string): Promise<boolean> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, cancelRequestedAt: true, reason: true, shards: { select: { status: true } } },
  });
  if (!run || isTerminalRun(run.status)) return false;
  if (run.shards.some((s) => s.status === 'pendiente' || s.status === 'asignado' || s.status === 'corriendo')) {
    return false;
  }
  if (run.cancelRequestedAt) {
    return finalizeRun(tx, { runId, terminal: 'cancelada', reason: run.reason ?? 'cancelado_por_usuario', now, publicBaseUrl });
  }
  if (run.shards.some((s) => s.status === 'interrumpido')) {
    return finalizeRun(tx, { runId, terminal: 'interrumpida', reason: run.reason ?? 'recuperacion_agotada', now, publicBaseUrl });
  }
  const pending = await tx.artifact.count({ where: { runId, sanitizationStatus: 'pendiente' } });
  if (pending > 0) {
    if (run.status !== 'finalizando') await bumpRun(tx, runId, { status: 'finalizando' });
    return false;
  }
  return finalizeRun(tx, { runId, terminal: 'terminada', reason: null, now, publicBaseUrl });
}

/**
 * Corridas en `finalizando`: terminan cuando no quedan artefactos pendientes o vence el plazo (≤ 60 s); un artefacto
 * ausente no cambia el resultado: se registra evidencia incompleta (ESP §13.2).
 */
export async function finalizeDueRuns(
  prisma: PrismaClient,
  now: Date,
  publicBaseUrl: string,
): Promise<string[]> {
  const runs = await prisma.run.findMany({
    where: { status: 'finalizando' },
    select: { id: true, selectionSnapshot: true, shards: { select: { updatedAt: true } } },
    take: 100,
  });
  const done: string[] = [];
  for (const r of runs) {
    const since = Math.max(0, ...r.shards.map((s) => s.updatedAt.getTime()));
    const limit = Math.min(60_000, snapshotOf(r).timeouts.finalizingMs);
    const pending = await prisma.artifact.count({ where: { runId: r.id, sanitizationStatus: 'pendiente' } });
    if (pending > 0 && now.getTime() - since < limit) continue;
    const ok = await runInTransaction(prisma, (tx) =>
      finalizeRun(tx, { runId: r.id, terminal: 'terminada', reason: null, now, publicBaseUrl }),
    );
    if (ok) done.push(r.id);
  }
  return done;
}

// =================================================================================================================
// Callbacks del ejecutor (ESP §13.3)
// =================================================================================================================

type AttemptStartReq = z.infer<typeof WorkerAttemptStartRequestSchema>;
type AttemptStartRes = z.infer<typeof WorkerAttemptStartResponseSchema>;
type ResultRes = z.infer<typeof WorkerResultResponseSchema>;
type CompleteReq = z.infer<typeof WorkerCompleteRequestSchema>;

export function callbackHash(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

function testPolicy(snap: RunSnapshot, automatedTestId: string, parameterKey: string) {
  const t = snap.tests.find((x) => x.automatedTestId === automatedTestId && x.parameterKey === parameterKey);
  if (!t) throw new KatalystError('NOT_FOUND', 'El resultado no pertenece al plan congelado.');
  return { retries: t.retries, classification: t.classification, writeIdempotencyApproved: t.writeIdempotencyApproved };
}

/** `POST /worker/attempts`: persiste el inicio ANTES de despachar el test. */
export async function startAttempt(
  prisma: PrismaClient,
  principal: Principal,
  req: AttemptStartReq,
  now: Date,
): Promise<AttemptStartRes> {
  const hash = callbackHash(req);
  const prior = await prisma.testAttempt.findUnique({
    where: { runResultId_attemptNo: { runResultId: req.runResultId, attemptNo: req.attemptNo } },
  });
  if (prior) {
    if (prior.startRequestHash !== hash) throw new KatalystError('CALLBACK_CONFLICT');
    return { attemptId: prior.id, duplicate: true, proceed: prior.status === 'corriendo' };
  }
  return runInTransaction(prisma, async (tx) => {
    const { lease, run } = await validateLease(tx, req, principal, now);
    const rr = await tx.runResult.findUnique({
      where: { id: req.runResultId },
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
    if (!rr || rr.runId !== run.id || rr.runShardId !== lease.runShardId) throw new KatalystError('NOT_FOUND');
    if (TERMINAL_RESULT.includes(rr.status)) throw new KatalystError('CONFLICT', 'El test ya tiene resultado final.');
    const snap = snapshotOf(run);
    const policy = testPolicy(snap, rr.automatedTestId, rr.parameterKey);
    const last = rr.attempts.at(-1);
    const expectedNo = (last?.attemptNo ?? 0) + 1;
    if (req.attemptNo !== expectedNo) throw new KatalystError('CONFLICT', `attemptNo esperado: ${expectedNo}.`);
    if (last?.status === 'corriendo') throw new KatalystError('CONFLICT', 'Hay un intento en curso.');
    const kindOk = ((): boolean => {
      switch (req.kind as AttemptKind) {
        case 'inicial':
          return !last;
        case 'retry':
          return !!last && canRetry(rr.attempts, policy);
        case 'recuperacion':
          return (
            !!last &&
            last.status === 'error_infraestructura' &&
            last.errorCategory === 'worker_perdido' &&
            policy.classification === 'lectura' &&
            rr.infraRecoveryCount < 1
          );
      }
    })();
    if (!kindOk) throw new KatalystError('CONFLICT', 'El tipo de intento no está permitido por la política congelada.');
    const cancelled = run.cancelRequestedAt !== null;
    const attempt = await tx.testAttempt.create({
      data: {
        runResultId: rr.id,
        attemptNo: req.attemptNo,
        kind: req.kind,
        status: cancelled ? 'cancelado' : 'corriendo',
        startedAt: new Date(req.startedAt),
        ...(cancelled ? { finishedAt: now, errorCategory: 'cancelacion' as const } : {}),
        workerLeaseId: lease.id,
        startRequestHash: hash,
      },
    });
    if (cancelled) {
      const reason = run.reason ?? 'cancelado_por_usuario';
      const updated = await tx.runResult.update({
        where: { id: rr.id },
        data: { status: 'cancelado', reason, reasonText: reasonText(reason), version: { increment: 1 } },
      });
      await publishResult(tx, updated, run.environmentId);
    } else {
      const updated = await tx.runResult.update({
        where: { id: rr.id },
        data: {
          status: 'corriendo',
          ownerLeaseId: lease.id,
          ...(req.kind === 'retry' ? { retryCount: { increment: 1 } } : {}),
          ...(req.kind === 'recuperacion' ? { infraRecoveryCount: { increment: 1 } } : {}),
          version: { increment: 1 },
        },
      });
      await publishResult(tx, updated, run.environmentId);
      if (run.status === 'preparando' || run.status === 'en_cola') await bumpRun(tx, run.id, { status: 'corriendo' });
    }
    await publishEvent(tx, {
      type: 'attempt.updated',
      entity: 'test_attempt',
      entityId: attempt.id,
      version: 0,
      runId: run.id,
      environmentId: run.environmentId,
      data: { runResultId: rr.id, attemptNo: attempt.attemptNo, kind: attempt.kind, status: attempt.status },
    });
    return { attemptId: attempt.id, duplicate: false, proceed: !cancelled };
  });
}

function reasonForFinal(
  status: RunResultStatus,
  category: ErrorCategory | null,
  requested: ResultReason | null | undefined,
): ResultReason | null {
  if (requested) return requested;
  switch (status) {
    case 'pasado':
    case 'inestable':
      return null;
    case 'fallido':
      return category === 'timeout_aplicacion' ? 'timeout_test' : null;
    case 'error_infraestructura':
      switch (category) {
        case 'resultado_desconocido':
          return 'escritura_resultado_desconocido';
        case 'login':
          return 'login_fallido';
        case 'timeout_corrida':
          return 'timeout_corrida';
        case 'worker_perdido':
          return 'worker_perdido';
        default:
          return 'error_interno';
      }
    case 'cancelado':
      return 'cancelado_por_usuario';
    case 'omitido':
      return 'dependencia_fallida';
    default:
      return null;
  }
}

const ACK_ACTOR = (runResultId: string) => `worker-result:${runResultId}`;

/** `POST /worker/results`: resultado de un intento (idempotente por `(runResultId, attemptNo)`). */
export async function recordResult(
  prisma: PrismaClient,
  principal: Principal,
  req: WorkerResultRequest,
  now: Date,
): Promise<ResultRes> {
  const hash = callbackHash(req);
  const prior = await prisma.testAttempt.findUnique({
    where: { runResultId_attemptNo: { runResultId: req.runResultId, attemptNo: req.attemptNo } },
  });
  if (prior?.resultRequestHash) {
    if (prior.resultRequestHash !== hash) throw new KatalystError('CALLBACK_CONFLICT');
    const ack = await prisma.idempotencyKey.findUnique({
      where: { actorKey_key: { actorKey: ACK_ACTOR(req.runResultId), key: `attempt:${req.attemptNo}` } },
    });
    if (ack?.responseBody) return { ...(ack.responseBody as ResultRes), duplicate: true };
    const rr = await prisma.runResult.findUniqueOrThrow({ where: { id: req.runResultId } });
    return { runResultId: rr.id, attemptNo: req.attemptNo, status: rr.status, duplicate: true, retryAllowed: false };
  }
  return runInTransaction(prisma, async (tx) => {
    const { lease, run } = await validateLease(tx, req, principal, now);
    const attempt = await tx.testAttempt.findUnique({
      where: { runResultId_attemptNo: { runResultId: req.runResultId, attemptNo: req.attemptNo } },
    });
    if (!attempt || attempt.workerLeaseId !== lease.id) {
      throw new KatalystError('CONFLICT', 'El intento no fue iniciado por este lease.');
    }
    if (attempt.status !== 'corriendo') throw new KatalystError('CONFLICT', 'El intento ya tiene resultado.');
    const rr = await tx.runResult.findUniqueOrThrow({ where: { id: req.runResultId } });
    const snap = snapshotOf(run);
    const policy = testPolicy(snap, rr.automatedTestId, rr.parameterKey);

    // Error sanitizado y verificado; si no puede sanitizarse se retiene (RNF-SEG-02).
    let error: string | null = null;
    if (req.error) {
      const clean = sanitizeErrorMessage(req.error);
      error = verifySanitized(clean).ok ? clean : '[error retenido: no pudo sanitizarse]';
    }
    await tx.testAttempt.update({
      where: { id: attempt.id },
      data: {
        status: req.attemptStatus,
        finishedAt: new Date(req.finishedAt),
        durationMs: req.durationMs,
        errorCategory: req.errorCategory,
        error,
        resultRequestHash: hash,
      },
    });
    const attempts = await tx.testAttempt.findMany({
      where: { runResultId: rr.id },
      orderBy: { attemptNo: 'asc' },
      select: { attemptNo: true, kind: true, status: true, errorCategory: true, durationMs: true },
    });
    const passed = req.attemptStatus === 'pasado';
    const retryAllowed = !passed && run.cancelRequestedAt === null && canRetry(attempts, policy);
    const final = req.final || !retryAllowed;
    let status: RunResultStatus = 'corriendo';
    let reason: ResultReason | null = null;
    const fr = finalResultFromAttempts(attempts);
    if (final) {
      status = fr.status;
      const override = req.finalStatus;
      if (override && (override === 'omitido' || override === 'bloqueado' || override === 'cancelado') && fr.status !== 'fallido') {
        status = override;
      }
      reason = reasonForFinal(status, req.errorCategory, req.reason);
    }
    const updated = await tx.runResult.update({
      where: { id: rr.id },
      data: {
        status,
        reason,
        reasonText: reason ? reasonText(reason) : null,
        durationMs: fr.durationMs,
        retryCount: fr.retryCount,
        infraRecoveryCount: fr.infraRecoveryCount,
        version: { increment: 1 },
      },
    });
    await publishResult(tx, updated, run.environmentId);
    await publishEvent(tx, {
      type: 'attempt.updated',
      entity: 'test_attempt',
      entityId: attempt.id,
      version: 1,
      runId: run.id,
      environmentId: run.environmentId,
      data: { runResultId: rr.id, attemptNo: attempt.attemptNo, status: req.attemptStatus },
    });
    await bumpRun(tx, run.id, {});
    const ack: ResultRes = {
      runResultId: rr.id,
      attemptNo: req.attemptNo,
      status,
      duplicate: false,
      retryAllowed: !final && retryAllowed,
    };
    await tx.idempotencyKey.create({
      data: {
        actorKey: ACK_ACTOR(rr.id),
        key: `attempt:${req.attemptNo}`,
        method: 'POST',
        path: '/api/v1/worker/results',
        requestHash: hash,
        state: 'completada',
        responseStatus: 200,
        responseBody: ack,
        runId: run.id,
        expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      },
    });
    return ack;
  });
}

/** `POST /worker/complete`: fin de shard. Idempotente; los tests no terminados se cierran con causa. */
export async function completeShard(
  prisma: PrismaClient,
  principal: Principal,
  req: CompleteReq,
  now: Date,
  publicBaseUrl: string,
): Promise<{ ok: true; duplicate: boolean }> {
  const lease = await prisma.workerLease.findUnique({ where: { id: req.leaseId }, include: { runShard: true } });
  if (
    lease &&
    lease.generation === req.generation &&
    lease.releasedAt &&
    !lease.revokedAt &&
    lease.runShard.status === req.shardStatus
  ) {
    return { ok: true, duplicate: true };
  }
  return runInTransaction(prisma, async (tx) => {
    const { lease: l, shard, run } = await validateLease(tx, req, principal, now);
    const open = await tx.runResult.findMany({
      where: { runShardId: shard.id, status: { in: ['pendiente', 'corriendo'] } },
      select: { id: true, status: true, automatedTest: { select: { classification: true } }, attempts: { where: { status: 'corriendo' }, select: { id: true } } },
    });
    for (const r of open) {
      let status: RunResultStatus;
      let reason: ResultReason;
      if (req.shardStatus === 'cancelado' || run.cancelRequestedAt) {
        status = 'cancelado';
        reason = run.reason ?? 'cancelado_por_usuario';
      } else if (r.attempts.length > 0 && r.automatedTest.classification !== 'lectura') {
        status = 'error_infraestructura';
        reason = 'escritura_resultado_desconocido';
      } else {
        status = 'error_infraestructura';
        reason = req.reason ?? 'error_interno';
      }
      for (const att of r.attempts) {
        await tx.testAttempt.update({
          where: { id: att.id },
          data: {
            status: status === 'cancelado' ? 'cancelado' : 'error_infraestructura',
            errorCategory: status === 'cancelado' ? 'cancelacion' : reason === 'escritura_resultado_desconocido' ? 'resultado_desconocido' : 'infraestructura',
            finishedAt: now,
          },
        });
      }
      const u = await tx.runResult.update({
        where: { id: r.id },
        data: { status, reason, reasonText: reasonText(reason), version: { increment: 1 } },
      });
      await publishResult(tx, u, run.environmentId);
    }
    await tx.workerLease.update({ where: { id: l.id }, data: { releasedAt: now, heartbeatAt: now } });
    const s = await tx.runShard.update({ where: { id: shard.id }, data: { status: req.shardStatus, updatedAt: now } });
    await releaseShardCapacity(tx, shard.id, now);
    const versions = { ...((run.runtimeVersions as object) ?? {}), ...req.runtimeVersions };
    await bumpRun(tx, run.id, {
      runtimeVersions: versions,
      ...(req.evidenceIncomplete ? { evidenceIncomplete: true } : {}),
      ...(req.shardStatus === 'interrumpido' && req.reason && !run.reason ? { reason: req.reason } : {}),
    });
    await publishEvent(tx, {
      type: 'shard.updated',
      entity: 'run_shard',
      entityId: s.id,
      version: s.currentGeneration,
      runId: run.id,
      environmentId: run.environmentId,
      data: { status: s.status, shardKey: s.shardKey },
    });
    await settleRunIfDone(tx, run.id, now, publicBaseUrl);
    return { ok: true as const, duplicate: false };
  });
}

// =================================================================================================================
// Historial (RF-RES-03): por test y por caso con tendencia
// =================================================================================================================

export interface HistoryOptions {
  environmentId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: { finishedAt: Date; id: string } | null;
}

export async function testHistory(db: Db, automatedTestId: string, o: HistoryOptions) {
  const where: Prisma.RunResultWhereInput = {
    automatedTestId,
    run: {
      status: { in: ['terminada', 'cancelada', 'interrumpida'] },
      ...(o.environmentId ? { environmentId: o.environmentId } : {}),
      ...(o.from || o.to ? { finishedAt: { ...(o.from ? { gte: o.from } : {}), ...(o.to ? { lt: o.to } : {}) } } : {}),
    },
  };
  const rows = await db.runResult.findMany({
    where: {
      ...where,
      ...(o.cursor
        ? {
            OR: [
              { run: { finishedAt: { lt: o.cursor.finishedAt } } },
              { run: { finishedAt: o.cursor.finishedAt }, id: { lt: o.cursor.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      status: true,
      durationMs: true,
      retryCount: true,
      run: { select: { id: true, environmentId: true, finishedAt: true } },
    },
    orderBy: [{ run: { finishedAt: 'desc' } }, { id: 'desc' }],
    take: o.limit + 1,
  });
  const trendRows = await db.runResult.findMany({
    where,
    select: { status: true, durationMs: true, run: { select: { finishedAt: true, environmentId: true } } },
    orderBy: [{ run: { finishedAt: 'desc' } }],
    take: 100,
  });
  const hasNext = rows.length > o.limit;
  const page = rows.slice(0, o.limit);
  const complete = trendRows.filter((r) => r.status === 'pasado' || r.status === 'inestable' || r.status === 'fallido');
  const ok = complete.filter((r) => r.status !== 'fallido').length;
  const durs = complete.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
  const flaky = flakyScore(
    trendRows.map((r) => ({ status: r.status, finishedAt: r.run.finishedAt ?? new Date(0), environmentId: r.run.environmentId })),
    o.environmentId,
  );
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      runId: r.run.id,
      environmentId: r.run.environmentId,
      status: r.status,
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      finishedAt: r.run.finishedAt?.toISOString() ?? null,
    })),
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ f: last.run.finishedAt?.toISOString(), id: last.id })).toString('base64url') : null,
    hasNext,
    trend: {
      successRate: complete.length ? ok / complete.length : null,
      avgDurationMs: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
      observations: complete.length,
    },
    flaky,
  };
}

export async function caseHistory(db: Db, caseId: string, o: HistoryOptions) {
  const where: Prisma.CaseResultWhereInput = {
    caseId,
    run: {
      status: { in: ['terminada', 'cancelada', 'interrumpida'] },
      ...(o.environmentId ? { environmentId: o.environmentId } : {}),
      ...(o.from || o.to ? { finishedAt: { ...(o.from ? { gte: o.from } : {}), ...(o.to ? { lt: o.to } : {}) } } : {}),
    },
  };
  const rows = await db.caseResult.findMany({
    where: {
      ...where,
      ...(o.cursor
        ? {
            OR: [
              { run: { finishedAt: { lt: o.cursor.finishedAt } } },
              { run: { finishedAt: o.cursor.finishedAt }, id: { lt: o.cursor.id } },
            ],
          }
        : {}),
    },
    select: { id: true, status: true, durationMs: true, run: { select: { id: true, environmentId: true, finishedAt: true } } },
    orderBy: [{ run: { finishedAt: 'desc' } }, { id: 'desc' }],
    take: o.limit + 1,
  });
  const trendRows = await db.caseResult.findMany({
    where,
    select: { status: true, durationMs: true },
    orderBy: [{ run: { finishedAt: 'desc' } }],
    take: 100,
  });
  const hasNext = rows.length > o.limit;
  const page = rows.slice(0, o.limit);
  const complete = trendRows.filter((r) => r.status === 'pasado' || r.status === 'inestable' || r.status === 'fallido');
  const ok = complete.filter((r) => r.status !== 'fallido').length;
  const durs = complete.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      runId: r.run.id,
      environmentId: r.run.environmentId,
      status: r.status,
      durationMs: r.durationMs,
      retryCount: 0,
      finishedAt: r.run.finishedAt?.toISOString() ?? null,
    })),
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ f: last.run.finishedAt?.toISOString(), id: last.id })).toString('base64url') : null,
    hasNext,
    trend: {
      successRate: complete.length ? ok / complete.length : null,
      avgDurationMs: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
      observations: complete.length,
    },
    flaky: null,
  };
}

/** Decodifica el cursor de historial (`{f, id}` base64url). */
export function decodeHistoryCursor(cursor: string | undefined): { finishedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { f?: string; id?: string };
    if (!v.f || !v.id || Number.isNaN(Date.parse(v.f))) throw new Error('x');
    return { finishedAt: new Date(v.f), id: v.id };
  } catch {
    throw new KatalystError('VALIDATION_FAILED', 'Cursor inválido.');
  }
}

