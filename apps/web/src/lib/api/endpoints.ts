/**
 * Funciones tipadas por recurso sobre el cliente único. Rutas tomadas de `ROUTES` (@katalyst/shared/rbac);
 * las marcadas PENDIENTE no existen aún en ROUTES (ver docs/pendientes-integracion.md).
 */
import type {
  ApiTokenCreateRequest,
  EnvironmentCreate,
  EnvironmentUpdate,
  ExportCreate,
  LoginRequest,
  PanelUserCreate,
  PanelUserUpdate,
  PerfThresholdCreate,
  RecordingCreate,
  RunCreateRequest,
  RunPreviewRequest,
  ScheduleCreate,
  ScheduleUpdate,
  SuiteCreate,
  SuiteUpdate,
  TestRailConnectionUpdate,
} from '@katalyst/shared/schemas';
import { api, apiRequest, type QueryValue } from './client';
import type * as T from './types';

type Q = Record<string, QueryValue>;
const enc = encodeURIComponent;

export const authApi = {
  providers: (signal?: AbortSignal) =>
    apiRequest<T.AuthProviders>('/auth/providers', { signal, skipAuthRedirect: true }),
  me: (signal?: AbortSignal) => apiRequest<T.Me>('/auth/me', { signal, skipAuthRedirect: true }),
  login: (body: LoginRequest) =>
    apiRequest<T.Me>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
  logout: () => api.post<{ ok: true }>('/auth/logout', {}, { skipAuthRedirect: true }),
  tokens: (signal?: AbortSignal) => api.get<T.Page<T.ApiToken>>('/auth/tokens', undefined, signal),
  createToken: (body: ApiTokenCreateRequest) => api.post<T.ApiTokenCreated>('/auth/tokens', body),
  revokeToken: (id: string) => api.delete<void>(`/auth/tokens/${enc(id)}`),
};

export const dashboardApi = {
  /** PENDIENTE [WEB→API-B]. */
  summary: (signal?: AbortSignal) => api.get<T.DashboardSummary>('/dashboard/summary', undefined, signal),
};

export const catalogApi = {
  sections: (signal?: AbortSignal) => api.get<T.Page<T.Section> | T.Section[]>('/testrail/sections', undefined, signal),
  cases: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.CaseRow>>('/testrail/cases', q, signal),
  case: (id: string, signal?: AbortSignal) => api.get<T.CaseDetail>(`/testrail/cases/${enc(id)}`, undefined, signal),
  caseHistory: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.History>(`/testrail/cases/${enc(id)}/history`, q, signal),
  test: (id: string, signal?: AbortSignal) => api.get<T.AutomatedTest>(`/tests/${enc(id)}`, undefined, signal),
  /** PENDIENTE [WEB→API-A]. */
  testSource: (id: string, signal?: AbortSignal) =>
    api.get<T.TestSource>(`/tests/${enc(id)}/source`, undefined, signal),
  /** PENDIENTE [WEB→API-A]: etiquetas conocidas del manifiesto vigente. */
  tags: (signal?: AbortSignal) => api.get<{ items: string[] }>('/catalog/tags', undefined, signal),
  reviewLink: (testId: string, caseId: string, body: { caseRevision: number; comment?: string }) =>
    api.put<unknown>(`/tests/${enc(testId)}/case-links/${enc(caseId)}/review`, body),
  sync: () => api.post<T.SyncRun>('/testrail/sync', {}),
};

export const suitesApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Suite>>('/suites', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Suite>(`/suites/${enc(id)}`, undefined, signal),
  create: (body: SuiteCreate) => api.post<T.Suite>('/suites', body),
  update: (id: string, body: SuiteUpdate) => api.put<T.Suite>(`/suites/${enc(id)}`, body),
  remove: (id: string) => api.delete<void>(`/suites/${enc(id)}`),
};

export const envApi = {
  list: (signal?: AbortSignal) =>
    api.get<T.Page<T.EnvironmentSummary> | T.EnvironmentSummary[]>('/environments', undefined, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Environment>(`/environments/${enc(id)}`, undefined, signal),
  create: (body: EnvironmentCreate) => api.post<T.Environment>('/environments', body),
  update: (id: string, body: EnvironmentUpdate) => api.put<T.Environment>(`/environments/${enc(id)}`, body),
  users: (id: string, signal?: AbortSignal) =>
    api.get<T.Page<T.TestUser> | T.TestUser[]>(`/environments/${enc(id)}/users`, undefined, signal),
  createUser: (id: string, body: unknown) => api.post<T.TestUser>(`/environments/${enc(id)}/users`, body),
  updateUser: (id: string, userId: string, body: unknown) =>
    api.put<T.TestUser>(`/environments/${enc(id)}/users/${enc(userId)}`, body),
};

export const runsApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.RunSummary>>('/runs', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.RunDetail>(`/runs/${enc(id)}`, undefined, signal),
  results: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.RunResult>>(`/runs/${enc(id)}/results`, q, signal),
  attempts: (id: string, resultId: string, signal?: AbortSignal) =>
    api.get<T.Page<T.TestAttempt> | T.TestAttempt[]>(
      `/runs/${enc(id)}/results/${enc(resultId)}/attempts`,
      undefined,
      signal,
    ),
  caseResults: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.CaseResult>>(`/runs/${enc(id)}/case-results`, q, signal),
  artifacts: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.Artifact> | T.Artifact[]>(`/runs/${enc(id)}/artifacts`, q, signal),
  artifactAccess: (id: string, artifactId: string) =>
    api.get<T.ArtifactAccess>(`/runs/${enc(id)}/artifacts/${enc(artifactId)}`),
  preview: (body: RunPreviewRequest, signal?: AbortSignal) =>
    apiRequest<T.RunPreview>('/runs/preview', { method: 'POST', body, signal }),
  create: (body: RunCreateRequest, idempotencyKey: string) =>
    api.post<T.RunSummary>('/runs', body, { idempotencyKey }),
  cancel: (id: string, reason?: string) => api.post<T.RunCancelResponse>(`/runs/${enc(id)}/cancel`, { reason }),
};

export const schedulesApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Schedule>>('/schedules', q, signal),
  get: (id: string, signal?: AbortSignal) => api.get<T.Schedule>(`/schedules/${enc(id)}`, undefined, signal),
  create: (body: ScheduleCreate) => api.post<T.Schedule>('/schedules', body),
  update: (id: string, body: ScheduleUpdate) => api.put<T.Schedule>(`/schedules/${enc(id)}`, body),
  remove: (id: string) => api.delete<void>(`/schedules/${enc(id)}`),
  pause: (id: string) => api.post<T.Schedule>(`/schedules/${enc(id)}/pause`, {}),
  resume: (id: string) => api.post<T.Schedule>(`/schedules/${enc(id)}/resume`, {}),
  duplicate: (id: string, name?: string) => api.post<T.Schedule>(`/schedules/${enc(id)}/duplicate`, { name }),
  next: (id: string, count = 5, signal?: AbortSignal) =>
    api.get<T.ScheduleNext>(`/schedules/${enc(id)}/next`, { count }, signal),
  preview: (body: unknown, signal?: AbortSignal) =>
    apiRequest<T.SchedulePreview>('/schedules/preview', { method: 'POST', body, signal }),
  revisions: (id: string, signal?: AbortSignal) =>
    api.get<T.Page<T.ScheduleRevision> | T.ScheduleRevision[]>(`/schedules/${enc(id)}/revisions`, undefined, signal),
  occurrences: (id: string, q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.ScheduleOccurrence>>(`/schedules/${enc(id)}/occurrences`, q, signal),
};

export const perfApi = {
  aggregates: (q: Q, signal?: AbortSignal) => api.get<T.PerfResponse>('/perf', q, signal),
  /** PENDIENTE [WEB→API-C]. */
  summary: (q: Q, signal?: AbortSignal) => api.get<T.PerfSummary>('/perf/summary', q, signal),
  errors: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PerfErrorItem>>('/perf/errors', q, signal),
  thresholds: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.PerfThreshold>>('/perf/thresholds', q, signal),
  createThreshold: (body: PerfThresholdCreate) => api.post<T.PerfThreshold>('/perf/thresholds', body),
  updateThreshold: (id: string, body: unknown) => api.put<T.PerfThreshold>(`/perf/thresholds/${enc(id)}`, body),
  marks: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.EventMark>>('/events', q, signal),
  createMark: (body: unknown) => api.post<T.EventMark>('/events', body),
};

export const alertsApi = {
  list: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.Alert>>('/alerts', q, signal),
};

export const testrailApi = {
  syncRuns: (q: Q, signal?: AbortSignal) => api.get<T.Page<T.SyncRun>>('/testrail/sync-runs', q, signal),
  deliveries: (q: Q, signal?: AbortSignal) =>
    api.get<T.Page<T.Delivery>>('/integrations/testrail/deliveries', q, signal),
  retryDelivery: (id: string, note?: string) =>
    api.post<T.DeliveryRetry>(`/integrations/testrail/deliveries/${enc(id)}/retry`, { note }),
  connection: (signal?: AbortSignal) => api.get<T.TestRailConnection>('/testrail/connection', undefined, signal),
  saveConnection: (body: TestRailConnectionUpdate) => api.put<T.TestRailConnection>('/testrail/connection', body),
  testConnection: (body: unknown) => api.post<T.TestRailConnectionTest>('/testrail/connection/test', body),
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
  channels: (signal?: AbortSignal) =>
    api.get<T.Page<T.NotificationChannel> | T.NotificationChannel[]>('/notifications/channels', undefined, signal),
  updateChannel: (kind: string, body: unknown) =>
    api.put<T.NotificationChannel>(`/notifications/channels/${enc(kind)}`, body),
  testChannel: (kind: string) => api.post<T.NotificationChannelTest>(`/notifications/channels/${enc(kind)}/test`, {}),
  preferences: (signal?: AbortSignal) =>
    api.get<T.NotificationPreferences>('/notifications/preferences', undefined, signal),
  updatePreferences: (body: unknown) => api.put<T.NotificationPreferences>('/notifications/preferences', body),
};

export const exportsApi = {
  create: (body: ExportCreate) => api.post<T.ExportJob>('/exports', body),
  get: (id: string, signal?: AbortSignal) => api.get<T.ExportJob>(`/exports/${enc(id)}`, undefined, signal),
  download: (id: string) => api.get<{ url: string; expiresAt: string }>(`/exports/${enc(id)}/download`),
};

export const recordingsApi = {
  create: (body: RecordingCreate) => api.post<T.RecordingCreated>('/recordings', body),
  get: (id: string, signal?: AbortSignal) => api.get<T.RecordingSession>(`/recordings/${enc(id)}`, undefined, signal),
  cancel: (id: string, reason?: string) => api.post<T.RecordingSession>(`/recordings/${enc(id)}/cancel`, { reason }),
  /** PENDIENTE [WEB→API-C]. */
  command: (id: string, command: T.RecordingCommand) =>
    api.post<T.RecordingSession>(`/recordings/${enc(id)}/commands`, { command }),
};

export const devicesApi = {
  status: (signal?: AbortSignal) => api.get<T.DeviceStatus>('/devices/status', undefined, signal),
  list: (signal?: AbortSignal) => api.get<T.Page<T.Device> | T.Device[]>('/devices', undefined, signal),
  revoke: (id: string) => api.delete<void>(`/devices/${enc(id)}`),
  authorization: (userCode: string, signal?: AbortSignal) =>
    api.get<T.DeviceAuthorizationView>(`/devices/authorizations/${enc(userCode)}`, undefined, signal),
  approve: (userCode: string) => api.post<{ ok: true }>('/devices/approve', { userCode }),
  deny: (userCode: string) => api.post<{ ok: true }>('/devices/deny', { userCode }),
};

export const generateApi = {
  create: (caseId: string) => api.post<T.GenerationRequest>('/generate', { caseId }),
  get: (id: string, signal?: AbortSignal) => api.get<T.GenerationRequest>(`/generate/${enc(id)}`, undefined, signal),
};

export const recordingCreate = (body: RecordingCreate) => recordingsApi.create(body);
export const runCreate = (body: RunCreateRequest, key: string) => runsApi.create(body, key);
export const scheduleSave = (id: string | null, body: ScheduleCreate | ScheduleUpdate) =>
  id ? schedulesApi.update(id, body as ScheduleUpdate) : schedulesApi.create(body as ScheduleCreate);

/** Algunos listados pueden devolver arreglo o página: normaliza a arreglo. */
export function itemsOf<X>(v: T.Page<X> | X[] | undefined | null): X[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.items;
}
