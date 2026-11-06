/**
 * Variables de entorno propias del área API-C (rendimiento, notificaciones, grabación, IA, exportaciones) que aún no
 * están en `src/config.ts` (propiedad de API-A; pendiente de integrarlas allí). Validadas con Zod; sin secretos
 * (solo referencias o parámetros).
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

export const ApiCEnvSchema = z.object({
  /** Override del proveedor de PR: `local` (repositorio git local de desarrollo) además de github/gitlab/none. */
  GIT_PR_PROVIDER: opt(z.enum(['github', 'gitlab', 'local', 'none'])),
  GIT_PR_LOCAL_REPO_PATH: opt(z.string().min(1)),
  /** Carpeta de tests grabados y de borradores IA dentro del repositorio de tests. */
  RECORDING_TESTS_DIR: z.string().regex(/^[a-z0-9_/-]+$/).default('tests/grabaciones'),
  AI_DRAFTS_DIR: z.string().regex(/^[a-z0-9_/-]+$/).default('tests/borradores'),
  /** Módulo de fixtures que importa cada test (convención qa-tests). */
  QA_TESTS_FIXTURE_IMPORT: z.string().default('../../fixtures/test.ts'),
  RECORDER_INSTALL_URL: opt(z.url()),
  /** Ruta del panel para aprobar dispositivos (verificationUri). */
  DEVICE_VERIFICATION_PATH: z.string().default('/dispositivos/vincular'),
  DEVICE_CREDENTIAL_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  DEVICE_ONLINE_WINDOW_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
  /** Solo desarrollo/pruebas: permite webhooks en loopback/http. */
  NOTIFIER_WEBHOOK_ALLOW_LOOPBACK: bool(false),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(16_000),
  AI_PRICE_INPUT_PER_MTOK: opt(z.coerce.number().min(0)),
  AI_PRICE_OUTPUT_PER_MTOK: opt(z.coerce.number().min(0)),
  EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PERF_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  PERF_AGGREGATE_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  PERF_GAP_THRESHOLD_MIN: z.coerce.number().int().min(1).max(1440).default(15),
});
export type ApiCSettings = z.infer<typeof ApiCEnvSchema>;

let cached: ApiCSettings | undefined;
export function apiCSettings(env: NodeJS.ProcessEnv = process.env): ApiCSettings {
  if (env !== process.env) return ApiCEnvSchema.parse(env);
  return (cached ??= ApiCEnvSchema.parse(env));
}
/** Solo pruebas. */
export function resetApiCSettings(): void {
  cached = undefined;
}
