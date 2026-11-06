/**
 * Evaluador de umbrales de rendimiento (RF-REN-03, RF-NOT-02; ESP §13.8). Lo invoca `main.control.ts` cada
 * `THRESHOLD_EVAL_INTERVAL_MS` (60 s).
 * - Ventana móvil por reloj UTC `[now − window_min, now)` sobre muestras CRUDAS de UNA serie.
 * - Estrictamente mayor al límite; muestra insuficiente (p95/tasas < 20, máx < 1, o `min_samples` mayor) no dispara.
 * - Alerta identificada por umbral/ambiente/origen/canal; mutex (bloqueo de fila) + `last_sent_at` en BD ⇒ como
 *   máximo un envío por alerta en cualquier ventana móvil de 60 min, también tras reinicio.
 * - Envío por outbox (`notification.alert`): los reintentos no crean alertas nuevas.
 * - Recuperación: la alerta pasa a `recuperada` sin notificación adicional.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import {
  alertFingerprint,
  canSendAlert,
  effectiveMinSamples,
  evaluateThreshold,
  evaluationWindow,
  MIN_COMPLETED_FOR_MAX,
  MIN_COMPLETED_FOR_P95,
  MIN_STARTED_FOR_RATES,
  type PerfStats,
  type ThresholdEvaluation,
} from '@katalyst/shared';
import type { Config } from '../config.js';
import { enqueueOutbox } from '../lib/outbox.js';
import { lockAlert, NO_CHANNEL } from '../modules/alerts/service.js';
import { activeChannels } from '../modules/notifications/channels.js';
import { panelLink, type ThresholdAlertPayload } from '../modules/notifications/messages.js';
import { rawFilterSql, STATS_COLUMNS, type StatsRow } from '../modules/perf/sql.js';
import { thresholdDims } from '../modules/perf/thresholds.js';

/** Vigencia de una entrega de alerta: pasada 1 h la siguiente evaluación decide de nuevo. */
export const ALERT_DELIVERY_TTL_MS = 60 * 60 * 1000;

export function statsFromRow(r: StatsRow, minP95: number, minRates: number): PerfStats {
  const mv = (value: number | null, sufficient: boolean, n: number, required: number) => ({
    value: sufficient ? value : null,
    sufficient,
    n,
    required,
  });
  const p95ok = r.completed >= minP95;
  const ratesOk = r.started >= minRates;
  const maxOk = r.completed >= MIN_COMPLETED_FOR_MAX;
  return {
    started: r.started,
    completed: r.completed,
    discarded: r.discarded,
    successes: r.started - r.timeouts - r.network_errors - r.http_errors,
    httpErrors: r.http_errors,
    networkErrors: r.network_errors,
    timeouts: r.timeouts,
    over29s: r.over29s,
    mean: mv(r.mean_ms, maxOk, r.completed, MIN_COMPLETED_FOR_MAX),
    max: mv(r.max_ms, maxOk, r.completed, MIN_COMPLETED_FOR_MAX),
    min: mv(r.min_ms, maxOk, r.completed, MIN_COMPLETED_FOR_MAX),
    p95: mv(r.p95_ms, p95ok, r.completed, minP95),
    errorRate: mv(ratesOk ? (r.http_errors + r.network_errors + r.timeouts) / r.started : null, ratesOk, r.started, minRates),
    timeoutRate: mv(ratesOk ? r.timeouts / r.started : null, ratesOk, r.started, minRates),
    quality: r.started + r.discarded === 0 ? 'sin_datos' : p95ok ? 'suficiente' : 'insuficiente',
  };
}

export interface PerfEvaluatorDeps {
  prisma: PrismaClient;
  config: Config;
  logger?: Logger;
  now?: Date;
}

export interface PerfEvaluationSummary {
  evaluated: number;
  exceeded: number;
  enqueued: number;
  suppressed: number;
  recovered: number;
  errors: number;
}

/** Un ciclo del evaluador. Idempotente y seguro con varias réplicas. */
export async function evaluatePerfThresholds(deps: PerfEvaluatorDeps): Promise<PerfEvaluationSummary> {
  const now = deps.now ?? new Date();
  const summary: PerfEvaluationSummary = { evaluated: 0, exceeded: 0, enqueued: 0, suppressed: 0, recovered: 0, errors: 0 };
  const thresholds = await deps.prisma.perfThreshold.findMany({
    where: { enabled: true, deletedAt: null },
    include: { environment: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  for (const t of thresholds) {
    try {
      const dims = thresholdDims(t);
      const { from, to } = evaluationWindow(now, t.windowMin);
      const required = effectiveMinSamples(t.metric, t.minSamples);
      const rows = await deps.prisma.$queryRaw<StatsRow[]>`
        SELECT ${STATS_COLUMNS} FROM perf_sample
        WHERE ${rawFilterSql({
          environmentId: dims.environmentId,
          endpointKeys: [dims.endpointKey],
          provenance: dims.provenance,
          source: dims.source,
          metricKind: dims.metricKind,
          cacheMode: dims.cacheMode,
          workerProfile: dims.workerProfile ?? '',
        })} AND ts >= ${from} AND ts < ${to}`;
      const stats = statsFromRow(
        rows[0]!,
        t.metric === 'p95' ? required : MIN_COMPLETED_FOR_P95,
        t.metric === 'error_rate' || t.metric === 'timeout_rate' ? required : MIN_STARTED_FOR_RATES,
      );
      const ev: ThresholdEvaluation = evaluateThreshold({ metric: t.metric, limit: t.limit, minSamples: t.minSamples }, stats);
      summary.evaluated++;
      const payload: ThresholdAlertPayload = {
        thresholdId: t.id,
        label: t.label,
        environmentId: t.environmentId,
        environmentName: t.environment.name,
        endpointKey: dims.endpointKey,
        provenance: dims.provenance,
        source: dims.source,
        metricKind: dims.metricKind,
        cacheMode: dims.cacheMode,
        workerProfile: dims.workerProfile,
        metric: t.metric,
        unit: t.unit as 'ms' | 'ratio',
        value: ev.value,
        limit: t.limit,
        n: ev.n,
        required: ev.required,
        windowMin: t.windowMin,
        windowFrom: from.toISOString(),
        windowTo: to.toISOString(),
        evaluatedAt: now.toISOString(),
      };
      await deps.prisma.$transaction(async (tx) => {
        await tx.perfThreshold.update({
          where: { id: t.id },
          data: { lastEvaluatedAt: now, lastState: ev.state, lastValue: ev.value, lastN: ev.n },
        });
        const channels = await activeChannels(tx, deps.config);
        const targets = channels.length > 0 ? channels.map((c) => c.kind) : [null];
        for (const channel of targets) {
          const fingerprint = alertFingerprint({
            thresholdId: t.id,
            environmentId: t.environmentId,
            source: dims.source,
            channel: channel ?? NO_CHANNEL,
          });
          if (ev.state === 'superado') {
            const alert = await lockAlert(tx, {
              kind: 'umbral_rendimiento',
              fingerprint,
              environmentId: t.environmentId,
              thresholdId: t.id,
              channel,
              payload,
            });
            const full = {
              ...payload,
              alertId: alert.id,
              link: panelLink(deps.config.PUBLIC_BASE_URL, `/rendimiento?ambiente=${t.environmentId}&alerta=${alert.id}`),
            };
            const send = channel !== null && canSendAlert(alert.last_sent_at, now);
            await tx.alert.update({
              where: { id: alert.id },
              data: {
                status: 'activa',
                recoveredAt: null,
                payload: full,
                ...(send ? { lastSentAt: now, sendCount: { increment: 1 } } : {}),
              },
            });
            if (send) {
              await enqueueOutbox(tx, {
                operation: 'notification.alert',
                dedupKey: `alert:${alert.id}:${now.toISOString()}`,
                payload: { alertId: alert.id },
                alertId: alert.id,
                expiresAt: new Date(now.getTime() + ALERT_DELIVERY_TTL_MS),
              });
              summary.enqueued++;
            } else if (channel !== null) summary.suppressed++;
          } else if (ev.state === 'normal') {
            const r = await tx.alert.updateMany({
              where: { fingerprint, status: 'activa' },
              data: { status: 'recuperada', recoveredAt: now },
            });
            summary.recovered += r.count;
          }
        }
      });
      if (ev.state === 'superado') summary.exceeded++;
    } catch (err) {
      summary.errors++;
      deps.logger?.error({ err, thresholdId: t.id }, 'evaluación de umbral fallida');
    }
  }
  return summary;
}

/** Bucle del evaluador para `main.control.ts` (API-B): ejecuta cada `intervalMs` hasta `signal`. */
export async function perfEvaluatorLoop(
  deps: Omit<PerfEvaluatorDeps, 'now'>,
  opts: { intervalMs?: number; signal?: AbortSignal; onTick?: () => void } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? deps.config.THRESHOLD_EVAL_INTERVAL_MS;
  while (!opts.signal?.aborted) {
    const started = Date.now();
    try {
      await evaluatePerfThresholds(deps);
    } catch (err) {
      deps.logger?.error({ err }, 'ciclo del evaluador de umbrales fallido');
    }
    opts.onTick?.();
    const wait = Math.max(1000, interval - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
