/**
 * Protocolo `katalyst://` (ESP §13.6: "un enlace del panel contiene solo ID de sesión, nunca credencial duradera").
 * Formas aceptadas (únicas):
 *   katalyst://grabar?session=<uuid>        (forma del asistente)
 *   katalyst://recording/<uuid>             (forma `assistantLink` de RecordingCreatedResponseSchema)
 * Cualquier otro parámetro (token, code, url…) invalida el enlace completo: no se procesa nada parcial.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROTOCOL_SCHEME = 'katalyst';
const MAX_LINK_LENGTH = 200;

export type DeepLink = { kind: 'recording'; recordingId: string };

export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL_SCHEME}:`) return null;
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  if (host === 'grabar' && (path === '' || path === '/')) {
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'session') return null;
    const id = url.searchParams.get('session') ?? '';
    return UUID_RE.test(id) ? { kind: 'recording', recordingId: id.toLowerCase() } : null;
  }
  if (host === 'recording') {
    if (url.search) return null;
    const id = path.replace(/^\//, '');
    return UUID_RE.test(id) ? { kind: 'recording', recordingId: id.toLowerCase() } : null;
  }
  return null;
}

/** Busca el primer argumento de línea de comandos con el esquema `katalyst://` (Windows/Linux, `second-instance`). */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  for (const a of argv) if (typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) return a;
  return null;
}
