/**
 * Clientes HTTP de la API de worker. El ejecutor usa SOLO `KATALYST_WORKER_API_URL` con su `leaseToken`
 * (RNF-SEG-05: sin BD/Redis/Docker); el supervisor usa la API interna con su credencial de servicio.
 * Los callbacks son idempotentes por clave estable (ESP §13.3), por lo que se reintentan ante fallas
 * transitorias (red, 5xx, 429) con backoff; 4xx no se reintenta. Respuestas validadas con Zod.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { z } from 'zod';
import {
  WorkerArtifactFinalizeResponseSchema,
  WorkerArtifactUploadResponseSchema,
  WorkerAttemptStartResponseSchema,
  WorkerCatalogListingResponseSchema,
  WorkerCompleteResponseSchema,
  WorkerHeartbeatResponseSchema,
  WorkerPerfSamplesResponseSchema,
  WorkerResultResponseSchema,
} from '@katalyst/shared';
import { WorkerApiError } from './errors.js';
import {
  RunnerClaimResponseSchema,
  type ArtifactFinalizeRequest,
  type ArtifactUploadRequest,
  type AttemptStartRequest,
  type CatalogListingRequest,
  type ClaimRequest,
  type CompleteRequest,
  type HeartbeatRequest,
  type PerfSamplesRequest,
  type ResultRequest,
  type SupervisorApiClient,
  type UploadTarget,
  type WorkerApiClient,
} from './types.js';

export const WORKER_API_PREFIX = '/api/v1/worker';

export interface HttpClientOptions {
  baseUrl: string;
  /** Devuelve el token (Bearer). Se llama en cada solicitud; nunca se registra. */
  token: () => string | Promise<string>;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

interface CallOptions {
  idempotencyKey?: string;
  retry?: boolean;
  maxAttempts?: number;
}

export class HttpJsonClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = new URL(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  resolve(pathOrUrl: string): URL {
    return new URL(pathOrUrl, this.base);
  }

  isSameOrigin(url: URL): boolean {
    return url.origin === this.base.origin;
  }

  async post<S extends z.ZodType>(path: string, body: unknown, schema: S, call: CallOptions = {}): Promise<z.infer<S>> {
    const maxAttempts = call.retry === false ? 1 : (call.maxAttempts ?? this.opts.maxAttempts ?? 5);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.once(path, body, schema, call);
      } catch (e) {
        lastError = e;
        const retryable = e instanceof WorkerApiError ? e.retryable : true;
        if (!retryable || attempt === maxAttempts) break;
        const base = this.opts.backoffBaseMs ?? 500;
        await this.sleep(Math.min(10_000, base * 2 ** (attempt - 1)));
      }
    }
    if (lastError instanceof WorkerApiError) throw lastError;
    throw new WorkerApiError(0, 'NETWORK_ERROR', 'No se pudo contactar la API de worker', true);
  }

  private async once<S extends z.ZodType>(path: string, body: unknown, schema: S, call: CallOptions): Promise<z.infer<S>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${await this.opts.token()}`,
      'user-agent': this.opts.userAgent ?? 'katalyst-runner',
    };
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(this.resolve(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 15_000),
      });
    } catch {
      throw new WorkerApiError(0, 'NETWORK_ERROR', 'Error de red con la API de worker', true);
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
      const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`;
      const message = typeof err?.message === 'string' ? err.message : `HTTP ${res.status}`;
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new WorkerApiError(res.status, code, message, retryable);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new WorkerApiError(502, 'INVALID_RESPONSE', 'Respuesta de la API no cumple el contrato', false);
    return parsed.data as z.infer<S>;
  }

  /** Carga del contenido a la URL acotada emitida por la API (S3/MinIO firmada o ruta de la propia API). */
  async upload(target: UploadTarget, file: string, sizeBytes: number): Promise<void> {
    const url = this.resolve(target.url);
    const headers: Record<string, string> = { ...target.headers, 'content-length': String(sizeBytes) };
    // El leaseToken solo viaja a la propia API; nunca a un almacén externo (la URL firmada ya autoriza).
    if (this.isSameOrigin(url) && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
      headers.authorization = `Bearer ${await this.opts.token()}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: target.method,
        headers,
        body: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream,
        duplex: 'half',
        signal: AbortSignal.timeout(Math.max(60_000, this.opts.requestTimeoutMs ?? 15_000)),
      } as RequestInit);
    } catch {
      throw new WorkerApiError(0, 'UPLOAD_NETWORK_ERROR', 'Error de red al cargar el artefacto', true);
    }
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new WorkerApiError(res.status, `UPLOAD_HTTP_${res.status}`, 'Carga de artefacto rechazada', res.status >= 500);
  }
}

export class HttpWorkerApiClient implements WorkerApiClient {
  readonly http: HttpJsonClient;
  constructor(opts: HttpClientOptions) {
    this.http = new HttpJsonClient(opts);
  }

  heartbeat(req: HeartbeatRequest) {
    // El heartbeat no se reintenta en bucle: el próximo tick es el reintento natural.
    return this.http.post(`${WORKER_API_PREFIX}/heartbeat`, req, WorkerHeartbeatResponseSchema, { maxAttempts: 2 });
  }
  startAttempt(req: AttemptStartRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/attempts`, req, WorkerAttemptStartResponseSchema, {
      idempotencyKey: `attempt:${req.runResultId}:${req.attemptNo}`,
    });
  }
  postResult(req: ResultRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/results`, req, WorkerResultResponseSchema, {
      idempotencyKey: `result:${req.runResultId}:${req.attemptNo}`,
    });
  }
  requestArtifactUpload(req: ArtifactUploadRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/artifacts/upload`, req, WorkerArtifactUploadResponseSchema, {
      idempotencyKey: `artifact:${req.runResultId ?? 'run'}:${req.attemptNo ?? 0}:${req.kind}:${req.checksumSha256}`,
    });
  }
  uploadArtifactContent(target: UploadTarget, file: string, sizeBytes: number) {
    return this.http.upload(target, file, sizeBytes);
  }
  finalizeArtifact(artifactId: string, req: ArtifactFinalizeRequest) {
    return this.http.post(
      `${WORKER_API_PREFIX}/artifacts/${encodeURIComponent(artifactId)}/finalize`,
      req,
      WorkerArtifactFinalizeResponseSchema,
      { idempotencyKey: `finalize:${artifactId}` },
    );
  }
  postPerfSamples(req: PerfSamplesRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/perf/samples`, req, WorkerPerfSamplesResponseSchema, {
      idempotencyKey: `perf:${req.leaseId}`,
    });
  }
  complete(req: CompleteRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/complete`, req, WorkerCompleteResponseSchema, {
      idempotencyKey: `complete:${req.leaseId}`,
    });
  }
}

export class HttpSupervisorApiClient implements SupervisorApiClient {
  readonly http: HttpJsonClient;
  constructor(opts: HttpClientOptions) {
    this.http = new HttpJsonClient(opts);
  }
  claim(req: ClaimRequest) {
    // Sin reintento HTTP: un claim repetido podría devolver SHARD_NOT_CLAIMABLE; BullMQ reintenta el trabajo.
    return this.http.post(`${WORKER_API_PREFIX}/claim`, req, RunnerClaimResponseSchema, { retry: false });
  }
  postCatalogListing(req: CatalogListingRequest) {
    return this.http.post(`${WORKER_API_PREFIX}/catalog/listing`, req, WorkerCatalogListingResponseSchema, {
      idempotencyKey: `catalog:${req.catalogRevisionId}`,
    });
  }
}
