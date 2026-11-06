/**
 * Canal SSE único por pestaña (RNF-OPT-04, ESP §17.2): dedupe por seq y por entidad+versión, lotes, reconexión con
 * backoff y Last-Event-ID, snapshot/reset, pestaña oculta y fallback de polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { SseManager, SseParser, defaultBackoff, sseStore, startSse, stopSse, type DomainEventLike, type VisibilitySource } from '@/lib/sse/manager';
import { fallbackInterval, POLL_MAX_MS } from '@/lib/sse/polling';
import { setCsrfToken } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

interface FakeStream {
  push: (text: string) => void;
  close: () => void;
  response: Response;
}
function fakeStream(status = 200): FakeStream {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    push: (t) => ctrl.enqueue(enc.encode(t)),
    close: () => ctrl.close(),
    response: new Response(status === 200 ? body : null, { status, headers: { 'Content-Type': 'text/event-stream' } }),
  };
}

interface Conn {
  headers: Record<string, string>;
  signal: AbortSignal;
  stream: FakeStream;
}
let conns: Conn[] = [];
let nextStatus: number[] = [];
const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
  const status = nextStatus.shift() ?? 200;
  const stream = fakeStream(status);
  const signal = init!.signal!;
  conns.push({ headers: init!.headers as Record<string, string>, signal, stream });
  signal.addEventListener('abort', () => {
    try {
      stream.close();
    } catch {
      /* ya cerrado */
    }
  });
  return Promise.resolve(stream.response);
}) as unknown as typeof fetch;

class FakeVisibility implements VisibilitySource {
  hidden = false;
  private cbs = new Set<() => void>();
  isHidden = () => this.hidden;
  subscribe = (cb: () => void) => {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  };
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const cb of this.cbs) cb();
  }
}

const ev = (seq: number, over: Partial<DomainEventLike> = {}): DomainEventLike => ({
  seq,
  type: 'run.updated',
  entity: 'run',
  entityId: 'run-1',
  version: seq,
  runId: 'run-1',
  data: {},
  ...over,
});
const sse = (event: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = () => vi.advanceTimersByTimeAsync(0);

let qc: QueryClient;
let vis: FakeVisibility;
let flushed: DomainEventLike[][];
let mgr: SseManager | null;

function make(extra: Partial<ConstructorParameters<typeof SseManager>[0]> = {}) {
  mgr = new SseManager({ queryClient: qc, fetchImpl, visibility: vis, batchMs: 100, backoffMs: (n) => n * 1000, onFlush: (b) => flushed.push(b), ...extra });
  return mgr;
}

beforeEach(() => {
  vi.useFakeTimers();
  conns = [];
  nextStatus = [];
  flushed = [];
  (fetchImpl as unknown as { mockClear: () => void }).mockClear();
  qc = new QueryClient();
  vis = new FakeVisibility();
  mgr = null;
  setCsrfToken(null);
});
afterEach(() => {
  mgr?.stop();
  stopSse();
  vi.useRealTimers();
});

describe('SseParser', () => {
  it('parsea bloques partidos entre fragmentos, CRLF, comentarios y data multilínea', () => {
    const p = new SseParser();
    expect(p.push('id: 7\r\nevent: run.upd')).toEqual([]);
    const out = p.push('ated\r\ndata: {"a":1}\r\n\r\n: ping\n\ndata: x\ndata: y\n\n');
    expect(out).toEqual([
      { id: '7', event: 'run.updated', data: '{"a":1}' },
      { id: null, event: 'message', data: 'x\ny' },
    ]);
  });
});

describe('SseManager', () => {
  it('abre UN canal con cookies (sin tokens en la URL) y pasa a open', async () => {
    make().start();
    await tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('/api/v1/events/stream');
    expect(init.credentials).toBe('same-origin');
    expect(conns[0]!.headers['Last-Event-ID']).toBeUndefined();
    expect(sseStore.state.status).toBe('open');
    mgr!.start(); // idempotente
    await tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('startSse reemplaza el canal previo: una sola conexión viva por pestaña', async () => {
    const a = startSse({ queryClient: qc, fetchImpl, visibility: vis });
    await tick();
    const b = startSse({ queryClient: qc, fetchImpl, visibility: vis });
    await tick();
    expect(a).not.toBe(b);
    expect(conns).toHaveLength(2);
    expect(conns[0]!.signal.aborted).toBe(true);
    expect(conns[1]!.signal.aborted).toBe(false);
  });

  it('descarta duplicados por seq y versiones antiguas por entidad; agrupa en un lote', async () => {
    make().start();
    await tick();
    const s = conns[0]!.stream;
    s.push(sse('run.updated', ev(1, { version: 3 }), '1'));
    s.push(sse('run.updated', ev(1, { version: 3 }), '1')); // mismo seq
    s.push(sse('run.updated', ev(2, { version: 2 }), '2')); // versión antigua de la misma entidad
    s.push(sse('run.updated', ev(3, { entityId: 'run-2', version: 1 }), '3'));
    s.push(sse('ping', {}));
    await tick();
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.map((e) => e.seq)).toEqual([1, 3]);
    expect(mgr!.lastEventId).toBe('3');
  });

  it('run.updated actualiza el detalle en caché si la versión es mayor e invalida listas', async () => {
    const key = qk.runs.detail('run-1');
    qc.setQueryData(key, { id: 'run-1', status: 'cola', version: 1 });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    make().start();
    await tick();
    conns[0]!.stream.push(sse('run.updated', ev(5, { version: 2, data: { status: 'corriendo' } })));
    await vi.advanceTimersByTimeAsync(100);
    expect(qc.getQueryData(key)).toMatchObject({ status: 'corriendo', version: 2 });
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['runs', 'list']));
    expect(keys).toContain(JSON.stringify(['dashboard']));
  });

  it('eventos de resultados invalidan resultados/intentos de la corrida', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    make().start();
    await tick();
    conns[0]!.stream.push(sse('run_result.updated', ev(1, { type: 'run_result.updated', entity: 'run_result', entityId: 'res-1', runId: 'run-9' })));
    await vi.advanceTimersByTimeAsync(100);
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['runs', 'results', 'run-9']));
    expect(keys).toContain(JSON.stringify(['runs', 'attempts', 'run-9']));
  });

  it('snapshot adopta lastSeq e invalida las corridas activas; reset limpia versiones y reconcilia', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    make().start();
    await tick();
    const s = conns[0]!.stream;
    s.push(sse('snapshot', { lastSeq: 40, activeRunIds: ['run-a'] }));
    await tick();
    expect(mgr!.lastEventId).toBe('40');
    expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(JSON.stringify(['runs', 'detail', 'run-a']));
    s.push(sse('run.updated', ev(41, { version: 9 })));
    s.push(sse('reset', { reason: 'last_event_id_expirado', lastSeq: 50 }));
    await tick();
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['runs']));
    expect(keys).toContain(JSON.stringify(['schedules']));
    // Tras reset, una versión menor de la misma entidad vuelve a aceptarse (versiones olvidadas).
    expect(mgr!.ingest(ev(51, { version: 1 }))).toBe(true);
    expect(mgr!.ingest(ev(50))).toBe(false);
  });

  it('reconecta con backoff y Last-Event-ID tras corte; reconcilia al reabrir', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    make().start();
    await tick();
    conns[0]!.stream.push(sse('run.updated', ev(12), '12'));
    await tick();
    conns[0]!.stream.close();
    await tick();
    expect(sseStore.state.status).toBe('reconnecting');
    expect(sseStore.state.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(conns).toHaveLength(2);
    expect(conns[1]!.headers['Last-Event-ID']).toBe('12');
    expect(sseStore.state.status).toBe('open');
    expect(sseStore.state.failures).toBe(0);
    expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(JSON.stringify(['runs']));
  });

  it('errores HTTP repetidos aumentan el backoff; 404/501 marcan unavailable', async () => {
    nextStatus = [500, 503, 404];
    make().start();
    await tick();
    expect(sseStore.state).toMatchObject({ status: 'reconnecting', failures: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sseStore.state).toMatchObject({ status: 'reconnecting', failures: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sseStore.state).toMatchObject({ status: 'unavailable', failures: 3 });
    expect(conns).toHaveLength(3);
  });

  it('401 detiene el canal y avisa (sesión vencida), sin reintentos', async () => {
    nextStatus = [401];
    const onUnauthorized = vi.fn();
    make({ onUnauthorized }).start();
    await tick();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(sseStore.state.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conns).toHaveLength(1);
  });

  it('pestaña oculta suspende el canal; al volver reconecta con Last-Event-ID y reconcilia', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    make().start();
    await tick();
    conns[0]!.stream.push(sse('run.updated', ev(3), '3'));
    await tick();
    vis.set(true);
    await tick();
    expect(conns[0]!.signal.aborted).toBe(true);
    expect(sseStore.state.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(conns).toHaveLength(1); // nada de reconexiones con la pestaña oculta
    spy.mockClear();
    vis.set(false);
    await tick();
    expect(conns).toHaveLength(2);
    expect(conns[1]!.headers['Last-Event-ID']).toBe('3');
    expect(sseStore.state.status).toBe('open');
    expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(JSON.stringify(['runs']));
  });

  it('arranca en pausa si la pestaña ya está oculta', async () => {
    vis.hidden = true;
    make().start();
    await tick();
    expect(conns).toHaveLength(0);
    expect(sseStore.state.status).toBe('paused');
  });

  it('stop mientras se espera la respuesta no deja un lector abierto', async () => {
    let resolve!: (r: Response) => void;
    const slow = vi.fn(() => new Promise<Response>((r) => (resolve = r))) as unknown as typeof fetch;
    const m = make({ fetchImpl: slow });
    m.start();
    m.stop();
    const s = fakeStream();
    resolve(s.response);
    await tick();
    expect(sseStore.state.status).toBe('closed');
    // El cuerpo se cancela (no queda un lector colgado) y no se reabre el canal.
    expect(s.response.bodyUsed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('envía X-CSRF-Token si existe', async () => {
    setCsrfToken('tok');
    make().start();
    await tick();
    expect(conns[0]!.headers['X-CSRF-Token']).toBe('tok');
  });
});

describe('fallback de polling', () => {
  it('nunca sondea con SSE sano, en pausa o cerrado', () => {
    for (const status of ['open', 'idle', 'connecting', 'paused', 'closed'] as const) {
      expect(fallbackInterval({ status, failures: 3 }, 'detail')).toBe(false);
    }
  });
  it('detalle 5 s, lista 30 s, con backoff hasta 60 s', () => {
    expect(fallbackInterval({ status: 'reconnecting', failures: 1 }, 'detail')).toBe(5_000);
    expect(fallbackInterval({ status: 'reconnecting', failures: 2 }, 'detail')).toBe(10_000);
    expect(fallbackInterval({ status: 'unavailable', failures: 1 }, 'list')).toBe(30_000);
    expect(fallbackInterval({ status: 'unavailable', failures: 9 }, 'list')).toBe(POLL_MAX_MS);
    expect(fallbackInterval({ status: 'reconnecting', failures: 9 }, 'detail')).toBe(POLL_MAX_MS);
  });
  it('defaultBackoff crece exponencialmente con jitter y tope de 30 s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(defaultBackoff(1)).toBe(1000);
    expect(defaultBackoff(3)).toBe(4000);
    expect(defaultBackoff(20)).toBe(30_000);
  });
});
