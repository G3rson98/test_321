/**
 * Catálogo de códigos de error estables de la API /api/v1 (ESP §9: `{ error: { code, message, requestId, details? } }`).
 * 401 sin autenticación, 403 sin permiso, 404 inexistente/no visible, 409 conflicto, 422 regla de negocio, 429 límite.
 * Los códigos son contrato público: no renombrar; solo agregar.
 *
 * RNF-SEG-03, RF-EJE-01, RF-EJE-06, RF-EJE-08, RF-PRG-01.
 */
import { z } from 'zod';

interface ErrorDef {
  readonly status: number;
  /** Mensaje por defecto en español, sin datos sensibles. */
  readonly message: string;
}

export const ERROR_CATALOG = {
  // Genéricos
  BAD_REQUEST: { status: 400, message: 'Solicitud mal formada.' },
  VALIDATION_FAILED: { status: 422, message: 'La solicitud no cumple el esquema.' },
  UNAUTHENTICATED: { status: 401, message: 'Se requiere autenticación.' },
  SESSION_EXPIRED: { status: 401, message: 'La sesión venció; vuelve a iniciar sesión.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Credenciales inválidas.' },
  TOKEN_REVOKED: { status: 401, message: 'La credencial fue revocada o venció.' },
  FORBIDDEN: { status: 403, message: 'No tienes permiso para esta operación.' },
  CSRF_INVALID: { status: 403, message: 'Token CSRF ausente o inválido.' },
  USER_DISABLED: { status: 403, message: 'El usuario está deshabilitado.' },
  NOT_FOUND: { status: 404, message: 'Recurso inexistente o no visible.' },
  ROUTE_NOT_FOUND: { status: 404, message: 'Ruta inexistente.' },
  CONFLICT: { status: 409, message: 'Conflicto con el estado actual del recurso.' },
  VERSION_CONFLICT: { status: 409, message: 'El recurso cambió desde que lo leíste; recarga antes de guardar.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'El contenido excede el tamaño permitido.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Tipo de contenido no soportado.' },
  RATE_LIMITED: { status: 429, message: 'Demasiadas solicitudes; intenta más tarde.' },
  INTERNAL_ERROR: { status: 500, message: 'Error interno.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Servicio no disponible temporalmente.' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'Una dependencia (BD/cola) no está disponible.' },

  // Idempotencia (ESP §9)
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: 'Falta el encabezado Idempotency-Key.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'La misma Idempotency-Key se usó con un cuerpo distinto.' },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: 'Una solicitud con la misma Idempotency-Key está en proceso.' },

  // Selección y plan (ESP §9, §13.1)
  SELECTION_EMPTY: { status: 422, message: 'La selección no resuelve ningún caso ni test.' },
  SELECTION_EXCLUSIVE: { status: 422, message: 'Indica exactamente uno de suiteId, caseIds o tags.' },
  SELECTION_DUPLICATES: { status: 422, message: 'La selección contiene elementos duplicados.' },
  SELECTION_TOO_LARGE: { status: 422, message: 'La selección explícita supera el máximo de 500 casos.' },
  SELECTION_FOREIGN_IDS: { status: 422, message: 'La selección contiene IDs inexistentes o ajenos al proyecto.' },
  CASE_ARCHIVED: { status: 422, message: 'La selección incluye casos archivados.' },
  CATALOG_REVISION_INCOMPLETE: { status: 422, message: 'La revisión del catálogo está incompleta.' },
  MANIFEST_INVALID: { status: 422, message: 'El manifiesto de tests es inválido.' },
  MANIFEST_HASH_MISMATCH: { status: 409, message: 'El hash del manifiesto no coincide con el snapshot.' },
  COMMIT_UNAVAILABLE: { status: 422, message: 'El commit congelado ya no puede obtenerse.' },
  ADMISSION_CONFIG_CHANGED: { status: 409, message: 'La configuración cambió desde la vista previa.' },

  // Ambientes y producción (RF-EJE-06, RNF-SEG-04)
  ENVIRONMENT_DISABLED: { status: 422, message: 'El ambiente está deshabilitado.' },
  PRODUCTION_BLOCKED: { status: 422, message: 'La selección no puede ejecutarse en producción.' },
  RECORDING_PRODUCTION_BLOCKED: { status: 422, message: 'No se permite grabar en producción.' },
  HOST_NOT_ALLOWED: { status: 422, message: 'El host o esquema de la URL no está permitido.' },
  SECRET_REF_INVALID: { status: 422, message: 'La referencia de secreto es inválida.' },

  // Programación (ESP §13.5)
  CRON_INVALID: { status: 422, message: 'Expresión cron inválida.' },
  CRON_INTERVAL_TOO_SHORT: { status: 422, message: 'El intervalo entre ocurrencias es menor al mínimo permitido.' },
  TIMEZONE_INVALID: { status: 422, message: 'Zona horaria IANA inválida.' },
  SCHEDULE_RANGE_CROSSES_MIDNIGHT: {
    status: 422,
    message: 'El rango cruza medianoche: indica explícitamente los días posteriores a medianoche.',
  },
  SCHEDULE_NO_OCCURRENCES: { status: 422, message: 'La programación no produce ninguna ocurrencia.' },

  // Corridas (ESP §13.2, §13.3)
  RUN_NOT_CANCELLABLE: { status: 409, message: 'La corrida ya terminó y no puede cancelarse.' },
  RUN_FINALIZED: { status: 409, message: 'La corrida está en un estado terminal.' },
  CAPACITY_UNAVAILABLE: { status: 503, message: 'Sin capacidad reservada disponible.' },

  // Worker y leases (ESP §13.3, plan §4.3)
  LEASE_STALE: { status: 409, message: 'Lease obsoleto: generación vieja o revocada.' },
  LEASE_EXPIRED: { status: 409, message: 'Lease vencido.' },
  LEASE_NOT_FOUND: { status: 404, message: 'Lease inexistente.' },
  SHARD_NOT_CLAIMABLE: { status: 409, message: 'El shard no está disponible para asignación.' },
  CALLBACK_CONFLICT: { status: 409, message: 'La misma clave de callback se usó con contenido distinto.' },
  ARTIFACT_TOO_LARGE: { status: 413, message: 'El artefacto supera el tamaño permitido.' },
  ARTIFACT_QUOTA_EXCEEDED: { status: 422, message: 'Se agotó la cuota de evidencia de la corrida.' },
  ARTIFACT_CHECKSUM_MISMATCH: { status: 422, message: 'El checksum del artefacto no coincide.' },
  ARTIFACT_NOT_PUBLISHABLE: { status: 422, message: 'El artefacto no está sanitizado y no puede publicarse.' },
  SANITIZATION_FAILED: { status: 422, message: 'El contenido no pudo sanitizarse y fue bloqueado.' },

  // TestRail e integraciones (ESP §8, §13.4)
  TESTRAIL_UNAVAILABLE: { status: 502, message: 'TestRail no respondió.' },
  TESTRAIL_AUTH_FAILED: { status: 502, message: 'TestRail rechazó la autenticación del usuario de servicio.' },
  TESTRAIL_CONNECTION_INVALID: { status: 422, message: 'La configuración de TestRail es inválida.' },
  TESTRAIL_SYNC_IN_PROGRESS: { status: 409, message: 'Ya hay una sincronización en curso.' },
  DELIVERY_NOT_RETRYABLE: { status: 409, message: 'La entrega no está en un estado reintentable.' },
  GIT_PROVIDER_UNAVAILABLE: { status: 502, message: 'La plataforma Git no respondió.' },

  // Usuarios del panel (RF-USR)
  EMAIL_TAKEN: { status: 409, message: 'Ya existe un usuario con ese correo.' },
  LAST_ADMIN: { status: 409, message: 'No puede quitarse el último administrador activo.' },

  // Grabación y dispositivo (ESP §13.6)
  RECORDING_INVALID_STATE: { status: 409, message: 'La grabación no admite esta transición.' },
  RECORDING_EXPIRED: { status: 409, message: 'La sesión de grabación venció.' },
  RECORDING_TOO_LARGE: { status: 413, message: 'El código grabado supera 1 MiB.' },
  RECORDING_REJECTED: { status: 422, message: 'La grabación no supera las validaciones.' },
  SECRET_DETECTED: { status: 422, message: 'Se detectaron secretos en el contenido; fue rechazado.' },
  DEVICE_CODE_INVALID: { status: 400, message: 'Código de dispositivo inválido.' },
  DEVICE_CODE_EXPIRED: { status: 400, message: 'El código de dispositivo venció.' },
  DEVICE_AUTHORIZATION_PENDING: { status: 400, message: 'La autorización del dispositivo sigue pendiente.' },
  DEVICE_SLOW_DOWN: { status: 429, message: 'Consulta demasiado frecuente; espera el intervalo indicado.' },
  DEVICE_ACCESS_DENIED: { status: 403, message: 'La autorización del dispositivo fue denegada.' },

  // Rendimiento (ESP §13.8)
  PERF_IMPORT_INVALID: { status: 422, message: 'El archivo DXMon no cumple el contrato de importación.' },
  PERF_RANGE_TOO_LARGE: { status: 422, message: 'El rango solicitado supera el máximo de puntos por serie.' },
  THRESHOLD_MIN_SAMPLES: { status: 422, message: 'min_samples no puede ser menor al piso de la métrica.' },
  THRESHOLD_SERIES_INVALID: { status: 422, message: 'El selector debe identificar exactamente una serie.' },

  // Notificaciones, IA y exportaciones
  CHANNEL_NOT_CONFIGURED: { status: 422, message: 'El canal de notificación no está configurado.' },
  AI_DISABLED: { status: 422, message: 'La generación con IA no está habilitada.' },
  AI_BUDGET_EXCEEDED: { status: 429, message: 'Se agotó el presupuesto de IA.' },
  AI_PROVIDER_UNAVAILABLE: { status: 502, message: 'El proveedor de IA no respondió.' },
  EXPORT_TOO_LARGE: { status: 422, message: 'La exportación supera el límite; usa una exportación diferida.' },
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CATALOG[code].status;
}

export function defaultMessageFor(code: ErrorCode): string {
  return ERROR_CATALOG[code].message;
}

/** Detalle de validación sanitizado (sin valores recibidos). */
export const ValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Cuerpo de error uniforme de toda la API (ESP §9). */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z
      .object({
        issues: z.array(ValidationIssueSchema).optional(),
        reasons: z.array(z.string()).optional(),
        retryAfterSeconds: z.number().int().nonnegative().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
export type ApiErrorDetails = NonNullable<ApiErrorBody['error']['details']>;

/** Error de dominio portable (sin IO). La API lo transforma en `ApiErrorBody`. */
export class KatalystError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetails | undefined;

  constructor(code: ErrorCode, message?: string, details?: ApiErrorDetails) {
    super(message ?? defaultMessageFor(code));
    this.name = 'KatalystError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.details = details;
  }
}

export function isKatalystError(e: unknown): e is KatalystError {
  return e instanceof KatalystError;
}

export function toApiErrorBody(
  code: ErrorCode,
  requestId: string,
  message?: string,
  details?: ApiErrorDetails,
): ApiErrorBody {
  return {
    error: {
      code,
      message: message ?? defaultMessageFor(code),
      requestId,
      ...(details ? { details } : {}),
    },
  };
}
