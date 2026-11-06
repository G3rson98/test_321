/**
 * Resumen por serie del período, a partir de `GET /perf`. La media se pondera por respuestas completadas. El p95 del
 * período completo y los bytes promedio los calcula el servidor sobre muestras crudas (`series[].summary`, D-054):
 * el panel nunca recombina p95 por intervalo.
 */
import type { PerfResponse, PerfSeriesKey, PerfThreshold } from '@/lib/api/types';

export interface PerfSummaryRow {
  key: PerfSeriesKey;
  meanMs: number | null;
  /** p95 del período completo (muestras crudas, calculado por la API). */
  p95Ms: number | null;
  p95Status: 'ok' | 'muestra_insuficiente' | 'no_disponible';
  /** Promedio de bytes en red (comprimidos) por respuesta; `null` sin datos o fuera de la retención de crudos. */
  avgBytesWire: number | null;
  /** Promedio de bytes descomprimidos por respuesta. */
  avgBytesBody: number | null;
  maxMs: number | null;
  completed: number;
  started: number;
  httpErrors: number;
  timeouts: number;
  over29s: number;
  threshold: PerfThreshold | null;
}

export const seriesId = (k: Omit<PerfSeriesKey, 'environmentId'>) =>
  [k.endpointKey, k.provenance, k.source, k.metricKind, k.cacheMode, k.workerProfile ?? ''].join('|');

export function selectorOf(k: PerfSeriesKey) {
  return { endpointKey: k.endpointKey, provenance: k.provenance, source: k.source, metricKind: k.metricKind, cacheMode: k.cacheMode, workerProfile: k.workerProfile };
}

export function summarizePerf(resp: PerfResponse | undefined, thresholds: readonly PerfThreshold[] = []): PerfSummaryRow[] {
  if (!resp) return [];
  return resp.series.map((s) => {
    const pts = s.points;
    const completed = pts.reduce((a, p) => a + p.completed, 0);
    const weighted = pts.reduce((a, p) => (p.meanMs !== null ? a + p.meanMs * p.completed : a), 0);
    const withMean = pts.reduce((a, p) => (p.meanMs !== null ? a + p.completed : a), 0);
    const maxes = pts.map((p) => p.maxMs).filter((x): x is number => x !== null);
    const period = s.summary;
    const status: PerfSummaryRow['p95Status'] = period?.p95Status ?? 'muestra_insuficiente';
    const id = seriesId(s.key);
    const threshold =
      thresholds.find((t) => t.enabled && t.metric === 'p95' && t.environmentId === s.key.environmentId && seriesId(t.seriesSelector) === id) ?? null;
    return {
      key: s.key,
      meanMs: withMean > 0 ? Math.round(weighted / withMean) : null,
      p95Ms: period?.p95Ms ?? null,
      p95Status: status,
      avgBytesWire: period?.avgBytesWire ?? null,
      avgBytesBody: period?.avgBytesBody ?? null,
      maxMs: maxes.length ? Math.max(...maxes) : null,
      completed,
      started: pts.reduce((a, p) => a + p.started, 0),
      httpErrors: pts.reduce((a, p) => a + p.httpErrors, 0),
      timeouts: pts.reduce((a, p) => a + p.timeouts, 0),
      over29s: pts.reduce((a, p) => a + p.over29s, 0),
      threshold,
    };
  });
}

export const METRIC_KIND_LABEL: Record<PerfSeriesKey['metricKind'], string> = {
  network_request: 'Petición de red',
  screen_ready: 'Pantalla lista',
  root_ready: 'Raíz lista',
  root_current_wait: 'Espera por current',
};
