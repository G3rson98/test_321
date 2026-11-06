/**
 * Dirección del servidor Katalyst. El asistente solo hace conexiones salientes HTTPS a la API; `http://` se admite
 * únicamente hacia loopback y en modo desarrollo explícito (RNF-SEG-03, ESP §13.6). Sin puertos locales abiertos.
 */
import { RecorderError } from './errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Normaliza a `origin` (sin ruta, query ni credenciales). Lanza `SERVER_URL_INVALID` si no es seguro. */
export function normalizeServerUrl(input: string, opts: { devMode: boolean }): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RecorderError('SERVER_URL_INVALID');
  }
  if (url.username || url.password) throw new RecorderError('SERVER_URL_INVALID');
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && opts.devMode && isLoopbackHost(url.hostname)) return url.origin;
  throw new RecorderError('SERVER_URL_INVALID');
}

export function apiBaseUrl(serverOrigin: string): string {
  return `${serverOrigin}/api/v1`;
}

/**
 * ¿La URL externa (panel, PR) puede abrirse en el navegador del sistema? Solo https (o loopback en desarrollo);
 * para el panel se exige además el mismo origen que el servidor configurado.
 */
export function isSafeExternalUrl(
  candidate: string,
  opts: { devMode: boolean; requireOrigin?: string | null },
): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const okScheme =
    url.protocol === 'https:' || (opts.devMode && url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!okScheme) return false;
  if (opts.requireOrigin && url.origin !== opts.requireOrigin) return false;
  return true;
}
