/**
 * Mensajes de notificación (RF-NOT-01, RF-NOT-02): resumen + enlace autenticado al panel. Sin datos sensibles: no se
 * incluyen errores de tests, URLs crudas, cuerpos, usuarios de prueba ni secretos; todo texto pasa por sanitizeText.
 */
import { sanitizeText } from '@katalyst/shared';
import type { NotificationMessage } from '../../adapters/notifier/index.js';

const s = (v: string) => sanitizeText(v).value;

export function panelLink(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function fmtMetric(value: number | null, unit: 'ms' | 'ratio'): string {
  if (value === null) return 'muestra insuficiente';
  return unit === 'ms' ? `${Math.round(value).toLocaleString('es-BO')} ms` : `${(value * 100).toFixed(1)} %`;
}

export interface ThresholdAlertPayload {
  alertId?: string;
  thresholdId: string;
  label: string | null;
  environmentId: string;
  environmentName: string;
  endpointKey: string;
  provenance: string;
  source: string;
  metricKind: string;
  cacheMode: string;
  workerProfile: string | null;
  metric: string;
  unit: 'ms' | 'ratio';
  value: number | null;
  limit: number;
  n: number;
  required: number;
  windowMin: number;
  windowFrom: string;
  windowTo: string;
  evaluatedAt: string;
}

export function thresholdAlertMessage(p: ThresholdAlertPayload, publicBaseUrl: string): NotificationMessage {
  const name = p.label ?? `${p.metric} de ${p.endpointKey}`;
  return {
    subject: s(`[Katalyst] Umbral superado: ${name} (${p.environmentName})`),
    text: s(
      `${p.metric} = ${fmtMetric(p.value, p.unit)} supera el límite ${fmtMetric(p.limit, p.unit)} ` +
        `en la ventana de ${p.windowMin} min (n = ${p.n}).`,
    ),
    link: panelLink(publicBaseUrl, `/rendimiento?ambiente=${encodeURIComponent(p.environmentId)}&alerta=${encodeURIComponent(p.alertId ?? '')}`),
    facts: [
      { name: 'Ambiente', value: s(p.environmentName) },
      { name: 'Serie', value: s(p.endpointKey) },
      { name: 'Origen', value: `${p.provenance}/${p.source} · ${p.metricKind} · caché ${p.cacheMode}` },
      { name: 'Ventana (UTC)', value: `${p.windowFrom} → ${p.windowTo}` },
    ],
    severity: 'warning',
  };
}

export interface RunSummaryForMessage {
  runId: string;
  status: string;
  outcome: string | null;
  trigger: string;
  environmentName: string;
  suiteName: string | null;
  scheduleName: string | null;
  counts: Record<string, number>;
  durationMs: number | null;
  gitCommit: string;
  finishedAt: string | null;
}

export function runFinishedMessage(r: RunSummaryForMessage, publicBaseUrl: string): NotificationMessage {
  const interrupted = r.status === 'interrumpida';
  const what = r.scheduleName ?? r.suiteName ?? 'selección manual';
  const c = (k: string) => String(r.counts[k] ?? 0);
  return {
    subject: s(`[Katalyst] ${interrupted ? 'Ejecución interrumpida' : 'Ejecución con fallas'} · ${what} · ${r.environmentName}`),
    text: s(
      interrupted
        ? 'La ejecución terminó interrumpida por un problema técnico; revisa el detalle en el panel.'
        : `La ejecución terminó con ${c('fallido')} test(s) fallido(s).`,
    ),
    link: panelLink(publicBaseUrl, `/ejecuciones/${encodeURIComponent(r.runId)}`),
    facts: [
      { name: 'Estado', value: `${r.status}${r.outcome ? ` · ${r.outcome}` : ''}` },
      { name: 'Ambiente', value: s(r.environmentName) },
      { name: 'Origen', value: r.trigger },
      { name: 'Pasados', value: `${c('pasado')} (+${c('inestable')} inestables)` },
      { name: 'Fallidos', value: c('fallido') },
      { name: 'Bloqueados/omitidos', value: `${c('bloqueado')} / ${c('omitido')}` },
      { name: 'Infraestructura/cancelados', value: `${c('error_infraestructura')} / ${c('cancelado')}` },
      ...(r.durationMs !== null ? [{ name: 'Duración', value: `${Math.round(r.durationMs / 1000)} s` }] : []),
      { name: 'Commit', value: r.gitCommit.slice(0, 12) },
    ],
    severity: interrupted ? 'warning' : 'error',
  };
}
