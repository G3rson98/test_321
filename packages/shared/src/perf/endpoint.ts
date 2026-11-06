/**
 * Normalización de `endpoint_key` y `screen_key` (ESP §7 extensiones de perf_sample, §13.8): quitar IDs/query de
 * negocio y datos personales, conservar dimensiones permitidas como `typeOperation`. Nunca devuelve la URL cruda.
 * Formato de clave de serie (alineado con qa-tests/tools/perf-contract.ts, D-016): `<METHOD> <ruta>[?dim=valor]`.
 * El backend recalcula siempre la clave: la del archivo es informativa.
 * RF-REN-01, RF-REN-02.
 */

/** Parámetros de query que son dimensiones permitidas (no datos de negocio). */
export const DEFAULT_ALLOWED_QUERY_DIMENSIONS: readonly string[] = ['typeOperation'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const OPAQUE_RE = /^[A-Za-z0-9_-]{24,}$/;
const SAFE_DIM_VALUE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const ID_PLACEHOLDER = ':id';

/** ¿El segmento parece un identificador de negocio o dato personal? */
export function isIdLikeSegment(seg: string): boolean {
  if (seg.includes('@')) return true; // correos u otros identificadores personales
  if (UUID_RE.test(seg) || NUMERIC_RE.test(seg) || HEX_RE.test(seg) || DATE_RE.test(seg) || OPAQUE_RE.test(seg))
    return true;
  // Opacos de 20+ con letras y dígitos, o IDs de negocio con 3+ dígitos ("OC-12345").
  if (seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) return true;
  return /\d{3,}/.test(seg);
}

export function normalizePathSegment(raw: string): string {
  if (raw === '') return raw;
  let seg: string;
  try {
    seg = decodeURIComponent(raw);
  } catch {
    return ID_PLACEHOLDER; // mal codificado: opaco
  }
  return isIdLikeSegment(seg) ? ID_PLACEHOLDER : seg;
}

export interface NormalizeEndpointOptions {
  allowedQueryDimensions?: readonly string[];
  /** Prefijar el host en minúsculas (`host/ruta`). Default false (clave de serie sin origen). */
  includeHost?: boolean;
}

interface ParsedEndpoint {
  host: string;
  /** Alias simbólico de origen (`api`, `app`, `externo`) si la entrada usa la forma `alias:/ruta`. */
  alias: string | null;
  url: URL;
}

function parseEndpoint(input: string): ParsedEndpoint {
  const aliasMatch = /^([a-z][a-z0-9+.-]*):(\/(?!\/).*)$/i.exec(input);
  if (aliasMatch && !/^https?$/i.test(aliasMatch[1]!)) {
    return {
      host: '',
      alias: aliasMatch[1]!.toLowerCase(),
      url: new URL(aliasMatch[2]!, 'http://placeholder.invalid'),
    };
  }
  try {
    const url = new URL(input);
    return { host: url.hostname.toLowerCase() + (url.port ? `:${url.port}` : ''), alias: null, url };
  } catch {
    return {
      host: '',
      alias: null,
      url: new URL(input.startsWith('/') ? input : `/${input}`, 'http://placeholder.invalid'),
    };
  }
}

function pathWithDims(url: URL, allowed: readonly string[]): string {
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(normalizePathSegment);
  const path = '/' + segments.join('/');
  const allowedLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const seen = new Set<string>();
  const dims: string[] = [];
  for (const [k, v] of url.searchParams) {
    const canonical = allowedLower.get(k.toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    dims.push(`${canonical}=${SAFE_DIM_VALUE_RE.test(v) ? v : ':value'}`);
  }
  dims.sort();
  return `${path}${dims.length ? `?${dims.join('&')}` : ''}`;
}

/**
 * Ruta normalizada con dimensiones permitidas, opcionalmente con host.
 * `https://fmsapi.deltax.la/travelUploader/api/travelUploader/cbc/loadingOrder/123?typeOperation=distribution&page=2`
 * → `/travelUploader/api/travelUploader/cbc/loadingOrder/:id?typeOperation=distribution`.
 */
export function normalizeEndpointPath(input: string, opts: NormalizeEndpointOptions = {}): string {
  const p = parseEndpoint(input);
  const rest = pathWithDims(p.url, opts.allowedQueryDimensions ?? DEFAULT_ALLOWED_QUERY_DIMENSIONS);
  return opts.includeHost && p.host ? `${p.host}${rest}` : rest;
}

/** Endpoint sanitizado para persistir (`alias:/ruta?dims` o `host/ruta?dims`), sin IDs ni query de negocio. */
export function normalizeEndpointForStorage(input: string, opts: NormalizeEndpointOptions = {}): string {
  const p = parseEndpoint(input);
  const rest = pathWithDims(p.url, opts.allowedQueryDimensions ?? DEFAULT_ALLOWED_QUERY_DIMENSIONS);
  if (p.alias) return `${p.alias}:${rest}`;
  return p.host ? `${p.host}${rest}` : rest;
}

/** Clave de serie de una petición: `<METHOD> <ruta>[?dims]` (ESP §13.8). */
export function normalizeEndpointKey(
  input: string,
  opts: NormalizeEndpointOptions & { method?: string | null } = {},
): string {
  const method = (opts.method ?? 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
  return `${method} ${normalizeEndpointPath(input, opts)}`;
}

/**
 * Clave de pantalla. Acepta ruta (`/loadOrder?tab=x` → `/loadOrder`) o etiqueta (`loadOrder:distribution`),
 * reemplazando tokens con forma de ID por `:id`.
 */
export function normalizeScreenKey(input: string): string {
  const trimmed = input.trim().slice(0, 200);
  if (trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) {
    return normalizeEndpointPath(trimmed, { allowedQueryDimensions: [] });
  }
  return trimmed
    .split(/([:/])/)
    .map((tok) => (tok === ':' || tok === '/' || tok === '' ? tok : normalizePathSegment(tok)))
    .join('');
}

/**
 * Clave de serie de una muestra: petición → `<METHOD> <ruta>`; pantalla/arranque sin endpoint →
 * `<metric_kind> <screen_key>` (o solo `<metric_kind>`).
 */
export function seriesEndpointKey(sample: {
  endpoint: string | null;
  method?: string | null;
  screenKey?: string | null;
  metricKind: string;
}): string {
  if (sample.endpoint) return normalizeEndpointKey(sample.endpoint, { method: sample.method ?? null });
  if (sample.screenKey) return `${sample.metricKind} ${normalizeScreenKey(sample.screenKey)}`;
  return sample.metricKind;
}
