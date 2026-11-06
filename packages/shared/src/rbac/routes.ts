/**
 * Inventario de rutas /api/v1 con permiso requerido y módulo dueño (ESP §9 + rutas adicionales + plan §4.3/§4.4).
 * Los módulos de `apps/api` deben registrar exactamente estas rutas; un test de la API puede comparar contra la lista.
 * `public` = sin autenticación (con rate limit); `authenticated` = cualquier sesión válida del panel.
 * `owner` = además de permiso, autorización por recurso (solo el creador/propietario o admin).
 * RNF-SEG-03 (autorización por recurso en cada ruta).
 */
import type { Permission } from './permissions.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteAccess = Permission | 'public' | 'authenticated';
export type ApiModule =
  | 'auth'
  | 'users'
  | 'audit'
  | 'testrail'
  | 'catalog'
  | 'suites'
  | 'runs'
  | 'worker'
  | 'schedules'
  | 'events'
  | 'artifacts'
  | 'perf'
  | 'alerts'
  | 'notifications'
  | 'recordings'
  | 'devices'
  | 'generate'
  | 'exports'
  | 'environments'
  | 'health'
  | 'integrations';

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Ruta relativa a `/api/v1` en sintaxis Fastify (`:id`). Health va fuera del prefijo. */
  readonly path: string;
  readonly access: RouteAccess;
  readonly module: ApiModule;
  readonly owner?: true;
  /** Requiere encabezado `Idempotency-Key` (ESP §9). */
  readonly idempotent?: true;
  /** Autenticación con token de lease del ejecutor (plan §4.3). */
  readonly lease?: true;
  readonly rf: readonly string[];
}

const r = (
  method: HttpMethod,
  path: string,
  access: RouteAccess,
  module: ApiModule,
  rf: readonly string[],
  extra: Partial<Pick<RouteSpec, 'owner' | 'idempotent' | 'lease'>> = {},
): RouteSpec => ({ method, path, access, module, rf, ...extra });

export const API_PREFIX = '/api/v1';

export const ROUTES: readonly RouteSpec[] = [
  // Health (fuera de /api/v1)
  r('GET', '/healthz', 'public', 'health', ['RNF-OBS-02']),
  r('GET', '/readyz', 'public', 'health', ['RNF-OBS-02']),
  r('GET', '/metrics', 'public', 'health', ['RNF-OBS-01', 'RNF-OBS-02']),

  // Auth
  r('GET', '/auth/providers', 'public', 'auth', ['RF-USR-01']),
  r('POST', '/auth/login', 'public', 'auth', ['RF-USR-01']),
  r('POST', '/auth/logout', 'authenticated', 'auth', ['RF-USR-01']),
  r('GET', '/auth/me', 'authenticated', 'auth', ['RF-USR-01']),
  r('POST', '/auth/password/reset-request', 'public', 'auth', ['RF-USR-01']),
  r('POST', '/auth/password/reset', 'public', 'auth', ['RF-USR-01']),
  r('POST', '/auth/password/change', 'authenticated', 'auth', ['RF-USR-01']),
  r('GET', '/auth/tokens', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  r('POST', '/auth/tokens', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  r('DELETE', '/auth/tokens/:id', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  // Credenciales de servicio del supervisor (alcance restringido y expirable, RF-USR-03) y OIDC opcional (ESP §12).
  r('GET', '/auth/service-credentials', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  r('POST', '/auth/service-credentials', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  r('DELETE', '/auth/service-credentials/:id', 'api_tokens.manage', 'auth', ['RF-USR-03']),
  r('GET', '/auth/oidc/login', 'public', 'auth', ['RF-USR-01']),
  r('GET', '/auth/oidc/callback', 'public', 'auth', ['RF-USR-01']),

  // Usuarios del panel y auditoría
  r('GET', '/users', 'users.manage', 'users', ['RF-USR-01']),
  r('POST', '/users', 'users.manage', 'users', ['RF-USR-01']),
  r('GET', '/users/:id', 'users.manage', 'users', ['RF-USR-01']),
  r('PUT', '/users/:id', 'users.manage', 'users', ['RF-USR-01']),
  r('GET', '/audit-log', 'audit.read', 'audit', ['RF-USR-02']),

  // TestRail
  r('GET', '/testrail/connection', 'testrail.connection.manage', 'testrail', ['RF-TR-01']),
  r('PUT', '/testrail/connection', 'testrail.connection.manage', 'testrail', ['RF-TR-01']),
  r('POST', '/testrail/connection/test', 'testrail.connection.manage', 'testrail', ['RF-TR-01']),
  r('POST', '/testrail/sync', 'testrail.sync', 'testrail', ['RF-TR-02']),
  r('GET', '/testrail/sync-runs', 'testrail.read', 'testrail', ['RF-TR-02']),
  r('GET', '/testrail/sync-runs/:id', 'testrail.read', 'testrail', ['RF-TR-02']),
  r('GET', '/testrail/projects', 'testrail.read', 'testrail', ['RF-TR-02']),
  r('GET', '/testrail/suites', 'testrail.read', 'testrail', ['RF-TR-02']),
  r('GET', '/testrail/sections', 'testrail.read', 'testrail', ['RF-TR-02', 'RF-CAT-02']),
  r('GET', '/testrail/cases', 'testrail.read', 'testrail', ['RF-TR-02', 'RF-TR-03']),
  r('GET', '/testrail/cases/:id', 'testrail.read', 'testrail', ['RF-TR-02', 'RF-TR-07']),
  r('GET', '/testrail/cases/:id/history', 'runs.read', 'testrail', ['RF-RES-03']),
  r('GET', '/testrail/plans/:planId', 'testrail.read', 'testrail', ['RF-TR-06']),
  r('GET', '/testrail/runs/:trRunId/tests', 'testrail.read', 'testrail', ['RF-TR-06']),

  // Catálogo de tests
  r('GET', '/tests', 'catalog.read', 'catalog', ['RF-CAT-01', 'RF-CAT-02']),
  r('GET', '/tests/:id', 'catalog.read', 'catalog', ['RF-CAT-01', 'RF-CAT-05']),
  r('GET', '/tests/:id/history', 'runs.read', 'catalog', ['RF-RES-03', 'RF-CAT-04']),
  r('POST', '/tests/refresh', 'catalog.refresh', 'catalog', ['RF-CAT-01']),
  r('GET', '/catalog/revisions', 'catalog.read', 'catalog', ['RF-CAT-01']),
  r('GET', '/catalog/revisions/:id', 'catalog.read', 'catalog', ['RF-CAT-01']),
  r('PUT', '/tests/:id/case-links/:caseId/review', 'catalog.link.review', 'catalog', ['RF-TR-07']),

  // Suites
  r('GET', '/suites', 'suites.read', 'suites', ['RF-CAT-03']),
  r('POST', '/suites', 'suites.write', 'suites', ['RF-CAT-03']),
  r('GET', '/suites/:id', 'suites.read', 'suites', ['RF-CAT-03']),
  r('PUT', '/suites/:id', 'suites.write', 'suites', ['RF-CAT-03']),
  r('DELETE', '/suites/:id', 'suites.write', 'suites', ['RF-CAT-03']),

  // Corridas
  r('POST', '/runs/preview', 'runs.create', 'runs', ['RF-EJE-07']),
  r('POST', '/runs', 'runs.create', 'runs', ['RF-EJE-01', 'RF-EJE-07'], { idempotent: true }),
  r('GET', '/runs', 'runs.read', 'runs', ['RF-RES-01']),
  r('GET', '/runs/:id', 'runs.read', 'runs', ['RF-RES-01', 'RF-RES-05']),
  r('GET', '/runs/:id/results', 'runs.read', 'runs', ['RF-RES-05']),
  r('GET', '/runs/:id/results/:resultId/attempts', 'runs.read', 'runs', ['RF-RES-05', 'RF-EJE-08']),
  r('GET', '/runs/:id/case-results', 'runs.read', 'runs', ['RF-RES-05']),
  r('GET', '/runs/:id/targets', 'runs.read', 'runs', ['RF-TR-04', 'RF-TR-08']),
  r('POST', '/runs/:id/cancel', 'runs.cancel', 'runs', ['RF-EJE-03']),
  r('GET', '/runs/:id/events', 'runs.read', 'events', ['RF-EJE-02']),

  // Artefactos
  r('GET', '/runs/:id/artifacts', 'artifacts.read', 'artifacts', ['RF-RES-02']),
  r('GET', '/runs/:id/artifacts/:artifactId', 'artifacts.read', 'artifacts', ['RF-RES-02', 'RNF-SEG-05']),

  // Eventos en vivo (SSE global)
  r('GET', '/events/stream', 'authenticated', 'events', ['RF-EJE-02', 'RNF-OPT-04']),

  // Programaciones
  r('POST', '/schedules/preview', 'schedules.read', 'schedules', ['RF-PRG-02']),
  r('GET', '/schedules', 'schedules.read', 'schedules', ['RF-PRG-01']),
  r('POST', '/schedules', 'schedules.write', 'schedules', ['RF-PRG-01']),
  r('GET', '/schedules/:id', 'schedules.read', 'schedules', ['RF-PRG-01']),
  r('PUT', '/schedules/:id', 'schedules.write', 'schedules', ['RF-PRG-01', 'RF-PRG-03']),
  r('DELETE', '/schedules/:id', 'schedules.write', 'schedules', ['RF-PRG-03']),
  r('POST', '/schedules/:id/pause', 'schedules.write', 'schedules', ['RF-PRG-03']),
  r('POST', '/schedules/:id/resume', 'schedules.write', 'schedules', ['RF-PRG-03']),
  r('POST', '/schedules/:id/duplicate', 'schedules.write', 'schedules', ['RF-PRG-03']),
  r('GET', '/schedules/:id/next', 'schedules.read', 'schedules', ['RF-PRG-02']),
  r('GET', '/schedules/:id/revisions', 'schedules.read', 'schedules', ['RF-PRG-03']),
  r('GET', '/schedules/:id/occurrences', 'schedules.read', 'schedules', ['RF-PRG-04']),
  r('GET', '/exclusion-windows', 'schedules.read', 'schedules', ['RF-PRG-05']),
  r('POST', '/exclusion-windows', 'exclusion_windows.write', 'schedules', ['RF-PRG-05']),
  r('DELETE', '/exclusion-windows/:id', 'exclusion_windows.write', 'schedules', ['RF-PRG-05']),

  // Grabaciones
  r('POST', '/recordings', 'recordings.create', 'recordings', ['RF-GRB-01']),
  r('GET', '/recordings', 'recordings.read', 'recordings', ['RF-GRB-01'], { owner: true }),
  r('GET', '/recordings/:id', 'recordings.read', 'recordings', ['RF-GRB-01'], { owner: true }),
  r('POST', '/recordings/:id/status', 'recordings.create', 'recordings', ['RF-GRB-06'], { owner: true }),
  r('POST', '/recordings/:id/complete', 'recordings.create', 'recordings', ['RF-GRB-02'], { owner: true }),
  r('POST', '/recordings/:id/cancel', 'recordings.create', 'recordings', ['RF-GRB-06'], { owner: true }),

  // Flujo de dispositivo del asistente local (ESP §13.6)
  r('POST', '/devices/authorize', 'public', 'devices', ['RF-GRB-01']),
  r('POST', '/devices/token', 'public', 'devices', ['RF-GRB-01']),
  r('GET', '/devices/authorizations/:userCode', 'devices.approve', 'devices', ['RF-GRB-01']),
  r('POST', '/devices/approve', 'devices.approve', 'devices', ['RF-GRB-01']),
  r('POST', '/devices/deny', 'devices.approve', 'devices', ['RF-GRB-01']),
  r('GET', '/devices', 'devices.approve', 'devices', ['RF-GRB-01'], { owner: true }),
  r('DELETE', '/devices/:id', 'devices.approve', 'devices', ['RF-GRB-01'], { owner: true }),
  r('GET', '/devices/status', 'recordings.read', 'devices', ['RF-GRB-01'], { owner: true }),
  r('POST', '/devices/heartbeat', 'recordings.create', 'devices', ['RF-GRB-01'], { owner: true }),

  // Generación con IA
  r('POST', '/generate', 'generate.create', 'generate', ['RF-GRB-03']),
  r('POST', '/generate/review', 'generate.create', 'generate', ['RF-GRB-04']),
  r('GET', '/generate/:id', 'generate.create', 'generate', ['RF-GRB-03', 'RF-GRB-04'], { owner: true }),

  // Rendimiento, umbrales, marcas de eventos
  r('GET', '/perf', 'perf.read', 'perf', ['RF-REN-02']),
  r('GET', '/perf/series', 'perf.read', 'perf', ['RF-REN-02']),
  r('GET', '/perf/errors', 'perf.read', 'perf', ['RF-REN-05']),
  r('GET', '/perf/thresholds', 'perf.thresholds.manage', 'perf', ['RF-REN-03']),
  r('POST', '/perf/thresholds', 'perf.thresholds.manage', 'perf', ['RF-REN-03']),
  r('PUT', '/perf/thresholds/:id', 'perf.thresholds.manage', 'perf', ['RF-REN-03']),
  r('DELETE', '/perf/thresholds/:id', 'perf.thresholds.manage', 'perf', ['RF-REN-03']),
  r('GET', '/events', 'perf.read', 'perf', ['RF-REN-04']),
  r('POST', '/events', 'perf.events.write', 'perf', ['RF-REN-04']),

  // Alertas
  r('GET', '/alerts', 'alerts.read', 'alerts', ['RF-REN-03', 'RF-NOT-02']),
  r('GET', '/alerts/:id', 'alerts.read', 'alerts', ['RF-REN-03', 'RF-NOT-02']),

  // Notificaciones
  r('GET', '/notifications/channels', 'notifications.channels.manage', 'notifications', ['RF-NOT-01']),
  r('PUT', '/notifications/channels/:kind', 'notifications.channels.manage', 'notifications', ['RF-NOT-01']),
  r('POST', '/notifications/channels/:kind/test', 'notifications.channels.manage', 'notifications', ['RF-NOT-01']),
  r('GET', '/notifications/preferences', 'notifications.preferences', 'notifications', ['RF-NOT-03'], { owner: true }),
  r('PUT', '/notifications/preferences', 'notifications.preferences', 'notifications', ['RF-NOT-03'], { owner: true }),

  // Ambientes y usuarios de prueba
  r('GET', '/environments', 'environments.list', 'environments', ['RF-AMB-01']),
  r('POST', '/environments', 'environments.manage', 'environments', ['RF-AMB-01']),
  r('GET', '/environments/:id', 'environments.manage', 'environments', ['RF-AMB-01']),
  r('PUT', '/environments/:id', 'environments.manage', 'environments', ['RF-AMB-01']),
  r('GET', '/environments/:id/users', 'environments.manage', 'environments', ['RF-AMB-02']),
  r('POST', '/environments/:id/users', 'environments.manage', 'environments', ['RF-AMB-02']),
  r('PUT', '/environments/:id/users/:userId', 'environments.manage', 'environments', ['RF-AMB-02']),
  r('GET', '/settings/runtime', 'settings.manage', 'environments', ['RF-EJE-04']),
  r('PUT', '/settings/runtime', 'settings.manage', 'environments', ['RF-EJE-04']),

  // Integraciones / outbox
  r('GET', '/integrations/testrail/deliveries', 'integrations.deliveries.read', 'integrations', ['RF-TR-08']),
  r('POST', '/integrations/testrail/deliveries/:id/retry', 'integrations.deliveries.retry', 'integrations', [
    'RF-TR-08',
  ]),

  // Exportaciones
  r('POST', '/exports', 'exports.create', 'exports', ['RF-RES-04']),
  r('GET', '/exports/:id', 'exports.create', 'exports', ['RF-RES-04'], { owner: true }),
  r('GET', '/exports/:id/download', 'exports.create', 'exports', ['RF-RES-04'], { owner: true }),

  // Worker (plan §4.3)
  r('POST', '/worker/claim', 'worker.claim', 'worker', ['RF-EJE-08', 'RNF-CON-01']),
  r('POST', '/worker/catalog/listing', 'worker.claim', 'worker', ['RF-CAT-01']),
  r('POST', '/worker/heartbeat', 'worker.callback', 'worker', ['RNF-CON-01', 'RF-EJE-03'], { lease: true }),
  r('POST', '/worker/attempts', 'worker.callback', 'worker', ['RF-EJE-08'], { lease: true }),
  r('POST', '/worker/results', 'worker.callback', 'worker', ['RF-EJE-08', 'RF-RES-01'], { lease: true }),
  r('POST', '/worker/artifacts/upload', 'worker.callback', 'worker', ['RF-RES-02', 'RNF-SEG-05'], { lease: true }),
  r('POST', '/worker/artifacts/:id/finalize', 'worker.callback', 'worker', ['RF-RES-02'], { lease: true }),
  r('POST', '/worker/perf/samples', 'worker.callback', 'worker', ['RF-REN-01'], { lease: true }),
  r('POST', '/worker/complete', 'worker.callback', 'worker', ['RF-EJE-08'], { lease: true }),
];

/** Busca la especificación de una ruta (método + patrón Fastify). */
export function findRoute(method: HttpMethod, path: string): RouteSpec | undefined {
  return ROUTES.find((x) => x.method === method && x.path === path);
}
