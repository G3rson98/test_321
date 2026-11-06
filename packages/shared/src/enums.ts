/**
 * Enums de dominio de Katalyst. Valores EXACTOS de ESP §3, §7, §13.2, §13.6, §13.8.
 * Fuente única para Zod (API), Prisma (enums de PostgreSQL con los mismos valores) y panel.
 * Cambiar un valor aquí exige migración Prisma y entrada en docs/decisiones.md.
 *
 * RF-EJE-07, RF-EJE-08, RF-RES-05, RF-CAT-05, RF-GRB-06, RF-REN-01, RF-USR-01.
 */
import { z } from 'zod';

function zEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}

// ---------------------------------------------------------------------------
// Ejecución (ESP §13.2)
// ---------------------------------------------------------------------------

/** `run.status` — ESP §13.2. */
export const RUN_STATUSES = [
  'en_cola',
  'preparando',
  'corriendo',
  'finalizando',
  'terminada',
  'cancelando',
  'cancelada',
  'interrumpida',
  'omitida',
] as const;
export const RunStatusSchema = zEnum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Estados activos (no terminales) de una corrida. */
export const ACTIVE_RUN_STATUSES = [
  'en_cola',
  'preparando',
  'corriendo',
  'finalizando',
  'cancelando',
] as const satisfies readonly RunStatus[];
/** Estados terminales: una corrida en estos estados no se reabre por callbacks tardíos (ESP §13.2). */
export const TERMINAL_RUN_STATUSES = [
  'terminada',
  'cancelada',
  'interrumpida',
  'omitida',
] as const satisfies readonly RunStatus[];

/** `run.outcome` — ESP §13.2. `null` mientras la corrida está activa. */
export const RUN_OUTCOMES = ['pasado', 'inestable', 'fallido', 'bloqueado', 'incompleto'] as const;
export const RunOutcomeSchema = zEnum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** `run.sync_status` y `run_testrail_target.sync_status` — ESP §13.2. */
export const SYNC_STATUSES = ['no_aplica', 'pendiente', 'enviando', 'sincronizada', 'requiere_intervencion'] as const;
export const SyncStatusSchema = zEnum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/** `run.trigger` — ESP §7. */
export const RUN_TRIGGERS = ['manual', 'programada', 'api'] as const;
export const RunTriggerSchema = zEnum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/** `run_result.status` — ESP §13.2. */
export const RUN_RESULT_STATUSES = [
  'pendiente',
  'corriendo',
  'pasado',
  'inestable',
  'fallido',
  'bloqueado',
  'omitido',
  'cancelado',
  'error_infraestructura',
] as const;
export const RunResultStatusSchema = zEnum(RUN_RESULT_STATUSES);
export type RunResultStatus = z.infer<typeof RunResultStatusSchema>;
export const TERMINAL_RUN_RESULT_STATUSES = [
  'pasado',
  'inestable',
  'fallido',
  'bloqueado',
  'omitido',
  'cancelado',
  'error_infraestructura',
] as const satisfies readonly RunResultStatus[];

/** `test_attempt.kind` — ESP §7. */
export const ATTEMPT_KINDS = ['inicial', 'retry', 'recuperacion'] as const;
export const AttemptKindSchema = zEnum(ATTEMPT_KINDS);
export type AttemptKind = z.infer<typeof AttemptKindSchema>;

/**
 * `test_attempt.status`. La ESP no enumera valores; se fijan en D-010.
 * `error_infraestructura` con `error_category = resultado_desconocido` representa la escritura en curso perdida (ESP §13.3).
 */
export const ATTEMPT_STATUSES = [
  'corriendo',
  'pasado',
  'fallido',
  'omitido',
  'cancelado',
  'error_infraestructura',
] as const;
export const AttemptStatusSchema = zEnum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/** `test_attempt.error_category` (ESP §13.2: aplicación vs infraestructura vs login). D-010. */
export const ERROR_CATEGORIES = [
  'asercion',
  'timeout_aplicacion',
  'error_aplicacion',
  'login',
  'navegador_no_disponible',
  'worker_perdido',
  'resultado_desconocido',
  'timeout_corrida',
  'infraestructura',
  'politica',
  'configuracion',
  'cancelacion',
  'desconocido',
] as const;
export const ErrorCategorySchema = zEnum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
/** Categorías que cuentan como falla funcional confirmada de la aplicación (ESP §13.2). */
export const FUNCTIONAL_ERROR_CATEGORIES = [
  'asercion',
  'timeout_aplicacion',
  'error_aplicacion',
] as const satisfies readonly ErrorCategory[];

/** `run_shard.status`. D-010. */
export const SHARD_STATUSES = [
  'pendiente',
  'asignado',
  'corriendo',
  'completado',
  'cancelado',
  'interrumpido',
] as const;
export const ShardStatusSchema = zEnum(SHARD_STATUSES);
export type ShardStatus = z.infer<typeof ShardStatusSchema>;

/** `case_result.coverage` — ESP §7. */
export const COVERAGES = ['completa', 'parcial', 'ninguna'] as const;
export const CoverageSchema = zEnum(COVERAGES);
export type Coverage = z.infer<typeof CoverageSchema>;

/** `case_result.status` — agregado local por caso (ESP §13.4). `no_ejecutado` = sin resultado externo. */
export const CASE_RESULT_STATUSES = [
  'pendiente',
  'pasado',
  'inestable',
  'fallido',
  'bloqueado',
  'no_ejecutado',
] as const;
export const CaseResultStatusSchema = zEnum(CASE_RESULT_STATUSES);
export type CaseResultStatus = z.infer<typeof CaseResultStatusSchema>;

/**
 * Códigos estables de causa (`run_result.reason`, bloqueos de plan, omisiones). ESP §13.1, §13.2, §13.5.
 */
export const RESULT_REASONS = [
  'sin_automatizacion',
  'caso_archivado',
  'test_retirado',
  'test_no_aprobado',
  'clasificacion_ausente',
  'clasificacion_contradictoria',
  'escritura_en_produccion',
  'revision_pendiente',
  'usuario_con_escritura',
  'ambiente_deshabilitado',
  'manifiesto_invalido',
  'commit_no_disponible',
  'variante_faltante',
  'excluido_inestable',
  'cancelado_por_usuario',
  'cancelado_por_programacion',
  'worker_perdido',
  'recuperacion_agotada',
  'escritura_resultado_desconocido',
  'timeout_test',
  'timeout_preparacion',
  'timeout_corrida',
  'login_fallido',
  'dependencia_fallida',
  'sin_capacidad',
  'error_interno',
] as const;
export const ResultReasonSchema = zEnum(RESULT_REASONS);
export type ResultReason = z.infer<typeof ResultReasonSchema>;

// ---------------------------------------------------------------------------
// Programación (ESP §7, §13.5)
// ---------------------------------------------------------------------------

/** `schedule_occurrence.status` — ESP §7. */
export const OCCURRENCE_STATUSES = ['admitida', 'omitida'] as const;
export const OccurrenceStatusSchema = zEnum(OCCURRENCE_STATUSES);
export type OccurrenceStatus = z.infer<typeof OccurrenceStatusSchema>;

/** `schedule_occurrence.reason` para omitidas — ESP §7, §13.5, RF-PRG-04/05. */
export const OCCURRENCE_SKIP_REASONS = [
  'solapamiento',
  'sin_capacidad',
  'caida_servicio',
  'ventana_exclusion',
  'programacion_pausada',
  'configuracion_invalida',
  'seleccion_vacia',
  'ambiente_deshabilitado',
] as const;
export const OccurrenceSkipReasonSchema = zEnum(OCCURRENCE_SKIP_REASONS);
export type OccurrenceSkipReason = z.infer<typeof OccurrenceSkipReasonSchema>;

/** Modo del editor visual de horario (RF-PRG-02). */
export const SCHEDULE_EDITOR_MODES = ['hora_fija', 'intervalo'] as const;
export const ScheduleEditorModeSchema = zEnum(SCHEDULE_EDITOR_MODES);
export type ScheduleEditorMode = z.infer<typeof ScheduleEditorModeSchema>;

// ---------------------------------------------------------------------------
// Catálogo, TestRail (ESP §7, §8)
// ---------------------------------------------------------------------------

/** `automated_test.classification` — ESP §7, RF-EJE-06. */
export const CLASSIFICATIONS = ['lectura', 'escritura', 'sin_clasificar'] as const;
export const ClassificationSchema = zEnum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

/** `automated_test.status` — ESP §7. */
export const TEST_STATUSES = ['borrador', 'aprobado', 'retirado'] as const;
export const TestStatusSchema = zEnum(TEST_STATUSES);
export type TestStatus = z.infer<typeof TestStatusSchema>;

/** `test_case_link.review_status` — ESP §7, §13.1, RF-TR-07. */
export const LINK_REVIEW_STATUSES = ['vigente', 'requiere_revision'] as const;
export const LinkReviewStatusSchema = zEnum(LINK_REVIEW_STATUSES);
export type LinkReviewStatus = z.infer<typeof LinkReviewStatusSchema>;

/** `testrail_connection.last_sync_status` y `testrail_sync_run.status`. */
export const SYNC_RUN_STATUSES = ['nunca', 'en_curso', 'exitosa', 'fallida'] as const;
export const SyncRunStatusSchema = zEnum(SYNC_RUN_STATUSES);
export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;

/** `catalog_revision.status` (refresco del manifiesto/lista Playwright, RF-CAT-01). */
export const CATALOG_REVISION_STATUSES = ['en_curso', 'completa', 'fallida'] as const;
export const CatalogRevisionStatusSchema = zEnum(CATALOG_REVISION_STATUSES);
export type CatalogRevisionStatus = z.infer<typeof CatalogRevisionStatusSchema>;

/** Valores de TestRail `status_id` usados (ESP §8). */
export const TESTRAIL_STATUS_IDS = { passed: 1, blocked: 2, untested: 3, retest: 4, failed: 5 } as const;
export type TestRailStatusId = (typeof TESTRAIL_STATUS_IDS)[keyof typeof TESTRAIL_STATUS_IDS];

// ---------------------------------------------------------------------------
// Outbox, integraciones y notificaciones
// ---------------------------------------------------------------------------

/** `outbox_delivery.status`. D-010. */
export const OUTBOX_STATUSES = [
  'pendiente',
  'en_proceso',
  'entregada',
  'requiere_intervencion',
  'vencida',
  'cancelada',
] as const;
export const OutboxStatusSchema = zEnum(OUTBOX_STATUSES);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/** `outbox_delivery.operation` (texto en BD). Orden por destino: crear → resultados → adjuntos → cerrar (ESP §13.4). */
export const OUTBOX_OPERATIONS = [
  'run.dispatch_shard',
  'testrail.add_run',
  'testrail.add_results_for_cases',
  'testrail.add_attachment_to_result',
  'testrail.close_run',
  'notification.run_finished',
  'notification.alert',
] as const;
export const OutboxOperationSchema = zEnum(OUTBOX_OPERATIONS);
export type OutboxOperation = z.infer<typeof OutboxOperationSchema>;

/** Canales de notificación (RF-NOT-01; elección pendiente ESP §12). */
export const NOTIFICATION_CHANNEL_KINDS = ['correo', 'slack', 'teams'] as const;
export const NotificationChannelKindSchema = zEnum(NOTIFICATION_CHANNEL_KINDS);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKindSchema>;

/** Eventos suscribibles por usuario (RF-NOT-03). */
export const NOTIFICATION_EVENTS = [
  'corrida_con_fallas',
  'corrida_interrumpida',
  'umbral_superado',
  'sync_requiere_intervencion',
] as const;
export const NotificationEventSchema = zEnum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/** `alert.kind`. */
export const ALERT_KINDS = ['umbral_rendimiento', 'corrida_fallida', 'corrida_interrumpida', 'disponibilidad'] as const;
export const AlertKindSchema = zEnum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

/** `alert.status`. Recuperación se registra sin notificación obligatoria (ESP §13.8). */
export const ALERT_STATUSES = ['activa', 'recuperada'] as const;
export const AlertStatusSchema = zEnum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

// ---------------------------------------------------------------------------
// Artefactos (ESP §7, §13.7)
// ---------------------------------------------------------------------------

/** `artifact.kind`. */
export const ARTIFACT_KINDS = [
  'reporte',
  'traza',
  'video',
  'captura',
  'log',
  'dxmon_samples',
  'dxmon_summary',
] as const;
export const ArtifactKindSchema = zEnum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** `artifact.sanitization_status`. Solo `sanitizado` es publicable (ESP §7, RF-RES-02). */
export const SANITIZATION_STATUSES = ['pendiente', 'sanitizado', 'deshabilitado', 'fallido', 'retenido'] as const;
export const SanitizationStatusSchema = zEnum(SANITIZATION_STATUSES);
export type SanitizationStatus = z.infer<typeof SanitizationStatusSchema>;

// ---------------------------------------------------------------------------
// Rendimiento DXMon (ESP §7, §13.8)
// ---------------------------------------------------------------------------

/** `perf_sample.source`. */
export const PERF_SOURCES = ['ui', 'raiz', 'probe', 'app'] as const;
export const PerfSourceSchema = zEnum(PERF_SOURCES);
export type PerfSource = z.infer<typeof PerfSourceSchema>;

/** `perf_threshold.metric`. */
export const PERF_METRICS = ['p95', 'max', 'error_rate', 'timeout_rate'] as const;
export const PerfMetricSchema = zEnum(PERF_METRICS);
export type PerfMetric = z.infer<typeof PerfMetricSchema>;

/**
 * `perf_sample.metric_kind` (fronteras ESP §13.8). `root_current_wait` = espera por `current` dentro del arranque
 * (submétrica; no prueba que la pantalla esté lista). Alineado con qa-tests/tools/perf-contract.ts (D-016).
 */
export const PERF_METRIC_KINDS = ['network_request', 'screen_ready', 'root_ready', 'root_current_wait'] as const;
export const PerfMetricKindSchema = zEnum(PERF_METRIC_KINDS);
export type PerfMetricKind = z.infer<typeof PerfMetricKindSchema>;

/** `perf_sample.provenance`: quién midió. Series DXMon y Playwright nunca se mezclan (ESP §13.8, D-016). */
export const PERF_PROVENANCES = ['dxmon', 'playwright'] as const;
export const PerfProvenanceSchema = zEnum(PERF_PROVENANCES);
export type PerfProvenance = z.infer<typeof PerfProvenanceSchema>;

/** `perf_sample.error_kind`: HTTP no exitoso, error de red, timeout o condición de pantalla fallida. */
export const PERF_ERROR_KINDS = ['http', 'red', 'timeout', 'condicion'] as const;
export const PerfErrorKindSchema = zEnum(PERF_ERROR_KINDS);
export type PerfErrorKind = z.infer<typeof PerfErrorKindSchema>;

/** `perf_sample.cache_mode`. */
export const CACHE_MODES = ['fria', 'caliente', 'desconocida'] as const;
export const CacheModeSchema = zEnum(CACHE_MODES);
export type CacheMode = z.infer<typeof CacheModeSchema>;

/** Granularidad de agregados (RF-REN-02). */
export const PERF_GRANULARITIES = ['minute', 'hour', 'day'] as const;
export const PerfGranularitySchema = zEnum(PERF_GRANULARITIES);
export type PerfGranularity = z.infer<typeof PerfGranularitySchema>;

// ---------------------------------------------------------------------------
// Grabación y dispositivos (ESP §13.6)
// ---------------------------------------------------------------------------

/** `recording_session.status` — ESP §13.6. */
export const RECORDING_STATUSES = [
  'creada',
  'vinculada',
  'grabando',
  'validando',
  'pr_abierto',
  'rechazada',
  'cancelada',
  'vencida',
] as const;
export const RecordingStatusSchema = zEnum(RECORDING_STATUSES);
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;
export const TERMINAL_RECORDING_STATUSES = [
  'pr_abierto',
  'rechazada',
  'cancelada',
  'vencida',
] as const satisfies readonly RecordingStatus[];

/** `device_authorization.status` (flujo de dispositivo, ESP §13.6). */
export const DEVICE_AUTHORIZATION_STATUSES = ['pendiente', 'aprobada', 'denegada', 'vencida', 'consumida'] as const;
export const DeviceAuthorizationStatusSchema = zEnum(DEVICE_AUTHORIZATION_STATUSES);
export type DeviceAuthorizationStatus = z.infer<typeof DeviceAuthorizationStatusSchema>;

// ---------------------------------------------------------------------------
// Identidad y acceso (ESP §3, RF-USR)
// ---------------------------------------------------------------------------

/** Roles de usuario del panel: `qa < dev < admin` (ESP §3). */
export const PANEL_ROLES = ['qa', 'dev', 'admin'] as const;
export const PanelRoleSchema = zEnum(PANEL_ROLES);
export type PanelRole = z.infer<typeof PanelRoleSchema>;

/** Todos los roles incluyendo el actor de sistema `servicio` (worker/supervisor). */
export const ROLES = ['qa', 'dev', 'admin', 'servicio'] as const;
export const RoleSchema = zEnum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** `api_credential.kind` (RF-USR-03). */
export const API_CREDENTIAL_KINDS = ['token_api', 'servicio_supervisor', 'dispositivo'] as const;
export const ApiCredentialKindSchema = zEnum(API_CREDENTIAL_KINDS);
export type ApiCredentialKind = z.infer<typeof ApiCredentialKindSchema>;

/** Tipo de actor registrado en auditoría (RF-USR-02). */
export const ACTOR_KINDS = ['panel_user', 'api_credential', 'servicio', 'sistema'] as const;
export const ActorKindSchema = zEnum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof ActorKindSchema>;

// ---------------------------------------------------------------------------
// Exportaciones e IA
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export const ExportFormatSchema = zEnum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/** `export_job.status`. */
export const JOB_STATUSES = ['pendiente', 'en_proceso', 'listo', 'fallido', 'vencido'] as const;
export const JobStatusSchema = zEnum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** `generation_request.status` (RF-GRB-03/04). */
export const GENERATION_STATUSES = ['pendiente', 'en_proceso', 'listo', 'fallido', 'rechazado_presupuesto'] as const;
export const GenerationStatusSchema = zEnum(GENERATION_STATUSES);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

export const GENERATION_KINDS = ['borrador_desde_caso', 'revision_grabacion'] as const;
export const GenerationKindSchema = zEnum(GENERATION_KINDS);
export type GenerationKind = z.infer<typeof GenerationKindSchema>;

// ---------------------------------------------------------------------------
// Eventos en vivo (plan §4.4)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'run.created',
  'run.updated',
  'run_result.updated',
  'attempt.updated',
  'shard.updated',
  'case_result.updated',
  'sync.updated',
  'schedule.updated',
  'schedule.occurrence',
  'alert.updated',
  'catalog.updated',
  'testrail.sync',
  'recording.updated',
  'export.updated',
  'generation.updated',
] as const;
export const EventTypeSchema = zEnum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EVENT_ENTITIES = [
  'run',
  'run_result',
  'test_attempt',
  'run_shard',
  'case_result',
  'run_testrail_target',
  'schedule',
  'schedule_occurrence',
  'alert',
  'catalog_revision',
  'testrail_sync_run',
  'recording_session',
  'export_job',
  'generation_request',
] as const;
export const EventEntitySchema = zEnum(EVENT_ENTITIES);
export type EventEntity = z.infer<typeof EventEntitySchema>;
