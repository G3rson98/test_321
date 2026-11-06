/**
 * Rendimiento DXMon: agregados, errores puntuales, umbrales y marcas de eventos (ESP §9, §13.8).
 * RF-REN-02, RF-REN-03, RF-REN-04, RF-REN-05.
 */
import { z } from 'zod';
import {
  CacheModeSchema,
  PerfGranularitySchema,
  PerfMetricKindSchema,
  PerfMetricSchema,
  PerfProvenanceSchema,
  PerfSourceSchema,
} from '../enums.js';
import { ActorRefSchema, CursorQuerySchema, IsoDateTimeSchema, UuidSchema, VersionSchema } from './common.js';
import { METRIC_MIN_SAMPLES_FLOOR, METRIC_UNIT } from '../perf/stats.js';

/** `GET /perf?endpoint=&from=&to=&by=hour` (+ dimensiones de serie). */
export const PerfQuerySchema = z
  .object({
    environmentId: UuidSchema,
    endpoint: z.string().max(500).optional(),
    screen: z.string().max(200).optional(),
    provenance: PerfProvenanceSchema.optional(),
    source: PerfSourceSchema.optional(),
    metricKind: PerfMetricKindSchema.optional(),
    cacheMode: CacheModeSchema.optional(),
    workerProfile: z.string().max(100).optional(),
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    by: PerfGranularitySchema.default('hour'),
    /** Comparación con el período anterior de igual duración (RF-REN-02). */
    compare: z.enum(['none', 'previous_period']).default('none'),
  })
  .refine((q) => new Date(q.to).getTime() > new Date(q.from).getTime(), {
    message: 'to debe ser posterior a from',
    path: ['to'],
  });
export type PerfQuery = z.infer<typeof PerfQuerySchema>;

const nullableMs = z.number().nonnegative().nullable();

export const PerfPointSchema = z.object({
  bucketStart: IsoDateTimeSchema,
  started: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  httpErrors: z.number().int().nonnegative(),
  networkErrors: z.number().int().nonnegative(),
  timeouts: z.number().int().nonnegative(),
  over29s: z.number().int().nonnegative(),
  meanMs: nullableMs,
  maxMs: nullableMs,
  /** `null` con `p95Status` ≠ `ok` cuando la muestra es insuficiente o no está disponible fuera de 90 días. */
  p95Ms: nullableMs,
  p95Status: z.enum(['ok', 'muestra_insuficiente', 'no_disponible']),
  errorRate: z.number().min(0).max(1).nullable(),
  timeoutRate: z.number().min(0).max(1).nullable(),
  quality: z.enum(['suficiente', 'insuficiente', 'sin_datos']),
});
export type PerfPoint = z.infer<typeof PerfPointSchema>;

export const PerfSeriesKeySchema = z.object({
  environmentId: UuidSchema,
  endpointKey: z.string(),
  provenance: PerfProvenanceSchema,
  source: PerfSourceSchema,
  metricKind: PerfMetricKindSchema,
  cacheMode: CacheModeSchema,
  workerProfile: z.string().nullable(),
});

export const EventMarkSchema = z.object({
  id: UuidSchema,
  ts: IsoDateTimeSchema,
  label: z.string(),
  environmentId: UuidSchema,
  frontendVersion: z.string().nullable(),
  backendVersion: z.string().nullable(),
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type EventMark = z.infer<typeof EventMarkSchema>;

export const PerfResponseSchema = z.object({
  granularity: PerfGranularitySchema,
  series: z.array(
    z.object({
      key: PerfSeriesKeySchema,
      points: z.array(PerfPointSchema).max(1000),
      comparison: z.array(PerfPointSchema).max(1000).nullable(),
    }),
  ),
  marks: z.array(EventMarkSchema),
  /** Antigüedad del último dato: falta de muestras no equivale a sistema sano (ESP §13.8). */
  lastSampleAt: IsoDateTimeSchema.nullable(),
  gaps: z.array(z.object({ from: IsoDateTimeSchema, to: IsoDateTimeSchema })),
});

/** `GET /perf/series`: catálogo de series disponibles. */
export const PerfSeriesListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema,
  q: z.string().max(200).optional(),
});

/** RF-REN-05: errores HTTP, timeouts y > 29 s con hora exacta. */
export const PerfErrorsQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema,
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  kind: z.enum(['http_error', 'network_error', 'timeout', 'over_29s']).optional(),
  endpoint: z.string().max(500).optional(),
});
export const PerfErrorItemSchema = z.object({
  id: UuidSchema,
  ts: IsoDateTimeSchema,
  runId: UuidSchema,
  endpointKey: z.string(),
  provenance: PerfProvenanceSchema,
  source: PerfSourceSchema,
  kind: z.enum(['http_error', 'network_error', 'timeout', 'over_29s']),
  statusCode: z.number().int().nullable(),
  totalMs: nullableMs,
  censoredAtMs: nullableMs,
});

/** Selector de UNA serie (ESP §7: "selector de una sola serie y unidades explícitas"). */
export const SeriesSelectorSchema = z.object({
  endpointKey: z.string().min(1).max(500),
  /** No mezclar DXMon y Playwright (ESP §13.8, D-016). */
  provenance: PerfProvenanceSchema,
  source: PerfSourceSchema,
  metricKind: PerfMetricKindSchema,
  cacheMode: CacheModeSchema,
  workerProfile: z.string().max(100).nullable(),
});

const thresholdBase = {
  environmentId: UuidSchema,
  seriesSelector: SeriesSelectorSchema,
  metric: PerfMetricSchema,
  /** ms para p95/max; razón 0..1 para error_rate/timeout_rate. */
  limit: z.number().nonnegative(),
  windowMin: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60),
  minSamples: z.number().int().min(1),
  enabled: z.boolean().default(true),
  label: z.string().trim().max(200).optional(),
};

function refineThreshold(
  v: { metric: z.infer<typeof PerfMetricSchema>; limit: number; minSamples: number },
  ctx: z.RefinementCtx,
) {
  if (v.minSamples < METRIC_MIN_SAMPLES_FLOOR[v.metric]) {
    ctx.addIssue({
      code: 'custom',
      path: ['minSamples'],
      message: 'THRESHOLD_MIN_SAMPLES',
      params: { code: 'THRESHOLD_MIN_SAMPLES', floor: METRIC_MIN_SAMPLES_FLOOR[v.metric] },
    });
  }
  if (METRIC_UNIT[v.metric] === 'ratio' && v.limit > 1) {
    ctx.addIssue({ code: 'custom', path: ['limit'], message: 'Las tasas se expresan como razón 0..1' });
  }
}

export const PerfThresholdCreateSchema = z.object(thresholdBase).superRefine(refineThreshold);
export type PerfThresholdCreate = z.infer<typeof PerfThresholdCreateSchema>;
export const PerfThresholdUpdateSchema = z
  .object({ ...thresholdBase, version: VersionSchema })
  .superRefine(refineThreshold);

export const PerfThresholdSchema = z.object({
  id: UuidSchema,
  ...thresholdBase,
  unit: z.enum(['ms', 'ratio']),
  label: z.string().nullable(),
  lastEvaluation: z
    .object({
      at: IsoDateTimeSchema,
      state: z.enum(['superado', 'normal', 'insuficiente']),
      value: z.number().nullable(),
      n: z.number().int(),
    })
    .nullable(),
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: VersionSchema,
});
export type PerfThreshold = z.infer<typeof PerfThresholdSchema>;

export const PerfThresholdListQuerySchema = CursorQuerySchema.extend({ environmentId: UuidSchema.optional() });

/** `POST /events` (marca de despliegue/cambio, RF-REN-04). */
export const EventMarkCreateSchema = z.object({
  ts: IsoDateTimeSchema,
  label: z.string().trim().min(1).max(200),
  environmentId: UuidSchema,
  frontendVersion: z.string().trim().max(100).optional(),
  backendVersion: z.string().trim().max(100).optional(),
});
export const EventMarkListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});

/** `GET /perf/series` → `items[]`: clave de serie + conteo y último dato (API-C, D-025). */
export const PerfSeriesItemSchema = PerfSeriesKeySchema.extend({
  sampleCount: z.number().int().nonnegative(),
  lastSampleAt: IsoDateTimeSchema,
});
export type PerfSeriesItem = z.infer<typeof PerfSeriesItemSchema>;
