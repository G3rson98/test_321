/**
 * WorkerApiClient falso en memoria: registra llamadas, aplica fencing (generación) y permite inyectar
 * `cancelRequested`, 409 LEASE_STALE y rechazos. Valida cada solicitud con los esquemas de @katalyst/shared.
 */
import { randomUUID } from 'node:crypto';
import {
  WorkerArtifactFinalizeRequestSchema,
  WorkerArtifactUploadRequestSchema,
  WorkerAttemptStartRequestSchema,
  WorkerCompleteRequestSchema,
  WorkerHeartbeatRequestSchema,
  WorkerPerfSamplesRequestSchema,
  WorkerResultRequestSchema,
} from '@katalyst/shared';
import { WorkerApiError } from '../../src/worker-api/errors.js';
import type {
  ArtifactFinalizeRequest,
  ArtifactUploadRequest,
  AttemptStartRequest,
  CompleteRequest,
  HeartbeatRequest,
  PerfSamplesRequest,
  ResultRequest,
  UploadTarget,
  WorkerApiClient,
} from '../../src/worker-api/types.js';

export interface Call {
  op: string;
  body: unknown;
}

export class FakeWorkerApi implements WorkerApiClient {
  calls: Call[] = [];
  cancelRequested = false;
  /** Generación vigente: callbacks con otra generación ⇒ 409 LEASE_STALE. */
  currentGeneration = 1;
  proceed = true;
  rejectUploads: string | null = null;
  heartbeatError: Error | null = null;
  uploaded: Array<{ target: UploadTarget; file: string; size: number; content: Buffer }> = [];
  private readonly results = new Map<string, string>();

  private fence(b: { generation: number }): void {
    if (b.generation !== this.currentGeneration) throw new WorkerApiError(409, 'LEASE_STALE', 'Lease obsoleto', false);
  }

  ops(op: string): unknown[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.body);
  }

  async heartbeat(req: HeartbeatRequest) {
    WorkerHeartbeatRequestSchema.parse(req);
    this.calls.push({ op: 'heartbeat', body: req });
    if (this.heartbeatError) throw this.heartbeatError;
    this.fence(req);
    return {
      ok: true as const,
      leaseExpiresAt: new Date(Date.now() + 75_000).toISOString(),
      cancelRequested: this.cancelRequested,
      cancelDeadlineAt: this.cancelRequested ? new Date(Date.now() + 30_000).toISOString() : null,
    };
  }
  async startAttempt(req: AttemptStartRequest) {
    WorkerAttemptStartRequestSchema.parse(req);
    this.calls.push({ op: 'attempt', body: req });
    this.fence(req);
    return { attemptId: randomUUID(), duplicate: false, proceed: this.proceed && !this.cancelRequested };
  }
  async postResult(req: ResultRequest) {
    WorkerResultRequestSchema.parse(req);
    this.calls.push({ op: 'result', body: req });
    const key = `${req.runResultId}:${req.attemptNo}`;
    const body = JSON.stringify({ ...req, generation: undefined });
    const prev = this.results.get(key);
    if (prev !== undefined && prev !== body) throw new WorkerApiError(409, 'CALLBACK_CONFLICT', 'conflicto', false);
    if (prev === undefined) this.fence(req);
    this.results.set(key, body);
    return {
      runResultId: req.runResultId,
      attemptNo: req.attemptNo,
      status: (req.finalStatus ?? 'corriendo') as 'corriendo',
      duplicate: prev !== undefined,
      retryAllowed: !req.final,
    };
  }
  async requestArtifactUpload(req: ArtifactUploadRequest) {
    WorkerArtifactUploadRequestSchema.parse(req);
    this.calls.push({ op: 'artifact', body: req });
    this.fence(req);
    const artifactId = randomUUID();
    if (req.sanitization.status !== 'sanitizado' || this.rejectUploads) {
      return { artifactId, upload: null, rejectedReason: this.rejectUploads ?? `sanitización: ${req.sanitization.status}` };
    }
    return {
      artifactId,
      upload: { method: 'PUT' as const, url: `/api/v1/worker/artifacts/${artifactId}/content`, headers: {}, expiresAt: new Date(Date.now() + 300_000).toISOString() },
      rejectedReason: null,
    };
  }
  async uploadArtifactContent(target: UploadTarget, file: string, size: number) {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(file);
    this.calls.push({ op: 'upload', body: { url: target.url, size } });
    this.uploaded.push({ target, file, size, content });
  }
  async finalizeArtifact(artifactId: string, req: ArtifactFinalizeRequest) {
    WorkerArtifactFinalizeRequestSchema.parse(req);
    this.calls.push({ op: 'finalize', body: { artifactId, ...req } });
    this.fence(req);
    return {
      id: artifactId,
      runId: randomUUID(),
      runResultId: null,
      testAttemptId: null,
      kind: 'reporte' as const,
      contentType: 'application/json',
      sizeBytes: req.sizeBytes,
      checksum: req.checksumSha256,
      sanitizationStatus: 'sanitizado' as const,
      sanitizationReason: null,
      publishable: true,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
  }
  async postPerfSamples(req: PerfSamplesRequest) {
    WorkerPerfSamplesRequestSchema.parse(req);
    this.calls.push({ op: 'perf', body: req });
    this.fence(req);
    return { accepted: 1, duplicates: 0, quarantined: [], fileError: null };
  }
  async complete(req: CompleteRequest) {
    WorkerCompleteRequestSchema.parse(req);
    this.calls.push({ op: 'complete', body: req });
    this.fence(req);
    return { ok: true as const, duplicate: false };
  }
}
