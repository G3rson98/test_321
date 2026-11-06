/**
 * TestRail: conexión (solo referencias de secretos), sincronización, árbol y casos (ESP §8, §9).
 * RF-TR-01, RF-TR-02, RF-TR-03, RF-TR-06, RF-TR-07, RF-TR-08.
 */
import { z } from 'zod';
import { LinkReviewStatusSchema, SyncRunStatusSchema } from '../enums.js';
import {
  CaseRefSchema,
  CursorQuerySchema,
  HttpUrlSchema,
  IsoDateTimeSchema,
  SecretRefSchema,
  Sha256HexSchema,
  sortQuerySchema,
  UuidSchema,
  VersionSchema,
} from './common.js';

export const TestRailConnectionSchema = z.object({
  id: UuidSchema,
  baseUrl: HttpUrlSchema,
  username: z.string(),
  /** Referencia al secreto de la API key; nunca el valor (ESP §7). */
  secretRef: SecretRefSchema,
  projectExternalId: z.number().int().positive().nullable(),
  suiteExternalIds: z.array(z.number().int().positive()),
  enabled: z.boolean(),
  lastSyncAt: IsoDateTimeSchema.nullable(),
  lastSyncStatus: SyncRunStatusSchema,
  version: VersionSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TestRailConnection = z.infer<typeof TestRailConnectionSchema>;

/** `PUT /testrail/connection` (admin). */
export const TestRailConnectionUpdateSchema = z.object({
  baseUrl: HttpUrlSchema,
  username: z.string().trim().min(1).max(254),
  secretRef: SecretRefSchema,
  projectExternalId: z.number().int().positive().nullable(),
  suiteExternalIds: z.array(z.number().int().positive()).max(100).default([]),
  enabled: z.boolean(),
  version: VersionSchema.optional(),
});
export type TestRailConnectionUpdate = z.infer<typeof TestRailConnectionUpdateSchema>;

/** `POST /testrail/connection/test`: prueba la conexión guardada o una candidata sin guardarla. */
export const TestRailConnectionTestRequestSchema = TestRailConnectionUpdateSchema.omit({ version: true }).partial();
export const TestRailConnectionTestResponseSchema = z.object({
  ok: z.boolean(),
  /** Código estable de falla (p. ej. TESTRAIL_AUTH_FAILED, HOST_NOT_ALLOWED). */
  errorCode: z.string().nullable(),
  message: z.string(),
  testrailVersion: z.string().nullable(),
  projects: z.array(z.object({ externalId: z.number().int(), name: z.string() })),
  latencyMs: z.number().int().nonnegative().nullable(),
});

/** `POST /testrail/sync` → 202 con la corrida de sincronización. */
export const TestRailSyncRequestSchema = z.object({
  suiteExternalIds: z.array(z.number().int().positive()).max(100).optional(),
});
export const TestRailSyncRunSchema = z.object({
  id: UuidSchema,
  connectionId: UuidSchema,
  status: SyncRunStatusSchema,
  trigger: z.enum(['manual', 'programada']),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  stats: z.object({
    projects: z.number().int().nonnegative(),
    suites: z.number().int().nonnegative(),
    sections: z.number().int().nonnegative(),
    casesSeen: z.number().int().nonnegative(),
    casesCreated: z.number().int().nonnegative(),
    casesUpdated: z.number().int().nonnegative(),
    casesNewRevision: z.number().int().nonnegative(),
    casesArchived: z.number().int().nonnegative(),
    linksRequiringReview: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    unsupportedFields: z.array(z.string()),
  }),
  error: z.string().nullable(),
  createdBy: UuidSchema.nullable(),
});
export type TestRailSyncRun = z.infer<typeof TestRailSyncRunSchema>;

export const TestRailProjectSchema = z.object({
  id: UuidSchema,
  externalId: z.number().int(),
  name: z.string(),
  archivedAt: IsoDateTimeSchema.nullable(),
});
export const TestRailSuiteSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  externalId: z.number().int(),
  name: z.string(),
  archivedAt: IsoDateTimeSchema.nullable(),
});
export const TestRailSectionSchema = z.object({
  id: UuidSchema,
  suiteId: UuidSchema,
  externalId: z.number().int(),
  name: z.string(),
  parentId: UuidSchema.nullable(),
  depth: z.number().int().nonnegative(),
  archivedAt: IsoDateTimeSchema.nullable(),
  caseCount: z.number().int().nonnegative().optional(),
  automatedCount: z.number().int().nonnegative().optional(),
});
export type TestRailSection = z.infer<typeof TestRailSectionSchema>;
export const TestRailSectionsQuerySchema = z.object({ suiteId: UuidSchema.optional() });

export const TestRailStepSchema = z.object({
  content: z.string(),
  expected: z.string().nullable(),
});

/** Resumen de caso para catálogo (`GET /testrail/cases`). */
export const TestRailCaseSummarySchema = z.object({
  id: UuidSchema,
  trCaseId: z.number().int().positive(),
  ref: CaseRefSchema,
  sectionId: UuidSchema,
  suiteId: UuidSchema,
  title: z.string(),
  priority: z.string().nullable(),
  type: z.string().nullable(),
  refs: z.string().nullable(),
  revision: z.number().int().positive(),
  archivedAt: IsoDateTimeSchema.nullable(),
  syncedAt: IsoDateTimeSchema,
  automated: z.boolean(),
  automatedTestCount: z.number().int().nonnegative(),
  linksRequiringReview: z.number().int().nonnegative(),
  lastResult: z.object({ status: z.string(), runId: UuidSchema, finishedAt: IsoDateTimeSchema.nullable() }).nullable(),
});
export type TestRailCaseSummary = z.infer<typeof TestRailCaseSummarySchema>;

export const TestRailCaseDetailSchema = TestRailCaseSummarySchema.extend({
  steps: z.array(TestRailStepSchema),
  expected: z.string().nullable(),
  contentHash: Sha256HexSchema,
  customFields: z.record(z.string(), z.unknown()),
  links: z.array(
    z.object({
      automatedTestId: UuidSchema,
      stableKey: UuidSchema,
      title: z.string(),
      reviewStatus: LinkReviewStatusSchema,
      reviewedCaseRevision: z.number().int().positive().nullable(),
    }),
  ),
  revisions: z.array(
    z.object({ revision: z.number().int().positive(), contentHash: Sha256HexSchema, createdAt: IsoDateTimeSchema }),
  ),
});
export type TestRailCaseDetail = z.infer<typeof TestRailCaseDetailSchema>;

/** `GET /testrail/cases?section=&q=&automated=` (ESP §9). */
export const TestRailCaseListQuerySchema = CursorQuerySchema.extend({
  section: UuidSchema.optional(),
  suiteId: UuidSchema.optional(),
  /** Incluye descendientes de la sección (ESP §9). */
  includeDescendants: z.coerce.boolean().default(true),
  q: z.string().trim().max(200).optional(),
  automated: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  includeArchived: z.coerce.boolean().default(false),
  lastResult: z.string().max(32).optional(),
  sort: sortQuerySchema(['title', 'trCaseId', 'syncedAt'] as const, 'title'),
});
export type TestRailCaseListQuery = z.infer<typeof TestRailCaseListQuerySchema>;

/** RF-TR-06: plan/corrida existente. */
export const TestRailPlanSchema = z.object({
  planId: z.number().int().positive(),
  name: z.string(),
  entries: z.array(
    z.object({
      suiteExternalId: z.number().int(),
      runs: z.array(z.object({ trRunId: z.number().int(), name: z.string(), isCompleted: z.boolean() })),
    }),
  ),
});
export const TestRailRunTestsSchema = z.object({
  trRunId: z.number().int().positive(),
  tests: z.array(z.object({ trTestId: z.number().int(), trCaseId: z.number().int(), title: z.string() })),
});
