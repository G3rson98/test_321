/**
 * Canales de notificación (correo SMTP, Slack/Teams webhook; elección pendiente ESP §12) y preferencias por usuario.
 * Webhooks y credenciales SMTP son secretos: solo `secretRef`. RF-NOT-01, RF-NOT-02, RF-NOT-03.
 */
import { z } from 'zod';
import { NotificationChannelKindSchema, NotificationEventSchema } from '../enums.js';
import { IsoDateTimeSchema, SecretRefSchema, UuidSchema, VersionSchema } from './common.js';
import { EmailSchema } from './auth.js';

export const NotificationChannelSchema = z.object({
  kind: NotificationChannelKindSchema,
  enabled: z.boolean(),
  /** Webhook (Slack/Teams) o credencial SMTP por referencia. */
  secretRef: SecretRefSchema.nullable(),
  /** Correo: destinatarios por defecto del equipo. */
  recipients: z.array(z.string()),
  /** Correo: remitente y host SMTP (no secretos). */
  smtp: z.object({ host: z.string(), port: z.number().int(), from: z.string(), secure: z.boolean() }).nullable(),
  lastTestAt: IsoDateTimeSchema.nullable(),
  lastTestOk: z.boolean().nullable(),
  updatedAt: IsoDateTimeSchema,
  version: VersionSchema,
});
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationChannelParamsSchema = z.object({ kind: NotificationChannelKindSchema });

export const NotificationChannelUpdateSchema = z.object({
  enabled: z.boolean(),
  secretRef: SecretRefSchema.nullable().optional(),
  recipients: z.array(EmailSchema).max(100).optional(),
  smtp: z
    .object({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      from: EmailSchema,
      secure: z.boolean().default(true),
    })
    .nullable()
    .optional(),
  version: VersionSchema.optional(),
});

export const NotificationChannelTestResponseSchema = z.object({
  ok: z.boolean(),
  /** Entrega ambigua (canal sin confirmación idempotente) se registra como tal (ESP §13.8). */
  ambiguous: z.boolean(),
  message: z.string(),
});

/** Preferencias del usuario autenticado (RF-NOT-03). */
export const NotificationPreferencesSchema = z.object({
  userId: UuidSchema,
  channels: z.array(NotificationChannelKindSchema),
  events: z.array(NotificationEventSchema),
  /** Vacío = ninguna programación; `allSchedules` = todas. */
  scheduleIds: z.array(UuidSchema),
  allSchedules: z.boolean(),
  thresholdIds: z.array(UuidSchema),
  allThresholds: z.boolean(),
  updatedAt: IsoDateTimeSchema,
  version: VersionSchema,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const NotificationPreferencesUpdateSchema = z.object({
  channels: z.array(NotificationChannelKindSchema).max(3),
  events: z.array(NotificationEventSchema),
  scheduleIds: z.array(UuidSchema).max(500).default([]),
  allSchedules: z.boolean().default(false),
  thresholdIds: z.array(UuidSchema).max(500).default([]),
  allThresholds: z.boolean().default(false),
  version: VersionSchema.optional(),
});
