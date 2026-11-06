/**
 * API de worker (plan §4.3; ESP §13.3). Supervisor: token de servicio. Ejecutor: `leaseToken` en `Authorization`.
 * Todos los callbacks llevan `leaseId` + `generation` (fencing): 409 LEASE_STALE si están obsoletos.
 * Repetir un mensaje ya persistido devuelve el acuse original sin mutación; contenido distinto con la misma
 * clave → 409 CALLBACK_CONFLICT.
 * RF-EJE-03, RF-EJE-05, RF-EJE-08, RF-RES-01, RF-RES-02, RF-REN-01, RNF-CON-01, RNF-SEG-05.
 */
import { z } from 'zod';
import {
  ArtifactKindSchema,
  AttemptKindSchema,
  AttemptStatusSchema,
  ClassificationSchema,
  ErrorCategorySchema,
  ResultReasonSchema,
  RunResultStatusSchema,
  SanitizationStatusSchema,
  ShardStatusSchema,
} from '../enums.js';
import {
  GitCommitShaSchema,
  IsoDateTimeSchema,
  ParameterKeySchema,
  SecretRefSchema,
  Sha256HexSchema,
  UuidSchema,
} from './common.js';
import { ArtifactPolicySchema } from './environments.js';
import { RuntimeVersionsSchema } from './runs.js';
import { ArtifactSchema } from './artifacts.js';

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const LEASE_TTL_MS = 75_000;
export const WATCHDOG_INTERVAL_MS = 15_000;
export const CANCEL_DEADLINE_MS = 30_000;
/** Chromium sin freno de temporizadores (RNF-CON-03). */
export const CHROMIUM_NO_THROTTLE_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
] as const;

/** `POST /worker/claim` (supervisor). BullMQ solo transporta `{ runId, shardId }`. */
export const WorkerClaimRequestSchema = z.object({
  runId: UuidSchema,
  shardId: UuidSchema,
  /** Identificador del supervisor/host + contenedor previsto. */
  workerId: z.string().min(1).max(200),
});
export type WorkerClaimRequest = z.infer<typeof WorkerClaimRequestSchema>;

export const ShardJobPayloadSchema = z.object({ runId: UuidSchema, shardId: UuidSchema });
export type ShardJobPayload = z.infer<typeof ShardJobPayloadSchema>;

export const AssignedTestSchema = z.object({
  runResultId: UuidSchema,
  stableKey: UuidSchema,
  file: z.string(),
  title: z.string(),
  parameterKey: ParameterKeySchema,
  classification: ClassificationSchema,
  retries: z.number().int().min(0).max(2),
  writeIdempotencyApproved: z.boolean(),
  /** Próximo `attemptNo` (>1 si es recuperación tras lease perdido). */
  nextAttemptNo: z.number().int().positive(),
  /** `recuperacion` si este test se reasigna tras pérdida del worker anterior. */
  nextAttemptKind: AttemptKindSchema,
});
export type AssignedTest = z.infer<typeof AssignedTestSchema>;

export const ShardAssignmentSchema = z.object({
  runId: UuidSchema,
  shardId: UuidSchema,
  shardKey: z.string(),
  kind: z.enum(['funcional', 'rendimiento']),
  gitCommit: GitCommitShaSchema,
  manifestHash: Sha256HexSchema,
  tests: z.array(AssignedTestSchema).min(1),
  environment: z.object({ appUrl: z.string(), apiUrl: z.string(), isProduction: z.boolean() }),
  /** Solo para el supervisor: resuelve el secreto y lo monta en tmpfs (nunca en argv/env visibles). */
  testUserRef: z
    .object({ testUserId: UuidSchema, username: z.string(), secretRef: SecretRefSchema, readOnly: z.boolean() })
    .nullable(),
  timeouts: z.object({
    testMs: z.number().int().positive(),
    setupMs: z.number().int().positive(),
    runMs: z.number().int().positive(),
    /** Instante límite absoluto de la corrida. */
    runDeadlineAt: IsoDateTimeSchema,
  }),
  artifactPolicy: ArtifactPolicySchema,
  runtime: z.object({
    playwrightVersion: z.string(),
    image: z.string(),
    imageDigest: z.string().nullable(),
    browserConcurrency: z.literal(1),
    chromiumFlags: z.array(z.string()),
  }),
});
export type ShardAssignment = z.infer<typeof ShardAssignmentSchema>;

export const WorkerClaimResponseSchema = z.object({
  leaseId: UuidSchema,
  generation: z.number().int().positive(),
  /** Token expirable de alcance shard para el ejecutor. Se entrega una sola vez. */
  leaseToken: z.string().min(32),
  leaseExpiresAt: IsoDateTimeSchema,
  heartbeatIntervalMs: z.number().int().positive(),
  assignment: ShardAssignmentSchema,
});
export type WorkerClaimResponse = z.infer<typeof WorkerClaimResponseSchema>;

const fencing = { leaseId: UuidSchema, generation: z.number().int().positive() };
export const LeaseFencingSchema = z.object(fencing);

/** `POST /worker/heartbeat` cada 15 s. */
export const WorkerHeartbeatRequestSchema = z.object({
  ...fencing,
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  resources: z
    .object({ cpuPct: z.number().min(0).max(10_000).nullable(), memMb: z.number().nonnegative().nullable() })
    .optional(),
});
export const WorkerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  leaseExpiresAt: IsoDateTimeSchema,
  cancelRequested: z.boolean(),
  /** Instante en que debe estar detenido el árbol de procesos si hay cancelación (≤ 30 s). */
  cancelDeadlineAt: IsoDateTimeSchema.nullable(),
});

/** `POST /worker/attempts`: persistir inicio ANTES de despachar (ESP §13.3). Clave `(runResultId, attemptNo)`. */
export const WorkerAttemptStartRequestSchema = z.object({
  ...fencing,
  runResultId: UuidSchema,
  attemptNo: z.number().int().positive(),
  kind: AttemptKindSchema,
  startedAt: IsoDateTimeSchema,
});
export const WorkerAttemptStartResponseSchema = z.object({
  attemptId: UuidSchema,
  duplicate: z.boolean(),
  /** `false` si la corrida pidió cancelación: no despachar. */
  proceed: z.boolean(),
});

/** `POST /worker/results`: resultado de un intento; `final` indica que no habrá más intentos de ese test. */
export const WorkerResultRequestSchema = z.object({
  ...fencing,
  runResultId: UuidSchema,
  attemptNo: z.number().int().positive(),
  attemptStatus: AttemptStatusSchema.exclude(['corriendo']),
  finishedAt: IsoDateTimeSchema,
  durationMs: z.number().int().nonnegative(),
  errorCategory: ErrorCategorySchema.nullable(),
  /** Mensaje ya sanitizado por el ejecutor; la API vuelve a sanitizar y verificar. */
  error: z.string().max(8192).nullable(),
  final: z.boolean(),
  finalStatus: RunResultStatusSchema.exclude(['pendiente', 'corriendo']).optional(),
  reason: ResultReasonSchema.nullable().optional(),
});
export type WorkerResultRequest = z.infer<typeof WorkerResultRequestSchema>;
export const WorkerResultResponseSchema = z.object({
  runResultId: UuidSchema,
  attemptNo: z.number().int().positive(),
  status: RunResultStatusSchema,
  duplicate: z.boolean(),
  /** Si se permite otro intento (retry funcional) según la política congelada. */
  retryAllowed: z.boolean(),
});

/** `POST /worker/artifacts/upload`: registra metadatos y devuelve URL de carga acotada (≤ 5 min). */
export const WorkerArtifactUploadRequestSchema = z.object({
  ...fencing,
  runResultId: UuidSchema.nullable(),
  attemptNo: z.number().int().positive().nullable(),
  kind: ArtifactKindSchema,
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  checksumSha256: Sha256HexSchema,
  /** Resultado de la sanitización local; si no es `sanitizado`, no se emite URL de carga. */
  sanitization: z.object({
    status: SanitizationStatusSchema,
    reason: z.string().max(500).nullable(),
    sanitizerVersion: z.string().max(50),
    findingsRemaining: z.number().int().nonnegative(),
  }),
});
export const WorkerArtifactUploadResponseSchema = z.object({
  artifactId: UuidSchema,
  upload: z
    .object({
      method: z.enum(['PUT', 'POST']),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      expiresAt: IsoDateTimeSchema,
    })
    .nullable(),
  /** Motivo si no se acepta la carga (cuota, política, sanitización). */
  rejectedReason: z.string().nullable(),
});
export const WorkerArtifactFinalizeRequestSchema = z.object({
  ...fencing,
  sizeBytes: z.number().int().positive(),
  checksumSha256: Sha256HexSchema,
});
export const WorkerArtifactFinalizeResponseSchema = ArtifactSchema;

/** `POST /worker/perf/samples`: muestras DXMon/Playwright (contrato en `@katalyst/shared/perf`). */
export const WorkerPerfSamplesRequestSchema = z.object({
  ...fencing,
  /** Contenido de `samples.json` (snake_case, schema_version 1), validado por muestra con `parsePerfSamples`. */
  samplesFile: z.unknown(),
  summaryFile: z.unknown().optional(),
});
export const WorkerPerfSamplesResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  quarantined: z.array(
    z.object({ index: z.number().int(), sampleKey: z.string().nullable(), reasons: z.array(z.string()) }),
  ),
  fileError: z.string().nullable(),
});

/** `POST /worker/complete`: fin de shard. */
export const WorkerCompleteRequestSchema = z.object({
  ...fencing,
  shardStatus: ShardStatusSchema.extract(['completado', 'cancelado', 'interrumpido']),
  reason: ResultReasonSchema.nullable(),
  runtimeVersions: RuntimeVersionsSchema,
  /** Evidencia incompleta (cuota agotada, sanitización fallida). */
  evidenceIncomplete: z.boolean().default(false),
});
export const WorkerCompleteResponseSchema = z.object({ ok: z.literal(true), duplicate: z.boolean() });

/** `POST /worker/catalog/listing` (supervisor): resultado del listado aislado para `POST /tests/refresh`. */
export const WorkerCatalogListingRequestSchema = z.object({
  catalogRevisionId: UuidSchema,
  gitCommit: GitCommitShaSchema,
  manifest: z.unknown().nullable(),
  playwrightList: z.unknown().nullable(),
  error: z.string().max(8192).nullable(),
});
export const WorkerCatalogListingResponseSchema = z.object({ ok: z.literal(true), status: z.string() });
