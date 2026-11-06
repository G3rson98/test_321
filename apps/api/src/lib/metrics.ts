/**
 * Métricas Prometheus (prom-client) con baja cardinalidad: sin IDs de corrida/usuario ni URLs crudas en etiquetas.
 * RNF-OBS-01 (cola: pendientes, duración, fallas), RNF-OBS-02 (retraso, leases vencidos, outbox pendiente,
 * almacenamiento, última sincronización exitosa). Contrato de deploy: `katalyst_outbox_overdue`,
 * `katalyst_queue_oldest_waiting_seconds`, `katalyst_worker_leases_expired_recent` (docs/pendientes-integracion.md).
 *
 * Los valores que dependen de BD se calculan al hacer scrape mediante colectores registrados
 * (`registerMetricsCollector`), con timeout para no bloquear `/metrics`.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ app: 'katalyst' });

let defaultsStarted = false;
/** Métricas de proceso (CPU, memoria, event loop). Idempotente. */
export function startDefaultMetrics(service: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  collectDefaultMetrics({ register: metricsRegistry, prefix: 'katalyst_process_', labels: { service } });
}

const reg = [metricsRegistry];

export const metrics = {
  httpRequests: new Counter({
    name: 'katalyst_http_requests_total',
    help: 'Solicitudes HTTP por ruta (patrón), método y clase de estado',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: reg,
  }),
  httpDuration: new Histogram({
    name: 'katalyst_http_request_duration_seconds',
    help: 'Duración de solicitudes HTTP por ruta (patrón)',
    labelNames: ['method', 'route'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: reg,
  }),
  authFailures: new Counter({
    name: 'katalyst_auth_failures_total',
    help: 'Fallos de autenticación por motivo',
    labelNames: ['reason'] as const,
    registers: reg,
  }),
  outboxPending: new Gauge({
    name: 'katalyst_outbox_pending',
    help: 'Entregas de outbox pendientes o en proceso por familia de operación',
    labelNames: ['family'] as const,
    registers: reg,
  }),
  outboxOverdue: new Gauge({
    name: 'katalyst_outbox_overdue',
    help: 'Entregas de outbox vencidas (24 h) o con próximo intento atrasado más de 1 h',
    registers: reg,
  }),
  outboxIntervention: new Gauge({
    name: 'katalyst_outbox_requires_intervention',
    help: 'Entregas de outbox que requieren intervención administrativa',
    registers: reg,
  }),
  outboxDeliveries: new Counter({
    name: 'katalyst_outbox_deliveries_total',
    help: 'Resultados de intentos de entrega de outbox',
    labelNames: ['family', 'result'] as const,
    registers: reg,
  }),
  outboxAttemptDuration: new Histogram({
    name: 'katalyst_outbox_attempt_duration_seconds',
    help: 'Duración de intentos de entrega de outbox',
    labelNames: ['family'] as const,
    buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: reg,
  }),
  testrailLastSuccessfulSync: new Gauge({
    name: 'katalyst_testrail_last_successful_sync_timestamp_seconds',
    help: 'Instante Unix de la última sincronización TestRail exitosa (0 = nunca)',
    registers: reg,
  }),
  testrailSyncs: new Counter({
    name: 'katalyst_testrail_syncs_total',
    help: 'Sincronizaciones TestRail por resultado',
    labelNames: ['status', 'trigger'] as const,
    registers: reg,
  }),
  testrailRequests: new Counter({
    name: 'katalyst_testrail_requests_total',
    help: 'Llamadas a la API de TestRail por endpoint y clase de estado',
    labelNames: ['endpoint', 'status_class'] as const,
    registers: reg,
  }),
  queueOldestWaiting: new Gauge({
    name: 'katalyst_queue_oldest_waiting_seconds',
    help: 'Antigüedad de la corrida en cola más antigua (s)',
    registers: reg,
  }),
  queuePending: new Gauge({
    name: 'katalyst_queue_pending',
    help: 'Corridas en cola o preparando',
    registers: reg,
  }),
  workerLeasesExpiredRecent: new Gauge({
    name: 'katalyst_worker_leases_expired_recent',
    help: 'Leases vencidos/revocados en los últimos 15 min',
    registers: reg,
  }),
  catalogLastRevision: new Gauge({
    name: 'katalyst_catalog_last_complete_revision_timestamp_seconds',
    help: 'Instante Unix de la última revisión completa del catálogo (0 = nunca)',
    registers: reg,
  }),
  artifactsStoredBytes: new Gauge({
    name: 'katalyst_artifacts_stored_bytes',
    help: 'Bytes de evidencia almacenada vigente (según BD)',
    registers: reg,
  }),
};

export type MetricsCollector = () => Promise<void>;
const collectors = new Map<string, MetricsCollector>();

/** Registra (o reemplaza por nombre) un colector que actualiza gauges antes de cada scrape. */
export function registerMetricsCollector(name: string, fn: MetricsCollector): void {
  collectors.set(name, fn);
}

/** Ejecuta colectores con timeout individual y devuelve el texto de exposición. */
export async function renderMetrics(timeoutMs = 2_000): Promise<string> {
  await Promise.all(
    [...collectors.values()].map((fn) =>
      Promise.race([
        fn().catch(() => undefined),
        new Promise((r) => setTimeout(r, timeoutMs).unref()),
      ]),
    ),
  );
  return metricsRegistry.metrics();
}

export const METRICS_CONTENT_TYPE = metricsRegistry.contentType;

/** Familia de operación de outbox (`testrail`, `notification`, `run`) para etiquetas acotadas. */
export function opFamily(operation: string): string {
  const f = operation.split('.')[0] ?? 'otro';
  return ['testrail', 'notification', 'run'].includes(f) ? f : 'otro';
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
