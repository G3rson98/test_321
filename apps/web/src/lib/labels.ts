/**
 * Mapeo enum ESP → etiqueta en español + tono visual (ui-capturas §6.2 #10, decisión D-WEB-03).
 * `status`, `outcome` y `sync_status` son dimensiones separadas (ESP §13.2): nunca se mezclan en una misma etiqueta.
 */
import type {
  CaseResultStatus,
  Coverage,
  ErrorCategory,
  OccurrenceSkipReason,
  OutboxOperation,
  OutboxStatus,
  PanelRole,
  RecordingStatus,
  ResultReason,
  RunOutcome,
  RunResultStatus,
  RunStatus,
  RunTrigger,
  SyncRunStatus,
  SyncStatus,
  Classification,
  TestStatus,
  ArtifactKind,
  SanitizationStatus,
  JobStatus,
} from '@katalyst/shared/enums';

export type Tone =
  | 'passed'
  | 'failed'
  | 'flaky'
  | 'running'
  | 'blocked'
  | 'skipped'
  | 'neutral'
  | 'infra'
  | 'outline';

export interface StatusLabel {
  label: string;
  tone: Tone;
  /** Punto pulsante (estados activos). */
  live?: boolean;
}

export const RUN_STATUS_LABEL: Record<RunStatus, StatusLabel> = {
  en_cola: { label: 'En cola', tone: 'outline' },
  preparando: { label: 'Preparando', tone: 'outline', live: true },
  corriendo: { label: 'Corriendo', tone: 'running', live: true },
  finalizando: { label: 'Finalizando', tone: 'outline', live: true },
  terminada: { label: 'Terminada', tone: 'neutral' },
  cancelando: { label: 'Cancelando', tone: 'outline', live: true },
  cancelada: { label: 'Cancelada', tone: 'skipped' },
  interrumpida: { label: 'Interrumpida', tone: 'infra' },
  omitida: { label: 'Omitida', tone: 'skipped' },
};

export const RUN_OUTCOME_LABEL: Record<RunOutcome, StatusLabel> = {
  pasado: { label: 'Pasado', tone: 'passed' },
  inestable: { label: 'Inestable', tone: 'flaky' },
  fallido: { label: 'Fallido', tone: 'failed' },
  bloqueado: { label: 'Bloqueado', tone: 'blocked' },
  incompleto: { label: 'Incompleto', tone: 'skipped' },
};

/** Columna "ESTADO" de corridas: estado activo/terminal no exitoso, o el outcome si `terminada`. */
export function runStateLabel(status: RunStatus, outcome: RunOutcome | null): StatusLabel {
  if (status === 'terminada' && outcome) return RUN_OUTCOME_LABEL[outcome];
  return RUN_STATUS_LABEL[status];
}

export const SYNC_STATUS_LABEL: Record<SyncStatus, StatusLabel> = {
  no_aplica: { label: 'No aplica', tone: 'neutral' },
  pendiente: { label: 'Pendiente', tone: 'flaky' },
  enviando: { label: 'Enviando', tone: 'running', live: true },
  sincronizada: { label: 'Publicado', tone: 'passed' },
  requiere_intervencion: { label: 'Requiere intervención', tone: 'failed' },
};

export const RESULT_STATUS_LABEL: Record<RunResultStatus, StatusLabel> = {
  pendiente: { label: 'Pendiente', tone: 'outline' },
  corriendo: { label: 'Corriendo', tone: 'running', live: true },
  pasado: { label: 'Pasado', tone: 'passed' },
  inestable: { label: 'Inestable', tone: 'flaky' },
  fallido: { label: 'Fallido', tone: 'failed' },
  bloqueado: { label: 'Bloqueado', tone: 'blocked' },
  omitido: { label: 'Omitido', tone: 'skipped' },
  cancelado: { label: 'Cancelado', tone: 'skipped' },
  error_infraestructura: { label: 'Error infra', tone: 'infra' },
};

export const LAST_RESULT_NONE: StatusLabel = { label: 'Sin ejecutar', tone: 'skipped' };

export function lastResultLabel(status: string | null | undefined): StatusLabel {
  if (!status) return LAST_RESULT_NONE;
  return (RESULT_STATUS_LABEL as Record<string, StatusLabel>)[status] ??
    (RUN_OUTCOME_LABEL as Record<string, StatusLabel>)[status] ?? { label: status, tone: 'neutral' };
}

export const CASE_RESULT_LABEL: Record<CaseResultStatus, StatusLabel> = {
  pendiente: { label: 'Pendiente', tone: 'outline' },
  pasado: { label: 'Pasado', tone: 'passed' },
  inestable: { label: 'Inestable', tone: 'flaky' },
  fallido: { label: 'Fallido', tone: 'failed' },
  bloqueado: { label: 'Bloqueado', tone: 'blocked' },
  no_ejecutado: { label: 'No ejecutado', tone: 'skipped' },
};

export const COVERAGE_LABEL: Record<Coverage, string> = {
  completa: 'Completa',
  parcial: 'Parcial',
  ninguna: 'Ninguna',
};

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, StatusLabel> = {
  pendiente: { label: 'Pendiente', tone: 'flaky' },
  en_proceso: { label: 'Enviando', tone: 'running', live: true },
  entregada: { label: 'Entregado', tone: 'passed' },
  requiere_intervencion: { label: 'Requiere intervención', tone: 'failed' },
  vencida: { label: 'Vencida', tone: 'skipped' },
  cancelada: { label: 'Cancelada', tone: 'skipped' },
};

export const OUTBOX_OPERATION_LABEL: Record<OutboxOperation, string> = {
  'run.dispatch_shard': 'Despacho',
  'testrail.add_run': 'Creación de corrida',
  'testrail.add_results_for_cases': 'Resultados',
  'testrail.add_attachment_to_result': 'Adjunto',
  'testrail.close_run': 'Cierre de corrida',
  'notification.run_finished': 'Notificación',
  'notification.alert': 'Alerta',
};

export const SYNC_RUN_LABEL: Record<SyncRunStatus, StatusLabel> = {
  nunca: { label: 'Nunca', tone: 'skipped' },
  en_curso: { label: 'Sincronizando', tone: 'running', live: true },
  exitosa: { label: 'Completa', tone: 'passed' },
  fallida: { label: 'Fallida', tone: 'failed' },
};

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: 'Manual',
  programada: 'Programada',
  api: 'API',
};

export const ROLE_LABEL: Record<PanelRole, string> = {
  qa: 'QA',
  dev: 'Desarrollador',
  admin: 'Administrador',
};

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  lectura: 'lectura',
  escritura: 'escritura',
  sin_clasificar: 'Sin clasificar',
};

export const TEST_STATUS_LABEL: Record<TestStatus, string> = {
  borrador: 'Borrador',
  aprobado: 'Aprobado',
  retirado: 'Retirado',
};

export const RECORDING_STATUS_LABEL: Record<RecordingStatus, StatusLabel> = {
  creada: { label: 'Esperando al asistente', tone: 'outline' },
  vinculada: { label: 'Asistente vinculado', tone: 'running' },
  grabando: { label: 'Grabando', tone: 'failed', live: true },
  validando: { label: 'Validando', tone: 'running', live: true },
  pr_abierto: { label: 'PR abierto', tone: 'passed' },
  rechazada: { label: 'Rechazada', tone: 'failed' },
  cancelada: { label: 'Cancelada', tone: 'skipped' },
  vencida: { label: 'Vencida', tone: 'skipped' },
};

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  reporte: 'Reporte HTML',
  traza: 'Traza de Playwright',
  video: 'Video',
  captura: 'Captura sanitizada',
  log: 'Log',
  dxmon_samples: 'Muestras DXMon',
  dxmon_summary: 'Resumen DXMon',
};

export const SANITIZATION_LABEL: Record<SanitizationStatus, string> = {
  pendiente: 'Procesando',
  sanitizado: 'Disponible',
  deshabilitado: 'Deshabilitada por política',
  fallido: 'Falló la sanitización',
  retenido: 'Retenida por seguridad',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pendiente: 'En cola',
  en_proceso: 'Generando',
  listo: 'Listo',
  fallido: 'Falló',
  vencido: 'Vencido',
};

/** Causas legibles (ESP §13.1, §13.2, §13.5). */
export const REASON_LABEL: Record<ResultReason, string> = {
  sin_automatizacion: 'Sin automatización',
  caso_archivado: 'Caso archivado',
  test_retirado: 'Test retirado',
  test_no_aprobado: 'Test no aprobado',
  clasificacion_ausente: 'Sin clasificar',
  clasificacion_contradictoria: 'Clasificación contradictoria',
  escritura_en_produccion: 'Clasificación escritura',
  revision_pendiente: 'Revisión de pasos pendiente',
  usuario_con_escritura: 'Usuario de prueba con escritura',
  ambiente_deshabilitado: 'Ambiente deshabilitado',
  manifiesto_invalido: 'Manifiesto inválido',
  commit_no_disponible: 'Commit no disponible',
  variante_faltante: 'Variante faltante',
  excluido_inestable: 'Excluido por inestable',
  cancelado_por_usuario: 'Cancelado por el usuario',
  cancelado_por_programacion: 'Cancelado por cambio de programación',
  worker_perdido: 'Se perdió el ejecutor',
  recuperacion_agotada: 'Recuperación agotada',
  escritura_resultado_desconocido: 'Escritura con resultado desconocido',
  timeout_test: 'Tiempo de test agotado',
  timeout_preparacion: 'Tiempo de preparación agotado',
  timeout_corrida: 'Tiempo de corrida agotado',
  login_fallido: 'Falló el inicio de sesión',
  dependencia_fallida: 'Falló una dependencia',
  sin_capacidad: 'Sin capacidad',
  error_interno: 'Error interno',
};

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return '';
  return (REASON_LABEL as Record<string, string>)[code] ?? code;
}

export const OCCURRENCE_REASON_LABEL: Record<OccurrenceSkipReason, string> = {
  solapamiento: 'Solapamiento con una ejecución activa',
  sin_capacidad: 'Sin capacidad',
  caida_servicio: 'Servicio caído',
  ventana_exclusion: 'Ventana de exclusión',
  programacion_pausada: 'Programación pausada',
  configuracion_invalida: 'Configuración inválida',
  seleccion_vacia: 'Selección vacía',
  ambiente_deshabilitado: 'Ambiente deshabilitado',
};

/** Origen de la falla (ESP §13.2: aplicación vs runner vs publicación). */
export const ERROR_CATEGORY_LABEL: Record<ErrorCategory, { label: string; origin: 'app' | 'infra' | 'auth' | 'otro' }> = {
  asercion: { label: 'Verificación fallida', origin: 'app' },
  timeout_aplicacion: { label: 'Timeout de la aplicación', origin: 'app' },
  error_aplicacion: { label: 'Error de la aplicación', origin: 'app' },
  login: { label: 'Inicio de sesión', origin: 'auth' },
  navegador_no_disponible: { label: 'Navegador no disponible', origin: 'infra' },
  worker_perdido: { label: 'Ejecutor perdido', origin: 'infra' },
  resultado_desconocido: { label: 'Resultado desconocido', origin: 'infra' },
  timeout_corrida: { label: 'Timeout de la corrida', origin: 'infra' },
  infraestructura: { label: 'Infraestructura', origin: 'infra' },
  politica: { label: 'Política', origin: 'otro' },
  configuracion: { label: 'Configuración', origin: 'otro' },
  cancelacion: { label: 'Cancelación', origin: 'otro' },
  desconocido: { label: 'Desconocido', origin: 'otro' },
};

export const DAY_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'] as const;
export const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;
