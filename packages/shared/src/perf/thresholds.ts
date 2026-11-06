/**
 * Evaluación de umbrales y deduplicación de alertas (ESP §13.8).
 * - Umbral estrictamente mayor al límite.
 * - Muestra insuficiente ⇒ no dispara (estado `insuficiente`).
 * - Máximo un envío de la misma alerta (umbral/ambiente/origen/canal) en cualquier ventana móvil de 60 min.
 * RF-REN-03, RF-NOT-02.
 */
import type { PerfMetric, PerfSource } from '../enums.js';
import {
  computePerfStats,
  METRIC_MIN_SAMPLES_FLOOR,
  metricFromStats,
  type PerfObservation,
  type PerfStats,
} from './stats.js';

export const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export interface ThresholdDefinition {
  metric: PerfMetric;
  /** ms para p95/max; razón 0..1 para rates. */
  limit: number;
  minSamples: number;
}

export type ThresholdState = 'superado' | 'normal' | 'insuficiente';

export interface ThresholdEvaluation {
  state: ThresholdState;
  value: number | null;
  limit: number;
  n: number;
  required: number;
}

/** `min_samples` efectivo: nunca menor al piso de la métrica. */
export function effectiveMinSamples(metric: PerfMetric, minSamples: number): number {
  return Math.max(METRIC_MIN_SAMPLES_FLOOR[metric], Math.floor(minSamples));
}

/** Valida que `min_samples` no baje del piso (para el esquema de creación). */
export function isValidMinSamples(metric: PerfMetric, minSamples: number): boolean {
  return Number.isInteger(minSamples) && minSamples >= METRIC_MIN_SAMPLES_FLOOR[metric];
}

export function evaluateThreshold(
  def: ThresholdDefinition,
  input: readonly PerfObservation[] | PerfStats,
): ThresholdEvaluation {
  const required = effectiveMinSamples(def.metric, def.minSamples);
  const stats = Array.isArray(input)
    ? computePerfStats(input as readonly PerfObservation[], {
        minCompletedForP95: def.metric === 'p95' ? required : undefined,
        minStartedForRates: def.metric === 'error_rate' || def.metric === 'timeout_rate' ? required : undefined,
      })
    : (input as PerfStats);
  const m = metricFromStats(stats, def.metric);
  const n = m.n;
  if (n < required || m.value === null) {
    return { state: 'insuficiente', value: null, limit: def.limit, n, required };
  }
  return { state: m.value > def.limit ? 'superado' : 'normal', value: m.value, limit: def.limit, n, required };
}

export interface AlertIdentity {
  thresholdId: string;
  environmentId: string;
  source: PerfSource | string;
  channel: string;
}

/** Huella estable de la alerta (persistida en `alert.fingerprint`). */
export function alertFingerprint(a: AlertIdentity): string {
  return ['umbral', a.thresholdId, a.environmentId, a.source, a.channel].map((p) => encodeURIComponent(p)).join(':');
}

/** ¿Puede enviarse otra vez? Solo si no hubo envío en los últimos 60 min (ventana móvil). */
export function canSendAlert(lastSentAt: Date | null, now: Date, windowMs = ALERT_DEDUP_WINDOW_MS): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= windowMs;
}

/** Ventana móvil de evaluación por reloj UTC: `[now - windowMin, now)`. */
export function evaluationWindow(now: Date, windowMin: number): { from: Date; to: Date } {
  if (!(windowMin > 0)) throw new RangeError('windowMin debe ser > 0');
  return { from: new Date(now.getTime() - windowMin * 60_000), to: now };
}
