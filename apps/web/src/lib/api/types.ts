/**
 * Tipos de DTO del panel. Fuente: `@katalyst/shared/schemas` (z.infer, sin costo en el bundle).
 * Los campos/endpoints marcados como PENDIENTE no existen aún en ROUTES/DTO; están registrados en
 * docs/pendientes-integracion.md ([WEB→API-*]) y el panel degrada con elegancia si no llegan.
 */
import type { z } from 'zod';
import type {
  AlertSchema,
  ArtifactAccessResponseSchema,
  ArtifactSchema,
  AuditEntrySchema,
  AuthProvidersResponseSchema,
  AutomatedTestSchema,
  CaseResultSchema,
  DeliveryRetryResponseSchema,
  DeviceAuthorizationViewSchema,
  DeviceSchema,
  DeviceStatusResponseSchema,
  EnvironmentSchema,
  EnvironmentSummarySchema,
  EventMarkSchema,
  ExportJobSchema,
  FlakyInfoSchema,
  GenerationRequestSchema,
  HistoryResponseSchema,
  MeResponseSchema,
  NotificationChannelSchema,
  NotificationChannelTestResponseSchema,
  NotificationPreferencesSchema,
  OutboxDeliverySchema,
  PanelUserSchema,
  ApiTokenSchema,
  ApiTokenCreatedResponseSchema,
  PerfErrorItemSchema,
  PerfResponseSchema,
  PerfThresholdSchema,
  RecordingCreatedResponseSchema,
  RecordingSessionSchema,
  RunCancelResponseSchema,
  RunDetailSchema,
  RunPreviewResponseSchema,
  RunResultSchema,
  RunSummarySchema,
  ScheduleNextResponseSchema,
  ScheduleOccurrenceSchema,
  SchedulePreviewResponseSchema,
  ScheduleRevisionSchema,
  ScheduleSchema,
  SuiteSchema,
  TestAttemptSchema,
  TestRailCaseDetailSchema,
  TestRailCaseSummarySchema,
  TestRailConnectionSchema,
  TestRailConnectionTestResponseSchema,
  TestRailSectionSchema,
  TestRailSyncRunSchema,
  TestUserSchema,
} from '@katalyst/shared/schemas';
import type { Classification, RunOutcome } from '@katalyst/shared/enums';

export type { Page } from '@katalyst/shared/schemas';

export type Me = z.infer<typeof MeResponseSchema>;
export type AuthProviders = z.infer<typeof AuthProvidersResponseSchema>;
export type Section = z.infer<typeof TestRailSectionSchema>;
export type FlakyInfo = z.infer<typeof FlakyInfoSchema>;

/** Caso del catálogo. PENDIENTE [WEB→API-A]: `tags`, `flaky`, `sectionName`, `classification` en el resumen. */
export type CaseRow = z.infer<typeof TestRailCaseSummarySchema> & {
  tags?: string[];
  flaky?: FlakyInfo | null;
  sectionName?: string | null;
  classification?: Classification | null;
};
export type CaseDetail = z.infer<typeof TestRailCaseDetailSchema> & {
  tags?: string[];
  sectionName?: string | null;
  classification?: Classification | null;
  flaky?: FlakyInfo | null;
};
export type AutomatedTest = z.infer<typeof AutomatedTestSchema>;
export type History = z.infer<typeof HistoryResponseSchema>;
/** PENDIENTE [WEB→API-A]: `GET /tests/:id/source` (código sanitizado del test aprobado). */
export interface TestSource {
  testId: string;
  filePath: string;
  commit: string;
  code: string;
}

/** PENDIENTE [WEB→API-A]: `lastOutcome` y `scheduleLabels` informativos en la suite. */
export type Suite = z.infer<typeof SuiteSchema> & {
  lastOutcome?: RunOutcome | null;
  scheduleLabels?: string[];
};

export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema> & { appUrl?: string };
export type Environment = z.infer<typeof EnvironmentSchema>;
export type TestUser = z.infer<typeof TestUserSchema>;

export type RunSummary = z.infer<typeof RunSummarySchema> & {
  /** PENDIENTE [WEB→API-B]: etiqueta de origen para selecciones por casos/etiquetas ("C1501, C1502", "@oc"). */
  selectionLabel?: string | null;
};
export type RunDetail = z.infer<typeof RunDetailSchema> & { selectionLabel?: string | null };
export type RunPreview = z.infer<typeof RunPreviewResponseSchema> & {
  /** PENDIENTE [WEB→API-B]: workers/duración estimada informados por el servidor (no se inventan). */
  workers?: number | null;
  estimatedDurationMs?: number | null;
};
export type RunResult = z.infer<typeof RunResultSchema> & {
  /** PENDIENTE [WEB→API-B]: refs de caso y último error sanitizado para la fila. */
  caseRefs?: string[];
  lastError?: string | null;
};
export type TestAttempt = z.infer<typeof TestAttemptSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type RunCancelResponse = z.infer<typeof RunCancelResponseSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactAccess = z.infer<typeof ArtifactAccessResponseSchema>;

export type Schedule = z.infer<typeof ScheduleSchema> & { environmentName?: string; targetLabel?: string };
export type ScheduleNext = z.infer<typeof ScheduleNextResponseSchema>;
export type SchedulePreview = z.infer<typeof SchedulePreviewResponseSchema>;
export type ScheduleRevision = z.infer<typeof ScheduleRevisionSchema>;
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>;

export type PerfResponse = z.infer<typeof PerfResponseSchema>;
export type PerfErrorItem = z.infer<typeof PerfErrorItemSchema>;
export type PerfThreshold = z.infer<typeof PerfThresholdSchema>;
export type EventMark = z.infer<typeof EventMarkSchema>;
/** PENDIENTE [WEB→API-C]: `GET /perf/summary` — estadísticas del período por serie calculadas sobre muestras crudas. */
export interface PerfSummaryRow {
  seriesKey: {
    endpointKey: string;
    provenance: 'dxmon' | 'playwright';
    source: 'ui' | 'raiz' | 'probe' | 'app';
    metricKind: 'network_request' | 'screen_ready' | 'root_ready' | 'root_current_wait';
    cacheMode: 'fria' | 'caliente' | 'desconocida';
    workerProfile: string | null;
  };
  screen: string;
  meanMs: number | null;
  p95Ms: number | null;
  p95Status: 'ok' | 'muestra_insuficiente' | 'no_disponible';
  maxMs: number | null;
  bytesWire: number | null;
  bytesBody: number | null;
  completed: number;
  started: number;
  httpErrors: number;
  timeouts: number;
  over29s: number;
  thresholdId: string | null;
  thresholdLimitMs: number | null;
}
export interface PerfSummary {
  from: string;
  to: string;
  rows: PerfSummaryRow[];
}

export type Alert = z.infer<typeof AlertSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type PanelUser = z.infer<typeof PanelUserSchema>;
export type ApiToken = z.infer<typeof ApiTokenSchema>;
export type ApiTokenCreated = z.infer<typeof ApiTokenCreatedResponseSchema>;
export type TestRailConnection = z.infer<typeof TestRailConnectionSchema>;
export type TestRailConnectionTest = z.infer<typeof TestRailConnectionTestResponseSchema>;
export type SyncRun = z.infer<typeof TestRailSyncRunSchema>;
export type Delivery = z.infer<typeof OutboxDeliverySchema>;
export type DeliveryRetry = z.infer<typeof DeliveryRetryResponseSchema>;
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
export type NotificationChannelTest = z.infer<typeof NotificationChannelTestResponseSchema>;
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type ExportJob = z.infer<typeof ExportJobSchema>;
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;
export type RecordingCreated = z.infer<typeof RecordingCreatedResponseSchema>;
export type DeviceStatus = z.infer<typeof DeviceStatusResponseSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceAuthorizationView = z.infer<typeof DeviceAuthorizationViewSchema>;
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

/** PENDIENTE [WEB→API-B]: `GET /dashboard/summary` — KPIs de inicio calculados en servidor. */
export interface DashboardSummary {
  successRate7d: number | null;
  successRatePrev7d: number | null;
  runsToday: number;
  runningNow: number;
  coverage: { automated: number; total: number };
  activeAlerts: number;
  upcoming: { scheduleId: string; name: string; environmentName: string; at: string }[];
}

/** PENDIENTE [WEB→API-C]: `POST /recordings/:id/commands` — orden al asistente vinculado (lo ejecuta el asistente). */
export type RecordingCommand = 'detener' | 'agregar_verificacion' | 'enviar_pr';
