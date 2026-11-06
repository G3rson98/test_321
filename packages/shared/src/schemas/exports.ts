/**
 * Exportaciones CSV/PDF en servidor con los mismos permisos/filtros; página vs. conjunto completo explícito
 * (ESP §17.3). Grandes exportaciones como trabajo con archivo privado y vencimiento (ESP §17.4). RF-RES-04.
 */
import { z } from 'zod';
import { ExportFormatSchema, JobStatusSchema } from '../enums.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';

export const EXPORT_MAX_ROWS = 50_000;

export const ExportCreateSchema = z.object({
  format: ExportFormatSchema,
  scope: z.enum(['runs', 'run_results', 'case_results', 'audit_log', 'perf']),
  /** Filtros del listado de origen (validados por el endpoint con el esquema del listado). */
  filters: z.record(z.string(), z.unknown()).default({}),
  /** `pagina`: solo la página indicada por `cursor`/`limit`; `completo`: todo el conjunto filtrado. */
  extent: z.enum(['pagina', 'completo']),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  runId: UuidSchema.optional(),
});
export type ExportCreate = z.infer<typeof ExportCreateSchema>;

export const ExportJobSchema = z.object({
  id: UuidSchema,
  format: ExportFormatSchema,
  scope: z.string(),
  extent: z.enum(['pagina', 'completo']),
  status: JobStatusSchema,
  rowCount: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type ExportJob = z.infer<typeof ExportJobSchema>;

export const ExportDownloadResponseSchema = z.object({ url: z.string(), expiresAt: IsoDateTimeSchema });
