/**
 * Leases por shard con fencing (ESP §13.3; RF-EJE-08, RNF-CON-01, RF-AMB-03).
 * - `claimShard`: lease atómico por shard con generación creciente y `leaseToken` expirable de alcance shard (solo
 *   su SHA-256 en BD). Devuelve `WorkerClaimResponse` con `testUserRef` (referencia, nunca el secreto).
 * - `validateLease`: todo callback exige lease vigente y generación actual; si no ⇒ 409 LEASE_STALE/LEASE_EXPIRED.
 * - `heartbeat`: cada 15 s; extiende el lease 75 s y devuelve `cancelRequested`.
 * - `expireLeases` (watchdog ≤ 15 s): lease vencido ⇒ revocado; conserva resultados confirmados; recupera una sola vez
 *   por corrida (lectura en curso se repite como `recuperacion`, escritura en curso ⇒ resultado desconocido);
 *   agotada la recuperación ⇒ shard/corrida `interrumpida`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import {
  CHROMIUM_NO_THROTTLE_FLAGS,
  HEARTBEAT_INTERVAL_MS,
  KatalystError,
  LEASE_TTL_MS,
  CANCEL_DEADLINE_MS,
  canRecover,
  canRetry,
  lostAttemptOutcome,
  reasonText,
  type AssignedTest,
  type LeaseFencingSchema,
  type ResultReason,
  type WorkerClaimRequest,
  type WorkerClaimResponse,
} from '@katalyst/shared';
import type { z } from 'zod';
import { generateOpaqueToken, hashToken } from '../lib/crypto-tokens.js';
import type { Principal } from '../lib/auth.js';
import { publishEvent, runInTransaction } from '../lib/events-publish.js';
import { extendShardCapacity, releaseShardCapacity } from './capacity.js';
import { RUNTIME_DEFAULTS } from './run-planner.js';
import { bumpRun, isTerminalRun, settleRunIfDone, snapshotOf } from './results.js';
import { startDelaySeconds } from './run-admission.js';

type Db = Prisma.TransactionClient;
type Fencing = z.infer<typeof LeaseFencingSchema>;

export interface LeaseDeps {
  prisma: PrismaClient;
  logger: Logger;
  publicBaseUrl: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Orden de bloqueo global (evita interbloqueos con cancelación/admisión): primero la corrida (`FOR NO KEY UPDATE`,
 * compatible con las FK que insertan hijos), luego el shard.
 */
export async function lockRunAndShardOfLease(tx: Db, leaseId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT r.id FROM run r JOIN run_shard s ON s.run_id = r.id JOIN worker_lease l ON l.run_shard_id = s.id
    WHERE l.id = ${leaseId}::uuid FOR NO KEY UPDATE OF r`;
  await tx.$queryRaw`
    SELECT s.id FROM run_shard s JOIN worker_lease l ON l.run_shard_id = s.id
    WHERE l.id = ${leaseId}::uuid FOR UPDATE OF s`;
}

/** Bloquea el shard del lease (serializa callbacks, watchdog y cancelación) y valida fencing. */
export async function validateLease(
  tx: Db,
  f: Fencing,
  principal: Principal,
  now: Date,
  opts: { allowReleased?: boolean; allowTerminalRun?: boolean } = {},
) {
  if (principal.kind !== 'lease') throw new KatalystError('FORBIDDEN');
  if (principal.leaseId !== f.leaseId || principal.generation !== f.generation) {
    throw new KatalystError('LEASE_STALE');
  }
  await lockRunAndShardOfLease(tx, f.leaseId);
  const lease = await tx.workerLease.findUnique({ where: { id: f.leaseId }, include: { runShard: true } });
  if (!lease) throw new KatalystError('LEASE_NOT_FOUND');
  if (lease.generation !== f.generation || lease.revokedAt || lease.runShard.currentGeneration !== lease.generation) {
    throw new KatalystError('LEASE_STALE');
  }
  if (lease.releasedAt && !opts.allowReleased) throw new KatalystError('LEASE_STALE');
  if (!lease.releasedAt && lease.expiresAt.getTime() <= now.getTime()) throw new KatalystError('LEASE_EXPIRED');
  const run = await tx.run.findUniqueOrThrow({ where: { id: lease.runShard.runId } });
  if (isTerminalRun(run.status) && !opts.allowTerminalRun) throw new KatalystError('RUN_FINALIZED');
  return { lease, shard: lease.runShard, run };
}

function nextAttemptOf(
  attempts: { attemptNo: number; kind: 'inicial' | 'retry' | 'recuperacion'; status: string; errorCategory: string | null }[],
  policy: { retries: number; classification: 'lectura' | 'escritura' | 'sin_clasificar'; writeIdempotencyApproved: boolean },
  infraRecoveryCount: number,
): { no: number; kind: AssignedTest['nextAttemptKind'] } {
  const last = attempts.at(-1);
  if (!last) return { no: 1, kind: 'inicial' };
  if (last.status === 'error_infraestructura' && last.errorCategory === 'worker_perdido' && infraRecoveryCount < 1) {
    return { no: last.attemptNo + 1, kind: 'recuperacion' };
  }
  if (canRetry(attempts as Parameters<typeof canRetry>[0], policy)) return { no: last.attemptNo + 1, kind: 'retry' };
  return { no: last.attemptNo + 1, kind: 'inicial' };
}

/** `POST /worker/claim` (supervisor). */
export async function claimShard(
  deps: LeaseDeps,
  req: WorkerClaimRequest,
  now: Date = new Date(),
): Promise<WorkerClaimResponse> {
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;
  const token = generateOpaqueToken('lease');
  return runInTransaction(deps.prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM run WHERE id = ${req.runId}::uuid FOR NO KEY UPDATE`;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM run_shard WHERE id = ${req.shardId}::uuid AND run_id = ${req.runId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new KatalystError('NOT_FOUND');
    const shard = await tx.runShard.findUniqueOrThrow({ where: { id: req.shardId } });
    const run = await tx.run.findUniqueOrThrow({ where: { id: req.runId } });
    if (isTerminalRun(run.status) || run.cancelRequestedAt || shard.status !== 'asignado') {
      throw new KatalystError('SHARD_NOT_CLAIMABLE');
    }
    const active = await tx.workerLease.findFirst({
      where: { runShardId: shard.id, revokedAt: null, releasedAt: null },
    });
    if (active) throw new KatalystError('SHARD_NOT_CLAIMABLE');
    const snap = snapshotOf(run);
    const results = await tx.runResult.findMany({
      where: { runShardId: shard.id, status: { in: ['pendiente', 'corriendo'] } },
      include: {
        automatedTest: { select: { stableKey: true } },
        attempts: {
          orderBy: { attemptNo: 'asc' },
          select: { attemptNo: true, kind: true, status: true, errorCategory: true, durationMs: true },
        },
      },
    });
    if (results.length === 0) throw new KatalystError('SHARD_NOT_CLAIMABLE');

    // Revalidación de producción en backend: usuario reservado de solo lectura (ESP §13.7).
    const testUser = snap.testUser
      ? await tx.testUser.findUnique({
          where: { id: snap.testUser.testUserId },
          select: { id: true, username: true, secretRef: true, readOnly: true, enabled: true, disabledAt: true },
        })
      : null;
    if (snap.environment.isProduction && (!testUser || !testUser.readOnly || !testUser.enabled || testUser.disabledAt)) {
      throw new KatalystError('PRODUCTION_BLOCKED', 'El usuario de prueba de producción ya no es de solo lectura.');
    }

    const generation = shard.currentGeneration + 1;
    const lease = await tx.workerLease.create({
      data: {
        runShardId: shard.id,
        workerId: req.workerId,
        generation,
        tokenHash: hashToken(token),
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + ttl),
        createdAt: now,
      },
    });
    await tx.runShard.update({
      where: { id: shard.id },
      data: { status: 'corriendo', currentGeneration: generation, updatedAt: now },
    });
    await tx.runResult.updateMany({ where: { id: { in: results.map((r) => r.id) } }, data: { ownerLeaseId: lease.id } });
    await extendShardCapacity(tx, shard.id, new Date(now.getTime() + ttl + 60_000));
    if (run.status === 'en_cola') {
      await bumpRun(tx, run.id, { status: 'preparando', startedAt: run.startedAt ?? now });
      const reservation = await tx.capacityReservation.findFirst({
        where: { runShardId: shard.id, scope: 'global', releasedAt: null },
        select: { acquiredAt: true },
      });
      if (reservation) {
        startDelaySeconds.observe(
          { trigger: run.trigger },
          Math.max(0, (now.getTime() - reservation.acquiredAt.getTime()) / 1000),
        );
      }
    }
    await publishEvent(tx, {
      type: 'shard.updated',
      entity: 'run_shard',
      entityId: shard.id,
      version: generation,
      runId: run.id,
      environmentId: run.environmentId,
      data: { status: 'corriendo', shardKey: shard.shardKey, generation, workerId: req.workerId },
    });

    const startedAt = run.startedAt ?? now;
    const tests: AssignedTest[] = results.map((r) => {
      const pt = snap.tests.find((t) => t.automatedTestId === r.automatedTestId && t.parameterKey === r.parameterKey)!;
      const policy = {
        retries: pt.retries,
        classification: pt.classification,
        writeIdempotencyApproved: pt.writeIdempotencyApproved,
      };
      const next = nextAttemptOf(r.attempts, policy, r.infraRecoveryCount);
      return {
        runResultId: r.id,
        stableKey: r.automatedTest.stableKey,
        file: pt.filePath,
        title: pt.title,
        parameterKey: r.parameterKey,
        classification: pt.classification,
        retries: pt.retries,
        writeIdempotencyApproved: pt.writeIdempotencyApproved,
        nextAttemptNo: next.no,
        nextAttemptKind: next.kind,
      };
    });
    return {
      leaseId: lease.id,
      generation,
      leaseToken: token,
      leaseExpiresAt: lease.expiresAt.toISOString(),
      heartbeatIntervalMs: deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      assignment: {
        runId: run.id,
        shardId: shard.id,
        shardKey: shard.shardKey,
        kind: snap.kind,
        gitCommit: snap.gitCommit,
        manifestHash: snap.manifestHash,
        tests,
        environment: {
          appUrl: snap.environment.appUrl,
          apiUrl: snap.environment.apiUrl,
          isProduction: snap.environment.isProduction,
        },
        testUserRef: testUser
          ? { testUserId: testUser.id, username: testUser.username, secretRef: testUser.secretRef, readOnly: testUser.readOnly }
          : null,
        timeouts: {
          testMs: snap.timeouts.testMs,
          setupMs: snap.timeouts.setupMs,
          runMs: snap.timeouts.runMs,
          runDeadlineAt: new Date(startedAt.getTime() + snap.timeouts.runMs).toISOString(),
        },
        artifactPolicy: snap.artifactPolicy,
        runtime: {
          playwrightVersion: RUNTIME_DEFAULTS.playwrightVersion,
          image: RUNTIME_DEFAULTS.image,
          imageDigest: RUNTIME_DEFAULTS.imageDigest,
          browserConcurrency: 1,
          chromiumFlags: [...CHROMIUM_NO_THROTTLE_FLAGS],
        },
      },
    };
  });
}

/** `POST /worker/heartbeat`. */
export async function heartbeat(
  deps: Pick<LeaseDeps, 'prisma' | 'leaseTtlMs'>,
  principal: Principal,
  req: Fencing,
  now: Date = new Date(),
): Promise<{ ok: true; leaseExpiresAt: string; cancelRequested: boolean; cancelDeadlineAt: string | null }> {
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;
  return deps.prisma.$transaction(async (tx) => {
    const { lease, run } = await validateLease(tx, req, principal, now);
    const expiresAt = new Date(now.getTime() + ttl);
    await tx.workerLease.update({ where: { id: lease.id }, data: { heartbeatAt: now, expiresAt } });
    await extendShardCapacity(tx, lease.runShardId, new Date(expiresAt.getTime() + 60_000));
    return {
      ok: true as const,
      leaseExpiresAt: expiresAt.toISOString(),
      cancelRequested: run.cancelRequestedAt !== null,
      cancelDeadlineAt: run.cancelRequestedAt
        ? new Date(run.cancelRequestedAt.getTime() + CANCEL_DEADLINE_MS).toISOString()
        : null,
    };
  });
}

export interface LostLease {
  leaseId: string;
  shardId: string;
  runId: string;
  recovered: boolean;
}

/**
 * Watchdog: revoca leases vencidos (expiración 75 s + tick ≤ 15 s ⇒ detección ≤ 90 s, RNF-CON-01) y aplica la
 * política de recuperación de ESP §13.3.
 */
export async function expireLeases(deps: LeaseDeps, now: Date = new Date()): Promise<LostLease[]> {
  const expired = await deps.prisma.workerLease.findMany({
    where: { revokedAt: null, releasedAt: null, expiresAt: { lt: now } },
    select: { id: true },
    take: 100,
  });
  const out: LostLease[] = [];
  for (const { id } of expired) {
    const lost = await runInTransaction(deps.prisma, async (tx) => {
      await lockRunAndShardOfLease(tx, id);
      const lease = await tx.workerLease.findUniqueOrThrow({ where: { id }, include: { runShard: true } });
      if (lease.revokedAt || lease.releasedAt || lease.expiresAt.getTime() >= now.getTime()) return null;
      await tx.workerLease.update({ where: { id }, data: { revokedAt: now } });
      const shard = lease.runShard;
      const run = await tx.run.findUniqueOrThrow({ where: { id: shard.runId } });
      if (isTerminalRun(run.status)) return { leaseId: id, shardId: shard.id, runId: run.id, recovered: false };
      const snap = snapshotOf(run);
      const shardsOfRun = await tx.runShard.findMany({ where: { runId: run.id }, select: { recoveryCount: true } });
      const recoveryUsed = shardsOfRun.reduce((a, s) => a + s.recoveryCount, 0) >= 1;
      const canRecoverRun = !recoveryUsed && run.cancelRequestedAt === null;
      const open = await tx.runResult.findMany({
        where: { runShardId: shard.id, status: { in: ['pendiente', 'corriendo'] } },
        include: {
          attempts: {
            orderBy: { attemptNo: 'asc' },
            select: { id: true, attemptNo: true, kind: true, status: true, errorCategory: true, durationMs: true },
          },
        },
      });
      let remaining = 0;
      for (const r of open) {
        const pt = snap.tests.find((t) => t.automatedTestId === r.automatedTestId && t.parameterKey === r.parameterKey);
        const classification = pt?.classification ?? 'sin_clasificar';
        const running = r.attempts.find((a) => a.status === 'corriendo');
        let finalStatus: 'error_infraestructura' | 'cancelado' | null = null;
        let reason: ResultReason | null = null;
        if (running) {
          const lostOutcome = lostAttemptOutcome({ classification });
          await tx.testAttempt.update({
            where: { id: running.id },
            data: { status: lostOutcome.status, errorCategory: lostOutcome.errorCategory, finishedAt: now },
          });
          const attemptsAfter = r.attempts.map((a) =>
            a.id === running.id ? { ...a, status: lostOutcome.status, errorCategory: lostOutcome.errorCategory } : a,
          );
          if (classification !== 'lectura') {
            finalStatus = 'error_infraestructura';
            reason = 'escritura_resultado_desconocido';
          } else if (!(canRecoverRun && canRecover(attemptsAfter, { classification }))) {
            finalStatus = run.cancelRequestedAt ? 'cancelado' : 'error_infraestructura';
            reason = run.cancelRequestedAt ? (run.reason ?? 'cancelado_por_usuario') : 'recuperacion_agotada';
          }
        } else if (!canRecoverRun) {
          finalStatus = run.cancelRequestedAt ? 'cancelado' : 'error_infraestructura';
          reason = run.cancelRequestedAt ? (run.reason ?? 'cancelado_por_usuario') : 'recuperacion_agotada';
        }
        const durations = r.attempts.map((a) => a.durationMs).filter((d): d is number => typeof d === 'number');
        const updated = await tx.runResult.update({
          where: { id: r.id },
          data: finalStatus
            ? {
                status: finalStatus,
                reason,
                reasonText: reason ? reasonText(reason) : null,
                ownerLeaseId: null,
                durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
                version: { increment: 1 },
              }
            : { status: 'pendiente', ownerLeaseId: null, version: { increment: 1 } },
        });
        if (!finalStatus) remaining++;
        await publishEvent(tx, {
          type: 'run_result.updated',
          entity: 'run_result',
          entityId: updated.id,
          version: updated.version,
          runId: run.id,
          environmentId: run.environmentId,
          data: { status: updated.status, reason: updated.reason },
        });
      }
      await releaseShardCapacity(tx, shard.id, now);
      const recovered = remaining > 0 && canRecoverRun;
      const status = recovered
        ? ('pendiente' as const)
        : remaining > 0 || open.length > 0
          ? run.cancelRequestedAt
            ? ('cancelado' as const)
            : ('interrumpido' as const)
          : ('completado' as const);
      const s = await tx.runShard.update({
        where: { id: shard.id },
        data: { status, updatedAt: now, ...(recovered ? { recoveryCount: { increment: 1 } } : {}) },
      });
      // La caída recuperable se registra como evento; no finaliza prematuramente la corrida (ESP §13.2).
      await publishEvent(tx, {
        type: 'shard.updated',
        entity: 'run_shard',
        entityId: shard.id,
        version: s.currentGeneration,
        runId: run.id,
        environmentId: run.environmentId,
        data: { status, shardKey: shard.shardKey, event: 'worker_perdido', recovered, leaseId: id },
      });
      if (!recovered) {
        if (status === 'interrumpido' && !run.reason) await bumpRun(tx, run.id, { reason: 'recuperacion_agotada' });
        await settleRunIfDone(tx, run.id, now, deps.publicBaseUrl);
      }
      return { leaseId: id, shardId: shard.id, runId: run.id, recovered };
    });
    if (lost) {
      out.push(lost);
      deps.logger.warn({ runId: lost.runId, shardId: lost.shardId, recovered: lost.recovered }, 'lease vencido');
    }
  }
  return out;
}

/** Leases vencidos/revocados en una ventana (métrica `katalyst_worker_leases_expired_recent`). */
export async function recentlyExpiredLeases(db: Db, now: Date, windowMs = 15 * 60_000): Promise<number> {
  return db.workerLease.count({ where: { revokedAt: { gte: new Date(now.getTime() - windowMs) } } });
}
