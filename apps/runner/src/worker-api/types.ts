/**
 * Contrato con la API de worker (ESP §13.3; plan §4.3; `@katalyst/shared` schemas/worker.ts). Interfaces
 * inyectables: el ejecutor y el supervisor se prueban con implementaciones falsas, sin red ni Docker.
 * RF-EJE-03, RF-EJE-05, RF-EJE-08, RF-RES-01/02, RF-REN-01, RF-CAT-01, RNF-CON-01, RNF-SEG-05.
 */
import { z } from 'zod';
import { ShardAssignmentSchema, UuidSchema, WorkerClaimResponseSchema } from '@katalyst/shared';
import type {
  WorkerArtifactFinalizeRequestSchema,
  WorkerArtifactFinalizeResponseSchema,
  WorkerArtifactUploadRequestSchema,
  WorkerArtifactUploadResponseSchema,
  WorkerAttemptStartRequestSchema,
  WorkerAttemptStartResponseSchema,
  WorkerCatalogListingRequestSchema,
  WorkerCatalogListingResponseSchema,
  WorkerClaimRequestSchema,
  WorkerCompleteRequestSchema,
  WorkerCompleteResponseSchema,
  WorkerHeartbeatRequestSchema,
  WorkerHeartbeatResponseSchema,
  WorkerPerfSamplesRequestSchema,
  WorkerPerfSamplesResponseSchema,
  WorkerResultRequestSchema,
  WorkerResultResponseSchema,
} from '@katalyst/shared';

/**
 * Asignación con campos opcionales hacia adelante: `environment.name` (project de Playwright =
 * `KATALYST_ENV_NAME`) y `environment.id` aún no están en el contrato compartido (pendiente API-A/API-B).
 */
export const RunnerShardAssignmentSchema = ShardAssignmentSchema.extend({
  environment: ShardAssignmentSchema.shape.environment.extend({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/i)
      .refine((v) => v !== 'setup')
      .optional(),
    id: UuidSchema.optional(),
  }),
});
export type RunnerShardAssignment = z.infer<typeof RunnerShardAssignmentSchema>;
export const RunnerClaimResponseSchema = WorkerClaimResponseSchema.extend({ assignment: RunnerShardAssignmentSchema });
export type RunnerClaimResponse = z.infer<typeof RunnerClaimResponseSchema>;

export type ClaimRequest = z.infer<typeof WorkerClaimRequestSchema>;
export type HeartbeatRequest = z.infer<typeof WorkerHeartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;
export type AttemptStartRequest = z.infer<typeof WorkerAttemptStartRequestSchema>;
export type AttemptStartResponse = z.infer<typeof WorkerAttemptStartResponseSchema>;
export type ResultRequest = z.input<typeof WorkerResultRequestSchema>;
export type ResultResponse = z.infer<typeof WorkerResultResponseSchema>;
export type ArtifactUploadRequest = z.infer<typeof WorkerArtifactUploadRequestSchema>;
export type ArtifactUploadResponse = z.infer<typeof WorkerArtifactUploadResponseSchema>;
export type ArtifactFinalizeRequest = z.infer<typeof WorkerArtifactFinalizeRequestSchema>;
export type ArtifactFinalizeResponse = z.infer<typeof WorkerArtifactFinalizeResponseSchema>;
export type PerfSamplesRequest = z.infer<typeof WorkerPerfSamplesRequestSchema>;
export type PerfSamplesResponse = z.infer<typeof WorkerPerfSamplesResponseSchema>;
export type CompleteRequest = z.input<typeof WorkerCompleteRequestSchema>;
export type CompleteResponse = z.infer<typeof WorkerCompleteResponseSchema>;
export type CatalogListingRequest = z.infer<typeof WorkerCatalogListingRequestSchema>;
export type CatalogListingResponse = z.infer<typeof WorkerCatalogListingResponseSchema>;

export interface UploadTarget {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
}

/** Callbacks del EJECUTOR con `leaseToken` (alcance shard). Todos llevan `leaseId` + `generation` (fencing). */
export interface WorkerApiClient {
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  startAttempt(req: AttemptStartRequest): Promise<AttemptStartResponse>;
  postResult(req: ResultRequest): Promise<ResultResponse>;
  requestArtifactUpload(req: ArtifactUploadRequest): Promise<ArtifactUploadResponse>;
  uploadArtifactContent(target: UploadTarget, file: string, sizeBytes: number): Promise<void>;
  finalizeArtifact(artifactId: string, req: ArtifactFinalizeRequest): Promise<ArtifactFinalizeResponse>;
  postPerfSamples(req: PerfSamplesRequest): Promise<PerfSamplesResponse>;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

/** Operaciones del SUPERVISOR con su credencial de servicio. */
export interface SupervisorApiClient {
  claim(req: ClaimRequest): Promise<RunnerClaimResponse>;
  postCatalogListing(req: CatalogListingRequest): Promise<CatalogListingResponse>;
}
