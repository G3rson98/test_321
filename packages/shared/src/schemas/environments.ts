/**
 * Ambientes (destinos DeltaX) y usuarios de prueba. Nunca devuelven secretos (ESP §9). RF-AMB-01, RF-AMB-02.
 */
import { z } from 'zod';
import { ArtifactKindSchema } from '../enums.js';
import { HttpUrlSchema, IsoDateTimeSchema, SecretRefSchema, UuidSchema, VersionSchema } from './common.js';

/** Política de evidencia por ambiente (ESP §13.7: producción sin trazas/video por defecto). */
export const ArtifactPolicySchema = z.object({
  enabledKinds: z.array(ArtifactKindSchema),
  screenshotsOnFailureOnly: z.boolean().default(true),
  videoOnFailureOnly: z.boolean().default(true),
  traceOnFailureOnly: z.boolean().default(true),
  /** Cuotas por corrida (ARQ §6). */
  maxEvidenceBytesPerRun: z
    .number()
    .int()
    .positive()
    .default(250 * 1024 * 1024),
  maxTempBytesPerRun: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  retentionDays: z.number().int().min(1).max(365).default(30),
  /** Motivo visible cuando un tipo está deshabilitado. */
  disabledReasons: z.record(z.string(), z.string()).default({}),
});
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export const DEFAULT_PRODUCTION_ARTIFACT_POLICY: ArtifactPolicy = {
  enabledKinds: ['reporte', 'log'],
  screenshotsOnFailureOnly: true,
  videoOnFailureOnly: true,
  traceOnFailureOnly: true,
  maxEvidenceBytesPerRun: 250 * 1024 * 1024,
  maxTempBytesPerRun: 1024 * 1024 * 1024,
  retentionDays: 30,
  disabledReasons: {
    traza: 'Deshabilitado en producción por defecto (ESP §13.7).',
    video: 'Deshabilitado en producción por defecto (ESP §13.7).',
    captura: 'Requiere política de enmascaramiento probada con canarios (ESP §13.7).',
  },
};

/** Vista mínima para selección en corridas (rol qa, `environments.list`). */
export const EnvironmentSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  isProduction: z.boolean(),
  enabled: z.boolean(),
  recordingAllowed: z.boolean(),
});
export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema>;

export const EnvironmentSchema = EnvironmentSummarySchema.extend({
  appUrl: HttpUrlSchema,
  apiUrl: HttpUrlSchema,
  maxConcurrency: z.number().int().min(1).max(32),
  artifactPolicy: ArtifactPolicySchema,
  allowedHosts: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  disabledAt: IsoDateTimeSchema.nullable(),
  version: VersionSchema,
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const EnvironmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  appUrl: HttpUrlSchema,
  apiUrl: HttpUrlSchema,
  isProduction: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(32).default(1),
  enabled: z.boolean().default(true),
  recordingAllowed: z.boolean().default(false),
  artifactPolicy: ArtifactPolicySchema.optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).max(50).default([]),
});
export type EnvironmentCreate = z.infer<typeof EnvironmentCreateSchema>;

export const EnvironmentUpdateSchema = EnvironmentCreateSchema.partial().extend({ version: VersionSchema });
export type EnvironmentUpdate = z.infer<typeof EnvironmentUpdateSchema>;

/** Usuario de prueba: `secretRef` referencia la contraseña; solo el worker la lee (RF-AMB-02). */
export const TestUserSchema = z.object({
  id: UuidSchema,
  environmentId: UuidSchema,
  label: z.string(),
  username: z.string(),
  secretRef: SecretRefSchema,
  /** Declaración administrativa: el usuario solo tiene permisos de lectura (requisito de producción, ESP §13.7). */
  readOnly: z.boolean(),
  /** Admite uso concurrente; si no, se reserva (ESP §10 regla 10). */
  allowsConcurrency: z.boolean(),
  enabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: VersionSchema,
});
export type TestUser = z.infer<typeof TestUserSchema>;

export const TestUserCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  username: z.string().trim().min(1).max(254),
  secretRef: SecretRefSchema,
  readOnly: z.boolean(),
  allowsConcurrency: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export const TestUserUpdateSchema = TestUserCreateSchema.partial().extend({ version: VersionSchema });
export const EnvironmentUserParamsSchema = z.object({ id: UuidSchema, userId: UuidSchema });

/** Parámetros administrativos auditados (ESP §13.3 timeouts; §13.5 capacidad). */
export const RuntimeSettingsSchema = z.object({
  timeouts: z.object({
    testMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    setupMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    functionalRunMs: z
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(20 * 60_000),
    perfRunMs: z
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(4 * 60_000),
    finalizingMs: z.number().int().min(1000).max(60_000).default(60_000),
  }),
  capacity: z.object({
    globalBrowserConcurrency: z.number().int().min(1).max(32).default(1),
    perUserConcurrency: z.number().int().min(1).max(32).default(1),
    queueAdmissionGraceSeconds: z.number().int().min(1).max(300).default(60),
  }),
  schedule: z.object({ minIntervalMinutes: z.number().int().min(1).max(1440).default(5) }),
  version: VersionSchema,
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export const RuntimeSettingsUpdateSchema = RuntimeSettingsSchema;
