/**
 * Funciones tipadas por recurso sobre el cliente único. Cada ruta, método, código de estado y forma de respuesta
 * corresponde a `apps/api/src/modules/<módulo>/routes.ts` (inventario `ROUTES` de @katalyst/shared/rbac). No hay
 * endpoints inventados: lo que la API no expone se deriva en el panel (`features/common/derived.ts`).
 */
import type { z } from 'zod';
import type {
  ApiTokenCreateRequest,
  EnvironmentCreate,
  EnvironmentUpdate,
  EventMarkCreateSchema,
  ExportCreate,
  LoginRequest,
  NotificationChannelUpdateSchema,
  NotificationPreferencesUpdateSchema,
  PanelUserCreate,
  PanelUserUpdate,
  PerfThresholdCreate,
  PerfThresholdUpdateSchema,
  RecordingCreate,
  RunCreateRequest,
  RunPreviewRequest,
  SchedulePreviewRequestSchema,
  ScheduleCreate,
  ScheduleUpdate,
  SuiteCreate,
  SuiteUpdate,
  TestRailConnectionTestRequestSchema,
  TestRailConnectionUpdate,
  TestUserCreateSchema,
  TestUserUpdateSchema,
} from '@katalyst/shared/schemas';
import { api, apiRequest, type QueryValue } from './client';
import type * as T from './types';

type Q = Record<string, QueryValue>;
type EventMarkCreate = z.input<typeof EventMarkCreateSchema>;
type NotificationChannelUpdate = z.input<typeof NotificationChannelUpdateSchema>;
type NotificationPreferencesUpdate = z.input<typeof NotificationPreferencesUpdateSchema>;
type PerfThresholdUpdate = z.input<typeof PerfThresholdUpdateSchema>;
type SchedulePreviewRequest = z.input<typeof SchedulePreviewRequestSchema>;
type TestRailConnectionTestRequest = z.input<typeof TestRailConnectionTestRequestSchema>;
type TestUserCreate = z.input<typeof TestUserCreateSchema>;
type TestUserUpdate = z.input<typeof TestUserUpdateSchema>;
type Ok = { ok: true };
type Items<X> = { items: X[] };
const enc = encodeURIComponent;

export const authApi = {
  providers: (signal?: AbortSignal) =>
    apiRequest<T.AuthProviders>('/auth/providers', { signal, skipAuthRedirect: true }),
  me: (signal?: AbortSignal) => apiRequest<T.Me>('/auth/me', { signal, skipAuthRedirect: true }),
  /** 200 `MeResponse`; 401 INVALID_CREDENTIALS, 403 USER_DISABLED, 429 RATE_LIMITED (`retryAfterSeconds`). */
  login: (body: LoginRequest) =>
    apiRequest<T.Me>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
  logout: () => api.post<Ok>('/auth/logout', {}, { skipAuthRedirect: true }),
  tokens: (q: Q = {}, signal?: AbortSignal) => api.get<T.Page<T.ApiToken>>('/auth/tokens', q, signal),
  /** 201 `{credential, token}`: el valor del token se muestra una sola vez. */
  createToken: (body: ApiTokenCreateRequest) => api.post<T.ApiTokenCreated>('/auth/tokens', body),
  /** 200 con el token revocado. */
  revokeToken: (id: string) => api.delete<T.ApiToken>(`/auth/tokens/${enc(id)}`),
};

export const catalogApi = {
  sections: (q: Q = {}, signal?: AbortSignal) => api.get<T.Page<T.Section>>('/testrail/sections', { limit: 100, ...q }, signal),
  cases: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.CaseRow>>('/testrail/cases', q, signal),
  case: (id: string, signal?: AbortSignal) => api.get<T.CaseDetail>(`/testrail/cases/${enc(id)}`, undefined, signal),
  caseHistory: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.History>(`/testrail/cases/${enc(id)}/history`, q, signal),
  /** `GET /tests?tag=&case=&caseId=&section=&status=&classification=&lastResult=&flaky=&q=&sort=`. */
  tests: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.AutomatedTest>>('/tests', q, signal),
  test: (id: string, signal?: AbortSignal) => api.get<T.AutomatedTest>(`/tests/${enc(id)}`, undefined, signal),
  testHistory: (id: string, q: Q, signal?: AbortSignal) => api.get<T.History>(`/tests/${enc(id)}/history`, q, signal),
  reviewLink: (testId: string, caseId: string, body: { caseRevision: number; comment?: string }) =>
    api.put<unknown>(`/tests/${enc(testId)}/case-links/${enc(caseId)}/review`, body),
  /** 202 con la corrida de sincronización. */
  sync: () => api.post<T.SyncRun>('/testrail/sync', {}),
};

export const suitesApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Suite>>('/suites', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Suite>(`/suites/${enc(id)}`, undefined, signal),
  create: (body: SuiteCreate) => api.post<T.Suite>('/suites', body),
  update: (id: string, body: SuiteUpdate) => api.put<T.Suite>(`/suites/${enc(id)}`, body),
  /** Borrado lógico: 200 con la suite (`deletedAt`). */
  remove: (id: string) => api.delete<T.Suite>(`/suites/${enc(id)}`),
};

export const envApi = {
  /** Resumen para qa/dev, detalle para admin; excluye deshabilitados salvo `includeDisabled` (admin). */
  list: (signal?: AbortSignal, q: Q = {}) =>
    api.get<T.Page<T.EnvironmentListItem>>('/environments', { limit: 100, ...q }, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Environment>(`/environments/${enc(id)}`, undefined, signal),
  create: (body: EnvironmentCreate) => api.post<T.Environment>('/environments', body),
  update: (id: string, body: EnvironmentUpdate) => api.put<T.Environment>(`/environments/${enc(id)}`, body),
  users: (id: string, signal?: AbortSignal, q: Q = {}) =>
    api.get<T.Page<T.TestUser>>(`/environments/${enc(id)}/users`, { limit: 100, ...q }, signal),
  createUser: (id: string, body: TestUserCreate) => api.post<T.TestUser>(`/environments/${enc(id)}/users`, body),
  updateUser: (id: string, userId: string, body: TestUserUpdate) =>
    api.put<T.TestUser>(`/environments/${enc(id)}/users/${enc(userId)}`, body),
};

export const runsApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.RunSummary>>('/runs', q, signal),
  /** KPIs del inicio calculados en servidor (`todayFrom` = inicio del día local, ISO). */
  summary: (q: Q = {}, signal?: AbortSignal) => api.get<T.HomeSummary>('/runs/summary', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.RunDetail>(`/runs/${enc(id)}`, undefined, signal),
  results: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.RunResult>>(`/runs/${enc(id)}/results`, q, signal),
  attempts: (id: string, resultId: string, signal?: AbortSignal) =>
    api.get<Items<T.TestAttempt>>(`/runs/${enc(id)}/results/${enc(resultId)}/attempts`, undefined, signal),
  caseResults: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.CaseResult>>(`/runs/${enc(id)}/case-results`, q, signal),
  targets: (id: string, signal?: AbortSignal) => api.get<Items<T.RunTarget>>(`/runs/${enc(id)}/targets`, undefined, signal),
  artifacts: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.Artifact>>(`/runs/${enc(id)}/artifacts`, q, signal),
  artifactAccess: (id: string, artifactId: string) =>
    api.get<T.ArtifactAccess>(`/runs/${enc(id)}/artifacts/${enc(artifactId)}`),
  preview: (body: RunPreviewRequest, signal?: AbortSignal) =>
    apiRequest<T.RunPreview>('/runs/preview', { method: 'POST', body, signal }),
  /** 201 nueva, 200 repetida (misma Idempotency-Key y cuerpo), 409 IDEMPOTENCY_CONFLICT. */
  create: (body: RunCreateRequest, idempotencyKey: string) =>
    api.post<T.RunSummary>('/runs', body, { idempotencyKey }),
  cancel: (id: string, reason?: string) =>
    api.post<T.RunCancelResponse>(`/runs/${enc(id)}/cancel`, reason ? { reason } : {}),
};

export const schedulesApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Schedule>>('/schedules', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Schedule>(`/schedules/${enc(id)}`, undefined, signal),
  create: (body: ScheduleCreate) => api.post<T.Schedule>('/schedules', body),
  update: (id: string, body: ScheduleUpdate) => api.put<T.Schedule>(`/schedules/${enc(id)}`, body),
  /** 200 `{ok:true}` (borrado lógico). */
  remove: (id: string) => api.delete<Ok>(`/schedules/${enc(id)}`),
  pause: (id: string) => api.post<T.Schedule>(`/schedules/${enc(id)}/pause`, {}),
  resume: (id: string) => api.post<T.Schedule>(`/schedules/${enc(id)}/resume`, {}),
  /** 201 con la copia (queda pausada). */
  duplicate: (id: string, name?: string) =>
    api.post<T.Schedule>(`/schedules/${enc(id)}/duplicate`, name ? { name } : {}),
  next: (id: string, count = 5, signal?: AbortSignal) =>
    api.get<T.ScheduleNext>(`/schedules/${enc(id)}/next`, { count }, signal),
  /** Siempre 200: los problemas de la expresión llegan en `issues` (no como 422). */
  preview: (body: SchedulePreviewRequest, signal?: AbortSignal) =>
    apiRequest<T.SchedulePreview>('/schedules/preview', { method: 'POST', body, signal }),
  revisions: (id: string, q: Q = {}, signal?: AbortSignal) =>
    api.get<T.Page<T.ScheduleRevision>>(`/schedules/${enc(id)}/revisions`, { limit: 100, ...q }, signal),
  occurrences: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.ScheduleOccurrence>>(`/schedules/${enc(id)}/occurrences`, q, signal),
};

export const perfApi = {
  /** `GET /perf?environmentId&from&to&by=minute|hour|day&compare=none|previous_period&endpoint&screen&…`. */
  aggregates: (q: Q, signal?: AbortSignal) => api.get<T.PerfResponse>('/perf', q, signal),
  series: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PerfSeriesItem>>('/perf/series', q, signal),
  errors: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PerfErrorItem>>('/perf/errors', q, signal),
  thresholds: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PerfThreshold>>('/perf/thresholds', q, signal),
  createThreshold: (body: PerfThresholdCreate) => api.post<T.PerfThreshold>('/perf/thresholds', body),
  /** Cuerpo completo + `version` (no parcial). */
  updateThreshold: (id: string, body: PerfThresholdUpdate) =>
    api.put<T.PerfThreshold>(`/perf/thresholds/${enc(id)}`, body),
  removeThreshold: (id: string) => api.delete<Ok>(`/perf/thresholds/${enc(id)}`),
  marks: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.EventMark>>('/events', q, signal),
  createMark: (body: EventMarkCreate) => api.post<T.EventMark>('/events', body),
};

export const alertsApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Alert>>('/alerts', q, signal),
};

export const testrailApi = {
  syncRuns: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.SyncRun>>('/testrail/sync-runs', q, signal),
  deliveries: (q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.Delivery>>('/integrations/testrail/deliveries', q, signal),
  retryDelivery: (id: string, note?: string) =>
    api.post<T.DeliveryRetry>(`/integrations/testrail/deliveries/${enc(id)}/retry`, note ? { note } : {}),
  connection: (signal?: AbortSignal) => api.get<T.TestRailConnection>('/testrail/connection', undefined, signal),
  saveConnection: (body: TestRailConnectionUpdate) => api.put<T.TestRailConnection>('/testrail/connection', body),
  testConnection: (body: TestRailConnectionTestRequest) =>
    api.post<T.TestRailConnectionTest>('/testrail/connection/test', body),
  /** RF-TR-06 · Plan de TestRail existente (lectura en vivo; 404 si no existe, 502/503 si TestRail no responde). */
  plan: (planId: number, signal?: AbortSignal) => api.get<T.TestRailPlan>(`/testrail/plans/${planId}`, undefined, signal),
  /** RF-TR-06 · Tests de una corrida existente de TestRail (lectura en vivo). */
  runTests: (trRunId: number, signal?: AbortSignal) =>
    api.get<T.TestRailRunTests>(`/testrail/runs/${trRunId}/tests`, undefined, signal),
};

export const auditApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.AuditEntry>>('/audit-log', q, signal),
};

export const usersApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PanelUser>>('/users', q, signal),
  create: (body: PanelUserCreate) => api.post<T.PanelUser>('/users', body),
  update: (id: string, body: PanelUserUpdate) => api.put<T.PanelUser>(`/users/${enc(id)}`, body),
};

export const notificationsApi = {
  channels: (signal?: AbortSignal) => api.get<Items<T.NotificationChannel>>('/notifications/channels', undefined, signal),
  updateChannel: (kind: string, body: NotificationChannelUpdate) =>
    api.put<T.NotificationChannel>(`/notifications/channels/${enc(kind)}`, body),
  testChannel: (kind: string) => api.post<T.NotificationChannelTest>(`/notifications/channels/${enc(kind)}/test`, {}),
  preferences: (signal?: AbortSignal) =>
    api.get<T.NotificationPreferences>('/notifications/preferences', undefined, signal),
  updatePreferences: (body: NotificationPreferencesUpdate) =>
    api.put<T.NotificationPreferences>('/notifications/preferences', body),
};

export const exportsApi = {
  /** `pagina` ⇒ 201 `listo`; `completo` ⇒ 202 `pendiente` (consultar `get` hasta `listo|fallido`). */
  create: (body: ExportCreate) => api.post<T.ExportJob>('/exports', body),
  get: (id: string, signal?: AbortSignal) => api.get<T.ExportJob>(`/exports/${enc(id)}`, undefined, signal),
  /** URL firmada ≤ 5 min; 409 CONFLICT si aún se genera, 404 si venció. */
  download: (id: string) => api.get<T.ExportDownload>(`/exports/${enc(id)}/download`),
};

export const recordingsApi = {
  create: (body: RecordingCreate) => api.post<T.RecordingCreated>('/recordings', body),
  get: (id: string, signal?: AbortSignal) => api.get<T.RecordingSession>(`/recordings/${enc(id)}`, undefined, signal),
  cancel: (id: string, reason?: string) =>
    api.post<T.RecordingSession>(`/recordings/${enc(id)}/cancel`, reason ? { reason } : {}),
};

export const devicesApi = {
  status: (signal?: AbortSignal) => api.get<T.DeviceStatus>('/devices/status', undefined, signal),
  list: (signal?: AbortSignal) => api.get<Items<T.Device>>('/devices', undefined, signal),
  /** 200 `{ok:true}`: revoca la credencial del asistente. */
  revoke: (id: string) => api.delete<Ok>(`/devices/${enc(id)}`),
  /** 404 si el código no existe; `status` `pendiente|aprobada|denegada|vencida|consumida`. */
  authorization: (userCode: string, signal?: AbortSignal) =>
    api.get<T.DeviceAuthorizationView>(`/devices/authorizations/${enc(userCode)}`, undefined, signal),
  /** 400 DEVICE_CODE_EXPIRED, 409 CONFLICT (ya resuelta), 404 inexistente. */
  approve: (userCode: string) => api.post<Ok>('/devices/approve', { userCode }),
  deny: (userCode: string) => api.post<Ok>('/devices/deny', { userCode }),
};

export const generateApi = {
  /** 201 con la solicitud (`en_proceso` → `listo|fallido` por SSE `generation.updated`). */
  create: (caseId: string) => api.post<T.GenerationRequest>('/generate', { caseId }),
  review: (recordingId: string) => api.post<T.GenerationRequest>('/generate/review', { recordingId }),
  get: (id: string, signal?: AbortSignal) => api.get<T.GenerationRequest>(`/generate/${enc(id)}`, undefined, signal),
};

/** Normaliza `{items}` / página / arreglo a arreglo. */
export function itemsOf<X>(v: { items: X[] } | X[] | undefined | null): X[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.items;
}
