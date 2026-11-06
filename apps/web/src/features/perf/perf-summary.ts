/**
 * Resumen por serie del período, derivado de `GET /perf` (no existe `/perf/summary` en la API). La media se pondera
 * por respuestas completadas; el p95 del período NO se puede recombinar desde p95 por intervalo, así que se muestra el
 * peor p95 por intervalo (rotulado así) y "muestra insuficiente" si ningún intervalo alcanza el mínimo.
 * PENDIENTE [WEB→API-C]: p95 del período sobre muestras crudas y bytes en red/descomprimidos por serie.
 */
import type { PerfResponse, PerfSeriesKey, PerfThreshold } from '@/lib/api/types';

export interface PerfSummaryRow {
  key: PerfSeriesKey;
  meanMs: number | null;
  /** Peor p95 por intervalo del período. */
  p95Ms: number | null;
  p95Status: 'ok' | 'muestra_insuficiente' | 'no_disponible';
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
    const p95s = pts.filter((p) => p.p95Status === 'ok' && p.p95Ms !== null).map((p) => p.p95Ms!);
    const maxes = pts.map((p) => p.maxMs).filter((x): x is number => x !== null);
    const status: PerfSummaryRow['p95Status'] = p95s.length
      ? 'ok'
      : pts.length > 0 && pts.every((p) => p.p95Status === 'no_disponible')
        ? 'no_disponible'
        : 'muestra_insuficiente';
    const id = seriesId(s.key);
    const threshold =
      thresholds.find((t) => t.enabled && t.metric === 'p95' && t.environmentId === s.key.environmentId && seriesId(t.seriesSelector) === id) ?? null;
    return {
      key: s.key,
      meanMs: withMean > 0 ? Math.round(weighted / withMean) : null,
      p95Ms: p95s.length ? Math.max(...p95s) : null,
      p95Status: status,
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
