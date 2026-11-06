/**
 * Registro de auditoría (RF-USR-02): quién ejecutó, programó, aprobó o cambió configuraciones.
 * `diff` sanitizado: nunca contiene secretos (solo referencias).
 */
import { z } from 'zod';
import { ActorKindSchema } from '../enums.js';
import { CursorQuerySchema, IsoDateTimeSchema, UuidSchema } from './common.js';

/** Acciones auditadas: `<entidad>.<verbo>` en minúsculas. */
export const AUDIT_ACTION_REGEX = /^[a-z_]+\.[a-z_]+$/;
export const AuditActionSchema = z.string().regex(AUDIT_ACTION_REGEX).max(64);

/** Acciones conocidas (lista abierta; nuevas acciones deben seguir el formato). */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_reset',
  'api_token.create',
  'api_token.revoke',
  'panel_user.create',
  'panel_user.update',
  'panel_user.disable',
  'testrail_connection.update',
  'testrail_connection.test',
  'testrail.sync',
  'catalog.refresh',
  'test_case_link.review',
  'suite.create',
  'suite.update',
  'suite.delete',
  'run.create',
  'run.cancel',
  'schedule.create',
  'schedule.update',
  'schedule.pause',
  'schedule.resume',
  'schedule.duplicate',
  'schedule.delete',
  'exclusion_window.create',
  'exclusion_window.delete',
  'environment.create',
  'environment.update',
  'test_user.create',
  'test_user.update',
  'perf_threshold.create',
  'perf_threshold.update',
  'event_mark.create',
  'notification_channel.update',
  'notification_preference.update',
  'outbox_delivery.retry',
  'outbox_delivery.resolve',
  'recording.create',
  'recording.complete',
  'recording.cancel',
  'device.approve',
  'device.revoke',
  'generation.create',
  'export.create',
  'runtime_setting.update',
] as const;

export const AuditEntrySchema = z.object({
  id: UuidSchema,
  actorKind: ActorKindSchema,
  actorId: UuidSchema.nullable(),
  actorDisplay: z.string(),
  action: AuditActionSchema,
  entity: z.string(),
  entityId: z.string().nullable(),
  diff: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditListQuerySchema = CursorQuerySchema.extend({
  actorId: UuidSchema.optional(),
  action: AuditActionSchema.optional(),
  entity: z.string().max(64).optional(),
  entityId: z.string().max(128).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;
