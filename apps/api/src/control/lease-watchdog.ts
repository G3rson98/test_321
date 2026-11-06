/**
 * Watchdog de leases (cada ≤ 15 s; expiración 75 s ⇒ detección ≤ 90 s, RNF-CON-01) y plazos de corrida:
 * leases vencidos (recuperación única), cancelaciones no confirmadas a los 30 s, timeouts de corrida y reservas de
 * capacidad huérfanas. Publica señales de control al supervisor por Redis pub/sub.
 * RF-EJE-03, RF-EJE-08, RNF-CON-01.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { expireLeases, recentlyExpiredLeases } from '../services/leases.js';
import { enforceCancelDeadlines, enforceRunTimeouts, type ControlPublisher } from '../services/cancellation.js';
import { releaseOrphanReservations } from '../services/capacity.js';
import { metrics, registerMetricsCollector } from '../lib/metrics.js';

export interface WatchdogDeps {
  prisma: PrismaClient;
  logger: Logger;
  publicBaseUrl: string;
  publishControl: ControlPublisher;
  leaseTtlMs?: number;
}

export async function watchdogTick(deps: WatchdogDeps, now: Date = new Date()) {
  const lost = await expireLeases(deps, now);
  for (const l of lost) {
    await deps.publishControl({
      type: 'revoke',
      runId: l.runId,
      shardIds: [l.shardId],
      leaseIds: [l.leaseId],
      reason: 'lease_vencido',
      requestedAt: now.toISOString(),
      deadlineAt: now.toISOString(),
    });
  }
  const cancelled = await enforceCancelDeadlines(deps, now);
  const timedOut = await enforceRunTimeouts(deps, now);
  const released = await releaseOrphanReservations(deps.prisma, now);
  if (lost.length || cancelled.length || timedOut.length || released) {
    deps.logger.warn({ lost, cancelled, timedOut, released }, 'watchdog');
  }
  return { lost, cancelled, timedOut, released };
}

/** Métricas de cola/leases/almacenamiento calculadas al hacer scrape (RNF-OBS-01/02). */
export function registerRunMetrics(prisma: PrismaClient): void {
  registerMetricsCollector('runs', async () => {
    const now = new Date();
    const [pending, oldest, expired, stored] = await Promise.all([
      prisma.run.count({ where: { status: { in: ['en_cola', 'preparando'] } } }),
      prisma.run.findFirst({ where: { status: 'en_cola' }, orderBy: { queuedAt: 'asc' }, select: { queuedAt: true } }),
      recentlyExpiredLeases(prisma, now),
      prisma.artifact.aggregate({
        where: { uploadedAt: { not: null }, storageKey: { not: null } },
        _sum: { sizeBytes: true },
      }),
    ]);
    metrics.queuePending.set(pending);
    metrics.queueOldestWaiting.set(oldest ? Math.max(0, (now.getTime() - oldest.queuedAt.getTime()) / 1000) : 0);
    metrics.workerLeasesExpiredRecent.set(expired);
    metrics.artifactsStoredBytes.set(Number(stored._sum.sizeBytes ?? 0n));
  });
}
