/**
 * Primitivas comunes de los DTO /api/v1: UUID, instantes, paginación por cursor (ESP §9, §17.3), etiquetas, IDs de caso.
 * RNF-OPT-02, RNF-SEG-03.
 */
import { z } from 'zod';

export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** Instante ISO-8601 con zona (`Z` u offset). Todos los instantes se guardan en UTC (ESP §7). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Referencia de caso TestRail en títulos/manifiesto: `C1234`. */
export const CASE_REF_REGEX = /^C[1-9]\d*$/;
export const CaseRefSchema = z.string().regex(CASE_REF_REGEX, 'Formato de caso esperado: C<número>');
export type CaseRef = z.infer<typeof CaseRefSchema>;

/** Etiqueta Playwright: `@oc`, `@agendamiento`, `@humo`… */
export const TAG_REGEX = /^@[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TagSchema = z.string().regex(TAG_REGEX, 'Etiqueta esperada: @nombre');
export type Tag = z.infer<typeof TagSchema>;

/** Clave de variante/parámetro; `default` para tests sin parámetros (ESP §7). */
export const PARAMETER_KEY_REGEX = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const ParameterKeySchema = z.string().regex(PARAMETER_KEY_REGEX);
export const DEFAULT_PARAMETER_KEY = 'default';

/** SHA completo de commit Git (40 hex SHA-1 o 64 hex SHA-256). Nunca una rama (ESP §13.1). */
export const GitCommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Hash SHA-256 hex en minúsculas. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Zona IANA (validada con Intl en tiempo de ejecución). Default `America/La_Paz` (RNF-USA-01). */
export const DEFAULT_TIMEZONE = 'America/La_Paz';
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const TimeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, { message: 'TIMEZONE_INVALID' });

/**
 * Referencia de secreto (`secret_ref`), nunca el valor (ESP §7, §13.7).
 * Formatos: `env:NOMBRE`, `file:/ruta/absoluta`, `ssm:/prefijo/nombre`.
 */
export const SECRET_REF_REGEX =
  /^(?:env:[A-Z][A-Z0-9_]{0,127}|file:\/[A-Za-z0-9_./-]{1,255}|ssm:\/[A-Za-z0-9_./-]{1,1011})$/;
export const SecretRefSchema = z
  .string()
  .regex(SECRET_REF_REGEX, 'SECRET_REF_INVALID')
  .refine((v) => !v.includes('..'), { message: 'SECRET_REF_INVALID' });
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** URL http(s) (la allowlist de hosts y protección SSRF se aplican en backend, ESP §13.7). */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const NonEmptyTrimmedString = (max = 200) => z.string().trim().min(1).max(max);

/** Lista no vacía y sin duplicados (ESP §9). */
export function uniqueNonEmptyArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .min(1, { message: 'SELECTION_EMPTY' })
    .max(max, { message: 'SELECTION_TOO_LARGE' })
    .refine((arr) => new Set(arr.map((v) => JSON.stringify(v))).size === arr.length, {
      message: 'SELECTION_DUPLICATES',
    });
}

// ---------------------------------------------------------------------------
// Paginación por cursor (ESP §17.3)
// ---------------------------------------------------------------------------

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;
export const PAGE_LIMIT_OPTIONS = [25, 50, 100] as const;

export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

/** Orden: `campo` asc o `-campo` desc; las claves permitidas las fija cada endpoint. Desempate por UUID. */
export function sortQuerySchema<const K extends readonly [string, ...string[]]>(keys: K, defaultSort: string) {
  const allowed = keys.flatMap((k) => [k, `-${k}`]) as [string, ...string[]];
  return z.enum(allowed).default(defaultSort);
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item).max(PAGE_LIMIT_MAX),
    nextCursor: z.string().nullable(),
    hasNext: z.boolean(),
    total: z.number().int().nonnegative().optional(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
  total?: number;
}

/** Codifica un cursor opaco (base64url de JSON). La API puede firmarlo; aquí solo el formato. */
export function encodeCursor(value: Record<string, string | number | null>): string {
  const json = JSON.stringify(value);
  let bin = '';
  for (const byte of new TextEncoder().encode(json)) bin += String.fromCharCode(byte);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): Record<string, string | number | null> | null {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, string | number | null>;
  } catch {
    return null;
  }
}

/** Respuesta `{ ok: true }` de operaciones sin cuerpo. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });

/** Parámetro de ruta `{id}`. */
export const IdParamsSchema = z.object({ id: UuidSchema });

/** Encabezado Idempotency-Key (ESP §9): 8..128 caracteres seguros. */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** Versión para concurrencia optimista (ESP §17.1: si la versión remota cambió, reconciliar). */
export const VersionSchema = z.number().int().nonnegative();

/** Referencia mínima a un actor para mostrar en UI (sin correo si no hay permiso). */
export const ActorRefSchema = z.object({
  id: UuidSchema.nullable(),
  kind: z.enum(['panel_user', 'api_credential', 'servicio', 'sistema']),
  displayName: z.string(),
});
export type ActorRef = z.infer<typeof ActorRefSchema>;
