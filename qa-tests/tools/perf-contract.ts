/**
 * Contrato de importación de muestras de rendimiento (schema_version 1). RF-REN-01/02/05, ESP §7 (`perf_sample` y
 * extensiones), ESP §13.8.
 *
 * Reglas aplicadas aquí:
 * - Tiempos en ms y tamaños en bytes; `bytes_wire` (transferencia) distinto de `bytes_body` (cuerpo descomprimido).
 * - Valores no observables => `null` con razón en `null_reasons`; nunca cero inventado. Un 0 de Resource Timing sin
 *   `Timing-Allow-Origin` no prueba compresión: se guarda null.
 * - Timeout = observación censurada: `total_ms=null`, `censored=true`, `censored_at_ms` y `timeout_limit_ms`.
 * - `over_29s` solo para respuestas completadas con duración estrictamente > 29 000 ms.
 * - Sin NaN ni negativos: la muestra se cuarentena con motivo y no detiene el resto.
 * - Endpoints normalizados (IDs fuera, solo dimensiones permitidas de query como `typeOperation`), sin datos personales.
 *
 * El validador autoritativo vive en `@katalyst/shared` (perf/); este módulo solo produce archivos conformes.
 */
import { createHash } from 'node:crypto';
import { OVER_29S_MS } from '../fixtures/timeouts.ts';

export const PERF_SCHEMA_VERSION = 1;

export type PerfSource = 'ui' | 'raiz' | 'probe' | 'app';
export type PerfMetricKind = 'network_request' | 'screen_ready' | 'root_ready' | 'root_current_wait';
export type PerfCacheMode = 'fria' | 'caliente';
export type PerfProvenance = 'dxmon' | 'playwright';
export type PerfErrorKind = 'http' | 'red' | 'timeout' | 'condicion' | null;

/** Campos de `perf_sample` (ESP §7) + extensiones. `null` cuando no es observable. */
export interface PerfSample {
  // ESP §7 perf_sample
  run_id: string;
  ts: string;
  source: PerfSource;
  endpoint: string | null;
  status_code: number | null;
  ok: boolean | null;
  total_ms: number | null;
  ttfb_ms: number | null;
  download_ms: number | null;
  bytes_wire: number | null;
  bytes_body: number | null;
  timeout: boolean;
  over_29s: boolean;
  visible: boolean | null;
  // Extensiones ESP §7
  environment_id: string | null;
  sample_key: string;
  schema_version: number;
  endpoint_key: string | null;
  screen_key: string | null;
  metric_kind: PerfMetricKind;
  cache_mode: PerfCacheMode | null;
  worker_profile: string;
  censored: boolean;
  invalid_reason: string | null;
  // Extensiones del adaptador (documentadas en tools/README-dxmon.md)
  provenance: PerfProvenance;
  method: string | null;
  error_kind: PerfErrorKind;
  censored_at_ms: number | null;
  timeout_limit_ms: number | null;
  content_encoding: string | null;
  null_reasons: Record<string, string>;
}

export interface QuarantinedSample {
  index: number;
  provenance: PerfProvenance;
  reason: string;
}

export interface SampleContext {
  runId: string;
  environmentId: string | null;
  workerProfile: string;
  apiOrigin: string | undefined;
  appOrigin: string | undefined;
}

/** Dimensiones de query permitidas en endpoint_key (ESP §13.8: mantener dimensiones permitidas como typeOperation). */
export const ALLOWED_QUERY_DIMENSIONS: readonly string[] = ['typeOperation'];

const ID_SEGMENT = [
  /^\d+$/, // numérico
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{16,}$/i, // hex largo / ObjectId
  /@/, // correos u otros identificadores personales
  /^[A-Za-z0-9_-]{24,}$/, // tokens/ids opacos largos
];

function normalizeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // segmento mal codificado: se trata como opaco
    return ':id';
  }
  return ID_SEGMENT.some((re) => re.test(decoded)) ? ':id' : segment;
}

export interface NormalizedEndpoint {
  /** URL saneada: origen simbólico + ruta normalizada + dimensiones permitidas. */
  endpoint: string;
  /** Clave de serie: `<METHOD> <ruta normalizada>[?dim=valor]`. */
  endpointKey: string;
}

/** Normaliza una URL de petición sin conservar IDs, valores de query no permitidos ni datos personales. */
export function normalizeEndpoint(rawUrl: string, method: string, ctx: Pick<SampleContext, 'apiOrigin' | 'appOrigin'>): NormalizedEndpoint | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const originAlias = url.origin === ctx.apiOrigin ? 'api' : url.origin === ctx.appOrigin ? 'app' : 'externo';
  const path = url.pathname
    .split('/')
    .map((s) => (s === '' ? s : normalizeSegment(s)))
    .join('/');
  const dims = ALLOWED_QUERY_DIMENSIONS.filter((d) => url.searchParams.has(d))
    .map((d) => `${d}=${encodeURIComponent((url.searchParams.get(d) ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40))}`)
    .join('&');
  const suffix = dims ? `?${dims}` : '';
  return { endpoint: `${originAlias}:${path}${suffix}`, endpointKey: `${method.toUpperCase()} ${path}${suffix}` };
}

/** Valida una duración en ms: número finito, >= 0 y < 10 min. Devuelve null si no es válida. */
export function validMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 600_000) return null;
  return Math.round(value * 1000) / 1000;
}

/** Valida bytes: entero finito >= 0 y < 1 GiB. */
export function validBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1024 ** 3) return null;
  return Math.round(value);
}

export function sampleKey(runId: string, provenance: PerfProvenance, seq: number): string {
  return createHash('sha256').update(`${runId}|${provenance}|${seq}`).digest('hex').slice(0, 32);
}

export function over29s(totalMs: number | null, censored: boolean): boolean {
  return !censored && totalMs !== null && totalMs > OVER_29S_MS;
}

/** Comprueba invariantes de una muestra ya construida. Devuelve el motivo de cuarentena o null. */
export function checkSample(sample: PerfSample): string | null {
  const numeric: Array<keyof PerfSample> = [
    'total_ms',
    'ttfb_ms',
    'download_ms',
    'bytes_wire',
    'bytes_body',
    'censored_at_ms',
    'timeout_limit_ms',
  ];
  for (const key of numeric) {
    const v = sample[key];
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `valor_no_numerico:${key}`;
    if (v < 0) return `valor_negativo:${key}`;
  }
  if (Number.isNaN(Date.parse(sample.ts))) return 'ts_invalido';
  if (sample.censored && sample.total_ms !== null) return 'censurada_con_latencia';
  if (sample.censored && !sample.timeout) return 'censurada_sin_timeout';
  if (sample.over_29s && (sample.censored || sample.total_ms === null || sample.total_ms <= OVER_29S_MS)) return 'over_29s_incoherente';
  if (sample.status_code !== null && (!Number.isInteger(sample.status_code) || sample.status_code < 100 || sample.status_code > 599)) {
    return 'status_code_invalido';
  }
  if (sample.schema_version !== PERF_SCHEMA_VERSION) return 'schema_version_invalida';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Resumen local (informativo). El backend recalcula con muestras crudas; aquí se usa el mismo método (ESP §13.8).
// ---------------------------------------------------------------------------------------------------------------

export const MIN_SAMPLES_P95 = 20;

/** p95 por rango ordenado con índice ceil(0.95*n) base 1. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1] ?? null;
}

export interface SeriesSummary {
  provenance: PerfProvenance;
  source: PerfSource;
  metric_kind: PerfMetricKind;
  endpoint_key: string | null;
  screen_key: string | null;
  cache_mode: PerfCacheMode | null;
  worker_profile: string;
  n_started_valid: number;
  n_completed: number;
  n_success: number;
  n_errors: number;
  n_timeouts: number;
  n_over_29s: number;
  n_invalid: number;
  mean_ms: number | null;
  max_ms: number | null;
  p95_ms: number | null;
  p95_status: 'ok' | 'muestra_insuficiente';
  error_rate: number | null;
  timeout_rate: number | null;
}

export function summarize(samples: readonly PerfSample[]): SeriesSummary[] {
  const groups = new Map<string, PerfSample[]>();
  for (const s of samples) {
    const key = JSON.stringify([s.provenance, s.source, s.metric_kind, s.endpoint_key, s.screen_key, s.cache_mode, s.worker_profile]);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out: SeriesSummary[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    const valid = list.filter((s) => s.invalid_reason === null);
    const completed = valid.filter((s) => !s.censored && s.total_ms !== null);
    const durations = completed.map((s) => s.total_ms as number);
    const timeouts = valid.filter((s) => s.timeout).length;
    const errors = valid.filter((s) => s.ok === false).length; // HTTP no exitoso + red + timeout + condición fallida
    const n = valid.length;
    const enoughP95 = durations.length >= MIN_SAMPLES_P95;
    const enoughRates = n >= MIN_SAMPLES_P95;
    out.push({
      provenance: first.provenance,
      source: first.source,
      metric_kind: first.metric_kind,
      endpoint_key: first.endpoint_key,
      screen_key: first.screen_key,
      cache_mode: first.cache_mode,
      worker_profile: first.worker_profile,
      n_started_valid: n,
      n_completed: completed.length,
      n_success: completed.filter((s) => s.ok === true).length,
      n_errors: errors,
      n_timeouts: timeouts,
      n_over_29s: completed.filter((s) => s.over_29s).length,
      n_invalid: list.length - n,
      mean_ms: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 1000) / 1000 : null,
      max_ms: durations.length ? Math.max(...durations) : null,
      p95_ms: enoughP95 ? p95(durations) : null,
      p95_status: enoughP95 ? 'ok' : 'muestra_insuficiente',
      error_rate: enoughRates ? errors / n : null,
      timeout_rate: enoughRates ? timeouts / n : null,
    });
  }
  return out;
}
