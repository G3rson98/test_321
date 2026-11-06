/** Suites guardadas (RF-CAT-03). Dinámicas para corridas futuras; las corridas aceptadas son inmutables (ESP §13.1). */
import { z } from 'zod';
import { CursorQuerySchema, IsoDateTimeSchema, sortQuerySchema, UuidSchema, VersionSchema } from './common.js';
import { SuiteSelectorSchema } from './selection.js';

export const SuiteSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  selector: SuiteSelectorSchema,
  createdBy: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
  version: VersionSchema,
  /** Conteos resueltos al momento de la consulta (informativos). */
  resolved: z.object({ cases: z.number().int().nonnegative(), tests: z.number().int().nonnegative() }).optional(),
});
export type Suite = z.infer<typeof SuiteSchema>;

export const SuiteCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  selector: SuiteSelectorSchema,
});
export type SuiteCreate = z.infer<typeof SuiteCreateSchema>;

export const SuiteUpdateSchema = SuiteCreateSchema.extend({ version: VersionSchema });
export type SuiteUpdate = z.infer<typeof SuiteUpdateSchema>;

export const SuiteListQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  sort: sortQuerySchema(['name', 'updatedAt'] as const, 'name'),
});
