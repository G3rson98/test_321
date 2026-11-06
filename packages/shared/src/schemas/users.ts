/**
 * Usuarios del panel (RF-USR-01, RF-USR-02). Correos normalizados únicos; borrado lógico vía `disabledAt` (ESP §7).
 */
import { z } from 'zod';
import { PanelRoleSchema } from '../enums.js';
import { CursorQuerySchema, IsoDateTimeSchema, UuidSchema, sortQuerySchema, VersionSchema } from './common.js';
import { EmailSchema } from './auth.js';

export const PanelUserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  name: z.string(),
  role: PanelRoleSchema,
  /** `true` si usa auth propia (hash presente). El hash nunca sale de la BD. */
  hasLocalPassword: z.boolean(),
  authSubject: z.string().nullable(),
  disabledAt: IsoDateTimeSchema.nullable(),
  lastLoginAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: VersionSchema,
});
export type PanelUser = z.infer<typeof PanelUserSchema>;

export const PanelUserCreateSchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(120),
  role: PanelRoleSchema,
  /** Si se omite, se envía invitación/recuperación; nunca se devuelve la contraseña. */
  initialPassword: z.string().min(12).max(1024).optional(),
});
export type PanelUserCreate = z.infer<typeof PanelUserCreateSchema>;

export const PanelUserUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: PanelRoleSchema.optional(),
  disabled: z.boolean().optional(),
  version: VersionSchema,
});
export type PanelUserUpdate = z.infer<typeof PanelUserUpdateSchema>;

export const PanelUserListQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  role: PanelRoleSchema.optional(),
  includeDisabled: z.coerce.boolean().default(false),
  sort: sortQuerySchema(['email', 'name', 'createdAt'] as const, 'email'),
});
