/**
 * Programaciones (ESP §7, §9, §13.5). El editor visual genera crons (ver `@katalyst/shared/schedule`).
 * RF-PRG-01, RF-PRG-02, RF-PRG-03, RF-PRG-04, RF-PRG-05.
 */
import { z } from 'zod';
import { NotificationChannelKindSchema, OccurrenceSkipReasonSchema, OccurrenceStatusSchema } from '../enums.js';
import {
  ActorRefSchema,
  CursorQuerySchema,
  DEFAULT_TIMEZONE,
  IsoDateTimeSchema,
  sortQuerySchema,
  TimeZoneSchema,
  UuidSchema,
  VersionSchema,
} from './common.js';
import { RunSelectionSchema, SelectionFieldsShape, refineExactlyOneSelection } from './selection.js';
import { RetriesSchema } from './runs.js';
import { MAX_CRON_EXPRESSIONS } from '../schedule/validate.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Formato HH:MM');
const DaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'Días duplicados');

/** Entrada del editor visual (RF-PRG-02). Días: 0 = domingo … 6 = sábado. */
export const ScheduleEditorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('hora_fija'), days: DaysSchema, times: z.array(HHMM).min(1).max(96) }),
  z.object({
    mode: z.literal('intervalo'),
    days: DaysSchema,
    start: HHMM,
    end: HHMM,
    everyMinutes: z.number().int().min(1).max(1440),
    /** Obligatorio si start > end (cruza medianoche). */
    overnightDays: DaysSchema.optional(),
  }),
]);
export type ScheduleEditor = z.infer<typeof ScheduleEditorSchema>;

export const CronExpressionsSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_CRON_EXPRESSIONS);

export const ScheduleNotifySchema = z.object({
  onFailure: z.boolean().default(true),
  onInterruption: z.boolean().default(true),
  channels: z.array(NotificationChannelKindSchema).default([]),
});

const scheduleShape = {
  name: z.string().trim().min(1).max(120),
  ...SelectionFieldsShape,
  environmentId: UuidSchema,
  timezone: TimeZoneSchema.default(DEFAULT_TIMEZONE),
  retries: RetriesSchema,
  enabled: z.boolean().default(true),
  notify: ScheduleNotifySchema.default({ onFailure: true, onInterruption: true, channels: [] }),
  /** Exactamente uno: editor visual (preferido) o expresiones avanzadas. */
  editor: ScheduleEditorSchema.optional(),
  cronExpressions: CronExpressionsSchema.optional(),
};

function refineSchedule(
  v: { editor?: unknown; cronExpressions?: unknown; suiteId?: string; caseIds?: string[]; tags?: string[] },
  ctx: z.RefinementCtx,
) {
  refineExactlyOneSelection(v, ctx);
  if ((v.editor === undefined) === (v.cronExpressions === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'CRON_INVALID',
      path: ['cronExpressions'],
      params: { code: 'CRON_INVALID' },
    });
  }
}

export const ScheduleCreateSchema = z.object(scheduleShape).superRefine(refineSchedule);
export type ScheduleCreate = z.infer<typeof ScheduleCreateSchema>;

/** Edición: afecta ocurrencias futuras y corridas no iniciadas; incrementa `revision` (ESP §13.5). */
export const ScheduleUpdateSchema = z
  .object({ ...scheduleShape, revision: z.number().int().positive() })
  .superRefine(refineSchedule);
export type ScheduleUpdate = z.infer<typeof ScheduleUpdateSchema>;

export const ScheduleSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  suiteId: UuidSchema.nullable(),
  selector: RunSelectionSchema,
  environmentId: UuidSchema,
  cronExpressions: z.array(z.string()),
  editor: ScheduleEditorSchema.nullable(),
  description: z.string().nullable(),
  timezone: z.string(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  enabled: z.boolean(),
  pausedAt: IsoDateTimeSchema.nullable(),
  retries: z.number().int().min(0).max(2),
  notify: ScheduleNotifySchema,
  revision: z.number().int().positive(),
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
  nextOccurrence: IsoDateTimeSchema.nullable(),
  lastOccurrence: z
    .object({
      scheduledFor: IsoDateTimeSchema,
      status: OccurrenceStatusSchema,
      reason: OccurrenceSkipReasonSchema.nullable(),
      runId: UuidSchema.nullable(),
    })
    .nullable(),
  version: VersionSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  enabled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().trim().max(120).optional(),
  sort: sortQuerySchema(['name', 'createdAt', 'updatedAt'] as const, 'name'),
});

export const PreviewOccurrenceSchema = z.object({ at: IsoDateTimeSchema, local: z.string() });

/** `GET /schedules/{id}/next?count=5`. */
export const ScheduleNextQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(50).default(5),
  after: IsoDateTimeSchema.optional(),
});
export const ScheduleNextResponseSchema = z.object({
  timezone: z.string(),
  revision: z.number().int().positive(),
  occurrences: z.array(PreviewOccurrenceSchema),
});

/** `POST /schedules/preview`: vista previa sin guardar (misma política DST que admisión). */
export const SchedulePreviewRequestSchema = z
  .object({
    editor: ScheduleEditorSchema.optional(),
    cronExpressions: CronExpressionsSchema.optional(),
    timezone: TimeZoneSchema.default(DEFAULT_TIMEZONE),
    count: z.number().int().min(1).max(50).default(5),
    after: IsoDateTimeSchema.optional(),
  })
  .refine((v) => (v.editor === undefined) !== (v.cronExpressions === undefined), { message: 'CRON_INVALID' });
export const SchedulePreviewResponseSchema = z.object({
  cronExpressions: z.array(z.string()),
  description: z.string().nullable(),
  timezone: z.string(),
  occurrences: z.array(PreviewOccurrenceSchema),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const ScheduleRevisionSchema = z.object({
  scheduleId: UuidSchema,
  revision: z.number().int().positive(),
  changedBy: ActorRefSchema,
  changedAt: IsoDateTimeSchema,
  action: z.enum(['create', 'update', 'pause', 'resume', 'delete', 'duplicate']),
  diff: z.record(z.string(), z.unknown()),
});

export const ScheduleOccurrenceSchema = z.object({
  id: UuidSchema,
  scheduleId: UuidSchema,
  scheduleRevision: z.number().int().positive(),
  scheduledFor: IsoDateTimeSchema,
  status: OccurrenceStatusSchema,
  reason: OccurrenceSkipReasonSchema.nullable(),
  runId: UuidSchema.nullable(),
  /** Retraso de admisión (ms) desde el instante previsto (RNF-REN-02). */
  admissionDelayMs: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>;

export const ScheduleOccurrenceListQuerySchema = CursorQuerySchema.extend({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  status: OccurrenceStatusSchema.optional(),
});

export const ScheduleDuplicateRequestSchema = z.object({ name: z.string().trim().min(1).max(120).optional() });

/** Ventanas de exclusión (RF-PRG-05). Global, por ambiente o por programación. */
export const ExclusionWindowSchema = z.object({
  id: UuidSchema,
  environmentId: UuidSchema.nullable(),
  scheduleId: UuidSchema.nullable(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  reason: z.string(),
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
});
export const ExclusionWindowCreateSchema = z
  .object({
    environmentId: UuidSchema.nullable().default(null),
    scheduleId: UuidSchema.nullable().default(null),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .refine((v) => new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(), {
    message: 'endsAt debe ser posterior a startsAt',
    path: ['endsAt'],
  });
export const ExclusionWindowListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  scheduleId: UuidSchema.optional(),
  activeAt: IsoDateTimeSchema.optional(),
});
