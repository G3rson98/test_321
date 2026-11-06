/**
 * Bloqueo de grabación en producción (ESP §13.6 "No permitir grabación en producción en el alcance inicial";
 * RF-GRB-05; ARQ: sin destino seguro la grabación queda bloqueada). Falla cerrado: si no puede verificarse el
 * ambiente, no se abre el navegador. Defensa en profundidad con lista de hosts productivos conocidos de DeltaX.
 */
import type { EnvironmentSummary } from '@katalyst/shared/schemas';
import type { RecordingDetail } from './api-client.js';
import { isLoopbackHost } from './config.js';
import { RecorderError } from './errors.js';

/** Hosts productivos de FMS DeltaX (ESP §2). Nunca se graba contra ellos aunque la configuración diga otra cosa. */
export const PRODUCTION_HOST_DENYLIST = ['cbc.deltax.la', 'fmsapi.deltax.la'] as const;

export interface RecordingEnvironment {
  id: string;
  name: string;
  isProduction: boolean;
  recordingAllowed: boolean;
  enabled: boolean;
  appUrl: string | null;
}

export function isDeniedProductionHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return PRODUCTION_HOST_DENYLIST.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Combina la extensión `environment` del detalle de grabación (si la API la provee) con `GET /environments`.
 * Ante datos contradictorios prevalece el más restrictivo.
 */
export function resolveRecordingEnvironment(
  recording: Pick<RecordingDetail, 'environmentId' | 'environment'>,
  summaries: readonly EnvironmentSummary[] | null,
): RecordingEnvironment | null {
  const fromDetail =
    recording.environment && recording.environment.id === recording.environmentId ? recording.environment : null;
  const fromList = summaries?.find((e) => e.id === recording.environmentId) ?? null;
  if (!fromDetail && !fromList) return null;
  // Desconocido ⇒ no permitido (falla cerrado).
  const allowed = [fromDetail?.recordingAllowed, fromList?.recordingAllowed].filter((v) => v !== undefined);
  return {
    id: recording.environmentId,
    name: fromList?.name ?? fromDetail?.name ?? 'Ambiente',
    isProduction: (fromDetail?.isProduction ?? false) || (fromList?.isProduction ?? false),
    recordingAllowed: allowed.length > 0 && allowed.every(Boolean),
    enabled: (fromDetail?.enabled ?? true) && (fromList?.enabled ?? true),
    appUrl: fromDetail?.appUrl ?? null,
  };
}

/** Lanza `RecorderError` si no se puede grabar en el ambiente. */
export function assertRecordableEnvironment(
  env: RecordingEnvironment | null,
  opts: { devMode: boolean },
): RecordingEnvironment {
  if (!env) throw new RecorderError('ENVIRONMENT_UNKNOWN');
  if (env.isProduction) throw new RecorderError('PRODUCTION_BLOCKED');
  if (!env.enabled || !env.recordingAllowed) throw new RecorderError('RECORDING_NOT_ALLOWED');
  if (env.appUrl) {
    let url: URL;
    try {
      url = new URL(env.appUrl);
    } catch {
      throw new RecorderError('ENVIRONMENT_UNKNOWN');
    }
    if (isDeniedProductionHost(url.hostname)) throw new RecorderError('PRODUCTION_BLOCKED');
    if (url.username || url.password) throw new RecorderError('ENVIRONMENT_URL_INSECURE');
    const secure =
      url.protocol === 'https:' || (opts.devMode && url.protocol === 'http:' && isLoopbackHost(url.hostname));
    if (!secure) throw new RecorderError('ENVIRONMENT_URL_INSECURE');
  }
  return env;
}

/** Verifica también cada URL que se va a abrir (inicio de login/codegen). */
export function assertUrlNotProduction(candidate: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new RecorderError('URL_NOT_ALLOWED');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RecorderError('URL_NOT_ALLOWED');
  if (isDeniedProductionHost(url.hostname)) throw new RecorderError('PRODUCTION_BLOCKED');
}
