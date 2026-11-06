/**
 * Cliente HTTP de la API /api/v1 para el asistente local (programado contra los DTO de `@katalyst/shared`).
 * - Solo HTTPS saliente (validado en `config.ts`); `redirect: 'error'` para no reenviar la credencial a otro host.
 * - La credencial del dispositivo viaja solo en `Authorization: Bearer` y nunca se registra ni se refleja en errores.
 * - Errores con el sobre `{ error: { code, message, requestId } }` de ESP §9.
 * RF-GRB-01, RF-GRB-02, RF-GRB-06, RNF-SEG-01.
 */
import { z } from 'zod';
import {
  DeviceAuthorizeResponseSchema,
  DeviceTokenResponseSchema,
  EnvironmentSummarySchema,
  HttpUrlSchema,
  RecordingSessionSchema,
  type RecordingComplete,
} from '@katalyst/shared/schemas';
import { sanitizeErrorMessage } from '@katalyst/shared/sanitize';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, requestId: string | null = null, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().max(100),
    message: z.string().max(2000).optional(),
    requestId: z.string().max(200).optional(),
    details: z.unknown().optional(),
  }),
});

/**
 * Detalle de grabación para el asistente. `environment` es una extensión que el asistente consume si la API la
 * provee (pendiente [RECORDER→API-C]); sin ella se usa `GET /environments` y se bloquea si no puede verificarse.
 */
export const RecordingEnvironmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  appUrl: HttpUrlSchema.nullable().optional(),
  isProduction: z.boolean(),
  recordingAllowed: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export const RecordingDetailSchema = RecordingSessionSchema.extend({
  environment: RecordingEnvironmentSchema.optional(),
});
export type RecordingDetail = z.infer<typeof RecordingDetailSchema>;

const RecordingPageSchema = z.object({
  items: z.array(RecordingSessionSchema),
  nextCursor: z.string().nullable().default(null),
  hasNext: z.boolean().default(false),
});
export type RecordingPage = z.infer<typeof RecordingPageSchema>;

const EnvironmentListSchema = z.union([
  z.array(EnvironmentSummarySchema),
  z.object({ items: z.array(EnvironmentSummarySchema) }).transform((v) => v.items),
]);

/** `complete`/`cancel` pueden responder la sesión directamente o envuelta en `{ recording }`. */
const RecordingResponseSchema = z.union([
  RecordingSessionSchema,
  z.object({ recording: RecordingSessionSchema }).transform((v) => v.recording),
]);

export interface ApiClientOptions {
  /** `https://host/api/v1` */
  baseUrl: string;
  fetch?: FetchLike;
  getToken?: () => string | null;
  timeoutMs?: number;
  userAgent?: string;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  query?: Record<string, string | undefined>;
}

export class KatalystApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly getToken: () => string | null;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.getToken = opts.getToken ?? (() => null);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.userAgent = opts.userAgent ?? 'KatalystRecorder';
  }

  // ---- Flujo de dispositivo (ESP §13.6) -------------------------------------------------------------

  async deviceAuthorize(body: { clientName: string; clientVersion: string; platform: 'windows' | 'macos' | 'linux' }) {
    return DeviceAuthorizeResponseSchema.parse(
      await this.request({ method: 'POST', path: '/devices/authorize', body, auth: false }),
    );
  }

  async deviceToken(deviceCode: string, signal?: AbortSignal) {
    const opts: RequestOptions = { method: 'POST', path: '/devices/token', body: { deviceCode }, auth: false };
    if (signal) opts.signal = signal;
    return DeviceTokenResponseSchema.parse(await this.request(opts));
  }

  async deviceHeartbeat(body: { clientVersion: string; activeRecordingId: string | null }): Promise<void> {
    await this.request({ method: 'POST', path: '/devices/heartbeat', body });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request({ method: 'DELETE', path: `/devices/${encodeURIComponent(deviceId)}` });
  }

  // ---- Grabaciones ---------------------------------------------------------------------------------

  async listRecordings(query: { status?: string; cursor?: string; limit?: number } = {}): Promise<RecordingPage> {
    const data = await this.request({
      method: 'GET',
      path: '/recordings',
      query: { status: query.status, cursor: query.cursor, limit: String(query.limit ?? 25) },
    });
    return RecordingPageSchema.parse(data);
  }

  async getRecording(id: string): Promise<RecordingDetail> {
    return RecordingDetailSchema.parse(
      await this.request({ method: 'GET', path: `/recordings/${encodeURIComponent(id)}` }),
    );
  }

  async listEnvironments() {
    return EnvironmentListSchema.parse(await this.request({ method: 'GET', path: '/environments' }));
  }

  async updateRecordingStatus(
    id: string,
    body: {
      status: 'vinculada' | 'grabando' | 'validando';
      steps?: { kind: 'accion' | 'verificacion' | 'no_soportada'; description: string }[];
    },
  ): Promise<void> {
    await this.request({ method: 'POST', path: `/recordings/${encodeURIComponent(id)}/status`, body });
  }

  async completeRecording(id: string, body: RecordingComplete) {
    const data = await this.request({
      method: 'POST',
      path: `/recordings/${encodeURIComponent(id)}/complete`,
      body,
      timeoutMs: 120_000,
    });
    return RecordingResponseSchema.parse(data);
  }

  async cancelRecording(id: string, reason?: string): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/recordings/${encodeURIComponent(id)}/cancel`,
      body: reason ? { reason } : {},
    });
  }

  // ---- Transporte ----------------------------------------------------------------------------------

  private async request(opts: RequestOptions): Promise<unknown> {
    const url = new URL(this.baseUrl + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      const token = this.getToken();
      if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'El asistente no está vinculado.');
      headers.authorization = `Bearer ${token}`;
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: opts.method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new ApiError(0, 'ABORTED', 'Operación cancelada.');
      const timedOut = timeout.aborted;
      throw new ApiError(
        0,
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? 'Katalyst no respondió a tiempo.' : 'No se pudo conectar con Katalyst.',
        null,
        e instanceof Error ? e.name : null,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const env = ErrorEnvelopeSchema.safeParse(json);
      if (env.success) {
        const { code, message, requestId, details } = env.data.error;
        throw new ApiError(
          res.status,
          code,
          sanitizeErrorMessage(message ?? code, 1000),
          requestId ?? null,
          details ?? null,
        );
      }
      throw new ApiError(res.status, `HTTP_${res.status}`, `Katalyst respondió HTTP ${res.status}.`);
    }
    return json;
  }
}
