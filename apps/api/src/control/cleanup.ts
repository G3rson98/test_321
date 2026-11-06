/**
 * Limpieza diaria idempotente (ESP §7 retenciones, ARQ §6): resultados, auditoría y entregas terminales 365 días;
 * artefactos 30 días (o la retención congelada de la política); claves de idempotencia 24 h; `event_log` 24 h.
 * Nunca toca corridas activas ni sus objetos. Borrado por lotes para no bloquear la BD.
 * RNF-INF-02, RNF-SEG-05, RF-RES-02.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { EVENT_LOG_RETENTION_HOURS, TERMINAL_RUN_STATUSES } from '@katalyst/shared';
import type { ArtifactStore } from '../adapters/artifact-store/index.js';

export interface CleanupDeps {
  prisma: PrismaClient;
  logger: Logger;
  store: ArtifactStore | null;
}

export interface CleanupOptions {
  resultsDays?: number;
  auditDays?: number;
  deliveriesDays?: number;
  batch?: number;
}

export interface CleanupStats {
  idempotencyKeys: number;
  events: number;
  artifactsExpired: number;
  deliveries: number;
  audit: number;
  occurrences: number;
  runs: number;
}

const DAY = 86_400_000;
const TERMINAL = [...TERMINAL_RUN_STATUSES];

export async function runCleanup(deps: CleanupDeps, now: Date = new Date(), o: CleanupOptions = {}): Promise<CleanupStats> {
  const batch = o.batch ?? 500;
  const { prisma } = deps;
  const stats: CleanupStats = {
    idempotencyKeys: 0,
    events: 0,
    artifactsExpired: 0,
    deliveries: 0,
    audit: 0,
    occurrences: 0,
    runs: 0,
  };

  stats.idempotencyKeys = (await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  stats.events = await prisma.$executeRaw`
    DELETE FROM event_log WHERE seq IN (
      SELECT seq FROM event_log WHERE created_at < ${new Date(now.getTime() - EVENT_LOG_RETENTION_HOURS * 3_600_000)}
      ORDER BY seq LIMIT 50000)`;

  // Artefactos vencidos de corridas terminales: borrar el objeto y conservar la fila con motivo (historial).
  for (;;) {
    const expired = await prisma.artifact.findMany({
      where: { expiresAt: { lt: now }, storageKey: { not: null }, run: { status: { in: TERMINAL } } },
      select: { id: true, storageKey: true },
      take: batch,
    });
    if (expired.length === 0) break;
    for (const a of expired) {
      if (deps.store && a.storageKey) {
        try {
          await deps.store.deleteObject(a.storageKey);
        } catch (err) {
          deps.logger.warn({ err, artifactId: a.id }, 'no se pudo borrar el objeto; se reintentará');
          continue;
        }
      }
      await prisma.artifact.update({
        where: { id: a.id },
        data: { storageKey: null, sanitizationReason: 'Evidencia eliminada por retención.' },
      });
      stats.artifactsExpired++;
    }
    if (expired.length < batch) break;
  }

  const deliveriesBefore = new Date(now.getTime() - (o.deliveriesDays ?? 365) * DAY);
  stats.deliveries = (
    await prisma.outboxDelivery.deleteMany({
      where: {
        status: { in: ['entregada', 'vencida', 'cancelada', 'requiere_intervencion'] },
        updatedAt: { lt: deliveriesBefore },
        OR: [{ runId: null }, { run: { status: { in: TERMINAL } } }],
      },
    })
  ).count;
  stats.audit = (
    await prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - (o.auditDays ?? 365) * DAY) } } })
  ).count;

  // Resultados de corridas terminales de más de 365 días (sin muestras de rendimiento: su retención es de API-C).
  const resultsBefore = new Date(now.getTime() - (o.resultsDays ?? 365) * DAY);
  stats.occurrences = (
    await prisma.scheduleOccurrence.deleteMany({
      where: {
        scheduledFor: { lt: resultsBefore },
        OR: [{ runId: null }, { run: { status: { in: TERMINAL }, finishedAt: { lt: resultsBefore } } }],
      },
    })
  ).count;
  for (;;) {
    const runs = await prisma.run.findMany({
      where: {
        status: { in: TERMINAL },
        finishedAt: { lt: resultsBefore },
        perfSamples: { none: {} },
        alerts: { none: {} },
        artifacts: { none: { storageKey: { not: null } } },
        occurrence: null,
      },
      select: { id: true },
      take: Math.min(batch, 100),
    });
    if (runs.length === 0) break;
    const ids = runs.map((r) => r.id);
    await prisma.$transaction(async (tx) => {
      await tx.outboxDelivery.deleteMany({ where: { runId: { in: ids } } });
      await tx.artifact.deleteMany({ where: { runId: { in: ids } } });
      await tx.testAttempt.deleteMany({ where: { runResult: { runId: { in: ids } } } });
      await tx.caseResult.deleteMany({ where: { runId: { in: ids } } });
      await tx.runResult.deleteMany({ where: { runId: { in: ids } } });
      await tx.capacityReservation.deleteMany({ where: { runId: { in: ids } } });
      await tx.workerLease.deleteMany({ where: { runShard: { runId: { in: ids } } } });
      await tx.runShard.deleteMany({ where: { runId: { in: ids } } });
      await tx.runTestRailTarget.deleteMany({ where: { runId: { in: ids } } });
      await tx.run.deleteMany({ where: { id: { in: ids }, status: { in: TERMINAL } } });
    });
    stats.runs += ids.length;
    if (runs.length < Math.min(batch, 100)) break;
  }
  return stats;
}

/** Ejecuta la limpieza una vez por día UTC a la hora configurada (el bucle corre cada hora). */
export function dailyCleanupGate(hourUtc: number) {
  let lastDay: string | null = null;
  return (now: Date): boolean => {
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== hourUtc || lastDay === day) return false;
    lastDay = day;
    return true;
  };
}
