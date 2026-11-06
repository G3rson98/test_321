/**
 * Heartbeat cada 15 s con fencing; 409 LEASE_STALE detiene; cancelRequested detiene; sin heartbeat exitoso durante
 * 75 s ⇒ lease vencido. Cliente HTTP: 409 no se reintenta, 5xx sí (callbacks idempotentes).
 * RNF-CON-01, RF-EJE-03, RF-EJE-08, ESP §13.3.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from '@katalyst/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultTracker } from '../src/executor/result-tracker.js';
import { HeartbeatLoop, type HeartbeatStop } from '../src/heartbeat.js';
import { isLeaseLost, WorkerApiError } from '../src/worker-api/errors.js';
import { HttpWorkerApiClient } from '../src/worker-api/http.js';
import { assignedTest } from './helpers/assignment.js';
import { FakeWorkerApi } from './helpers/fake-api.js';
import { FakeClock, flush } from './helpers/fake-clock.js';
import { silentLogger } from './helpers/logger.js';

describe('HeartbeatLoop (RNF-CON-01)', () => {
  function setup(api: FakeWorkerApi, generation = 1) {
    const clock = new FakeClock();
    const stops: HeartbeatStop[] = [];
    const loop = new HeartbeatLoop({
      api,
      leaseId: randomUUID(),
      generation,
      clock,
      progress: () => ({ completed: 1, total: 3 }),
      onStop: (s) => stops.push(s),
    });
    return { clock, stops, loop };
  }

  it('late inmediatamente y cada 15 s con leaseId+generation y progreso', async () => {
    const api = new FakeWorkerApi();
    const { clock, loop, stops } = setup(api);
    loop.start();
    await flush();
    expect(api.ops('heartbeat')).toHaveLength(1);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(api.ops('heartbeat')).toHaveLength(3);
    expect(api.ops('heartbeat')[0]).toMatchObject({ generation: 1, progress: { completed: 1, total: 3 } });
    expect(stops).toEqual([]);
    await loop.stop();
  });

  it('cancelRequested en la respuesta ⇒ detener por cancelación', async () => {
    const api = new FakeWorkerApi();
    const { clock, loop, stops } = setup(api);
    loop.start();
    await flush();
    api.cancelRequested = true;
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(stops).toEqual([expect.objectContaining({ reason: 'cancel' })]);
    await clock.advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(api.ops('heartbeat')).toHaveLength(2);
  });

  it('409 LEASE_STALE (generación vieja) ⇒ detener de inmediato, sin más latidos', async () => {
    const api = new FakeWorkerApi();
    api.currentGeneration = 2; // otro worker recibió el shard
    const { clock, loop, stops } = setup(api, 1);
    loop.start();
    await flush();
    expect(stops).toEqual([expect.objectContaining({ reason: 'lease_lost', code: 'LEASE_STALE' })]);
    await clock.advance(HEARTBEAT_INTERVAL_MS * 4);
    expect(api.ops('heartbeat')).toHaveLength(1);
  });

  it('API inaccesible durante LEASE_TTL_MS ⇒ lease vencido (unreachable)', async () => {
    const api = new FakeWorkerApi();
    api.heartbeatError = new WorkerApiError(0, 'NETWORK_ERROR', 'red', true);
    const { clock, loop, stops } = setup(api);
    loop.start();
    await flush();
    await clock.advance(LEASE_TTL_MS - HEARTBEAT_INTERVAL_MS);
    expect(stops).toEqual([]);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(stops).toEqual([expect.objectContaining({ reason: 'unreachable' })]);
  });
});

describe('Fencing en callbacks (RF-EJE-08)', () => {
  it('tras 409 LEASE_STALE el tracker no publica más resultados y pide detener', async () => {
    const api = new FakeWorkerApi();
    const t1 = assignedTest(randomUUID());
    const t2 = assignedTest(randomUUID());
    const stops: string[] = [];
    const tracker = new ResultTracker({
      api,
      leaseId: randomUUID(),
      generation: 1,
      tests: [t1, t2],
      logger: silentLogger(),
      knownSecrets: () => [],
      now: () => new Date(),
      gateDir: null,
      requestStop: (c) => stops.push(c),
    });
    const begin = (t: typeof t1, id: string) =>
      tracker.handle({ type: 'testBegin', key: `${t.stableKey}::default`, testId: id, title: id, projectName: 'p', isSetup: false, retry: 0, startTime: new Date().toISOString() });
    const end = (t: typeof t1, id: string) =>
      tracker.handle({
        type: 'testEnd', key: `${t.stableKey}::default`, testId: id, title: id, projectName: 'p', isSetup: false, retry: 0, retries: 0,
        status: 'passed', expectedStatus: 'passed', startTime: new Date().toISOString(), duration: 10, timeoutMs: 1000, errors: [], annotations: [], attachments: [], willRetry: false,
      });
    await begin(t1, 'a');
    await end(t1, 'a');
    expect(api.ops('result')).toHaveLength(1);
    api.currentGeneration = 2;
    await begin(t2, 'b');
    await end(t2, 'b');
    expect(stops).toEqual(['lease_lost']);
    expect(api.ops('result')).toHaveLength(1);
    await tracker.block(t2, 'variante_faltante', 'x');
    expect(api.ops('attempt')).toHaveLength(2);
  });

  it('el mismo resultado repetido es idempotente; contenido distinto con la misma clave es conflicto', async () => {
    const api = new FakeWorkerApi();
    const base = {
      leaseId: randomUUID(), generation: 1, runResultId: randomUUID(), attemptNo: 1, attemptStatus: 'pasado' as const,
      finishedAt: new Date().toISOString(), durationMs: 5, errorCategory: null, error: null, final: true, finalStatus: 'pasado' as const,
    };
    await api.postResult(base);
    await expect(api.postResult(base)).resolves.toMatchObject({ duplicate: true });
    await expect(api.postResult({ ...base, durationMs: 6 })).rejects.toMatchObject({ code: 'CALLBACK_CONFLICT' });
  });
});

describe('HttpWorkerApiClient contra servidor HTTP local', () => {
  let server: http.Server | null = null;
  afterEach(() => server?.close());

  async function serve(handler: (req: http.IncomingMessage, body: string) => { status: number; json: unknown }) {
    const seen: Array<{ url: string; auth: string | undefined; idem: string | undefined }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string | undefined });
        const r = handler(req, body);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { seen, baseUrl: `http://127.0.0.1:${port}` };
  }

  it('409 LEASE_STALE no se reintenta y se reconoce como lease perdido; envía Bearer leaseToken', async () => {
    const { seen, baseUrl } = await serve(() => ({ status: 409, json: { error: { code: 'LEASE_STALE', message: 'x', requestId: 'r' } } }));
    const token = 'lease-token-'.padEnd(40, 'x');
    const api = new HttpWorkerApiClient({ baseUrl, token: () => token, backoffBaseMs: 1 });
    const err = await api.heartbeat({ leaseId: randomUUID(), generation: 1 }).catch((e: unknown) => e);
    expect(isLeaseLost(err)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: '/api/v1/worker/heartbeat', auth: `Bearer ${token}` });
  });

  it('5xx se reintenta (idempotente) con Idempotency-Key estable', async () => {
    let n = 0;
    const { seen, baseUrl } = await serve(() =>
      ++n < 3 ? { status: 503, json: {} } : { status: 200, json: { runResultId: randomUUID(), attemptNo: 1, status: 'pasado', duplicate: false, retryAllowed: false } },
    );
    const api = new HttpWorkerApiClient({ baseUrl, token: () => 'x'.repeat(40), backoffBaseMs: 1 });
    const rr = randomUUID();
    await api.postResult({
      leaseId: randomUUID(), generation: 1, runResultId: rr, attemptNo: 1, attemptStatus: 'pasado', finishedAt: new Date().toISOString(),
      durationMs: 1, errorCategory: null, error: null, final: true, finalStatus: 'pasado',
    });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.idem))).toEqual(new Set([`result:${rr}:1`]));
  });

  it('respuesta fuera de contrato ⇒ INVALID_RESPONSE', async () => {
    const { baseUrl } = await serve(() => ({ status: 200, json: { ok: 'no' } }));
    const api = new HttpWorkerApiClient({ baseUrl, token: () => 'x'.repeat(40), backoffBaseMs: 1 });
    await expect(api.complete({ leaseId: randomUUID(), generation: 1, shardStatus: 'completado', reason: null, runtimeVersions: {} })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
