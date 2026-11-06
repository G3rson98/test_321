/**
 * Métricas de TestRail/catálogo para `/metrics` (RNF-OBS-02: última sincronización exitosa, outbox pendiente/vencida,
 * almacenamiento). Se calculan desde BD en cada scrape (consultas indexadas y acotadas).
 */
import type { PrismaClient } from '@prisma/client';
import { metrics, registerMetricsCollector } from '../../lib/metrics.js';
import { registerOutboxMetrics } from '../../control/outbox-publisher.js';

export function registerTestRailMetrics(prisma: PrismaClient): void {
  registerMetricsCollector('testrail', async () => {
    const last = await prisma.testRailSyncRun.findFirst({
      where: { status: 'exitosa' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    metrics.testrailLastSuccessfulSync.set(last?.finishedAt ? last.finishedAt.getTime() / 1000 : 0);
    const rev = await prisma.catalogRevision.findFirst({
      where: { status: 'completa' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    metrics.catalogLastRevision.set(rev?.finishedAt ? rev.finishedAt.getTime() / 1000 : 0);
  });
  registerMetricsCollector('artifacts_storage', async () => {
    const agg = await prisma.artifact.aggregate({
      _sum: { sizeBytes: true },
      where: { storageKey: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    metrics.artifactsStoredBytes.set(Number(agg._sum.sizeBytes ?? 0));
  });
  registerOutboxMetrics(prisma);
}
