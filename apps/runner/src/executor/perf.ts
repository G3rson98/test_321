/**
 * Importación de `samples.json` (contrato DXMon schema_version 1, qa-tests/tools/README-dxmon.md) vía
 * `POST /worker/perf/samples`. El backend valida por muestra (`parsePerfSamples`), deduplica `(run_id, sample_key)`
 * y cuarentena inválidas (ESP §13.8). Antes de enviar se verifica que el archivo no contenga datos sensibles
 * (RNF-SEG-02); con hallazgos no se envía. RF-REN-01, RF-REN-05.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeFindings, verifySanitized } from '@katalyst/shared';
import type { Logger } from '../logger.js';
import { isLeaseLost } from '../worker-api/errors.js';
import type { PerfSamplesResponse, WorkerApiClient } from '../worker-api/types.js';

export interface PerfImportResult {
  status: 'sin_muestras' | 'importado' | 'rechazado_sanitizacion' | 'invalido' | 'error' | 'lease_perdido';
  response?: PerfSamplesResponse;
  reason?: string;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function importPerfSamples(o: {
  api: Pick<WorkerApiClient, 'postPerfSamples'>;
  leaseId: string;
  generation: number;
  perfDir: string;
  knownSecrets: readonly string[];
  logger: Logger;
}): Promise<PerfImportResult> {
  const samplesPath = path.join(o.perfDir, 'samples.json');
  let samplesFile: unknown;
  try {
    samplesFile = await readJson(samplesPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'sin_muestras' };
    return { status: 'invalido', reason: 'samples.json no es JSON válido' };
  }
  let summaryFile: unknown;
  try {
    summaryFile = await readJson(path.join(o.perfDir, 'summary.json'));
  } catch {
    summaryFile = undefined;
  }
  for (const [name, content] of [['samples.json', samplesFile], ['summary.json', summaryFile]] as const) {
    if (content === undefined) continue;
    const v = verifySanitized(content, { knownSecrets: o.knownSecrets });
    if (!v.ok) {
      o.logger.error({ file: name, findings: summarizeFindings(v.findings) }, 'muestras de rendimiento con datos sensibles: no se importan');
      return { status: 'rechazado_sanitizacion', reason: `${name}: ${summarizeFindings(v.findings)}` };
    }
  }
  try {
    const response = await o.api.postPerfSamples({
      leaseId: o.leaseId,
      generation: o.generation,
      samplesFile,
      ...(summaryFile !== undefined ? { summaryFile } : {}),
    });
    o.logger.info(
      { accepted: response.accepted, duplicates: response.duplicates, quarantined: response.quarantined.length },
      'muestras de rendimiento importadas',
    );
    return { status: 'importado', response };
  } catch (e) {
    if (isLeaseLost(e)) return { status: 'lease_perdido' };
    return { status: 'error', reason: 'no se pudieron importar las muestras' };
  }
}
