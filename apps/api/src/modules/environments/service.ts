/**
 * Ambientes (destinos DeltaX), usuarios de prueba y parámetros administrativos (RF-AMB-01, RF-AMB-02, ESP §13.3,
 * §13.7). La API NUNCA lee las contraseñas de los usuarios de prueba (solo el worker resuelve `secret_ref`); aquí solo
 * se valida el formato de la referencia. Las URLs pasan por la protección SSRF (allowlist + IP) antes de guardarse.
 */
import type { Environment, Prisma, PrismaClient, TestUser } from '@prisma/client';
import {
  ArtifactPolicySchema,
  DEFAULT_PRODUCTION_ARTIFACT_POLICY,
  KatalystError,
  RuntimeSettingsSchema,
  type ArtifactPolicy,
  type RuntimeSettings,
} from '@katalyst/shared';
import {
  assertUrlAllowed,
  hostMatches,
  isValidHostPattern,
  resolveAndCheck,
  SsrfBlockedError,
  type LookupFn,
  type SsrfPolicy,
} from '../../lib/ssrf.js';
import { ENV_SECRET_PREFIX } from '../../lib/secrets.js';

/** Política por defecto fuera de producción: evidencia binaria deshabilitada hasta demostrar sanitización (ESP §13.7). */
export const DEFAULT_STAGING_ARTIFACT_POLICY: ArtifactPolicy = {
  ...DEFAULT_PRODUCTION_ARTIFACT_POLICY,
  disabledReasons: {
    traza: 'Habilitar tras demostrar la sanitización de trazas con canarios (ESP §13.7).',
    video: 'Habilitar tras demostrar el enmascaramiento visual con canarios (ESP §13.7).',
    captura: 'Habilitar tras demostrar el enmascaramiento visual con canarios (ESP §13.7).',
  },
};

/** Tipos de evidencia que nunca se habilitan en producción (trazas/video contienen red, DOM y píxeles). */
export const PRODUCTION_FORBIDDEN_KINDS = ['traza', 'video'] as const;

export function resolveArtifactPolicy(isProduction: boolean, policy: ArtifactPolicy | undefined): ArtifactPolicy {
  const p = policy ?? (isProduction ? DEFAULT_PRODUCTION_ARTIFACT_POLICY : DEFAULT_STAGING_ARTIFACT_POLICY);
  if (isProduction && p.enabledKinds.some((k) => (PRODUCTION_FORBIDDEN_KINDS as readonly string[]).includes(k))) {
    throw new KatalystError('VALIDATION_FAILED', 'Trazas y video no pueden habilitarse en un ambiente de producción.');
  }
  return ArtifactPolicySchema.parse(p);
}

/** Valida una referencia de secreto administrable (formato + restricciones del SecretProvider, sin resolverla). */
export function assertSecretRefAdministrable(ref: string): void {
  if (ref.startsWith('env:') && !ref.slice(4).startsWith(ENV_SECRET_PREFIX)) {
    throw new KatalystError('SECRET_REF_INVALID', `Las referencias env: deben usar el prefijo ${ENV_SECRET_PREFIX}.`);
  }
}

/**
 * Valida una URL configurable: forma, esquema, allowlist e IP literal; si el nombre resuelve, todas sus direcciones
 * deben estar permitidas. Un nombre que no resuelve desde la API (DNS privado de staging) se acepta: el cliente que
 * conecta (http-guard / runner) vuelve a validar en el momento de uso.
 */
export async function validateTargetUrl(url: string, policy: SsrfPolicy, lookup?: LookupFn): Promise<void> {
  const u = assertUrlAllowed(url, policy);
  try {
    await resolveAndCheck(u.hostname, policy, lookup);
  } catch (e) {
    if (e instanceof SsrfBlockedError && e.reason === 'dns') return;
    throw e;
  }
}

export function validateAllowedHosts(hosts: readonly string[], policy: SsrfPolicy): string[] {
  const out = [...new Set(hosts.map((h) => h.trim().toLowerCase()))];
  for (const h of out) {
    if (!isValidHostPattern(h)) throw new KatalystError('HOST_NOT_ALLOWED', `Patrón de host inválido: ${h.slice(0, 80)}`);
    if (policy.allowedHosts.length > 0 && !hostMatches(h.replace(/^\*\./, 'x.'), policy.allowedHosts) && !policy.allowedHosts.includes(h)) {
      throw new KatalystError('HOST_NOT_ALLOWED', 'El host no pertenece a la allowlist global de destinos.');
    }
  }
  return out;
}

export function toEnvironmentSummaryDto(e: Environment) {
  return {
    id: e.id,
    name: e.name,
    isProduction: e.isProduction,
    enabled: e.enabled && !e.disabledAt,
    recordingAllowed: e.recordingAllowed && !e.isProduction,
    appUrl: e.appUrl,
  };
}

export function toEnvironmentDto(e: Environment) {
  const parsed = ArtifactPolicySchema.safeParse(e.artifactPolicy);
  return {
    ...toEnvironmentSummaryDto(e),
    appUrl: e.appUrl,
    apiUrl: e.apiUrl,
    maxConcurrency: e.maxConcurrency,
    artifactPolicy: parsed.success ? parsed.data : resolveArtifactPolicy(e.isProduction, undefined),
    allowedHosts: e.allowedHosts,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    disabledAt: e.disabledAt?.toISOString() ?? null,
    version: e.version,
  };
}

export function toTestUserDto(u: TestUser) {
  return {
    id: u.id,
    environmentId: u.environmentId,
    label: u.label,
    username: u.username,
    secretRef: u.secretRef,
    readOnly: u.readOnly,
    allowsConcurrency: u.allowsConcurrency,
    enabled: u.enabled && !u.disabledAt,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    version: u.version,
  };
}

export function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

// ---------------------------------------------------------------------------
// Parámetros administrativos (ESP §13.3 timeouts, §13.5 capacidad e intervalo mínimo)
// ---------------------------------------------------------------------------

export const RUNTIME_SETTINGS_KEY = 'runtime';

export function defaultRuntimeSettings(): RuntimeSettings {
  return RuntimeSettingsSchema.parse({ timeouts: {}, capacity: {}, schedule: {}, version: 0 });
}

/** Parámetros vigentes (los congela API-B en el snapshot de cada corrida). */
export async function getRuntimeSettings(db: PrismaClient | Prisma.TransactionClient): Promise<RuntimeSettings> {
  const row = await db.runtimeSetting.findUnique({ where: { key: RUNTIME_SETTINGS_KEY } });
  if (!row) return defaultRuntimeSettings();
  const parsed = RuntimeSettingsSchema.safeParse({ ...(row.value as object), version: row.version });
  return parsed.success ? parsed.data : { ...defaultRuntimeSettings(), version: row.version };
}
