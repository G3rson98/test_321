/** Cliente HTTP único (ESP §17.2): errores uniformes, 401/403/429, CSRF, Idempotency-Key, AbortSignal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  apiRequest,
  ApiError,
  buildQuery,
  configureClient,
  errorMessage,
  fieldErrorsFrom,
  resetRateLimits,
  resourceOf,
  resourcePausedFor,
  setCsrfToken,
  setFetchImpl,
} from '@/lib/api/client';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let responder: (url: string, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
const envelope = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message, requestId: 'req-1', ...extra },
});

beforeEach(() => {
  calls = [];
  responder = () => json(200, { ok: true });
  setFetchImpl(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return Promise.resolve(responder(url, init ?? {}));
  }) as typeof fetch);
  configureClient({});
  setCsrfToken(null);
  resetRateLimits();
});
afterEach(() => {
  vi.useRealTimers();
});

const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe('peticiones', () => {
  it('antepone /api/v1, serializa query (arreglos repetidos, omite vacíos) y usa cookies same-origin', async () => {
    await api.get('/runs', { estado: ['corriendo', 'cola'], q: '', limit: 25, x: undefined, y: null });
    expect(calls[0]!.url).toBe('/api/v1/runs?estado=corriendo&estado=cola&limit=25');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(calls[0]!.init.method).toBe('GET');
    expect(buildQuery({})).toBe('');
  });

  it('envía X-CSRF-Token solo en mutaciones y nunca en GET', async () => {
    setCsrfToken('csrf-abc');
    await api.get('/suites');
    await api.post('/suites', { name: 'x' });
    await api.put('/suites/1', { name: 'y' });
    await api.delete('/suites/1');
    expect(headersOf(calls[0]!)['X-CSRF-Token']).toBeUndefined();
    expect(headersOf(calls[1]!)['X-CSRF-Token']).toBe('csrf-abc');
    expect(headersOf(calls[1]!)['Content-Type']).toBe('application/json');
    expect(calls[1]!.init.body).toBe('{"name":"x"}');
    expect(headersOf(calls[2]!)['X-CSRF-Token']).toBe('csrf-abc');
    expect(headersOf(calls[3]!)['X-CSRF-Token']).toBe('csrf-abc');
  });

  it('reenvía Idempotency-Key en POST /runs', async () => {
    await api.post('/runs', { mode: 'suite' }, { idempotencyKey: 'idem-123' });
    expect(headersOf(calls[0]!)['Idempotency-Key']).toBe('idem-123');
  });

  it('204 devuelve undefined', async () => {
    responder = () => new Response(null, { status: 204 });
    await expect(api.delete('/auth/tokens/1')).resolves.toBeUndefined();
  });

  it('propaga AbortError sin convertirlo en error de red', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(api.get('/runs', undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('error de red ⇒ ApiError status 0 con mensaje legible', async () => {
    setFetchImpl((() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch);
    const e = await api.get('/runs').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).isNetwork).toBe(true);
    expect(errorMessage(e)).toMatch(/No se pudo conectar/);
  });
});

describe('errores uniformes', () => {
  it('interpreta { error: { code, message, requestId, details } }', async () => {
    responder = () =>
      json(422, envelope('VALIDATION_FAILED', 'Datos inválidos', { details: { issues: [{ path: ['name'], code: 'too_small', message: 'Requerido' }, { path: ['selector', 'tags', 0], code: 'x', message: 'Etiqueta inválida' }] } }));
    const e = (await api.post('/suites', {}).catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(422);
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.message).toBe('Datos inválidos');
    expect(e.requestId).toBe('req-1');
    expect(fieldErrorsFrom(e)).toEqual({ name: 'Requerido', 'selector.tags.0': 'Etiqueta inválida' });
    expect(fieldErrorsFrom(new Error('x'))).toEqual({});
  });

  it('sin cuerpo JSON usa un código derivado del status y x-request-id', async () => {
    responder = () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'x-request-id': 'rid-9' } });
    const e = (await api.get('/runs').catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.requestId).toBe('rid-9');
  });
});

describe('401 / 403 / 429', () => {
  it('401 dispara onUnauthorized (redirección a ingreso) salvo con skipAuthRedirect', async () => {
    const onUnauthorized = vi.fn();
    configureClient({ onUnauthorized });
    responder = () => json(401, envelope('UNAUTHENTICATED', 'Se requiere autenticación.'));
    const e = (await api.get('/runs').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await apiRequest('/auth/me', { skipAuthRedirect: true }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('403 ⇒ ApiError FORBIDDEN tipado + onForbidden, mensaje de permiso', async () => {
    const onForbidden = vi.fn();
    configureClient({ onForbidden });
    responder = () => json(403, envelope('FORBIDDEN', 'No tienes permiso para esta operación.'));
    const e = (await api.post('/testrail/sync').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(403);
    expect(e.code).toBe('FORBIDDEN');
    expect(onForbidden).toHaveBeenCalledWith(e);
    expect(errorMessage(e)).toBe('No tienes permiso para esta operación.');
  });

  it('429 respeta Retry-After: pausa el recurso y la siguiente petición espera', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const onRateLimited = vi.fn();
    configureClient({ onRateLimited });
    responder = () => json(429, envelope('RATE_LIMITED', 'Demasiadas solicitudes'), { 'Retry-After': '2' });
    const e = (await api.get('/runs').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(2000);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(errorMessage(e)).toBe('Demasiadas solicitudes; intenta de nuevo en 2 s.');
    expect(resourcePausedFor('/runs/abc')).toBeGreaterThan(1900);
    expect(resourcePausedFor('/suites')).toBe(0);

    responder = () => json(200, { items: [] });
    let done = false;
    const p = api.get('/runs/abc').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(done).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('429 sin encabezado usa details.retryAfterSeconds y la pausa se cancela con AbortSignal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    responder = () => json(429, envelope('RATE_LIMITED', 'x', { details: { retryAfterSeconds: 3 } }));
    const e = (await api.get('/perf').catch((x: unknown) => x)) as ApiError;
    expect(e.retryAfterMs).toBe(3000);
    const ac = new AbortController();
    const p = api.get('/perf', undefined, ac.signal).catch((x: unknown) => x);
    ac.abort();
    await expect(p).resolves.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('Retry-After como fecha HTTP y tope de 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    responder = () => json(429, envelope('RATE_LIMITED', 'x'), { 'Retry-After': 'Fri, 06 Nov 2026 12:00:10 GMT' });
    const e = (await api.get('/alerts').catch((x: unknown) => x)) as ApiError;
    expect(e.retryAfterMs).toBe(10_000);
    responder = () => json(429, envelope('RATE_LIMITED', 'x'), { 'Retry-After': '9999' });
    const e2 = (await api.get('/audit-log').catch((x: unknown) => x)) as ApiError;
    expect(e2.retryAfterMs).toBe(60_000);
  });

  it('resourceOf toma el primer segmento', () => {
    expect(resourceOf('/runs/1/results?x=1')).toBe('runs');
    expect(resourceOf('testrail/cases')).toBe('testrail');
  });
});

describe('política de reintentos de Query', () => {
  it('reintenta una vez ante red/5xx/429, nunca 401/403/404/409/422; espera Retry-After', async () => {
    const { shouldRetryQuery, retryDelay } = await import('@/lib/query/client');
    const e = (status: number, retryAfterMs: number | null = null) => new ApiError({ status, code: 'X', message: 'x', retryAfterMs });
    for (const s of [0, 500, 503, 429]) {
      expect(shouldRetryQuery(0, e(s))).toBe(true);
      expect(shouldRetryQuery(1, e(s))).toBe(false);
    }
    for (const s of [401, 403, 404, 409, 422]) expect(shouldRetryQuery(0, e(s))).toBe(false);
    expect(shouldRetryQuery(0, new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(retryDelay(1, e(429, 4000))).toBe(4000);
    expect(retryDelay(1, e(500))).toBe(1000);
  });
});
