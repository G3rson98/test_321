/**
 * Eventos en vivo por SSE (plan §4.4, ESP §9, §17.2). Un canal por pestaña, sesión por cookie, `Last-Event-ID`,
 * secuencia persistida en `event_log`. Eventos sanitizados; no son fuente de verdad (ESP §13.2).
 * RF-EJE-02, RNF-OPT-04.
 */
import { z } from 'zod';
import { EventEntitySchema, EventTypeSchema, RunOutcomeSchema, RunStatusSchema, SyncStatusSchema } from '../enums.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { StatusCountsSchema } from './runs.js';

/** Envoltorio de evento de dominio. `id` SSE = `seq` como texto. */
export const DomainEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  type: EventTypeSchema,
  entity: EventEntitySchema,
  entityId: UuidSchema,
  /** Versión de la entidad para descartar duplicados/antiguos. */
  version: z.number().int().nonnegative(),
  occurredAt: IsoDateTimeSchema,
  /** Corrida relacionada (para filtrar por recurso). */
  runId: UuidSchema.nullable(),
  environmentId: UuidSchema.nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/** Datos típicos de `run.updated`. */
export const RunUpdatedDataSchema = z.object({
  status: RunStatusSchema,
  outcome: RunOutcomeSchema.nullable(),
  syncStatus: SyncStatusSchema,
  counts: StatusCountsSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  cancelRequestedAt: IsoDateTimeSchema.nullable(),
});

/** Eventos de control del canal (no de dominio). */
export const SSE_CONTROL_EVENTS = ['snapshot', 'ping', 'reset'] as const;
export type SseControlEvent = (typeof SSE_CONTROL_EVENTS)[number];

/** `snapshot` tras conectar/reconectar: última secuencia y entidades activas visibles. */
export const SseSnapshotSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  activeRunIds: z.array(UuidSchema),
  serverTime: IsoDateTimeSchema,
});

/** `reset`: el `Last-Event-ID` es demasiado antiguo (retención de `event_log`); el cliente debe refetch. */
export const SseResetSchema = z.object({
  reason: z.enum(['last_event_id_expirado', 'permisos_cambiaron']),
  lastSeq: z.number().int(),
});

/** `GET /events/stream`: filtros opcionales por tema; sin tokens en query string. */
export const EventStreamQuerySchema = z.object({
  topics: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')))
    .pipe(
      z.array(z.enum(['runs', 'schedules', 'alerts', 'catalog', 'testrail', 'recordings', 'exports', 'generation'])),
    )
    .optional(),
});

export const RunEventsParamsSchema = z.object({ id: UuidSchema });
export const EVENT_LOG_RETENTION_HOURS = 24;
export const SSE_PING_INTERVAL_MS = 25_000;
