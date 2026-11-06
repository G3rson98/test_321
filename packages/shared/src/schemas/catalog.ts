/**
 * Catálogo de tests automatizados (ESP §9 `GET /tests`, `POST /tests/refresh`, revisión de vínculos).
 * RF-CAT-01, RF-CAT-02, RF-CAT-04, RF-CAT-05, RF-TR-03, RF-TR-07, RF-RES-03.
 */
import { z } from 'zod';
import {
  CatalogRevisionStatusSchema,
  ClassificationSchema,
  LinkReviewStatusSchema,
  RunResultStatusSchema,
  TestStatusSchema,
} from '../enums.js';
import {
  CaseRefSchema,
  CursorQuerySchema,
  GitCommitShaSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  sortQuerySchema,
  TagSchema,
  UuidSchema,
} from './common.js';

export const FlakyInfoSchema = z.object({
  score: z.number().min(0).max(1).nullable(),
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  isFlaky: z.boolean(),
  environmentId: UuidSchema.nullable(),
});
export type FlakyInfo = z.infer<typeof FlakyInfoSchema>;

export const CaseLinkSchema = z.object({
  caseId: UuidSchema,
  ref: CaseRefSchema,
  title: z.string(),
  reviewStatus: LinkReviewStatusSchema,
  reviewedCaseRevision: z.number().int().positive().nullable(),
  currentCaseRevision: z.number().int().positive(),
  reviewedBy: UuidSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
});
export type CaseLink = z.infer<typeof CaseLinkSchema>;

export const AutomatedTestSchema = z.object({
  id: UuidSchema,
  stableKey: UuidSchema,
  filePath: z.string(),
  title: z.string(),
  tags: z.array(TagSchema),
  classification: ClassificationSchema,
  status: TestStatusSchema,
  parameterKeys: z.array(z.string()),
  writeIdempotencyApproved: z.boolean(),
  owner: z.string().nullable(),
  manifestCommit: GitCommitShaSchema.nullable(),
  flaky: FlakyInfoSchema,
  caseLinks: z.array(CaseLinkSchema),
  lastResult: z
    .object({ status: RunResultStatusSchema, runId: UuidSchema, finishedAt: IsoDateTimeSchema.nullable() })
    .nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type AutomatedTest = z.infer<typeof AutomatedTestSchema>;

/** `GET /tests?tag=&case=&status=` (ESP §9) + filtros RF-CAT-02. */
export const AutomatedTestListQuerySchema = CursorQuerySchema.extend({
  tag: z.union([TagSchema, z.array(TagSchema)]).optional(),
  case: CaseRefSchema.optional(),
  caseId: UuidSchema.optional(),
  section: UuidSchema.optional(),
  status: TestStatusSchema.optional(),
  classification: ClassificationSchema.optional(),
  lastResult: RunResultStatusSchema.optional(),
  flaky: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().trim().max(200).optional(),
  sort: sortQuerySchema(['title', 'filePath', 'updatedAt'] as const, 'title'),
});
export type AutomatedTestListQuery = z.infer<typeof AutomatedTestListQuerySchema>;

/** `POST /tests/refresh` → 202; el listado corre aislado en contenedor sin secretos (ESP §4). */
export const CatalogRefreshRequestSchema = z.object({}).strict();
export const CatalogRevisionSchema = z.object({
  id: UuidSchema,
  status: CatalogRevisionStatusSchema,
  gitCommit: GitCommitShaSchema.nullable(),
  manifestHash: Sha256HexSchema.nullable(),
  testCount: z.number().int().nonnegative(),
  errors: z.array(z.object({ code: z.string(), message: z.string(), stableKey: z.string().nullable() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), stableKey: z.string().nullable() })),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  createdBy: UuidSchema.nullable(),
});
export type CatalogRevision = z.infer<typeof CatalogRevisionSchema>;

/** `PUT /tests/{id}/case-links/{caseId}/review` (dev): revisión de versión de caso, no aprobación de código. */
export const CaseLinkReviewRequestSchema = z.object({
  /** Revisión del caso que el dev confirma como cubierta. Debe ser la vigente. */
  caseRevision: z.number().int().positive(),
  comment: z.string().max(2000).optional(),
});
export const CaseLinkReviewParamsSchema = z.object({ id: UuidSchema, caseId: UuidSchema });

/** RF-RES-03: historial por test o por caso con tendencia de éxito y duración. */
export const HistoryQuerySchema = CursorQuerySchema.extend({
  environmentId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export const HistoryPointSchema = z.object({
  runId: UuidSchema,
  environmentId: UuidSchema,
  status: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  finishedAt: IsoDateTimeSchema.nullable(),
});
export const HistoryResponseSchema = z.object({
  items: z.array(HistoryPointSchema),
  nextCursor: z.string().nullable(),
  hasNext: z.boolean(),
  trend: z.object({
    successRate: z.number().min(0).max(1).nullable(),
    avgDurationMs: z.number().nonnegative().nullable(),
    observations: z.number().int().nonnegative(),
  }),
  flaky: FlakyInfoSchema.nullable(),
});

/**
 * Payload BullMQ de la cola `catalog-listing` (API → supervisor del runner). Solo IDs: el runner hace checkout del commit
 * permitido, lista en aislamiento y responde por `POST /worker/catalog/listing` (RF-CAT-01, ESP §4).
 */
export const CatalogListingJobPayloadSchema = z.object({ catalogRevisionId: UuidSchema, gitCommit: GitCommitShaSchema });
export type CatalogListingJobPayload = z.infer<typeof CatalogListingJobPayloadSchema>;
export const CATALOG_LISTING_QUEUE_DEFAULT = 'catalog-listing';
