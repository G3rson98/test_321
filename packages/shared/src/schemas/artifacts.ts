/**
 * Artefactos (evidencia sanitizada). Privados; URLs firmadas ≤ 5 min tras autorización (RNF-SEG-05).
 * RF-RES-02, RF-TR-05, RNF-SEG-02.
 */
import { z } from 'zod';
import { ArtifactKindSchema, SanitizationStatusSchema } from '../enums.js';
import { IsoDateTimeSchema, Sha256HexSchema, UuidSchema } from './common.js';

export const SIGNED_URL_MAX_TTL_SECONDS = 300;

export const ArtifactSchema = z.object({
  id: UuidSchema,
  runId: UuidSchema,
  runResultId: UuidSchema.nullable(),
  testAttemptId: UuidSchema.nullable(),
  kind: ArtifactKindSchema,
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  checksum: Sha256HexSchema.nullable(),
  sanitizationStatus: SanitizationStatusSchema,
  /** Motivo visible si está deshabilitado, fallido o retenido (RF-RES-02). */
  sanitizationReason: z.string().nullable(),
  publishable: z.boolean(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactParamsSchema = z.object({ id: UuidSchema, artifactId: UuidSchema });

/** `GET /runs/{id}/artifacts/{artifactId}`: acceso autorizado por recurso. */
export const ArtifactAccessResponseSchema = z.object({
  artifact: ArtifactSchema,
  /** URL firmada (S3/MinIO) o del visor de reportes en origen separado; vence en ≤ 5 min. */
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
  /** `viewer` = se abre en el visor aislado (reportes HTML/trazas), `download` = descarga directa. */
  disposition: z.enum(['viewer', 'download']),
});
