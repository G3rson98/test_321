/**
 * Creación y admisión de corridas (ESP §9, §13.1, §13.3, §13.5; RF-EJE-01, RF-EJE-04, RF-EJE-07, RNF-REN-02).
 * - `createRunIdempotent`: `Idempotency-Key` por actor (misma clave + cuerpo ⇒ misma corrida; cuerpo distinto ⇒ 409;
 *   retención 24 h). La clave, la corrida, sus resultados, shards, destinos y casos se crean en UNA transacción.
 * - `createRunFromPlan`: filas inmutables del plan. Selección solo bloqueada ⇒ corrida `terminada` con outcome
 *   `bloqueado` sin navegador (ESP §13.1).
 * - `admitPendingShards`: reserva atómica de capacidad por shard + outbox `run.dispatch_shard` (payload
 *   `ShardJobPayload {runId, shardId}`) en la misma transacción; FIFO por `queued_at`.
 * - `expireQueuedScheduledRuns`: corrida programada sin capacidad tras la gracia (60 s) ⇒ `omitida/sin_capacidad`.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { Histogram } from 'prom-client';
import {
  IDEMPOTENCY_RETENTION_HOURS,
  KatalystError,
  canonicalJson,
  normalizeSelection,
  reasonText,
  sha256Hex,
  type PlanTest,
  type RunCreateRequest,
  type RunTrigger,
  type ShardJobPayload,
} from '@katalyst/shared';
import type { Principal } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { enqueueOutbox } from '../lib/outbox.js';
import { publishEvent, runInTransaction } from '../lib/events-publish.js';
import { metricsRegistry } from '../lib/metrics.js';
import { loadRuntimeSettings, resolvePlan, type ResolvedPlan } from './run-planner.js';
import { CapacityUnavailable, reserveShardCapacity, type CapacityScope } from './capacity.js';
import { finalizeRun, getRunSummary, type RunSummaryDto } from './results.js';

type Db = Prisma.TransactionClient;

export interface RunDeps {
  prisma: PrismaClient;
  logger: Logger;
  /** Techo de navegadores concurrentes del despliegue (`GLOBAL_BROWSER_CONCURRENCY`). */
  globalBrowserCeiling: number;
  /** URL pública del panel (enlace autenticado a la corrida en TestRail/notificaciones). */
  publicBaseUrl: string;
}

export const admissionDelaySeconds = new Histogram({
  name: 'katalyst_run_admission_delay_seconds',
  help: 'Retraso de admisión (reserva de capacidad) desde el instante previsto o de encolado (RNF-REN-02)',
  labelNames: ['trigger'] as const,
  buckets: [0.5, 1, 5, 15, 30, 60, 120, 300, 900],
  registers: [metricsRegistry],
});

export const startDelaySeconds = new Histogram({
  name: 'katalyst_run_start_delay_seconds',
  help: 'Retraso de inicio (claim del worker) desde la reserva de capacidad (RNF-REN-02)',
  labelNames: ['trigger'] as const,
  buckets: [0.5, 1, 5, 15, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export function actorKeyOf(p: Principal): string {
  return `${p.kind}:${p.kind === 'lease' ? p.leaseId : p.id}`;
}

export function actorRefs(p: Principal | 'system'): { createdById: string | null; createdByCredentialId: string | null } {
  if (p === 'system') return { createdById: null, createdByCredentialId: null };
  switch (p.kind) {
    case 'panel_user':
      return { createdById: p.id, createdByCredentialId: null };
    case 'device':
      return { createdById: p.userId, createdByCredentialId: null };
    case 'api_token':
      return { createdById: null, createdByCredentialId: p.id };
    default:
      return { createdById: null, createdByCredentialId: null };
  }
}

export interface RunMeta {
  trigger: RunTrigger;
  actor: Principal | 'system';
  idempotencyKey?: string | null;
  scheduleId?: string | null;
  scheduledFor?: Date | null;
  requestId?: string;
}

/** Reparte variantes ejecutables en shards disjuntos (round-robin estable). */
export function partitionShards(tests: readonly { runResultId: string }[], shardCount: number): string[][] {
  const n = Math.max(1, Math.min(shardCount, tests.length || 1));
  const out: string[][] = Array.from({ length: n }, () => []);
  tests.forEach((t, i) => out[i % n]!.push(t.runResultId));
  return out.filter((s) => s.length > 0);
}

function resultStatusForBlocked(t: PlanTest): { status: 'bloqueado' | 'omitido'; reason: PlanTest['blockReasons'][number] } {
  const reason = t.blockReasons[0] ?? 'error_interno';
  return { status: reason === 'excluido_inestable' ? 'omitido' : 'bloqueado', reason };
}

/** Crea todas las filas de la corrida a partir del plan, dentro de la transacción del llamador. */
export async function createRunFromPlan(
  tx: Db,
  deps: Pick<RunDeps, 'globalBrowserCeiling' | 'publicBaseUrl'>,
  plan: ResolvedPlan,
  meta: RunMeta,
  now: Date,
): Promise<string> {
  const runId = randomUUID();
  const snap = plan.snapshot;
  const refs = actorRefs(meta.actor);
  if (meta.actor !== 'system' && meta.actor.kind === 'api_token') {
    // Corrida por token API: se registra también el usuario dueño del token (quién la inició, RF-RES-01).
    const c = await tx.apiCredential.findUnique({ where: { id: meta.actor.id }, select: { principalId: true } });
    refs.createdById = c?.principalId ?? null;
  }
  await tx.run.create({
    data: {
      id: runId,
      trigger: meta.trigger,
      suiteId: snap.suite?.id ?? null,
      scheduleId: meta.scheduleId ?? null,
      environmentId: plan.environment.id,
      status: 'en_cola',
      selectionSnapshot: snap as unknown as Prisma.InputJsonValue,
      retries: snap.retries,
      catalogRevisionId: plan.catalogRevisionId,
      manifestHash: snap.manifestHash,
      gitCommit: snap.gitCommit,
      scheduledFor: meta.scheduledFor ?? null,
      queuedAt: now,
      createdById: refs.createdById,
      createdByCredentialId: refs.createdByCredentialId,
      idempotencyKey: meta.idempotencyKey ?? null,
      syncStatus: 'no_aplica',
      createdAt: now,
    },
  });

  // Resultados por test/variante (ejecutables en `pendiente`; bloqueados con causa estable).
  const results = snap.tests.map((t) => {
    const id = randomUUID();
    const blocked = t.executable ? null : resultStatusForBlocked(t);
    return {
      id,
      test: t,
      row: {
        id,
        runId,
        automatedTestId: t.automatedTestId,
        parameterKey: t.parameterKey,
        status: blocked ? blocked.status : ('pendiente' as const),
        reason: blocked ? blocked.reason : null,
        reasonText: blocked ? reasonText(blocked.reason) : null,
        createdAt: now,
      },
    };
  });

  // Shards disjuntos: capacidad 1 por defecto (RNF-OPT-05); N si el ambiente y la capacidad global lo permiten.
  const executable = results.filter((r) => r.test.executable).map((r) => ({ runResultId: r.id, test: r.test }));
  const globalMax = Math.min(deps.globalBrowserCeiling, plan.settings.capacity.globalBrowserConcurrency);
  const shardCount = snap.kind === 'rendimiento' ? 1 : Math.min(plan.environment.maxConcurrency, globalMax);
  const partitions = partitionShards(executable, shardCount);
  const shardOf = new Map<string, string>();
  const shards = partitions.map((ids, i) => {
    const id = randomUUID();
    for (const rid of ids) shardOf.set(rid, id);
    return {
      id,
      runId,
      shardKey: `s${i}`,
      status: 'pendiente' as const,
      assignedTestKeys: ids.map((rid) => {
        const t = executable.find((e) => e.runResultId === rid)!.test;
        return { runResultId: rid, stableKey: t.stableKey, parameterKey: t.parameterKey };
      }),
      createdAt: now,
    };
  });
  if (shards.length) await tx.runShard.createMany({ data: shards });
  if (results.length) {
    await tx.runResult.createMany({
      data: results.map((r) => ({ ...r.row, runShardId: shardOf.get(r.id) ?? null })),
    });
  }

  // Destinos TestRail (un destino por suite; IDs externos solo aquí) y casos agregables.
  const targetBySuite = new Map<string, string>();
  const existing = snap.testrail.mode === 'existente' ? snap.testrail : null;
  for (const t of plan.targets) {
    const id = randomUUID();
    targetBySuite.set(t.testrailSuiteId, id);
    await tx.runTestRailTarget.create({
      data: {
        id,
        runId,
        testrailSuiteId: t.testrailSuiteId,
        trRunId: existing ? existing.trRunId : null,
        existingRun: existing !== null,
        closeExistingRun: existing ? existing.closeExistingRun : false,
        syncStatus: 'pendiente',
      },
    });
  }
  if (snap.cases.length) {
    await tx.caseResult.createMany({
      data: snap.cases.map((c) => ({
        runId,
        caseId: c.caseId,
        caseRevision: c.revision,
        runTestRailTargetId: targetBySuite.get(c.testrailSuiteId) ?? null,
        status: 'pendiente' as const,
        coverage: 'ninguna' as const,
      })),
    });
  }

  await publishEvent(tx, {
    type: 'run.created',
    entity: 'run',
    entityId: runId,
    version: 0,
    runId,
    environmentId: plan.environment.id,
    data: { status: 'en_cola', trigger: meta.trigger, scheduleId: meta.scheduleId ?? null },
  });
  await recordAudit(tx, {
    actor: meta.actor,
    action: meta.trigger === 'programada' ? 'run.schedule' : 'run.create',
    entity: 'run',
    entityId: runId,
    diff: {
      trigger: meta.trigger,
      environmentId: plan.environment.id,
      selection: snap.selection,
      retries: snap.retries,
      gitCommit: snap.gitCommit,
      tests: snap.tests.length,
      executableTests: executable.length,
      cases: snap.cases.length,
    },
    ...(meta.requestId ? { requestId: meta.requestId } : {}),
  });

  // Selección solo bloqueada: termina sin navegador con outcome bloqueado.
  if (executable.length === 0) {
    await finalizeRun(tx, { runId, terminal: 'terminada', reason: null, now, publicBaseUrl: deps.publicBaseUrl });
  }
  return runId;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002';
}

export interface CreateRunResult {
  created: boolean;
  runId: string;
  run: RunSummaryDto;
}

/** `POST /runs` idempotente por actor. */
export async function createRunIdempotent(
  deps: RunDeps,
  input: { body: RunCreateRequest; idempotencyKey: string; actor: Principal; requestId?: string },
  now: Date = new Date(),
): Promise<CreateRunResult> {
  const actorKey = actorKeyOf(input.actor);
  const { previewToken, ...hashable } = input.body;
  const requestHash = sha256Hex(canonicalJson({ ...hashable, previewToken: previewToken ?? null }));

  const lookup = async (): Promise<CreateRunResult | null> => {
    const existing = await deps.prisma.idempotencyKey.findUnique({
      where: { actorKey_key: { actorKey, key: input.idempotencyKey } },
    });
    if (!existing) return null;
    if (existing.expiresAt.getTime() <= now.getTime()) {
      await deps.prisma.idempotencyKey.deleteMany({ where: { id: existing.id, expiresAt: { lte: now } } });
      return null;
    }
    if (existing.requestHash !== requestHash) throw new KatalystError('IDEMPOTENCY_CONFLICT');
    if (existing.state !== 'completada' || !existing.runId) throw new KatalystError('IDEMPOTENCY_IN_PROGRESS');
    return { created: false, runId: existing.runId, run: await getRunSummary(deps.prisma, existing.runId) };
  };

  const prior = await lookup();
  if (prior) return prior;

  const selection = normalizeSelection(input.body);
  const plan = await resolvePlan(deps.prisma, {
    selection,
    environmentId: input.body.environmentId,
    retries: input.body.retries,
    excludeFlaky: input.body.excludeFlaky,
    testrail: input.body.testrail,
    trigger: 'manual',
  });
  if (previewToken && previewToken !== plan.previewToken) throw new KatalystError('ADMISSION_CONFIG_CHANGED');

  let runId: string;
  try {
    runId = await runInTransaction(
      deps.prisma,
      async (tx) => {
        const key = await tx.idempotencyKey.create({
          data: {
            actorKey,
            key: input.idempotencyKey,
            method: 'POST',
            path: '/api/v1/runs',
            requestHash,
            state: 'en_proceso',
            userId: input.actor.kind === 'panel_user' ? input.actor.id : null,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_HOURS * 3_600_000),
          },
        });
        const id = await createRunFromPlan(
          tx,
          deps,
          plan,
          {
            trigger: input.actor.kind === 'api_token' ? 'api' : 'manual',
            actor: input.actor,
            idempotencyKey: input.idempotencyKey,
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          now,
        );
        await tx.idempotencyKey.update({
          where: { id: key.id },
          data: { state: 'completada', runId: id, responseStatus: 201 },
        });
        return id;
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await lookup();
      if (again) return again;
    }
    throw err;
  }
  return { created: true, runId, run: await getRunSummary(deps.prisma, runId) };
}

// ---------------------------------------------------------------------------------------------------------------
// Admisión por capacidad y despacho
// ---------------------------------------------------------------------------------------------------------------

export interface AdmissionResult {
  admitted: { runId: string; shardId: string }[];
  saturated: CapacityScope[];
}

const RESERVATION_CLAIM_WINDOW_MS = 5 * 60_000;

export interface ShardAdmission {
  runId: string;
  shardId: string;
  environmentId: string;
  testUserId: string | null;
  trigger: RunTrigger;
  scheduledFor: Date | null;
}

export interface CapacityLimits {
  globalMax: number;
  environmentMax: (environmentId: string) => Promise<number>;
  testUserMax: (testUserId: string) => Promise<number>;
}

/** Límites efectivos: techo del despliegue ∩ parámetros administrativos; ambiente y usuario de prueba desde BD. */
export async function capacityLimits(db: Db, globalBrowserCeiling: number): Promise<CapacityLimits> {
  const settings = await loadRuntimeSettings(db);
  const envCache = new Map<string, number>();
  const userCache = new Map<string, number>();
  return {
    globalMax: Math.min(globalBrowserCeiling, settings.capacity.globalBrowserConcurrency),
    environmentMax: async (id) => {
      if (!envCache.has(id)) {
        const env = await db.environment.findUnique({ where: { id }, select: { maxConcurrency: true } });
        envCache.set(id, env?.maxConcurrency ?? 1);
      }
      return envCache.get(id)!;
    },
    testUserMax: async (id) => {
      if (!userCache.has(id)) {
        const u = await db.testUser.findUnique({ where: { id }, select: { allowsConcurrency: true } });
        userCache.set(id, u?.allowsConcurrency ? settings.capacity.perUserConcurrency : 1);
      }
      return userCache.get(id)!;
    },
  };
}

/**
 * Admite UN shard dentro de la transacción del llamador: reserva atómica de capacidad + shard `asignado` + outbox
 * `run.dispatch_shard`. Sin capacidad devuelve el alcance saturado y deja la transacción íntegra (las reservas
 * parciales del shard se eliminan).
 */
export async function admitShardInTx(
  tx: Db,
  s: ShardAdmission,
  limits: CapacityLimits,
  now: Date,
): Promise<{ ok: true } | { ok: false; scope: CapacityScope | null }> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM run_shard WHERE id = ${s.shardId}::uuid AND status = 'pendiente'
    FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) return { ok: false, scope: null };
  try {
    await reserveShardCapacity(tx, {
      runId: s.runId,
      shardId: s.shardId,
      environmentId: s.environmentId,
      environmentMax: await limits.environmentMax(s.environmentId),
      globalMax: limits.globalMax,
      testUserId: s.testUserId,
      testUserMax: s.testUserId ? await limits.testUserMax(s.testUserId) : 1,
      expiresAt: new Date(now.getTime() + RESERVATION_CLAIM_WINDOW_MS),
      now,
    });
  } catch (err) {
    if (err instanceof CapacityUnavailable) {
      await tx.capacityReservation.deleteMany({ where: { runShardId: s.shardId, releasedAt: null, acquiredAt: now } });
      return { ok: false, scope: err.scope };
    }
    throw err;
  }
  const shard = await tx.runShard.update({ where: { id: s.shardId }, data: { status: 'asignado', updatedAt: now } });
  const payload: ShardJobPayload = { runId: s.runId, shardId: s.shardId };
  await enqueueOutbox(tx, {
    operation: 'run.dispatch_shard',
    dedupKey: `run.dispatch_shard:${s.shardId}:${randomUUID()}`,
    payload,
    runId: s.runId,
  });
  if (s.trigger === 'programada') {
    await tx.scheduleOccurrence.updateMany({ where: { runId: s.runId, admittedAt: null }, data: { admittedAt: now } });
  }
  await publishEvent(tx, {
    type: 'shard.updated',
    entity: 'run_shard',
    entityId: s.shardId,
    version: shard.currentGeneration,
    runId: s.runId,
    environmentId: s.environmentId,
    data: { status: 'asignado', shardKey: shard.shardKey },
  });
  const from = s.scheduledFor ?? now;
  admissionDelaySeconds.observe({ trigger: s.trigger }, Math.max(0, (now.getTime() - from.getTime()) / 1000));
  return { ok: true };
}

/** Admite shards pendientes en orden FIFO mientras haya capacidad. Seguro con varios procesos (SKIP LOCKED). */
export async function admitPendingShards(
  deps: RunDeps,
  now: Date = new Date(),
  opts: { runId?: string; limit?: number } = {},
): Promise<AdmissionResult> {
  const candidates = await deps.prisma.runShard.findMany({
    where: {
      status: 'pendiente',
      run: {
        status: { in: ['en_cola', 'preparando', 'corriendo'] },
        cancelRequestedAt: null,
        ...(opts.runId ? { id: opts.runId } : {}),
      },
    },
    select: {
      id: true,
      runId: true,
      run: { select: { environmentId: true, selectionSnapshot: true, queuedAt: true, scheduledFor: true, trigger: true } },
    },
    orderBy: [{ run: { queuedAt: 'asc' } }, { shardKey: 'asc' }],
    take: opts.limit ?? 50,
  });
  const out: AdmissionResult = { admitted: [], saturated: [] };
  if (candidates.length === 0) return out;
  const limits = await capacityLimits(deps.prisma, deps.globalBrowserCeiling);
  const fullEnvs = new Set<string>();
  const fullUsers = new Set<string>();
  for (const c of candidates) {
    if (out.saturated.includes('global')) break;
    const snap = c.run.selectionSnapshot as { testUser?: { testUserId: string } | null };
    const envId = c.run.environmentId;
    const testUserId = snap.testUser?.testUserId ?? null;
    if (fullEnvs.has(envId) || (testUserId && fullUsers.has(testUserId))) continue;
    const r = await runInTransaction(deps.prisma, (tx) =>
      admitShardInTx(
        tx,
        {
          runId: c.runId,
          shardId: c.id,
          environmentId: envId,
          testUserId,
          trigger: c.run.trigger,
          scheduledFor: c.run.scheduledFor ?? c.run.queuedAt,
        },
        limits,
        now,
      ),
    );
    if (r.ok) {
      out.admitted.push({ runId: c.runId, shardId: c.id });
    } else if (r.scope) {
      if (!out.saturated.includes(r.scope)) out.saturated.push(r.scope);
      if (r.scope === 'environment') fullEnvs.add(envId);
      if (r.scope === 'test_user' && testUserId) fullUsers.add(testUserId);
    }
  }
  return out;
}

/**
 * Corridas programadas aún en cola (sin ningún shard con capacidad) vencida la gracia ⇒ `omitida/sin_capacidad`;
 * nunca se ejecutan tarde (ESP §13.5). La ocurrencia queda `omitida` con la misma causa.
 */
export async function expireQueuedScheduledRuns(
  deps: RunDeps,
  now: Date = new Date(),
  graceMs?: number,
): Promise<string[]> {
  const settings = await loadRuntimeSettings(deps.prisma);
  const grace = graceMs ?? settings.capacity.queueAdmissionGraceSeconds * 1000;
  const runs = await deps.prisma.run.findMany({
    where: {
      status: 'en_cola',
      trigger: 'programada',
      scheduledFor: { lt: new Date(now.getTime() - grace) },
      cancelRequestedAt: null,
      shards: { every: { status: 'pendiente', currentGeneration: 0 } },
    },
    select: { id: true },
    take: 100,
  });
  const omitted: string[] = [];
  for (const r of runs) {
    const done = await runInTransaction(deps.prisma, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM run WHERE id = ${r.id}::uuid AND status = 'en_cola' FOR NO KEY UPDATE SKIP LOCKED`;
      if (locked.length === 0) return false;
      const assigned = await tx.runShard.count({ where: { runId: r.id, status: { not: 'pendiente' } } });
      if (assigned > 0) return false;
      await tx.runResult.updateMany({
        where: { runId: r.id, status: 'pendiente' },
        data: { status: 'omitido', reason: 'sin_capacidad', reasonText: reasonText('sin_capacidad') },
      });
      await tx.runShard.updateMany({ where: { runId: r.id }, data: { status: 'cancelado', updatedAt: now } });
      await finalizeRun(tx, {
        runId: r.id,
        terminal: 'omitida',
        reason: 'sin_capacidad',
        now,
        publicBaseUrl: deps.publicBaseUrl,
      });
      return true;
    });
    if (done) omitted.push(r.id);
  }
  return omitted;
}
