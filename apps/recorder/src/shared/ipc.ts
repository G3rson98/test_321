/**
 * Contrato IPC tipado renderer ↔ main del asistente local. Cada mensaje entrante se valida con Zod en main
 * (`ipc-router.ts`) y cada instantánea de estado saliente se valida antes de enviarse. Nunca transporta la
 * credencial del dispositivo, `storageState` ni contraseñas (RNF-SEG-01, ESP §13.6). RF-GRB-01, RF-GRB-06.
 */
import { z } from 'zod';
import { ClassificationSchema, RecordingStatusSchema } from '@katalyst/shared/enums';
import { TagSchema, UuidSchema } from '@katalyst/shared/schemas';
import { IPC_COMMANDS } from './channels.js';

// ---------------------------------------------------------------------------
// Peticiones renderer → main
// ---------------------------------------------------------------------------

const Empty = z.undefined().or(z.object({}).strict());

export const RecordingDraftSchema = z
  .object({
    title: z.string().trim().min(1, 'Escribe un título para el test').max(300),
    tags: z
      .array(TagSchema)
      .max(20)
      .refine((t) => new Set(t).size === t.length, 'Etiquetas duplicadas'),
    classification: ClassificationSchema,
  })
  .strict();
export type RecordingDraft = z.infer<typeof RecordingDraftSchema>;

export const IPC_REQUEST_SCHEMAS = {
  [IPC_COMMANDS.getState]: Empty,
  [IPC_COMMANDS.setServerUrl]: z.object({ serverUrl: z.string().trim().min(1).max(2048) }).strict(),
  [IPC_COMMANDS.startLink]: Empty,
  [IPC_COMMANDS.cancelLink]: Empty,
  [IPC_COMMANDS.openVerification]: Empty,
  [IPC_COMMANDS.unlink]: Empty,
  [IPC_COMMANDS.installBrowser]: Empty,
  [IPC_COMMANDS.listRecordings]: z
    .object({ scope: z.enum(['activas', 'todas']).default('activas'), cursor: z.string().max(512).optional() })
    .strict(),
  [IPC_COMMANDS.openRecording]: z.object({ id: UuidSchema }).strict(),
  [IPC_COMMANDS.startLogin]: Empty,
  [IPC_COMMANDS.startCapture]: z.object({ skipLogin: z.boolean().default(false) }).strict(),
  [IPC_COMMANDS.stopCapture]: Empty,
  [IPC_COMMANDS.rerecord]: Empty,
  [IPC_COMMANDS.addVerification]: Empty,
  [IPC_COMMANDS.validateDraft]: z.object({ draft: RecordingDraftSchema }).strict(),
  [IPC_COMMANDS.maskSensitive]: Empty,
  [IPC_COMMANDS.submit]: z
    .object({
      draft: RecordingDraftSchema,
      /** El QA confirma que leyó las advertencias (TODO selector, verificaciones pendientes, no soportadas). */
      acknowledgeWarnings: z.boolean(),
    })
    .strict(),
  [IPC_COMMANDS.discard]: z.object({ reason: z.string().trim().max(500).optional() }).strict(),
  [IPC_COMMANDS.closeRecording]: Empty,
  [IPC_COMMANDS.openPullRequest]: Empty,
} as const satisfies Record<(typeof IPC_COMMANDS)[keyof typeof IPC_COMMANDS], z.ZodType>;

export type IpcRequestSchemas = typeof IPC_REQUEST_SCHEMAS;
export type IpcRequest<C extends keyof IpcRequestSchemas> = z.input<IpcRequestSchemas[C]>;

// ---------------------------------------------------------------------------
// Respuestas y estado main → renderer
// ---------------------------------------------------------------------------

export const IpcErrorSchema = z.object({ code: z.string().max(64), message: z.string().max(2000) });
export type IpcError = z.infer<typeof IpcErrorSchema>;
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export const StepViewSchema = z.object({
  index: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
  kind: z.enum(['accion', 'verificacion', 'no_soportada']),
  description: z.string().max(500),
});
export type StepView = z.infer<typeof StepViewSchema>;

export const IssueViewSchema = z.object({
  severity: z.enum(['error', 'advertencia']),
  code: z.string().max(64),
  message: z.string().max(1000),
  line: z.number().int().nullable(),
});
export type IssueView = z.infer<typeof IssueViewSchema>;

export const ValidationViewSchema = z.object({
  ok: z.boolean(),
  bytes: z.number().int().nonnegative(),
  issues: z.array(IssueViewSchema).max(500),
  maskedValues: z.number().int().nonnegative(),
});
export type ValidationView = z.infer<typeof ValidationViewSchema>;

export const RECORDING_PHASES = [
  'cargando',
  'bloqueada',
  'lista',
  'login',
  'iniciando',
  'grabando',
  'detenida',
  'enviando',
  'enviada',
  'rechazada',
  'cancelada',
  'vencida',
  'error',
] as const;
export const RecordingPhaseSchema = z.enum(RECORDING_PHASES);
export type RecordingPhase = z.infer<typeof RecordingPhaseSchema>;

export const RecordingViewSchema = z.object({
  id: UuidSchema,
  caseRef: z.string().max(32),
  serverStatus: RecordingStatusSchema.nullable(),
  phase: RecordingPhaseSchema,
  environmentName: z.string().max(200).nullable(),
  appUrl: z.string().max(2048).nullable(),
  expiresAt: z.string().nullable(),
  tags: z.array(z.string().max(80)).max(20),
  steps: z.array(StepViewSchema).max(500),
  warnings: z.array(IssueViewSchema).max(200),
  pendingVerifications: z.number().int().nonnegative(),
  verificationGuide: z.boolean(),
  hasStorageState: z.boolean(),
  codePreview: z.string().max(200_000).nullable(),
  validation: ValidationViewSchema.nullable(),
  prUrl: z.string().max(2048).nullable(),
  rejectionReasons: z.array(z.object({ code: z.string(), message: z.string(), line: z.number().int().nullable() })),
  message: z.string().max(2000).nullable(),
});
export type RecordingView = z.infer<typeof RecordingViewSchema>;

export const DEVICE_LINK_STATUSES = ['sin_configurar', 'sin_vincular', 'vinculando', 'vinculado'] as const;

export const DeviceViewSchema = z.object({
  status: z.enum(DEVICE_LINK_STATUSES),
  /** Código corto que el usuario confirma en el panel (no es secreto: es de un solo uso y vence en 5 min). */
  userCode: z.string().max(16).nullable(),
  verificationUri: z.string().max(2048).nullable(),
  codeExpiresAt: z.string().nullable(),
  deviceId: z.string().nullable(),
  credentialExpiresAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  healthy: z.boolean().nullable(),
  message: z.string().max(2000).nullable(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

export const BrowserViewSchema = z.object({
  status: z.enum(['desconocido', 'instalado', 'faltante', 'instalando', 'error']),
  source: z.enum(['incluido', 'descargado', 'ninguno']),
  message: z.string().max(2000).nullable(),
});
export type BrowserView = z.infer<typeof BrowserViewSchema>;

export const AppStateSchema = z.object({
  version: z.string().max(50),
  serverUrl: z.string().max(2048).nullable(),
  devMode: z.boolean(),
  credentialStore: z.enum(['disponible', 'no_disponible']),
  device: DeviceViewSchema,
  browser: BrowserViewSchema,
  recording: RecordingViewSchema.nullable(),
  /** Grabación pedida por enlace `katalyst://` antes de vincular el asistente. */
  pendingRecordingId: UuidSchema.nullable(),
  notice: z.object({ kind: z.enum(['info', 'error']), message: z.string().max(2000) }).nullable(),
});
export type AppState = z.infer<typeof AppStateSchema>;

export const RecordingListItemSchema = z.object({
  id: UuidSchema,
  caseRef: z.string(),
  status: RecordingStatusSchema,
  tags: z.array(z.string()),
  expiresAt: z.string(),
  createdAt: z.string(),
  prUrl: z.string().nullable(),
  hasLocalCode: z.boolean(),
});
export type RecordingListItem = z.infer<typeof RecordingListItemSchema>;
export const RecordingListViewSchema = z.object({
  items: z.array(RecordingListItemSchema),
  nextCursor: z.string().nullable(),
});
export type RecordingListView = z.infer<typeof RecordingListViewSchema>;
