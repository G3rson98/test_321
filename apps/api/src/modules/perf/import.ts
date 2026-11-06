/**
 * Importación de `samples.json` DXMon/Playwright a `perf_sample` (ESP §7, §13.8). Servicio invocado por la API de
 * worker (`POST /worker/perf/samples`, módulo de API-B) dentro de su transacción con lease vigente.
 * - Validador autoritativo `parsePerfSamples` (@katalyst/shared/perf): inválidas en cuarentena con conteo, sin
 *   detener las válidas; sin NaN ni negativos; `endpoint_key`/`over_29s` recalculados por el backend.
 * - Deduplicación `(run_id, sample_key)`: contra lo ya importado y por `ON CONFLICT DO NOTHING` (concurrencia).
 * - El ambiente se toma de la corrida (no del archivo).
 * RF-REN-01, RF-REN-05.
 */
import type { Prisma } from '@prisma/client';
import { KatalystError, parsePerfSamples, type PerfImportResult } from '@katalyst/shared';

export interface PerfImportSummary {
  runId: string;
  environmentId: string;
  received: number;
  imported: number;
  duplicates: number;
  quarantined: number;
  producerQuarantined: number;
  /** Motivos de cuarentena agregados (sin valores de las muestras). */
  quarantineReasons: Record<string, number>;
}

const BATCH = 1000;

function reasonKey(r: string): string {
  // `campo: mensaje` → conservar solo el campo y un código corto; nunca valores.
  const [field, rest] = r.split(': ', 2);
  return rest !== undefined ? `${field}:${rest.slice(0, 60)}` : r.slice(0, 80);
}

/**
 * Importa el archivo (objeto ya parseado de JSON) para la corrida `runId`.
 * Lanza `PERF_IMPORT_INVALID` si el encabezado/versión/run_id del archivo es inválido (no importa nada).
 */
export async function importPerfSamples(
  tx: Prisma.TransactionClient,
  runId: string,
  file: unknown,
): Promise<PerfImportSummary> {
  const run = await tx.run.findUnique({ where: { id: runId }, select: { id: true, environmentId: true } });
  if (!run) throw new KatalystError('NOT_FOUND');
  const existing = await tx.perfSample.findMany({ where: { runId }, select: { sampleKey: true } });
  const result: PerfImportResult = parsePerfSamples(file, {
    existingSampleKeys: new Set(existing.map((e) => e.sampleKey)),
    expectedRunId: runId,
  });
  if (!result.ok) {
    throw new KatalystError('PERF_IMPORT_INVALID', undefined, { reasons: [result.fileError ?? 'invalido'] });
  }
  let imported = 0;
  for (let i = 0; i < result.valid.length; i += BATCH) {
    const chunk = result.valid.slice(i, i + BATCH);
    const r = await tx.perfSample.createMany({
      skipDuplicates: true,
      data: chunk.map((s) => ({
        runId,
        environmentId: run.environmentId,
        sampleKey: s.sampleKey,
        schemaVersion: s.schemaVersion,
        ts: new Date(s.ts),
        provenance: s.provenance,
        source: s.source,
        metricKind: s.metricKind,
        endpoint: s.endpoint,
        endpointKey: s.endpointKey,
        method: s.method,
        screenKey: s.screenKey,
        statusCode: s.statusCode,
        ok: s.ok,
        totalMs: s.totalMs,
        ttfbMs: s.ttfbMs,
        downloadMs: s.downloadMs,
        bytesWire: s.bytesWire === null ? null : BigInt(s.bytesWire),
        bytesBody: s.bytesBody === null ? null : BigInt(s.bytesBody),
        timeout: s.timeout,
        timeoutLimitMs: s.timeoutLimitMs,
        censoredAtMs: s.censoredAtMs,
        censored: s.censored,
        networkError: s.networkError,
        errorKind: s.errorKind,
        over29s: s.over29s,
        visible: s.visible,
        cacheMode: s.cacheMode,
        workerProfile: s.workerProfile,
        invalidReason: s.invalidReason,
        contentEncoding: s.contentEncoding,
        nullReasons: s.nullReasons,
      })),
    });
    imported += r.count;
  }
  const quarantineReasons: Record<string, number> = {};
  for (const q of result.quarantined) {
    for (const r of q.reasons) {
      const k = reasonKey(r);
      quarantineReasons[k] = (quarantineReasons[k] ?? 0) + 1;
    }
  }
  return {
    runId,
    environmentId: run.environmentId,
    received: result.valid.length + result.quarantined.length + result.duplicates,
    imported,
    duplicates: result.duplicates + (result.valid.length - imported),
    quarantined: result.quarantined.length,
    producerQuarantined: result.producerQuarantined,
    quarantineReasons,
  };
}
