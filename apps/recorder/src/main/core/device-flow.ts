/**
 * Flujo de dispositivo (RFC 8628 adaptado, ESP §13.6): el asistente pide un código de un solo uso, el QA lo aprueba
 * desde su sesión del panel y el asistente consulta con sondeo limitado respetando `interval` y `slow_down`.
 * Vence a los 5 minutos como máximo. El `deviceCode` nunca se muestra ni se registra. RF-GRB-01, RNF-SEG-01.
 */
import { DEVICE_CODE_TTL_SECONDS } from '@katalyst/shared/schemas';
import { ApiError, type KatalystApiClient } from './api-client.js';
import { RecorderError } from './errors.js';

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalMs: number;
  /** Instante (ms epoch) en que el código vence; acotado a 5 min aunque la API devuelva más. */
  expiresAtMs: number;
}

export interface DeviceToken {
  accessToken: string;
  deviceId: string;
  expiresAt: string;
}

export interface DeviceFlowClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: DeviceFlowClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new RecorderError('DEVICE_LINK_CANCELLED'));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new RecorderError('DEVICE_LINK_CANCELLED'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Aumento del intervalo ante `slow_down` (RFC 8628 §3.5). */
export const SLOW_DOWN_INCREMENT_MS = 5_000;
export const MIN_INTERVAL_MS = 1_000;
export const MAX_CONSECUTIVE_NETWORK_ERRORS = 3;

export async function startDeviceAuthorization(
  api: Pick<KatalystApiClient, 'deviceAuthorize'>,
  client: { clientName: string; clientVersion: string; platform: 'windows' | 'macos' | 'linux' },
  clock: Pick<DeviceFlowClock, 'now'> = realClock,
): Promise<DeviceAuthorization> {
  const res = await api.deviceAuthorize(client);
  // El enlace del panel solo puede llevar el código corto, nunca el deviceCode ni credenciales.
  if (res.verificationUriComplete.includes(res.deviceCode)) {
    throw new RecorderError('URL_NOT_ALLOWED', 'La API devolvió un enlace de verificación inseguro.');
  }
  const ttlSeconds = Math.min(res.expiresIn, DEVICE_CODE_TTL_SECONDS);
  return {
    deviceCode: res.deviceCode,
    userCode: res.userCode,
    verificationUri: res.verificationUri,
    verificationUriComplete: res.verificationUriComplete,
    intervalMs: Math.max(res.interval * 1000, MIN_INTERVAL_MS),
    expiresAtMs: clock.now() + ttlSeconds * 1000,
  };
}

export interface PollOptions {
  signal?: AbortSignal;
  /** Se notifica cada vez que el servidor pide frenar (para mostrar/depurar). */
  onSlowDown?: (newIntervalMs: number) => void;
}

/**
 * Consulta `POST /devices/token` hasta aprobación, rechazo o vencimiento. El número de consultas queda acotado por
 * `ceil(ttl / intervalo)`: nunca consulta más rápido que `interval`, y cada `slow_down` suma 5 s.
 */
export async function pollDeviceToken(
  api: Pick<KatalystApiClient, 'deviceToken'>,
  auth: DeviceAuthorization,
  clock: DeviceFlowClock = realClock,
  opts: PollOptions = {},
): Promise<DeviceToken & { polls: number }> {
  let intervalMs = auth.intervalMs;
  let polls = 0;
  let networkErrors = 0;
  const maxPolls = Math.ceil(Math.max(auth.expiresAtMs - clock.now(), 0) / intervalMs) + 1;
  for (;;) {
    await clock.sleep(intervalMs, opts.signal);
    if (opts.signal?.aborted) throw new RecorderError('DEVICE_LINK_CANCELLED');
    if (clock.now() >= auth.expiresAtMs || polls >= maxPolls) throw new RecorderError('DEVICE_CODE_EXPIRED');
    polls += 1;
    try {
      const t = await api.deviceToken(auth.deviceCode, opts.signal);
      return { accessToken: t.accessToken, deviceId: t.deviceId, expiresAt: t.expiresAt, polls };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      switch (e.code) {
        case 'DEVICE_AUTHORIZATION_PENDING':
          networkErrors = 0;
          continue;
        case 'DEVICE_SLOW_DOWN':
        case 'RATE_LIMITED':
          networkErrors = 0;
          intervalMs += SLOW_DOWN_INCREMENT_MS;
          opts.onSlowDown?.(intervalMs);
          continue;
        case 'DEVICE_CODE_EXPIRED':
        case 'DEVICE_CODE_INVALID':
          throw new RecorderError('DEVICE_CODE_EXPIRED');
        case 'DEVICE_ACCESS_DENIED':
          throw new RecorderError('DEVICE_ACCESS_DENIED');
        case 'ABORTED':
          throw new RecorderError('DEVICE_LINK_CANCELLED');
        case 'NETWORK_ERROR':
        case 'TIMEOUT':
          networkErrors += 1;
          if (networkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) throw new RecorderError('NETWORK_ERROR');
          continue;
        default:
          if (e.status >= 500) {
            networkErrors += 1;
            if (networkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) throw new RecorderError('API_ERROR', e.message);
            continue;
          }
          throw new RecorderError('API_ERROR', e.message);
      }
    }
  }
}
