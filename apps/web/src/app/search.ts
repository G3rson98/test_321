/**
 * Search params validados con Zod y defaults explícitos (ESP §17.1). La URL guarda filtros compartibles; nunca
 * secretos, selecciones masivas ni datos personales. Valores inválidos caen al default (`.catch`).
 */
import { z } from 'zod';

const limit = z.union([z.literal(25), z.literal(50), z.literal(100)]).default(25).catch(25);
const optStr = (max = 200) => z.string().trim().min(1).max(max).optional().catch(undefined);
const cursor = z.string().min(1).max(512).optional().catch(undefined);
const uuid = z.string().uuid().optional().catch(undefined);

export const loginSearch = z.object({
  redirect: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith('/') && !v.startsWith('//'), 'Solo rutas internas')
    .optional()
    .catch(undefined),
  motivo: z.enum(['expirada', 'salida']).optional().catch(undefined),
});

export const catalogSearch = z.object({
  seccion: uuid,
  /** Etiquetas separadas por coma ("@oc,@humo"), combinadas con OR. */
  etiqueta: z
    .string()
    .max(500)
    .regex(/^@[\w-]+(,@[\w-]+)*$/)
    .optional()
    .catch(undefined),
  q: optStr(200),
  // Estados de `case_result` que acepta `lastResult` en GET /testrail/cases (la API no filtra "sin ejecutar").
  estado: z.enum(['pasado', 'fallido', 'inestable', 'bloqueado']).optional().catch(undefined),
  automatizacion: z.enum(['automatizado', 'sin_test']).optional().catch(undefined),
  sort: z.enum(['title', '-title', 'trCaseId', '-trCaseId', 'syncedAt', '-syncedAt']).default('trCaseId').catch('trCaseId'),
  cursor,
  limit,
});
export type CatalogSearch = z.infer<typeof catalogSearch>;

export const caseSearch = z.object({ grabacion: uuid, test: uuid });

export const runsSearch = z.object({
  ambiente: uuid,
  estado: z
    .enum(['en_cola', 'preparando', 'corriendo', 'finalizando', 'terminada', 'cancelando', 'cancelada', 'interrumpida', 'omitida'])
    .optional()
    .catch(undefined),
  resultado: z.enum(['pasado', 'inestable', 'fallido', 'bloqueado', 'incompleto']).optional().catch(undefined),
  origen: z.enum(['manual', 'programada', 'api']).optional().catch(undefined),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  sort: z.enum(['-createdAt', 'createdAt', '-finishedAt', 'finishedAt']).default('-createdAt').catch('-createdAt'),
  cursor,
  limit,
});
export type RunsSearch = z.infer<typeof runsSearch>;

export const newRunSearch = z.object({
  modo: z.enum(['suite', 'casos', 'etiquetas']).default('suite').catch('suite'),
  suiteId: uuid,
  caseId: uuid,
  /** Corrida de origen para "Repetir fallidos" (la selección se resuelve desde sus resultados). */
  repetir: uuid,
});
export type NewRunSearch = z.infer<typeof newRunSearch>;

export const runDetailSearch = z.object({ resultado: uuid, vista: z.enum(['tests', 'casos']).default('tests').catch('tests') });

export const schedulesSearch = z.object({
  ambiente: uuid,
  activa: z.enum(['si', 'no']).optional().catch(undefined),
  q: optStr(120),
  cursor,
  limit,
});

export const newScheduleSearch = z.object({
  suiteId: uuid,
  modo: z.enum(['suite', 'casos', 'etiquetas']).optional().catch(undefined),
  desde: uuid,
});

export const perfSearch = z.object({
  periodo: z.enum(['hoy', '7d', '30d']).default('hoy').catch('hoy'),
  ambiente: uuid,
  agrupar: z.enum(['hora', 'dia']).optional().catch(undefined),
  comparar: z.enum(['no', 'anterior']).default('no').catch('no'),
});
export type PerfSearch = z.infer<typeof perfSearch>;

export const testrailSearch = z.object({
  estado: z.enum(['pendiente', 'en_proceso', 'entregada', 'requiere_intervencion', 'vencida', 'cancelada']).optional().catch(undefined),
  cursor,
  limit,
});

export const auditSearch = z.object({
  accion: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional().catch(undefined),
  entidad: optStr(64),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  cursor,
  limit,
});

export const testUsersSearch = z.object({ ambiente: uuid });

export const deviceLinkSearch = z.object({
  codigo: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).optional().catch(undefined),
});
