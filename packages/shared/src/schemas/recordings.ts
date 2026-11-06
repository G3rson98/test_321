/**
 * Grabaciones y flujo de dispositivo del asistente local (ESP §9, §13.6). Nunca contienen sesiones de navegador,
 * `storageState` ni contraseñas. RF-GRB-01, RF-GRB-02, RF-GRB-05, RF-GRB-06, RNF-SEG-01.
 */
import { z } from 'zod';
import { ClassificationSchema, DeviceAuthorizationStatusSchema, RecordingStatusSchema } from '../enums.js';
import { CursorQuerySchema, IsoDateTimeSchema, TagSchema, UuidSchema } from './common.js';

export const RECORDING_TTL_MS = 2 * 60 * 60 * 1000;
export const RECORDING_MAX_CODE_BYTES = 1024 * 1024;
export const DEVICE_CODE_TTL_SECONDS = 300;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** `POST /recordings` con `{ caseId, environmentId, tags }`. */
export const RecordingCreateSchema = z.object({
  caseId: UuidSchema,
  environmentId: UuidSchema,
  tags: z
    .array(TagSchema)
    .max(20)
    .refine((t) => new Set(t).size === t.length, 'Etiquetas duplicadas')
    .default([]),
});
export type RecordingCreate = z.infer<typeof RecordingCreateSchema>;

export const RecordingStepSchema = z.object({
  kind: z.enum(['accion', 'verificacion', 'no_soportada']),
  description: z.string().max(500),
});

export const RecordingSessionSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  caseRef: z.string(),
  environmentId: UuidSchema,
  createdBy: UuidSchema,
  deviceId: UuidSchema.nullable(),
  status: RecordingStatusSchema,
  tags: z.array(TagSchema),
  expiresAt: IsoDateTimeSchema,
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  commit: z.string().nullable(),
  rejectionReasons: z.array(z.object({ code: z.string(), message: z.string(), line: z.number().int().nullable() })),
  steps: z.array(RecordingStepSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;

/** Respuesta de creación: enlace para el asistente con SOLO el ID de sesión (ESP §13.6). */
export const RecordingCreatedResponseSchema = z.object({
  recording: RecordingSessionSchema,
  assistantLink: z.string().regex(/^katalyst:\/\/recording\/[0-9a-f-]{36}$/),
  assistant: z.object({ linked: z.boolean(), online: z.boolean(), installUrl: z.string().nullable() }),
});

/** `POST /recordings/{id}/status` (asistente): transición idempotente. */
export const RecordingStatusUpdateSchema = z.object({
  status: RecordingStatusSchema.extract(['vinculada', 'grabando', 'validando']),
  steps: z.array(RecordingStepSchema).max(500).optional(),
});

/** `POST /recordings/{id}/complete` con el código grabado (≤ 1 MiB). Ruta/nombre los genera el servidor. */
export const RecordingCompleteSchema = z.object({
  code: z.string().min(1).max(RECORDING_MAX_CODE_BYTES),
  classification: ClassificationSchema,
  title: z.string().trim().min(1).max(300),
  tags: z.array(TagSchema).max(20).default([]),
  steps: z.array(RecordingStepSchema).max(500).default([]),
  pendingVerifications: z.number().int().nonnegative().default(0),
});
export type RecordingComplete = z.infer<typeof RecordingCompleteSchema>;

export const RecordingCancelSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const RecordingListQuerySchema = CursorQuerySchema.extend({
  status: RecordingStatusSchema.optional(),
  caseId: UuidSchema.optional(),
});

// ---------------------------------------------------------------------------
// Flujo de dispositivo (RFC 8628 adaptado; ESP §13.6)
// ---------------------------------------------------------------------------

/** `POST /devices/authorize` (asistente, público con rate limit). */
export const DeviceAuthorizeRequestSchema = z.object({
  clientName: z.string().trim().min(1).max(100),
  clientVersion: z.string().trim().min(1).max(50),
  platform: z.enum(['windows', 'macos', 'linux']),
});
export const DeviceAuthorizeResponseSchema = z.object({
  /** Secreto del asistente para consultar; nunca se muestra al usuario. */
  deviceCode: z.string().min(32),
  /** Código corto de un solo uso que el usuario confirma en el panel (p. ej. `ABCD-EFGH`). */
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUri: z.string(),
  /** Solo contiene el `userCode`, nunca credenciales. */
  verificationUriComplete: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

/** `POST /devices/token` (asistente consulta). Errores: DEVICE_AUTHORIZATION_PENDING, DEVICE_SLOW_DOWN, DEVICE_CODE_EXPIRED, DEVICE_ACCESS_DENIED. */
export const DeviceTokenRequestSchema = z.object({ deviceCode: z.string().min(32).max(256) });
export const DeviceTokenResponseSchema = z.object({
  /** Credencial de dispositivo revocable (se guarda en el almacén del SO). Emitida solo por este endpoint. */
  accessToken: z.string().min(32),
  tokenType: z.literal('Bearer'),
  deviceId: UuidSchema,
  expiresAt: IsoDateTimeSchema,
});

/** Panel: ver/aprobar/denegar la solicitud con sesión autenticada. */
export const DeviceUserCodeParamsSchema = z.object({ userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/) });
export const DeviceAuthorizationViewSchema = z.object({
  userCode: z.string(),
  clientName: z.string(),
  clientVersion: z.string(),
  platform: z.string(),
  status: DeviceAuthorizationStatusSchema,
  expiresAt: IsoDateTimeSchema,
});
export const DeviceApproveRequestSchema = z.object({ userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/) });

export const DeviceSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  platform: z.string(),
  clientVersion: z.string(),
  createdAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** `GET /devices/status`: disponibilidad del asistente vinculado (ESP §9 bloque 2). */
export const DeviceStatusResponseSchema = z.object({
  linked: z.boolean(),
  online: z.boolean(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  clientVersion: z.string().nullable(),
  installUrl: z.string().nullable(),
});
export const DeviceHeartbeatRequestSchema = z.object({
  clientVersion: z.string().max(50),
  activeRecordingId: UuidSchema.nullable().default(null),
});
