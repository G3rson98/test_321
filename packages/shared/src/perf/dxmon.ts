/**
 * Contrato de importación de muestras de rendimiento versionado (`schema_version` 1) — ESP §7 extensiones de
 * perf_sample y §13.8. Es el VALIDADOR AUTORITATIVO del archivo `samples.json` que produce
 * qa-tests/tools/dxmon-adapter.ts (formato snake_case de qa-tests/tools/README-dxmon.md §5, D-016).
 * - Validación por muestra: las inválidas se cuarentenan con motivo y conteo sin detener las válidas.
 * - Sin `NaN`, sin duraciones/tamaños negativos; no disponibles son `null` (nunca cero inventado).
 * - Timeout = observación censurada: `total_ms = null`, `censored = true`, `censored_at_ms`/`timeout_limit_ms`.
 * - `over_29s` solo respuestas completadas > 29 000 ms; el backend lo recalcula y cuarentena incoherencias.
 * - Deduplicación por `(run_id, sample_key)`; `endpoint_key` se recalcula en el backend.
 * RF-REN-01, RF-REN-05.
 */
import { z } from 'zod';
import {
  CacheModeSchema,
  PerfErrorKindSchema,
  PerfMetricKindSchema,
  PerfProvenanceSchema,
  PerfSourceSchema,
  type CacheMode,
  type PerfErrorKind,
  type PerfMetricKind,
  type PerfProvenance,
  type PerfSource,
} from '../enums.js';
import {
  normalizeEndpointForStorage,
  normalizeScreenKey,
  seriesEndpointKey,
  type NormalizeEndpointOptions,
} from './endpoint.js';
import { isOver29s } from './stats.js';
import { sanitizeUrl } from '../sanitize/url.js';

export const PERF_SAMPLES_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_PERF_SCHEMA_VERSIONS = [1] as const;

const ms = z.number().nonnegative().max(3_600_000);
const bytes = z
  .number()
  .int()
  .nonnegative()
  .max(1024 ** 3);
const isoTs = z.iso.datetime({ offset: true });

/** Una muestra de `samples.json` (snake_case, ESP §7). */
export const PerfSampleFileItemSchema = z
  .object({
    schema_version: z.literal(PERF_SAMPLES_SCHEMA_VERSION),
    sample_key: z.string().min(1).max(200),
    run_id: z.string().max(64).nullable().default(null),
    environment_id: z.string().max(64).nullable().default(null),
    ts: isoTs,
    provenance: PerfProvenanceSchema,
    source: PerfSourceSchema,
    metric_kind: PerfMetricKindSchema,
    /** URL o `alias:/ruta` ya normalizada por el productor; el backend vuelve a sanitizar/normalizar. */
    endpoint: z.string().min(1).max(4096).nullable().default(null),
    endpoint_key: z.string().max(4096).nullable().default(null),
    screen_key: z.string().max(200).nullable().default(null),
    method: z
      .string()
      .regex(/^[A-Za-z]{3,10}$/)
      .nullable()
      .default(null),
    status_code: z.number().int().min(100).max(599).nullable().default(null),
    ok: z.boolean().nullable().default(null),
    total_ms: ms.nullable().default(null),
    ttfb_ms: ms.nullable().default(null),
    download_ms: ms.nullable().default(null),
    bytes_wire: bytes.nullable().default(null),
    bytes_body: bytes.nullable().default(null),
    timeout: z.boolean().default(false),
    censored: z.boolean().default(false),
    censored_at_ms: ms.nullable().default(null),
    timeout_limit_ms: ms.nullable().default(null),
    over_29s: z.boolean().default(false),
    error_kind: PerfErrorKindSchema.nullable().default(null),
    visible: z.boolean().nullable().default(null),
    cache_mode: CacheModeSchema.nullable().default(null),
    worker_profile: z.string().max(100).nullable().default(null),
    invalid_reason: z.string().max(200).nullable().default(null),
    content_encoding: z.string().max(50).nullable().default(null),
    /** Motivo por campo de los `null` (p. ej. `timing_no_disponible`). */
    null_reasons: z.record(z.string(), z.string().max(200)).default({}),
  })
  .loose()
  .superRefine((s, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (s.timeout && !s.censored) bad('censored', 'timeout_no_censurado');
    if (s.censored && !s.timeout) bad('censored', 'censurada_sin_timeout');
    if (s.censored && s.total_ms !== null) bad('total_ms', 'censurada_con_latencia');
    if (s.timeout && s.censored_at_ms === null && s.timeout_limit_ms === null)
      bad('censored_at_ms', 'timeout_sin_corte');
    if (!s.timeout && s.censored_at_ms !== null) bad('censored_at_ms', 'censura_sin_timeout');
    if (s.ttfb_ms !== null && s.total_ms !== null && s.ttfb_ms > s.total_ms) bad('ttfb_ms', 'ttfb_mayor_que_total');
    if (s.over_29s !== isOver29s({ timeout: s.timeout, totalMs: s.total_ms, networkError: s.error_kind === 'red' })) {
      bad('over_29s', 'over_29s_incoherente');
    }
    if (s.metric_kind === 'network_request' && s.endpoint === null) bad('endpoint', 'peticion_sin_endpoint');
  });
export type PerfSampleFileItem = z.output<typeof PerfSampleFileItemSchema>;

/** Encabezado de `samples.json`; `samples` se valida muestra por muestra. */
export const PerfSamplesFileHeaderSchema = z
  .object({
    schema_version: z.literal(PERF_SAMPLES_SCHEMA_VERSION),
    kind: z.literal('katalyst.perf_samples').default('katalyst.perf_samples'),
    run_id: z.string().max(64).nullable().default(null),
    environment_id: z.string().max(64).nullable().default(null),
    environment_name: z.string().max(100).nullable().default(null),
    generated_at: isoTs.nullable().default(null),
    worker_profile: z.string().max(100).nullable().default(null),
    producer: z
      .object({
        adapter: z.string().max(100).optional(),
        adapter_version: z.string().max(50).optional(),
        playwright_version: z.string().max(50).optional(),
        browser_version: z.string().max(100).optional(),
        dxmon: z
          .object({
            available: z.boolean(),
            version: z.string().max(50).nullable().optional(),
            sha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable()
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .nullable()
      .default(null),
    samples: z.array(z.unknown()).max(200_000),
    /** Cuarentena del productor (informativa; se suma al conteo). */
    quarantine: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            provenance: PerfProvenanceSchema.optional(),
            reason: z.string().max(200),
          })
          .loose(),
      )
      .max(200_000)
      .default([]),
  })
  .loose();

/** `summary.json` (informativo: el backend recalcula desde muestras crudas). */
export const PerfSummaryFileSchema = z
  .object({
    run_id: z.string().max(64).nullable().default(null),
    started_at: isoTs,
    finished_at: isoTs,
    duration_ms: ms.nullable().default(null),
    cycle_budget_ms: ms.nullable().default(null),
    cycle_limit_ms: ms.nullable().default(null),
    worker: z.record(z.string(), z.unknown()).nullable().default(null),
    producer: z.record(z.string(), z.unknown()).nullable().default(null),
    dxmon: z.record(z.string(), z.unknown()).nullable().default(null),
    skipped_screens: z.array(z.unknown()).default([]),
    counts: z.record(z.string(), z.unknown()).nullable().default(null),
    series: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .loose();
export type PerfSummaryFile = z.output<typeof PerfSummaryFileSchema>;

/** Muestra normalizada lista para `perf_sample` (camelCase = campos Prisma). */
export interface NormalizedPerfSample {
  sampleKey: string;
  schemaVersion: number;
  ts: string;
  provenance: PerfProvenance;
  source: PerfSource;
  metricKind: PerfMetricKind;
  /** Endpoint sanitizado y normalizado (sin IDs ni query de negocio) o null. */
  endpoint: string | null;
  /** Clave de serie recalculada por el backend. */
  endpointKey: string;
  screenKey: string | null;
  method: string | null;
  statusCode: number | null;
  ok: boolean | null;
  totalMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  bytesWire: number | null;
  bytesBody: number | null;
  timeout: boolean;
  censored: boolean;
  censoredAtMs: number | null;
  timeoutLimitMs: number | null;
  networkError: boolean;
  errorKind: PerfErrorKind | null;
  over29s: boolean;
  visible: boolean | null;
  cacheMode: CacheMode;
  workerProfile: string | null;
  invalidReason: string | null;
  contentEncoding: string | null;
  nullReasons: Record<string, string>;
}

export interface QuarantinedSample {
  index: number;
  sampleKey: string | null;
  reasons: string[];
}

export interface PerfImportResult {
  ok: boolean;
  /** Error de archivo completo (encabezado/versión). Si existe, no se importa nada. */
  fileError: string | null;
  header: Omit<z.output<typeof PerfSamplesFileHeaderSchema>, 'samples'> | null;
  valid: NormalizedPerfSample[];
  quarantined: QuarantinedSample[];
  /** Cuarentenas declaradas por el productor. */
  producerQuarantined: number;
  duplicates: number;
}

function sampleKeyOf(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'sample_key' in raw) {
    const k = (raw as { sample_key: unknown }).sample_key;
    return typeof k === 'string' ? k : null;
  }
  return null;
}

function nonFiniteField(raw: unknown): string | null {
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && !Number.isFinite(v)) return k;
    }
  }
  return null;
}

export interface ParsePerfSamplesOptions extends NormalizeEndpointOptions {
  /** Claves ya importadas para la misma corrida (dedupe `(run_id, sample_key)` entre importaciones). */
  existingSampleKeys?: ReadonlySet<string>;
  /** `run_id` del lease: muestras con otro `run_id` se cuarentenan. */
  expectedRunId?: string;
}

/** Valida y normaliza `samples.json` (objeto ya parseado de JSON). */
export function parsePerfSamples(raw: unknown, opts: ParsePerfSamplesOptions = {}): PerfImportResult {
  const header = PerfSamplesFileHeaderSchema.safeParse(raw);
  const empty = { valid: [], quarantined: [], producerQuarantined: 0, duplicates: 0 };
  if (!header.success) {
    const versionIssue = header.error.issues.find((i) => i.path[0] === 'schema_version');
    return {
      ok: false,
      fileError: versionIssue ? 'schema_version_no_soportada' : 'encabezado_invalido',
      header: null,
      ...empty,
    };
  }
  const { samples, ...meta } = header.data;
  if (opts.expectedRunId && meta.run_id && meta.run_id !== opts.expectedRunId) {
    return { ok: false, fileError: 'run_id_distinto', header: meta, ...empty };
  }
  const seen = new Set<string>(opts.existingSampleKeys ?? []);
  const valid: NormalizedPerfSample[] = [];
  const quarantined: QuarantinedSample[] = [];
  let duplicates = 0;

  samples.forEach((item, index) => {
    const nf = nonFiniteField(item);
    if (nf) {
      quarantined.push({ index, sampleKey: sampleKeyOf(item), reasons: [`valor_no_finito:${nf}`] });
      return;
    }
    const parsed = PerfSampleFileItemSchema.safeParse(item);
    if (!parsed.success) {
      quarantined.push({
        index,
        sampleKey: sampleKeyOf(item),
        reasons: parsed.error.issues.map((i) => `${i.path.join('.') || 'muestra'}: ${i.message}`),
      });
      return;
    }
    const s = parsed.data;
    if (opts.expectedRunId && s.run_id && s.run_id !== opts.expectedRunId) {
      quarantined.push({ index, sampleKey: s.sample_key, reasons: ['run_id_distinto'] });
      return;
    }
    if (seen.has(s.sample_key)) {
      duplicates++;
      return;
    }
    seen.add(s.sample_key);
    const endpoint = s.endpoint ? normalizeEndpointForStorage(sanitizeUrl(s.endpoint).value, opts) : null;
    const screenKey = s.screen_key ? normalizeScreenKey(s.screen_key) : null;
    valid.push({
      sampleKey: s.sample_key,
      schemaVersion: s.schema_version,
      ts: s.ts,
      provenance: s.provenance,
      source: s.source,
      metricKind: s.metric_kind,
      endpoint,
      endpointKey: seriesEndpointKey({ endpoint: s.endpoint, method: s.method, screenKey, metricKind: s.metric_kind }),
      screenKey,
      method: s.method ? s.method.toUpperCase() : null,
      statusCode: s.status_code,
      ok: s.ok,
      totalMs: s.total_ms,
      ttfbMs: s.ttfb_ms,
      downloadMs: s.download_ms,
      bytesWire: s.bytes_wire,
      bytesBody: s.bytes_body,
      timeout: s.timeout,
      censored: s.censored,
      censoredAtMs: s.censored_at_ms,
      timeoutLimitMs: s.timeout_limit_ms,
      networkError: s.error_kind === 'red',
      errorKind: s.error_kind,
      over29s: isOver29s({ timeout: s.timeout, totalMs: s.total_ms, networkError: s.error_kind === 'red' }),
      visible: s.visible,
      cacheMode: s.cache_mode ?? 'desconocida',
      workerProfile: s.worker_profile ?? meta.worker_profile,
      invalidReason: s.invalid_reason,
      contentEncoding: s.content_encoding,
      nullReasons: s.null_reasons,
    });
  });

  return {
    ok: true,
    fileError: null,
    header: meta,
    valid,
    quarantined,
    producerQuarantined: meta.quarantine.length,
    duplicates,
  };
}

/** Valida `summary.json`. */
export function parsePerfSummary(raw: unknown): { ok: true; summary: PerfSummaryFile } | { ok: false; error: string } {
  const r = PerfSummaryFileSchema.safeParse(raw);
  return r.success
    ? { ok: true, summary: r.data }
    : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
}
