/**
 * Resumen del inicio calculado en servidor (WEB→API-B): éxito de 7 días frente a los 7 anteriores, corridas de hoy,
 * corridas activas y próximas programaciones. Agregados `count`/`groupBy` (sin la cota de página de `GET /runs`).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { ACTIVE_RUN_STATUSES, nextOccurrence, type HomeSummary } from '@katalyst/shared';

type Db = Prisma.TransactionClient | PrismaClient;
const DAY_MS = 86_400_000;
const UPCOMING_LIMIT = 3;

async function successOf(db: Db, from: Date, to: Date): Promise<{ rate: number | null; runs: number }> {
  const groups = await db.run.groupBy({
    by: ['outcome'],
    where: { status: 'terminada', outcome: { not: null }, createdAt: { gte: from, lt: to } },
    _count: { _all: true },
  });
  const total = groups.reduce((a, g) => a + g._count._all, 0);
  const ok = groups.filter((g) => g.outcome === 'pasado' || g.outcome === 'inestable').reduce((a, g) => a + g._count._all, 0);
  return { rate: total === 0 ? null : ok / total, runs: total };
}

export async function upcomingSchedules(db: Db, now: Date, limit = UPCOMING_LIMIT): Promise<HomeSummary['upcoming']> {
  const rows = await db.schedule.findMany({
    where: { enabled: true, deletedAt: null },
    select: { id: true, name: true, environmentId: true, cronExpressions: true, timezone: true, environment: { select: { name: true } } },
  });
  return rows
    .map((s) => ({ s, at: nextOccurrence(s.cronExpressions, s.timezone, now) }))
    .filter((x): x is { s: (typeof rows)[number]; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, limit)
    .map(({ s, at }) => ({ scheduleId: s.id, name: s.name, environmentId: s.environmentId, environmentName: s.environment.name, at: at.toISOString() }));
}

export async function getHomeSummary(
  db: Db,
  opts: { now?: Date; todayFrom?: string | undefined; includeSchedules: boolean },
): Promise<HomeSummary> {
  const now = opts.now ?? new Date();
  const todayFrom = opts.todayFrom ? new Date(opts.todayFrom) : new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const cut = new Date(now.getTime() - 7 * DAY_MS);
  const [cur, prev, runsToday, running, upcoming] = await Promise.all([
    successOf(db, cut, now),
    successOf(db, new Date(now.getTime() - 14 * DAY_MS), cut),
    db.run.count({ where: { createdAt: { gte: todayFrom } } }),
    db.run.count({ where: { status: { in: [...ACTIVE_RUN_STATUSES] } } }),
    opts.includeSchedules ? upcomingSchedules(db, now) : Promise.resolve([]),
  ]);
  return {
    generatedAt: now.toISOString(),
    successRate: { current: cur.rate, previous: prev.rate, currentRuns: cur.runs, previousRuns: prev.runs },
    runsToday,
    running,
    upcoming,
  };
}
