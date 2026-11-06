/**
 * Cliente HTTP único del panel (ESP §17.2): fetch con AbortSignal, cookies same-origin, encabezado CSRF en
 * mutaciones, cuerpo de error uniforme `{ error: { code, message, requestId, details? } }` y manejo uniforme de
 * 401 (→ ingreso), 403 (sin permiso) y 429 (respeta Retry-After con pausa por recurso).
 * Nunca guarda tokens en localStorage ni en la URL (RNF-SEG-01).
 */
export const API_BASE = '/api/v1';

export interface ApiErrorDetails {
  issues?: { path: (string | number)[]; code: string; message: string }[];
  reasons?: string[];
  retryAfterSeconds?: number;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: ApiErrorDetails | undefined;
  /** Espera indicada por el servidor (429/503) en ms. */
  readonly retryAfterMs: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | null;
    details?: ApiErrorDetails;
    retryAfterMs?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Mensaje legible para el usuario a partir de cualquier error. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.isNetwork) return 'No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.';
    if (e.status === 403) return 'No tienes permiso para esta operación.';
    if (e.status === 429) {
      const s = e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : null;
      return s ? `Demasiadas solicitudes; intenta de nuevo en ${s} s.` : 'Demasiadas solicitudes; intenta más tarde.';
    }
    return e.message || 'Ocurrió un error inesperado.';
  }
  if (e instanceof Error && e.name === 'AbortError') return 'Solicitud cancelada.';
  return 'Ocurrió un error inesperado.';
}

export interface ClientHooks {
  /** 401 fuera de las rutas de autenticación: sesión vencida o ausente. */
  onUnauthorized?: (e: ApiError) => void;
  onForbidden?: (e: ApiError) => void;
  onRateLimited?: (e: ApiError) => void;
}

let hooks: ClientHooks = {};
let csrfToken: string | null = null;
let fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args);

export function configureClient(h: ClientHooks): void {
  hooks = h;
}
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}
/** Solo pruebas. */
export function setFetchImpl(f: typeof fetch): void {
  fetchImpl = f;
}

// ---------------------------------------------------------------------------
// Pausa por recurso ante 429 (ESP §17.2 "pausa global del recurso")
// ---------------------------------------------------------------------------
const pausedUntil = new Map<string, number>();
const MAX_PAUSE_MS = 60_000;

export function resourceOf(path: string): string {
  return path.replace(/^\/+/, '').split(/[/?]/)[0] ?? '';
}
export function resourcePausedFor(path: string, now = Date.now()): number {
  const until = pausedUntil.get(resourceOf(path));
  return until && until > now ? until - now : 0;
}
export function resetRateLimits(): void {
  pausedUntil.clear();
}

function parseRetryAfter(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, MAX_PAUSE_MS));
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, MAX_PAUSE_MS)) : null;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Petición
// ---------------------------------------------------------------------------
export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, String(item));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** No disparar la redirección global ante 401 (login, identidad inicial). */
  skipAuthRedirect?: boolean;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const pause = resourcePausedFor(path);
  if (pause > 0) await waitFor(pause, opts.signal);

  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}${buildQuery(opts.query)}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Error de red' });
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (res.ok) return payload as T;

  const body = (payload as { error?: { code?: string; message?: string; requestId?: string; details?: ApiErrorDetails } })
    ?.error;
  const retryAfterMs =
    parseRetryAfter(res.headers.get('Retry-After')) ??
    (body?.details?.retryAfterSeconds !== undefined ? body.details.retryAfterSeconds * 1000 : null);
  const err = new ApiError({
    status: res.status,
    code: body?.code ?? httpCode(res.status),
    message: body?.message ?? res.statusText ?? 'Error',
    requestId: body?.requestId ?? res.headers.get('x-request-id'),
    details: body?.details,
    retryAfterMs,
  });

  if (res.status === 401 && !opts.skipAuthRedirect) hooks.onUnauthorized?.(err);
  else if (res.status === 403) hooks.onForbidden?.(err);
  else if (res.status === 429) {
    pausedUntil.set(resourceOf(path), Date.now() + (retryAfterMs ?? 5_000));
    hooks.onRateLimited?.(err);
  }
  throw err;
}

function httpCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, extra: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...extra, method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown, extra: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...extra, method: 'PUT', body: body ?? {} }),
  delete: <T>(path: string, extra: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...extra, method: 'DELETE' }),
};

/** Errores de validación del servidor por campo (`details.issues[].path`). */
export function fieldErrorsFrom(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isApiError(e)) return out;
  for (const issue of e.details?.issues ?? []) {
    const key = issue.path.join('.');
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
