/**
 * Reconciliador (ESP §13.5, RNF-CON-04): PostgreSQL → Redis.
 * - Disparadores BullMQ Job Schedulers (`schedule-triggers`, un scheduler por expresión cron con su zona IANA): se
 *   sincronizan desde la tabla `schedule` (alta/baja/edición, Redis vaciado o reiniciado). El disparo SOLO despierta
 *   la materialización; la lógica de instantes (DST, ventanas, solapamiento) vive en `@katalyst/shared/schedule` y el
 *   cursor persistido garantiza que no se pierdan ni dupliquen ocurrencias.
 * - Despacho perdido de shards (`redispatchStaleShards`).
 * RF-PRG-01, RF-PRG-04, RNF-REN-02.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { redispatchStaleShards } from './dispatcher.js';

export const SCHEDULE_TRIGGERS_QUEUE = 'schedule-triggers';
export const SCHEDULE_TRIGGER_JOB = 'schedule-tick';

export interface ScheduleTriggerData {
  scheduleId: string;
}

export function schedulerIdFor(scheduleId: string, index: number): string {
  return `schedule-${scheduleId}-${index}`;
}

export function createTriggerQueue(connection: ConnectionOptions, prefix: string): Queue<ScheduleTriggerData> {
  return new Queue<ScheduleTriggerData>(SCHEDULE_TRIGGERS_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
  });
}

export type TriggerQueue = Pick<
  Queue<ScheduleTriggerData>,
  'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'
>;

/** Sincroniza los Job Schedulers de una o todas las programaciones. Devuelve (upserts, removals). */
export async function syncScheduleTriggers(
  prisma: PrismaClient,
  queue: TriggerQueue,
  scheduleId?: string,
): Promise<{ upserted: number; removed: number }> {
  const schedules = await prisma.schedule.findMany({
    where: scheduleId ? { id: scheduleId } : {},
    select: { id: true, cronExpressions: true, timezone: true, enabled: true, deletedAt: true },
  });
  const desired = new Map<string, { pattern: string; tz: string; scheduleId: string }>();
  for (const s of schedules) {
    if (!s.enabled || s.deletedAt) continue;
    s.cronExpressions.forEach((pattern, i) => desired.set(schedulerIdFor(s.id, i), { pattern, tz: s.timezone, scheduleId: s.id }));
  }
  const existing = await queue.getJobSchedulers(0, -1, true);
  let removed = 0;
  for (const j of existing) {
    const id = j.key ?? j.id ?? '';
    const belongs = scheduleId ? id.startsWith(`schedule-${scheduleId}-`) : id.startsWith('schedule-');
    if (!belongs) continue;
    const want = desired.get(id);
    if (!want || want.pattern !== j.pattern || want.tz !== j.tz) {
      await queue.removeJobScheduler(id);
      removed++;
    }
  }
  let upserted = 0;
  const present = new Set(existing.map((j) => j.key ?? j.id ?? ''));
  for (const [id, d] of desired) {
    const same = existing.find((j) => (j.key ?? j.id) === id && j.pattern === d.pattern && j.tz === d.tz);
    if (same && present.has(id)) continue;
    await queue.upsertJobScheduler(
      id,
      { pattern: d.pattern, tz: d.tz },
      { name: SCHEDULE_TRIGGER_JOB, data: { scheduleId: d.scheduleId }, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
    upserted++;
  }
  return { upserted, removed };
}

/** Worker del disparador: cada trabajo materializa la programación indicada (idempotente). */
export function startTriggerWorker(
  connection: ConnectionOptions,
  prefix: string,
  onTrigger: (scheduleId: string) => Promise<void>,
  logger: Logger,
): Worker<ScheduleTriggerData> {
  const w = new Worker<ScheduleTriggerData>(
    SCHEDULE_TRIGGERS_QUEUE,
    async (job) => {
      // Pequeño margen: el disparo puede llegar milisegundos antes del instante.
      await new Promise((r) => setTimeout(r, 250));
      await onTrigger(job.data.scheduleId);
    },
    { connection, prefix, concurrency: 1 },
  );
  w.on('error', (err) => logger.warn({ err }, 'worker de disparadores'));
  return w;
}

export interface ReconcileDeps {
  prisma: PrismaClient;
  logger: Logger;
  triggers?: TriggerQueue;
}

/** Tick del reconciliador. */
export async function reconcileTick(deps: ReconcileDeps, now: Date = new Date()) {
  const dispatch = await redispatchStaleShards(deps.prisma, now, deps.logger);
  let triggers = { upserted: 0, removed: 0 };
  if (deps.triggers) {
    try {
      triggers = await syncScheduleTriggers(deps.prisma, deps.triggers);
    } catch (err) {
      deps.logger.warn({ err }, 'no se pudieron sincronizar disparadores (Redis); el planificador sigue por sondeo');
    }
  }
  return { dispatch, triggers };
}
