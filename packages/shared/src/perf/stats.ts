/**
 * Estadísticas DXMon (ESP §13.8).
 * - Media/máximo/p95 solo sobre respuestas completadas válidas (incluye HTTP no exitoso).
 * - p95 por rango ordenado, índice `ceil(0.95·n)` base 1; nunca promediar percentiles.
 * - Timeouts = observaciones censuradas: no entran en latencia; sí en `timeout_rate` y `error_rate`.
 * - `error_rate` = (HTTP no exitoso + errores de red + timeouts) / solicitudes válidas iniciadas.
 * - `over_29s` = respuesta COMPLETADA con duración estrictamente > 29 000 ms (RF-REN-05 "respuestas de más de 29 s");
 *   un timeout es censurado y cuenta solo en timeouts (D-016).
 * - Mínimos: p95 ≥ 20 completadas; rates ≥ 20 iniciadas; máximo (y media) ≥ 1 completada.
 * RF-REN-02, RF-REN-03, RF-REN-05.
 */
import type { PerfMetric, PerfMetricKind } from '../enums.js';

export const OVER_29S_THRESHOLD_MS = 29_000;
export const MIN_COMPLETED_FOR_P95 = 20;
export const MIN_STARTED_FOR_RATES = 20;
export const MIN_COMPLETED_FOR_MAX = 1;

/** Piso de `min_samples` por métrica (ESP §13.8: puede aumentarse, no bajarse). */
export const METRIC_MIN_SAMPLES_FLOOR: Record<PerfMetric, number> = {
  p95: MIN_COMPLETED_FOR_P95,
  max: MIN_COMPLETED_FOR_MAX,
  error_rate: MIN_STARTED_FOR_RATES,
  timeout_rate: MIN_STARTED_FOR_RATES,
};

/** Unidad explícita de cada métrica (ESP §7 perf_threshold: "unidades explícitas"). */
export const METRIC_UNIT: Record<PerfMetric, 'ms' | 'ratio'> = {
  p95: 'ms',
  max: 'ms',
  error_rate: 'ratio',
  timeout_rate: 'ratio',
};

export const INSUFFICIENT_SAMPLE_LABEL = 'muestra insuficiente';

export interface PerfObservation {
  /** Duración total de una respuesta completada (ms). `null` si no se completó (timeout/red) o no disponible. */
  totalMs: number | null;
  timeout: boolean;
  /** Duración hasta el corte en timeouts (censurada). */
  censoredAtMs?: number | null;
  /** Error de red sin respuesta HTTP. */
  networkError?: boolean;
  statusCode?: number | null;
  /** `ok` reportado: para pantallas es el resultado de la condición lista/fallida. */
  ok?: boolean | null;
  metricKind?: PerfMetricKind;
  /** Muestra inválida (contención, visibilidad…): se descarta con motivo. */
  invalidReason?: string | null;
}

export interface MetricValue {
  value: number | null;
  sufficient: boolean;
  /** Tamaño de muestra usado para la suficiencia (completadas o iniciadas). */
  n: number;
  required: number;
}

export interface PerfStats {
  /** Solicitudes válidas iniciadas. */
  started: number;
  /** Respuestas completadas válidas (con duración). */
  completed: number;
  discarded: number;
  successes: number;
  httpErrors: number;
  networkErrors: number;
  timeouts: number;
  over29s: number;
  mean: MetricValue;
  max: MetricValue;
  min: MetricValue;
  p95: MetricValue;
  errorRate: MetricValue;
  timeoutRate: MetricValue;
  /** `suficiente` si p95 es calculable; `insuficiente` si hay datos pero no alcanzan; `sin_datos` si n=0. */
  quality: 'suficiente' | 'insuficiente' | 'sin_datos';
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** p95 por rango ordenado: índice `ceil(0.95·n)` base 1. Devuelve null para lista vacía. */
export function percentileByRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p > 0 && p <= 1)) throw new RangeError('p debe estar en (0, 1]');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function p95(values: readonly number[]): number | null {
  return percentileByRank(values, 0.95);
}

function isHttpError(o: PerfObservation): boolean {
  if (o.metricKind === 'screen_ready' || o.metricKind === 'root_ready') {
    return o.ok === false;
  }
  if (typeof o.ok === 'boolean') return !o.ok;
  if (typeof o.statusCode === 'number') return o.statusCode < 200 || o.statusCode >= 400;
  return false;
}

/** Duración observada: completada (`totalMs`) o hasta el corte (`censoredAtMs`) si es timeout. */
export function observedDurationMs(o: PerfObservation): number | null {
  if (o.timeout) return isFiniteNonNegative(o.censoredAtMs) ? o.censoredAtMs : null;
  return isFiniteNonNegative(o.totalMs) ? o.totalMs : null;
}

/** `over_29s`: solo respuestas completadas (no timeout ni error de red) con duración > 29 000 ms. */
export function isOver29s(o: Pick<PerfObservation, 'timeout' | 'totalMs' | 'networkError'>): boolean {
  return !o.timeout && !o.networkError && isFiniteNonNegative(o.totalMs) && o.totalMs > OVER_29S_THRESHOLD_MS;
}

export interface ComputeStatsOptions {
  /** Mínimo de completadas para p95 (no menor a 20). */
  minCompletedForP95?: number;
  /** Mínimo de iniciadas para rates (no menor a 20). */
  minStartedForRates?: number;
}

export function computePerfStats(observations: readonly PerfObservation[], opts: ComputeStatsOptions = {}): PerfStats {
  const minP95 = Math.max(MIN_COMPLETED_FOR_P95, opts.minCompletedForP95 ?? MIN_COMPLETED_FOR_P95);
  const minRates = Math.max(MIN_STARTED_FOR_RATES, opts.minStartedForRates ?? MIN_STARTED_FOR_RATES);
  let started = 0;
  let discarded = 0;
  let successes = 0;
  let httpErrors = 0;
  let networkErrors = 0;
  let timeouts = 0;
  let over29s = 0;
  const durations: number[] = [];

  for (const o of observations) {
    if (o.invalidReason) {
      discarded++;
      continue;
    }
    started++;
    if (isOver29s(o)) over29s++;
    if (o.timeout) {
      timeouts++;
      continue;
    }
    if (o.networkError) {
      networkErrors++;
      continue;
    }
    if (!isFiniteNonNegative(o.totalMs)) {
      // Iniciada pero sin duración disponible: no se inventa un cero; cuenta solo en iniciadas.
      if (isHttpError(o)) httpErrors++;
      else successes++;
      continue;
    }
    durations.push(o.totalMs);
    if (isHttpError(o)) httpErrors++;
    else successes++;
  }

  const completed = durations.length;
  const sum = durations.reduce((a, b) => a + b, 0);
  const maxV = completed ? Math.max(...durations) : null;
  const minV = completed ? Math.min(...durations) : null;
  const p95Sufficient = completed >= minP95;
  const ratesSufficient = started >= minRates;
  const maxSufficient = completed >= MIN_COMPLETED_FOR_MAX;

  return {
    started,
    completed,
    discarded,
    successes,
    httpErrors,
    networkErrors,
    timeouts,
    over29s,
    mean: {
      value: maxSufficient ? sum / completed : null,
      sufficient: maxSufficient,
      n: completed,
      required: MIN_COMPLETED_FOR_MAX,
    },
    max: {
      value: maxSufficient ? maxV : null,
      sufficient: maxSufficient,
      n: completed,
      required: MIN_COMPLETED_FOR_MAX,
    },
    min: {
      value: maxSufficient ? minV : null,
      sufficient: maxSufficient,
      n: completed,
      required: MIN_COMPLETED_FOR_MAX,
    },
    p95: { value: p95Sufficient ? p95(durations) : null, sufficient: p95Sufficient, n: completed, required: minP95 },
    errorRate: {
      value: ratesSufficient ? (httpErrors + networkErrors + timeouts) / started : null,
      sufficient: ratesSufficient,
      n: started,
      required: minRates,
    },
    timeoutRate: {
      value: ratesSufficient ? timeouts / started : null,
      sufficient: ratesSufficient,
      n: started,
      required: minRates,
    },
    quality: started + discarded === 0 ? 'sin_datos' : p95Sufficient ? 'suficiente' : 'insuficiente',
  };
}

/** Texto a mostrar para un valor (`muestra insuficiente` cuando no alcanza el mínimo). */
export function displayMetric(m: MetricValue, format: (v: number) => string = (v) => String(v)): string {
  if (!m.sufficient || m.value === null) return INSUFFICIENT_SAMPLE_LABEL;
  return format(m.value);
}

/** Valor de la métrica de umbral a partir de las estadísticas. */
export function metricFromStats(stats: PerfStats, metric: PerfMetric): MetricValue {
  switch (metric) {
    case 'p95':
      return stats.p95;
    case 'max':
      return stats.max;
    case 'error_rate':
      return stats.errorRate;
    case 'timeout_rate':
      return stats.timeoutRate;
  }
}
