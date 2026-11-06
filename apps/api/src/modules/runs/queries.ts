/**
 * Consultas de lectura de corridas (RF-RES-01, RF-RES-05, RF-TR-08; ESP §17.3, §17.4): paginación por cursor en
 * servidor, filtros indexados (`ix_run_environment_created_id`, `(created_at, id)`, `(run_id, status)`), proyecciones
 * `select` y agregados por `groupBy` (sin N+1). Las dimensiones resultado / cobertura / publicación no se mezclan.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  KatalystError,
  type CaseResult,
  type RunDetail,
  type RunListQuery,
  type RunResult,
  type RunTestRailTarget,
  type TestAttempt,
  type Page,
} from '@katalyst/shared';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, parseSort } from '../../lib/pagination.js';
import { RUN_SUMMARY_INCLUDE, countsFor, getRunSummary, snapshotOf, toRunSummary } from '../../services/results.js';
import type { RunSummary } from '@katalyst/shared';

type Db = Prisma.TransactionClient | PrismaClient;

export async function listRuns(db: Db, q: RunListQuery): Promise<Page<RunSummary>> {
  const sort = parseSort(q.sort, { createdAt: 'date', finishedAt: 'date' });
  const after = decodePageCursor(q.cursor, sort);
  const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
  const where: Prisma.RunWhereInput = {
    ...(q.environmentId ? { environmentId: q.environmentId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(q.outcome ? { outcome: q.outcome } : {}),
    ...(q.syncStatus ? { syncStatus: q.syncStatus } : {}),
    ...(q.trigger ? { trigger: q.trigger } : {}),
    ...(q.suiteId ? { suiteId: q.suiteId } : {}),
    ...(q.scheduleId ? { scheduleId: q.scheduleId } : {}),
    ...(q.createdBy ? { createdById: q.createdBy } : {}),
    ...(q.from || q.to
      ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } }
      : {}),
    ...(sort.field === 'finishedAt' ? { finishedAt: { not: null } } : {}),
  };
  const rows = await db.run.findMany({
    where: { AND: [where, keysetWhere(sort, after)] },
    include: RUN_SUMMARY_INCLUDE,
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
  });
  const ids = rows.slice(0, q.limit).map((r) => r.id);
  const { results, cases } = await countsFor(db as Prisma.TransactionClient, ids);
  return paginateMapped(rows, q.limit, sort, (r) =>
    toRunSummary(r, results.get(r.id)!, cases.get(r.id)!),
  );
}

export async function getRunDetail(db: Db, runId: string): Promise<RunDetail> {
  const summary = await getRunSummary(db as Prisma.TransactionClient, runId);
  const run = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: {
      selectionSnapshot: true,
      runtimeVersions: true,
      evidenceIncomplete: true,
      shards: {
        orderBy: { shardKey: 'asc' },
        include: {
          leases: { where: { revokedAt: null, releasedAt: null }, orderBy: { generation: 'desc' }, take: 1 },
        },
      },
    },
  });
  const [failed, infra, publication] = await Promise.all([
    db.runResult.count({ where: { runId, status: 'fallido' } }),
    db.runResult.count({ where: { runId, status: 'error_infraestructura' } }),
    db.outboxDelivery.count({ where: { runId, status: { in: ['requiere_intervencion', 'vencida'] }, operation: { startsWith: 'testrail.' } } }),
  ]);
  return {
    ...summary,
    snapshot: snapshotOf(run),
    runtimeVersions: (run.runtimeVersions ?? {}) as RunDetail['runtimeVersions'],
    shards: run.shards.map((s) => {
      const keys = Array.isArray(s.assignedTestKeys) ? s.assignedTestKeys : [];
      const l = s.leases[0];
      return {
        id: s.id,
        shardKey: s.shardKey,
        status: s.status,
        assignedTestCount: keys.length,
        recoveryCount: s.recoveryCount,
        currentLease: l
          ? {
              leaseId: l.id,
              workerId: l.workerId,
              generation: l.generation,
              heartbeatAt: l.heartbeatAt.toISOString(),
              expiresAt: l.expiresAt.toISOString(),
            }
          : null,
      };
    }),
    targets: await listTargets(db, runId),
    problems: { application: failed, runner: infra, publication },
    evidenceIncomplete: run.evidenceIncomplete,
  };
}

export async function assertRunExists(db: Db, runId: string): Promise<{ selectionSnapshot: unknown; environmentId: string }> {
  const r = await db.run.findUnique({ where: { id: runId }, select: { selectionSnapshot: true, environmentId: true } });
  if (!r) throw new KatalystError('NOT_FOUND');
  return r;
}

export async function listResults(
  db: Db,
  runId: string,
  q: { limit: number; cursor?: string | undefined; status?: RunResult['status'] | RunResult['status'][] | undefined; q?: string | undefined },
): Promise<Page<RunResult>> {
  const run = await assertRunExists(db, runId);
  const snap = snapshotOf(run);
  const sort = parseSort('id', { id: 'string' });
  const after = decodePageCursor(q.cursor, sort);
  const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
  const rows = await db.runResult.findMany({
    where: {
      AND: [
        {
          runId,
          ...(statuses ? { status: { in: statuses } } : {}),
          ...(q.q ? { automatedTest: { title: { contains: q.q, mode: 'insensitive' as const } } } : {}),
        },
        keysetWhere(sort, after),
      ],
    },
    include: { automatedTest: { select: { stableKey: true, title: true, filePath: true, classification: true } } },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
  });
  const ids = rows.map((r) => r.id);
  const artifactCounts = ids.length
    ? await db.artifact.groupBy({ by: ['runResultId'], where: { runResultId: { in: ids } }, _count: { _all: true } })
    : [];
  const countOf = new Map(artifactCounts.map((a) => [a.runResultId, a._count._all]));
  return paginateMapped(rows, q.limit, sort, (r) => {
    const pt = snap.tests.find((t) => t.automatedTestId === r.automatedTestId && t.parameterKey === r.parameterKey);
    return {
      id: r.id,
      runId: r.runId,
      automatedTestId: r.automatedTestId,
      stableKey: r.automatedTest.stableKey,
      title: pt?.title ?? r.automatedTest.title,
      filePath: pt?.filePath ?? r.automatedTest.filePath,
      parameterKey: r.parameterKey,
      classification: pt?.classification ?? r.automatedTest.classification,
      status: r.status,
      reason: r.reason,
      reasonText: r.reasonText,
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      infraRecoveryCount: r.infraRecoveryCount,
      caseIds: pt?.selectedCaseIds ?? [],
      artifactCount: countOf.get(r.id) ?? 0,
      evidenceIncomplete: r.evidenceIncomplete,
      updatedAt: r.updatedAt.toISOString(),
      version: r.version,
    };
  });
}

export async function listAttempts(db: Db, runId: string, resultId: string): Promise<{ items: TestAttempt[] }> {
  const rr = await db.runResult.findUnique({ where: { id: resultId }, select: { runId: true } });
  if (!rr || rr.runId !== runId) throw new KatalystError('NOT_FOUND');
  const rows = await db.testAttempt.findMany({ where: { runResultId: resultId }, orderBy: { attemptNo: 'asc' } });
  return {
    items: rows.map((a) => ({
      id: a.id,
      runResultId: a.runResultId,
      attemptNo: a.attemptNo,
      kind: a.kind,
      status: a.status,
      startedAt: a.startedAt.toISOString(),
      finishedAt: a.finishedAt?.toISOString() ?? null,
      durationMs: a.durationMs,
      errorCategory: a.errorCategory,
      error: a.error,
      workerLeaseId: a.workerLeaseId,
    })),
  };
}

export async function listCaseResults(
  db: Db,
  runId: string,
  q: { limit: number; cursor?: string | undefined },
): Promise<Page<CaseResult>> {
  const run = await assertRunExists(db, runId);
  const snap = snapshotOf(run);
  const sort = parseSort('id', { id: 'string' });
  const after = decodePageCursor(q.cursor, sort);
  const rows = await db.caseResult.findMany({
    where: { AND: [{ runId }, keysetWhere(sort, after)] },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
  });
  return paginateMapped(rows, q.limit, sort, (c) => {
    const pc = snap.cases.find((x) => x.caseId === c.caseId);
    return {
      id: c.id,
      runId: c.runId,
      caseId: c.caseId,
      ref: pc?.ref ?? 'C1',
      title: pc?.title ?? '',
      caseRevision: c.caseRevision,
      status: c.status,
      coverage: c.coverage,
      contributingResults: (Array.isArray(c.contributingResults) ? c.contributingResults : []) as CaseResult['contributingResults'],
      durationMs: c.durationMs,
      comment: c.comment,
      trResultId: c.trResultId,
      publishable: c.publishable,
      syncStatus: c.syncStatus,
    };
  });
}

export async function listTargets(db: Db, runId: string): Promise<RunTestRailTarget[]> {
  const targets = await db.runTestRailTarget.findMany({
    where: { runId },
    include: { testrailSuite: { select: { name: true, connection: { select: { baseUrl: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const pending = targets.length
    ? await db.outboxDelivery.groupBy({
        by: ['targetId'],
        where: { targetId: { in: targets.map((t) => t.id) }, status: { in: ['pendiente', 'en_proceso'] } },
        _count: { _all: true },
      })
    : [];
  const pendingOf = new Map(pending.map((p) => [p.targetId, p._count._all]));
  return targets.map((t) => ({
    id: t.id,
    testrailSuiteId: t.testrailSuiteId,
    suiteName: t.testrailSuite.name,
    trRunId: t.trRunId,
    syncStatus: t.syncStatus,
    closeExistingRun: t.closeExistingRun,
    pendingDeliveries: pendingOf.get(t.id) ?? 0,
    lastError: t.lastError,
    url: t.trRunId
      ? `${t.testrailSuite.connection.baseUrl.replace(/\/$/, '')}/index.php?/runs/view/${t.trRunId}`
      : null,
  }));
}
