/**
 * Corridas: creación idempotente, vista previa (plan resuelto), snapshot inmutable, resultados por intento/test/caso
 * y destinos TestRail (ESP §7, §9, §13.1–§13.4).
 * RF-EJE-01, RF-EJE-03, RF-EJE-05, RF-EJE-06, RF-EJE-07, RF-EJE-08, RF-RES-01, RF-RES-05, RF-TR-04, RF-TR-06.
 */
import { z } from 'zod';
import {
  AttemptKindSchema,
  AttemptStatusSchema,
  CaseResultStatusSchema,
  ClassificationSchema,
  CoverageSchema,
  ErrorCategorySchema,
  ResultReasonSchema,
  RunOutcomeSchema,
  RunResultStatusSchema,
  RunStatusSchema,
  RunTriggerSchema,
  ShardStatusSchema,
  SyncStatusSchema,
} from '../enums.js';
import {
  ActorRefSchema,
  CaseRefSchema,
  CursorQuerySchema,
  GitCommitShaSchema,
  IsoDateTimeSchema,
  ParameterKeySchema,
  Sha256HexSchema,
  sortQuerySchema,
  UuidSchema,
} from './common.js';
import {
  RunSelectionSchema,
  SelectionFieldsShape,
  refineExactlyOneSelection,
  SuiteSelectorSchema,
} from './selection.js';
import { ArtifactPolicySchema, EnvironmentSummarySchema } from './environments.js';

export const MAX_RETRIES = 2;
export const RetriesSchema = z.number().int().min(0).max(MAX_RETRIES).default(0);

/** Destino TestRail: corrida nueva por suite (default) o corrida/plan existente (RF-TR-06). */
export const TestRailTargetOptionsSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('nueva') }),
    z.object({
      mode: z.literal('existente'),
      trRunId: z.number().int().positive(),
      /** Cerrar una corrida preexistente requiere opción explícita (ESP §8). */
      closeExistingRun: z.boolean().default(false),
    }),
    z.object({ mode: z.literal('ninguno') }),
  ])
  .default({ mode: 'nueva' });
export type TestRailTargetOptions = z.infer<typeof TestRailTargetOptionsSchema>;

const runRequestShape = {
  ...SelectionFieldsShape,
  environmentId: UuidSchema,
  retries: RetriesSchema,
  /** Excluir tests marcados flaky (RF-CAT-04). */
  excludeFlaky: z.boolean().default(false),
  testrail: TestRailTargetOptionsSchema,
};

/** `POST /runs/preview`: no ejecuta; devuelve el plan resuelto y motivos de bloqueo (RF-EJE-07). */
export const RunPreviewRequestSchema = z.object(runRequestShape).superRefine(refineExactlyOneSelection);
export type RunPreviewRequest = z.infer<typeof RunPreviewRequestSchema>;

/**
 * `POST /runs` con encabezado `Idempotency-Key` (ESP §9). Misma clave + mismo cuerpo → misma corrida;
 * cuerpo distinto → 409 IDEMPOTENCY_CONFLICT.
 */
export const RunCreateRequestSchema = z
  .object({
    ...runRequestShape,
    /** Token de la vista previa: si la configuración cambió, 409 ADMISSION_CONFIG_CHANGED (ESP §13.5). */
    previewToken: z.string().max(256).optional(),
  })
  .superRefine(refineExactlyOneSelection);
export type RunCreateRequest = z.infer<typeof RunCreateRequestSchema>;

export const PlanCaseSchema = z.object({
  caseId: UuidSchema,
  trCaseId: z.number().int().positive(),
  ref: CaseRefSchema,
  title: z.string(),
  revision: z.number().int().positive(),
  testrailSuiteId: UuidSchema,
  executable: z.boolean(),
  blockReasons: z.array(ResultReasonSchema),
  /** Tests/variantes requeridos para cobertura completa (ESP §13.4). */
  requiredTests: z.array(z.object({ stableKey: UuidSchema, parameterKey: ParameterKeySchema })),
  expectedCoverage: CoverageSchema,
});
export type PlanCase = z.infer<typeof PlanCaseSchema>;

export const PlanTestSchema = z.object({
  automatedTestId: UuidSchema,
  stableKey: UuidSchema,
  filePath: z.string(),
  title: z.string(),
  classification: ClassificationSchema,
  parameterKey: ParameterKeySchema,
  retries: z.number().int().min(0).max(MAX_RETRIES),
  writeIdempotencyApproved: z.boolean(),
  executable: z.boolean(),
  blockReasons: z.array(ResultReasonSchema),
  /** Casos seleccionados que este test publica. */
  selectedCaseIds: z.array(UuidSchema),
  /** Otros casos tocados (informativos, no se publican; ESP §8). */
  touchedCaseIds: z.array(UuidSchema),
});
export type PlanTest = z.infer<typeof PlanTestSchema>;

export const RunPreviewResponseSchema = z.object({
  previewToken: z.string(),
  selection: RunSelectionSchema,
  environment: EnvironmentSummarySchema,
  catalogRevisionId: UuidSchema,
  gitCommit: GitCommitShaSchema,
  manifestHash: Sha256HexSchema,
  cases: z.array(PlanCaseSchema),
  tests: z.array(PlanTestSchema),
  counts: z.object({
    cases: z.number().int().nonnegative(),
    executableCases: z.number().int().nonnegative(),
    blockedCases: z.number().int().nonnegative(),
    tests: z.number().int().nonnegative(),
    executableTests: z.number().int().nonnegative(),
  }),
  /** Bloqueos globales (p. ej. ambiente deshabilitado) y advertencias (revisión pendiente en staging manual). */
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  /** `false` si todo está bloqueado: la corrida terminará sin navegador con outcome `bloqueado` (ESP §13.1). */
  willLaunchBrowser: z.boolean(),
  testrailTargets: z.array(z.object({ testrailSuiteId: UuidSchema, name: z.string(), caseCount: z.number().int() })),
});
export type RunPreviewResponse = z.infer<typeof RunPreviewResponseSchema>;

/**
 * `run.selection_snapshot` (JSON inmutable, ESP §13.1). Nunca copia secretos: el usuario de prueba va por referencia.
 */
export const RunSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  selection: RunSelectionSchema,
  suite: z.object({ id: UuidSchema, name: z.string(), selector: SuiteSelectorSchema }).nullable(),
  scheduleId: UuidSchema.nullable(),
  scheduleRevision: z.number().int().positive().nullable(),
  catalogRevisionId: UuidSchema,
  gitCommit: GitCommitShaSchema,
  manifestHash: Sha256HexSchema,
  environment: z.object({
    id: UuidSchema,
    name: z.string(),
    appUrl: z.string(),
    apiUrl: z.string(),
    isProduction: z.boolean(),
  }),
  testUser: z.object({ testUserId: UuidSchema, label: z.string(), readOnly: z.boolean() }).nullable(),
  retries: z.number().int().min(0).max(MAX_RETRIES),
  excludeFlaky: z.boolean(),
  timeouts: z.object({
    testMs: z.number().int().positive(),
    setupMs: z.number().int().positive(),
    runMs: z.number().int().positive(),
    finalizingMs: z.number().int().positive(),
  }),
  artifactPolicy: ArtifactPolicySchema,
  testrail: TestRailTargetOptionsSchema,
  cases: z.array(PlanCaseSchema),
  tests: z.array(PlanTestSchema),
  kind: z.enum(['funcional', 'rendimiento']),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const RuntimeVersionsSchema = z.object({
  node: z.string().optional(),
  playwright: z.string().optional(),
  chromium: z.string().optional(),
  image: z.string().optional(),
  imageDigest: z.string().optional(),
  runner: z.string().optional(),
  dxmon: z.string().optional(),
});
export type RuntimeVersions = z.infer<typeof RuntimeVersionsSchema>;

export const StatusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pendiente: z.number().int().nonnegative(),
  corriendo: z.number().int().nonnegative(),
  pasado: z.number().int().nonnegative(),
  inestable: z.number().int().nonnegative(),
  fallido: z.number().int().nonnegative(),
  bloqueado: z.number().int().nonnegative(),
  omitido: z.number().int().nonnegative(),
  cancelado: z.number().int().nonnegative(),
  error_infraestructura: z.number().int().nonnegative(),
});
export type StatusCounts = z.infer<typeof StatusCountsSchema>;

export const RunSummarySchema = z.object({
  id: UuidSchema,
  trigger: RunTriggerSchema,
  status: RunStatusSchema,
  outcome: RunOutcomeSchema.nullable(),
  syncStatus: SyncStatusSchema,
  reason: ResultReasonSchema.nullable(),
  environment: EnvironmentSummarySchema,
  suiteId: UuidSchema.nullable(),
  suiteName: z.string().nullable(),
  scheduleId: UuidSchema.nullable(),
  scheduleName: z.string().nullable(),
  counts: StatusCountsSchema,
  caseCounts: z.object({
    total: z.number().int().nonnegative(),
    pasado: z.number().int().nonnegative(),
    inestable: z.number().int().nonnegative(),
    fallido: z.number().int().nonnegative(),
    bloqueado: z.number().int().nonnegative(),
    no_ejecutado: z.number().int().nonnegative(),
    pendiente: z.number().int().nonnegative(),
  }),
  scheduledFor: IsoDateTimeSchema.nullable(),
  queuedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  cancelRequestedAt: IsoDateTimeSchema.nullable(),
  /** Duración de pared (ms). */
  durationMs: z.number().int().nonnegative().nullable(),
  gitCommit: GitCommitShaSchema,
  createdBy: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
  /** Versión monotónica para descartar eventos SSE viejos. */
  version: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunShardSchema = z.object({
  id: UuidSchema,
  shardKey: z.string(),
  status: ShardStatusSchema,
  assignedTestCount: z.number().int().nonnegative(),
  recoveryCount: z.number().int().nonnegative(),
  currentLease: z
    .object({
      leaseId: UuidSchema,
      workerId: z.string(),
      generation: z.number().int().positive(),
      heartbeatAt: IsoDateTimeSchema,
      expiresAt: IsoDateTimeSchema,
    })
    .nullable(),
});

export const RunTestRailTargetSchema = z.object({
  id: UuidSchema,
  testrailSuiteId: UuidSchema,
  suiteName: z.string(),
  trRunId: z.number().int().positive().nullable(),
  syncStatus: SyncStatusSchema,
  closeExistingRun: z.boolean(),
  pendingDeliveries: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  url: z.string().nullable(),
});
export type RunTestRailTarget = z.infer<typeof RunTestRailTargetSchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  snapshot: RunSnapshotSchema,
  runtimeVersions: RuntimeVersionsSchema,
  shards: z.array(RunShardSchema),
  targets: z.array(RunTestRailTargetSchema),
  /** Problemas del runner vs. de la aplicación vs. de publicación (ESP §13.2). */
  problems: z.object({
    application: z.number().int().nonnegative(),
    runner: z.number().int().nonnegative(),
    publication: z.number().int().nonnegative(),
  }),
  evidenceIncomplete: z.boolean(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunResultSchema = z.object({
  id: UuidSchema,
  runId: UuidSchema,
  automatedTestId: UuidSchema,
  stableKey: UuidSchema,
  title: z.string(),
  filePath: z.string(),
  parameterKey: ParameterKeySchema,
  classification: ClassificationSchema,
  status: RunResultStatusSchema,
  reason: ResultReasonSchema.nullable(),
  reasonText: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  infraRecoveryCount: z.number().int().nonnegative(),
  caseIds: z.array(UuidSchema),
  artifactCount: z.number().int().nonnegative(),
  evidenceIncomplete: z.boolean(),
  updatedAt: IsoDateTimeSchema,
  version: z.number().int().nonnegative(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const TestAttemptSchema = z.object({
  id: UuidSchema,
  runResultId: UuidSchema,
  attemptNo: z.number().int().positive(),
  kind: AttemptKindSchema,
  status: AttemptStatusSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCategory: ErrorCategorySchema.nullable(),
  /** Error sanitizado (ESP §13.7). */
  error: z.string().nullable(),
  workerLeaseId: UuidSchema.nullable(),
});
export type TestAttempt = z.infer<typeof TestAttemptSchema>;

export const CaseResultSchema = z.object({
  id: UuidSchema,
  runId: UuidSchema,
  caseId: UuidSchema,
  ref: CaseRefSchema,
  title: z.string(),
  caseRevision: z.number().int().positive(),
  status: CaseResultStatusSchema,
  coverage: CoverageSchema,
  contributingResults: z.array(
    z.object({
      runResultId: UuidSchema,
      stableKey: UuidSchema,
      parameterKey: ParameterKeySchema,
      status: RunResultStatusSchema,
    }),
  ),
  /** Suma de tiempos de intentos (tiempo de trabajo, ESP §13.4). */
  durationMs: z.number().int().nonnegative().nullable(),
  comment: z.string().nullable(),
  trResultId: z.number().int().positive().nullable(),
  publishable: z.boolean(),
  syncStatus: SyncStatusSchema,
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const RunListQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  status: z.union([RunStatusSchema, z.array(RunStatusSchema)]).optional(),
  outcome: RunOutcomeSchema.optional(),
  syncStatus: SyncStatusSchema.optional(),
  trigger: RunTriggerSchema.optional(),
  suiteId: UuidSchema.optional(),
  scheduleId: UuidSchema.optional(),
  createdBy: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  sort: sortQuerySchema(['createdAt', 'finishedAt'] as const, '-createdAt'),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunResultListQuerySchema = CursorQuerySchema.extend({
  status: z.union([RunResultStatusSchema, z.array(RunResultStatusSchema)]).optional(),
  q: z.string().trim().max(200).optional(),
});

export const RunResultParamsSchema = z.object({ id: UuidSchema, resultId: UuidSchema });

/** `POST /runs/{id}/cancel`. Idempotente: dos cancelaciones tienen el mismo efecto (ESP §13.3). */
export const RunCancelRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const RunCancelResponseSchema = z.object({
  run: RunSummarySchema,
  /** `false` si la detención real del worker no pudo confirmarse aún. */
  stopConfirmed: z.boolean(),
});
