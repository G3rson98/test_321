/**
 * Tipos de DTO del panel: SOLO `z.infer` de `@katalyst/shared/schemas` (sin costo en el bundle), idénticos a lo que
 * serializa la API (Fastify + Zod descarta campos no declarados). Los datos que la API no expone se derivan en el
 * panel a partir de otros endpoints (ver `lib/api/derive.ts`) o se degradan con un estado "no disponible"; las
 * necesidades abiertas están en docs/pendientes-integracion.md ([WEB→API-*]).
 */
import type { z } from 'zod';
import type {
  AlertSchema,
  ApiTokenCreatedResponseSchema,
  ApiTokenSchema,
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
  ExportDownloadResponseSchema,
  ExportJobSchema,
  FlakyInfoSchema,
  GenerationDetailSchema,
  HistoryResponseSchema,
  MeResponseSchema,
  NotificationChannelSchema,
  NotificationChannelTestResponseSchema,
  NotificationPreferencesSchema,
  OutboxDeliverySchema,
  PanelUserSchema,
  PerfErrorItemSchema,
  PerfResponseSchema,
  PerfSeriesItemSchema,
  PerfThresholdSchema,
  RecordingCreatedSchema,
  RecordingDetailSchema,
  RunCancelResponseSchema,
  RunDetailSchema,
  RunPreviewResponseSchema,
  RunResultSchema,
  RunSummarySchema,
  RunTestRailTargetSchema,
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

export type { Page } from '@katalyst/shared/schemas';

export type Me = z.infer<typeof MeResponseSchema>;
export type AuthProviders = z.infer<typeof AuthProvidersResponseSchema>;
export type Section = z.infer<typeof TestRailSectionSchema>;
export type FlakyInfo = z.infer<typeof FlakyInfoSchema>;

/** Caso del catálogo (`GET /testrail/cases`). Etiquetas/flaky/clasificación se derivan de `GET /tests`. */
export type CaseRow = z.infer<typeof TestRailCaseSummarySchema>;
export type CaseDetail = z.infer<typeof TestRailCaseDetailSchema>;
export type AutomatedTest = z.infer<typeof AutomatedTestSchema>;
export type History = z.infer<typeof HistoryResponseSchema>;

export type Suite = z.infer<typeof SuiteSchema>;

export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
/** `GET /environments` devuelve el detalle a admin y el resumen al resto. */
export type EnvironmentListItem = Environment | EnvironmentSummary;
export type TestUser = z.infer<typeof TestUserSchema>;

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type RunPreview = z.infer<typeof RunPreviewResponseSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
export type TestAttempt = z.infer<typeof TestAttemptSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type RunTarget = z.infer<typeof RunTestRailTargetSchema>;
export type RunCancelResponse = z.infer<typeof RunCancelResponseSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactAccess = z.infer<typeof ArtifactAccessResponseSchema>;

export type Schedule = z.infer<typeof ScheduleSchema>;
export type ScheduleNext = z.infer<typeof ScheduleNextResponseSchema>;
export type SchedulePreview = z.infer<typeof SchedulePreviewResponseSchema>;
export type ScheduleRevision = z.infer<typeof ScheduleRevisionSchema>;
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>;

export type PerfResponse = z.infer<typeof PerfResponseSchema>;
export type PerfPoint = PerfResponse['series'][number]['points'][number];
export type PerfSeriesKey = PerfResponse['series'][number]['key'];
export type PerfSeriesItem = z.infer<typeof PerfSeriesItemSchema>;
export type PerfErrorItem = z.infer<typeof PerfErrorItemSchema>;
export type PerfThreshold = z.infer<typeof PerfThresholdSchema>;
export type EventMark = z.infer<typeof EventMarkSchema>;

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
export type ExportDownload = z.infer<typeof ExportDownloadResponseSchema>;
/** `GET /recordings/:id` y respuestas de transición: sesión + ambiente (D-050). */
export type RecordingSession = z.infer<typeof RecordingDetailSchema>;
/** `POST /recordings` → 201 con enlace `katalyst://grabar?session=<id>`. */
export type RecordingCreated = z.infer<typeof RecordingCreatedSchema>;
export type DeviceStatus = z.infer<typeof DeviceStatusResponseSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceAuthorizationView = z.infer<typeof DeviceAuthorizationViewSchema>;
export type GenerationRequest = z.infer<typeof GenerationDetailSchema>;
