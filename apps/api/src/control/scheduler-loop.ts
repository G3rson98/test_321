/**
 * Planificador liviano (≤ 15 s, ESP §13.5; RNF-REN-02): materializa ocurrencias vencidas desde el cursor persistido,
 * admite shards pendientes según capacidad (FIFO), omite corridas programadas que agotaron la gracia de 60 s y cierra
 * corridas en `finalizando`. Separado de los workers de larga duración. Reloj inyectable para pruebas.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { materializeDueOccurrences } from '../services/scheduler.js';
import { admitPendingShards, expireQueuedScheduledRuns } from '../services/run-admission.js';
import { finalizeDueRuns } from '../services/results.js';

export interface SchedulerLoopDeps {
  prisma: PrismaClient;
  logger: Logger;
  publicBaseUrl: string;
  globalBrowserCeiling: number;
}

export async function schedulerTick(deps: SchedulerLoopDeps, now: Date = new Date()) {
  const occurrences = await materializeDueOccurrences(deps, now);
  const omitted = await expireQueuedScheduledRuns(deps, now);
  const admission = await admitPendingShards(deps, now);
  const finalized = await finalizeDueRuns(deps.prisma, now, deps.publicBaseUrl);
  const busy =
    occurrences.admitted + occurrences.queued + Object.keys(occurrences.omitted).length + omitted.length +
    admission.admitted.length + finalized.length;
  if (busy > 0) {
    deps.logger.info(
      {
        occurrences,
        omittedRuns: omitted,
        admitted: admission.admitted,
        saturated: admission.saturated,
        finalized,
      },
      'planificador',
    );
  }
  if (admission.saturated.length) deps.logger.debug({ saturated: admission.saturated }, 'capacidad saturada');
  return { occurrences, omitted, admission, finalized };
}
