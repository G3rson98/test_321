/**
 * Servidor HTTP falso (loopback, solo pruebas) que imita los contratos de /api/v1 que consume el asistente:
 * flujo de dispositivo, heartbeat, grabaciones y ambientes (DTO de @katalyst/shared). La API real la implementa
 * API-C en paralelo; este doble permite probar el cliente sin ella.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { EnvironmentSummary, RecordingSession } from '@katalyst/shared/schemas';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export type DeviceBehavior =
  | { kind: 'approve-after'; polls: number }
  | { kind: 'never' }
  | { kind: 'slow-down-at'; polls: number[]; approveAfter: number }
  | { kind: 'deny-after'; polls: number }
  | { kind: 'expire-after'; polls: number };

export interface FakeApi {
  url: string;
  apiBase: string;
  requests: RecordedRequest[];
  device: {
    behavior: DeviceBehavior;
    polls: number;
    deviceCode: string;
    userCode: string;
    token: string;
    deviceId: string;
    interval: number;
    expiresIn: number;
  };
  recordings: Map<string, RecordingSession>;
  environments: EnvironmentSummary[];
  completeResponse: (rec: RecordingSession, body: Record<string, unknown>) => { status: number; body: unknown };
  revoked: boolean;
  close(): Promise<void>;
}

const DEVICE_CODE = 'dc_' + 'a'.repeat(40);
const TOKEN = 'kdev_' + 'b'.repeat(48);

export function sendError(res: ServerResponse, status: number, code: string, message = code) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message, requestId: randomUUID() } }));
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    url: '',
    apiBase: '',
    requests: [],
    device: {
      behavior: { kind: 'approve-after', polls: 2 },
      polls: 0,
      deviceCode: DEVICE_CODE,
      userCode: 'ABCD-EFGH',
      token: TOKEN,
      deviceId: randomUUID(),
      interval: 5,
      expiresIn: 300,
    },
    recordings: new Map(),
    environments: [],
    completeResponse: (rec) => ({
      status: 200,
      body: {
        ...rec,
        status: 'pr_abierto',
        prUrl: 'https://git.example.test/qa-tests/pull/84',
        branch: 'grabacion/c1501',
        updatedAt: new Date().toISOString(),
      },
    }),
    revoked: false,
    close: async () => undefined,
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body: unknown = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      api.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      });
      handle(api, req, res, url, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  api.url = `http://127.0.0.1:${port}`;
  api.apiBase = `${api.url}/api/v1`;
  api.close = () => new Promise<void>((r) => server.close(() => r()));
  return api;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function authed(api: FakeApi, req: IncomingMessage, res: ServerResponse): boolean {
  if (api.revoked || req.headers.authorization !== `Bearer ${api.device.token}`) {
    sendError(res, 401, 'TOKEN_REVOKED');
    return false;
  }
  return true;
}

function handle(api: FakeApi, req: IncomingMessage, res: ServerResponse, url: URL, body: unknown) {
  const p = url.pathname.replace(/^\/api\/v1/, '');
  const m = req.method;
  if (m === 'POST' && p === '/devices/authorize') {
    api.device.polls = 0;
    return json(res, 200, {
      deviceCode: api.device.deviceCode,
      userCode: api.device.userCode,
      verificationUri: `${api.url}/dispositivos`,
      verificationUriComplete: `${api.url}/dispositivos?codigo=${api.device.userCode}`,
      expiresIn: api.device.expiresIn,
      interval: api.device.interval,
    });
  }
  if (m === 'POST' && p === '/devices/token') {
    if ((body as { deviceCode?: string } | null)?.deviceCode !== api.device.deviceCode)
      return sendError(res, 400, 'DEVICE_CODE_INVALID');
    api.device.polls += 1;
    const n = api.device.polls;
    const b = api.device.behavior;
    const grant = () =>
      json(res, 200, {
        accessToken: api.device.token,
        tokenType: 'Bearer',
        deviceId: api.device.deviceId,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    switch (b.kind) {
      case 'approve-after':
        return n >= b.polls ? grant() : sendError(res, 400, 'DEVICE_AUTHORIZATION_PENDING');
      case 'never':
        return sendError(res, 400, 'DEVICE_AUTHORIZATION_PENDING');
      case 'slow-down-at':
        if (b.polls.includes(n)) return sendError(res, 429, 'DEVICE_SLOW_DOWN');
        return n >= b.approveAfter ? grant() : sendError(res, 400, 'DEVICE_AUTHORIZATION_PENDING');
      case 'deny-after':
        return n >= b.polls
          ? sendError(res, 403, 'DEVICE_ACCESS_DENIED')
          : sendError(res, 400, 'DEVICE_AUTHORIZATION_PENDING');
      case 'expire-after':
        return n >= b.polls
          ? sendError(res, 400, 'DEVICE_CODE_EXPIRED')
          : sendError(res, 400, 'DEVICE_AUTHORIZATION_PENDING');
    }
  }
  if (m === 'POST' && p === '/devices/heartbeat') {
    if (!authed(api, req, res)) return;
    return json(res, 204, undefined);
  }
  const del = /^\/devices\/([0-9a-f-]{36})$/.exec(p);
  if (m === 'DELETE' && del) {
    if (!authed(api, req, res)) return;
    api.revoked = true;
    return json(res, 204, undefined);
  }
  if (m === 'GET' && p === '/environments') {
    if (!authed(api, req, res)) return;
    return json(res, 200, { items: api.environments });
  }
  if (m === 'GET' && p === '/recordings') {
    if (!authed(api, req, res)) return;
    return json(res, 200, { items: [...api.recordings.values()], nextCursor: null, hasNext: false });
  }
  const rec = /^\/recordings\/([0-9a-f-]{36})(?:\/(status|complete|cancel))?$/.exec(p);
  if (rec) {
    if (!authed(api, req, res)) return;
    const r = api.recordings.get(rec[1]!);
    if (!r) return sendError(res, 404, 'NOT_FOUND');
    const action = rec[2];
    if (m === 'GET' && !action) return json(res, 200, r);
    if (m === 'POST' && action === 'status') {
      const s = (body as { status: RecordingSession['status']; steps?: RecordingSession['steps'] }) ?? {};
      api.recordings.set(r.id, { ...r, status: s.status, steps: s.steps ?? r.steps });
      return json(res, 200, api.recordings.get(r.id));
    }
    if (m === 'POST' && action === 'complete') {
      const out = api.completeResponse(r, body as Record<string, unknown>);
      if (out.status < 400) api.recordings.set(r.id, out.body as RecordingSession);
      return json(res, out.status, out.body);
    }
    if (m === 'POST' && action === 'cancel') {
      if (['pr_abierto', 'rechazada', 'cancelada', 'vencida'].includes(r.status))
        return sendError(res, 409, 'RECORDING_INVALID_STATE');
      api.recordings.set(r.id, { ...r, status: 'cancelada' });
      return json(res, 200, api.recordings.get(r.id));
    }
  }
  sendError(res, 404, 'ROUTE_NOT_FOUND');
}

export function makeRecording(overrides: Partial<RecordingSession> = {}): RecordingSession {
  const now = Date.now();
  return {
    id: randomUUID(),
    caseId: randomUUID(),
    caseRef: 'C1501',
    environmentId: randomUUID(),
    createdBy: randomUUID(),
    deviceId: null,
    status: 'creada',
    tags: ['@agendamiento'],
    expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    branch: null,
    prUrl: null,
    commit: null,
    rejectionReasons: [],
    steps: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

/** Reloj virtual: `sleep` avanza el tiempo al instante (las pruebas no esperan segundos reales). */
export function virtualClock(start = Date.UTC(2026, 10, 6, 12, 0, 0)) {
  const sleeps: number[] = [];
  const clock = {
    t: start,
    sleeps,
    now: () => clock.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('aborted');
      sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}
