/**
 * Servidor HTTP falso de la API de worker para pruebas de integración locales: mismas rutas y códigos que el
 * contrato (`/api/v1/worker/*`, `{error:{code,message,requestId}}`), con autenticación separada para el
 * supervisor (token de servicio) y el ejecutor (leaseToken). Delegado en `FakeWorkerApi`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { WorkerCatalogListingRequestSchema, WorkerClaimRequestSchema } from '@katalyst/shared';
import { WorkerApiError } from '../../src/worker-api/errors.js';
import type { RunnerClaimResponse, RunnerShardAssignment } from '../../src/worker-api/types.js';
import { FakeWorkerApi } from './fake-api.js';

export interface FakeApiServer {
  url: string;
  api: FakeWorkerApi;
  serviceToken: string;
  leaseToken: string;
  leaseId: string;
  claims: unknown[];
  listings: unknown[];
  rawBodies: string[];
  setAssignment(a: RunnerShardAssignment): void;
  close(): Promise<void>;
}

export async function startFakeApiServer(): Promise<FakeApiServer> {
  const api = new FakeWorkerApi();
  const serviceToken = `svc-${randomBytes(24).toString('hex')}`;
  const leaseToken = `lease-${randomBytes(24).toString('hex')}`;
  const leaseId = randomUUID();
  let assignment: RunnerShardAssignment | null = null;
  const claims: unknown[] = [];
  const listings: unknown[] = [];
  const rawBodies: string[] = [];
  let claimed = false;

  const send = (res: http.ServerResponse, status: number, json: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  const fail = (res: http.ServerResponse, e: unknown) => {
    if (e instanceof WorkerApiError) return send(res, e.status, { error: { code: e.code, message: e.message, requestId: 'test' } });
    return send(res, 422, { error: { code: 'VALIDATION_FAILED', message: (e as Error).message.slice(0, 200), requestId: 'test' } });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? '';
      const auth = req.headers.authorization ?? '';
      try {
        if (req.method === 'PUT' && /^\/api\/v1\/worker\/artifacts\/[^/]+\/content$/.test(url)) {
          if (auth !== `Bearer ${leaseToken}`) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 't' } });
          api.uploaded.push({ target: { method: 'PUT', url, headers: {} }, file: '', size: raw.length, content: raw });
          res.writeHead(204).end();
          return;
        }
        const text = raw.toString('utf8');
        rawBodies.push(text);
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const route = url.replace(/^\/api\/v1\/worker/, '');
        if (route === '/claim' || route === '/catalog/listing') {
          if (auth !== `Bearer ${serviceToken}`) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 't' } });
          if (route === '/catalog/listing') {
            listings.push(WorkerCatalogListingRequestSchema.parse(body));
            return send(res, 200, { ok: true, status: 'recibido' });
          }
          claims.push(WorkerClaimRequestSchema.parse(body));
          if (claimed || !assignment) return send(res, 409, { error: { code: 'SHARD_NOT_CLAIMABLE', message: 'x', requestId: 't' } });
          claimed = true;
          const r: RunnerClaimResponse = {
            leaseId,
            generation: 1,
            leaseToken,
            leaseExpiresAt: new Date(Date.now() + 75_000).toISOString(),
            heartbeatIntervalMs: 15_000,
            assignment,
          };
          return send(res, 200, r);
        }
        if (auth !== `Bearer ${leaseToken}`) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 't' } });
        const finalize = /^\/artifacts\/([^/]+)\/finalize$/.exec(route);
        const handlers: Record<string, () => Promise<unknown>> = {
          '/heartbeat': () => api.heartbeat(body as never),
          '/attempts': () => api.startAttempt(body as never),
          '/results': () => api.postResult(body as never),
          '/artifacts/upload': () => api.requestArtifactUpload(body as never),
          '/perf/samples': () => api.postPerfSamples(body as never),
          '/complete': () => api.complete(body as never),
        };
        const h = finalize ? () => api.finalizeArtifact(finalize[1]!, body as never) : handlers[route];
        if (!h) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 't' } });
        send(res, 200, await h());
      } catch (e) {
        fail(res, e);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    api,
    serviceToken,
    leaseToken,
    leaseId,
    claims,
    listings,
    rawBodies,
    setAssignment: (a) => {
      assignment = a;
      claimed = false;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
