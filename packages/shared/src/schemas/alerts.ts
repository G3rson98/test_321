/** Alertas (umbral de rendimiento, corrida fallida/interrumpida). RF-REN-03, RF-NOT-01, RF-NOT-02. */
import { z } from 'zod';
import { AlertKindSchema, AlertStatusSchema, NotificationChannelKindSchema } from '../enums.js';
import { CursorQuerySchema, IsoDateTimeSchema, UuidSchema } from './common.js';

export const AlertSchema = z.object({
  id: UuidSchema,
  kind: AlertKindSchema,
  environmentId: UuidSchema.nullable(),
  thresholdId: UuidSchema.nullable(),
  runId: UuidSchema.nullable(),
  fingerprint: z.string(),
  status: AlertStatusSchema,
  channel: NotificationChannelKindSchema.nullable(),
  /** Datos sanitizados: valor observado, límite, n, ventana, enlace autenticado. */
  payload: z.record(z.string(), z.unknown()),
  lastSentAt: IsoDateTimeSchema.nullable(),
  recoveredAt: IsoDateTimeSchema.nullable(),
  sendCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  kind: AlertKindSchema.optional(),
  status: AlertStatusSchema.optional(),
  thresholdId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
