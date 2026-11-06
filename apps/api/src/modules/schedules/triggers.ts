/**
 * Sincronización best-effort de los disparadores BullMQ (Job Schedulers) al crear/editar/pausar/borrar una
 * programación desde la API. Si Redis no está disponible no falla la operación: el reconciliador del proceso de control
 * los corrige desde PostgreSQL (fuente de verdad) y el planificador sigue por sondeo ≤ 15 s. RF-PRG-01, ESP §13.5.
 */
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { createTriggerQueue, syncScheduleTriggers, type ScheduleTriggerData } from '../../control/reconciler.js';
import { bullConnectionFromUrl } from '../../control/dispatcher.js';

const queues = new WeakMap<FastifyInstance, Queue<ScheduleTriggerData>>();
let disabled = process.env['KATALYST_DISABLE_SCHEDULE_TRIGGERS'] === 'true';

/** Solo pruebas. */
export function setScheduleTriggersEnabled(enabled: boolean): void {
  disabled = !enabled;
}

function queueOf(app: FastifyInstance): Queue<ScheduleTriggerData> {
  let q = queues.get(app);
  if (!q) {
    q = createTriggerQueue(
      bullConnectionFromUrl(app.deps.config.REDIS_URL, { failFast: true }),
      app.deps.config.QUEUE_PREFIX,
    );
    q.on('error', () => undefined);
    queues.set(app, q);
  }
  return q;
}

export async function notifyScheduleChanged(app: FastifyInstance, scheduleId: string): Promise<void> {
  if (disabled) return;
  try {
    await Promise.race([
      syncScheduleTriggers(app.deps.prisma, queueOf(app), scheduleId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000).unref()),
    ]);
  } catch (err) {
    app.log.warn({ err, scheduleId }, 'disparadores BullMQ no sincronizados (se reconciliarán)');
  }
}

export async function closeScheduleTriggers(app: FastifyInstance): Promise<void> {
  const q = queues.get(app);
  queues.delete(app);
  await q?.close().catch(() => undefined);
}
