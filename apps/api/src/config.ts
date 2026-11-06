/**
 * Configuración por entorno validada con Zod (plan §3). Los secretos se leen SIEMPRE por referencia (`*_REF`,
 * formato `env:NOMBRE` | `file:/ruta` | `ssm:/prefijo/nombre`) mediante SecretProvider; nunca valores en claro.
 * RNF-SEG-01, RNF-SEG-03, RNF-OPT-05, RNF-OBS-01.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SecretRefSchema, isValidTimeZone } from '@katalyst/shared';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');
const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
/** Cadena vacía en el entorno equivale a "no definido". */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());
const optionalRef = opt(SecretRefSchema);
const optionalUrl = opt(z.url());
const optionalStr = opt(z.string());

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SERVICE_VERSION: z.string().default('0.1.0'),

    // HTTP
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: int(3000, 1, 65535),
    REPORTS_HOST: z.string().default('0.0.0.0'),
    REPORTS_PORT: int(3001, 1, 65535),
    PUBLIC_BASE_URL: z.url().default('http://localhost:5173'),
    REPORTS_BASE_URL: z.url().default('http://localhost:3001'),
    TRUST_PROXY: bool(false),
    BODY_LIMIT_BYTES: int(1_048_576 + 65_536, 1024, 50 * 1024 * 1024),
    OPENAPI_UI_ENABLED: bool(true),
    CORS_ALLOWED_ORIGINS: csv,
    RATE_LIMIT_MAX: int(300, 1, 100_000),
    RATE_LIMIT_WINDOW_MS: int(60_000, 1000, 3_600_000),

    // PostgreSQL (pool total ≤ 20 entre procesos, RNF-OPT-05)
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL debe ser postgresql://'),
    // Defaults alineados con deploy/ (docs/pendientes-integracion.md): api 10 + control 6 + reports 3 = 19 ≤ 20.
    DATABASE_POOL_API: int(10, 1, 20),
    DATABASE_POOL_CONTROL: int(6, 1, 20),
    DATABASE_POOL_REPORTS: int(3, 1, 20),
    /** Override del pool del proceso actual (lo fija docker-compose por servicio). */
    DATABASE_POOL_MAX: opt(z.coerce.number().int().min(1).max(20)),
    TOTAL_DB_POOL_BUDGET: int(20, 1, 20),
    DB_POOL_TIMEOUT_SECONDS: int(10, 1, 120),

    // Redis/BullMQ
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'REDIS_URL debe ser redis://')
      .default('redis://localhost:6379/0'),
    QUEUE_PREFIX: z.string().default('katalyst'),

    // Sesión y CSRF (ESP §13.7)
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('katalyst_session'),
    SESSION_TTL_HOURS: int(12, 1, 24 * 30),
    SESSION_SECRET_REF: optionalRef,
    COOKIE_SECURE: bool(true),
    CSRF_HEADER_NAME: z.string().default('x-csrf-token'),

    // Secretos
    SECRET_PROVIDER: z.enum(['env', 'file', 'ssm']).default('env'),
    SECRET_FILE_DIR: z.string().default('/run/secrets/katalyst'),
    AWS_REGION: optionalStr,
    SSM_PREFIX: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]*$/)
      .default('/katalyst/internal'),

    // Artefactos (RNF-SEG-05)
    ARTIFACT_STORE: z.enum(['fs', 's3', 'minio']).default('fs'),
    ARTIFACT_BUCKET: z.string().default('katalyst-evidence'),
    ARTIFACT_FS_DIR: z.string().default('./.data/artifacts'),
    /** Clave HMAC propia de URLs firmadas del almacén fs (dev); si falta se deriva de SESSION_SECRET_REF (D-045). */
    ARTIFACT_FS_SIGNING_KEY_REF: optionalRef,
    S3_ENDPOINT: optionalUrl,
    S3_ACCESS_KEY_REF: optionalRef,
    S3_SECRET_KEY_REF: optionalRef,
    SIGNED_URL_TTL_SECONDS: int(300, 10, 300),

    // TestRail (RF-TR-01; la conexión vive en BD, estos son defaults/bootstraps)
    TESTRAIL_BASE_URL: optionalUrl,
    TESTRAIL_USERNAME: optionalStr,
    TESTRAIL_API_KEY_REF: optionalRef,
    TESTRAIL_SYNC_INTERVAL_MS: int(3_600_000, 60_000, 86_400_000),

    // Git (plataforma pendiente ESP §12)
    GIT_PROVIDER: z.enum(['github', 'gitlab', 'local', 'none']).default('none'),
    /** Repositorio bare local para `GIT_PROVIDER=local` (solo desarrollo). */
    GIT_LOCAL_REPO_PATH: optionalStr,
    GIT_BASE_URL: optionalUrl,
    GIT_REPOSITORY: optionalStr,
    GIT_PROTECTED_BRANCH: z.string().default('main'),
    GIT_TOKEN_REF: optionalRef,

    // Notificaciones (canal pendiente ESP §12)
    NOTIFIER_CHANNELS: csv.pipe(z.array(z.enum(['correo', 'slack', 'teams']))),
    SMTP_HOST: optionalStr,
    SMTP_PORT: int(587, 1, 65535),
    SMTP_FROM: optionalStr,
    SMTP_CREDENTIALS_REF: optionalRef,
    SLACK_WEBHOOK_REF: optionalRef,
    TEAMS_WEBHOOK_REF: optionalRef,

    // IA (proveedor pendiente ESP §12)
    AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
    AI_MODEL: z.string().default(''),
    AI_API_KEY_REF: optionalRef,
    AI_BUDGET_USD_PER_REQUEST: z.coerce.number().min(0).default(0.5),
    AI_BUDGET_USD_PER_USER_DAY: z.coerce.number().min(0).default(5),
    AI_BUDGET_USD_PER_MONTH: z.coerce.number().min(0).default(50),
    AI_TIMEOUT_MS: int(120_000, 1000, 600_000),

    // Grabación, IA, notificaciones, exportaciones y rendimiento (API-C, D-031; espejo de modules/recordings/settings.ts)
    GIT_PR_PROVIDER: opt(z.enum(['github', 'gitlab', 'local', 'none'])),
    GIT_PR_LOCAL_REPO_PATH: opt(z.string().min(1)),
    RECORDING_TESTS_DIR: z.string().regex(/^[a-z0-9_/-]+$/).default('tests/grabaciones'),
    AI_DRAFTS_DIR: z.string().regex(/^[a-z0-9_/-]+$/).default('tests/borradores'),
    QA_TESTS_FIXTURE_IMPORT: z.string().default('../../fixtures/test.ts'),
    RECORDER_INSTALL_URL: optionalUrl,
    DEVICE_VERIFICATION_PATH: z.string().default('/dispositivos/vincular'),
    DEVICE_CREDENTIAL_TTL_DAYS: int(90, 1, 365),
    DEVICE_ONLINE_WINDOW_SECONDS: int(120, 15, 3600),
    NOTIFIER_WEBHOOK_ALLOW_LOOPBACK: bool(false),
    AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
    AI_MAX_OUTPUT_TOKENS: int(16_000, 256, 64_000),
    AI_PRICE_INPUT_PER_MTOK: opt(z.coerce.number().min(0)),
    AI_PRICE_OUTPUT_PER_MTOK: opt(z.coerce.number().min(0)),
    EXPORT_TTL_HOURS: int(24, 1, 168),
    PERF_RAW_RETENTION_DAYS: int(90, 1, 365),
    PERF_AGGREGATE_RETENTION_DAYS: int(365, 30, 3650),
    PERF_GAP_THRESHOLD_MIN: int(15, 1, 1440),

    // Dominio / control (ESP §13.3, §13.5, §13.8)
    DEFAULT_TIMEZONE: z.string().refine(isValidTimeZone, 'Zona IANA inválida').default('America/La_Paz'),
    SCHEDULER_TICK_MS: int(15_000, 1000, 15_000),
    RECONCILER_INTERVAL_MS: int(60_000, 5_000, 3_600_000),
    OUTBOX_POLL_MS: int(5_000, 500, 60_000),
    WATCHDOG_INTERVAL_MS: int(15_000, 1000, 15_000),
    LEASE_TTL_MS: int(75_000, 30_000, 75_000),
    HEARTBEAT_INTERVAL_MS: int(15_000, 1000, 15_000),
    THRESHOLD_EVAL_INTERVAL_MS: int(60_000, 10_000, 60_000),
    CLEANUP_HOUR_UTC: int(8, 0, 23),
    GLOBAL_BROWSER_CONCURRENCY: int(1, 1, 32),
    ALLOWED_TARGET_HOSTS: csv,
    /** Excepciones SSRF registradas: hosts que pueden resolver a redes privadas (staging privado, ESP §13.7). */
    SSRF_PRIVATE_ALLOWED_HOSTS: csv,
    /** Permite loopback en URLs configurables (solo desarrollo/pruebas locales). */
    SSRF_ALLOW_LOOPBACK: bool(false),
    /** Permite `http://` en URLs configurables (solo desarrollo; HTTPS obligatorio en red, RNF-SEG-03). */
    SSRF_ALLOW_HTTP: bool(false),
    /** Timeout total por solicitud HTTP saliente (TestRail, Git) en ms. */
    OUTBOUND_HTTP_TIMEOUT_MS: int(30_000, 1_000, 300_000),
    /** Campos personalizados de TestRail que forman parte del contenido versionado del caso (content_hash). */
    TESTRAIL_BUSINESS_FIELDS: csv,
    /** Cola BullMQ del listado aislado de tests (`POST /tests/refresh`, la consume el runner). */
    CATALOG_LISTING_QUEUE: z.string().default('catalog-listing'),
    /** Exponer /metrics fuera de loopback/red privada (por defecto no). */
    METRICS_PUBLIC: bool(false),
    /** Archivo cuyo mtime toca el proceso de control en cada ciclo ≤ 15 s (healthcheck de deploy/). */
    HEALTH_FILE: optionalStr,

    // Login propio: rate limit y bloqueo progresivo (ESP §13.7)
    LOGIN_MAX_FAILURES: int(5, 1, 100),
    LOGIN_LOCKOUT_BASE_SECONDS: int(60, 1, 3_600),
    LOGIN_LOCKOUT_MAX_SECONDS: int(3_600, 60, 86_400),
    PASSWORD_RESET_TTL_MINUTES: int(30, 5, 1_440),
    /** Vigencia máxima de credenciales de servicio (supervisor) en días. */
    SERVICE_CREDENTIAL_TTL_DAYS: int(30, 1, 365),

    // Bootstrap de identidad administrativa inicial (RF-USR-03)
    BOOTSTRAP_ADMIN_EMAIL: opt(z.email()),
    BOOTSTRAP_ADMIN_PASSWORD_REF: optionalRef,
    SUPERVISOR_TOKEN_REF: optionalRef,

    // OIDC corporativo opcional (pendiente ESP §12)
    OIDC_ISSUER_URL: optionalUrl,
    OIDC_CLIENT_ID: optionalStr,
    OIDC_CLIENT_SECRET_REF: optionalRef,
    OIDC_REDIRECT_URL: optionalUrl,
  })
  .superRefine((env, ctx) => {
    const sum = env.DATABASE_POOL_API + env.DATABASE_POOL_CONTROL + env.DATABASE_POOL_REPORTS;
    if (env.DATABASE_POOL_MAX !== undefined && env.DATABASE_POOL_MAX > env.TOTAL_DB_POOL_BUDGET) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_MAX'],
        message: 'DATABASE_POOL_MAX > TOTAL_DB_POOL_BUDGET; RNF-OPT-05',
      });
    }
    if (sum > env.TOTAL_DB_POOL_BUDGET) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_API'],
        message: `Pools API+control+reports = ${sum} > TOTAL_DB_POOL_BUDGET (${env.TOTAL_DB_POOL_BUDGET}); RNF-OPT-05`,
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.SESSION_SECRET_REF)
        ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET_REF'], message: 'Obligatorio en producción' });
      if (!env.COOKIE_SECURE)
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'Cookies Secure obligatorias en producción' });
    }
    if (env.AI_PROVIDER !== 'none' && (!env.AI_MODEL || !env.AI_API_KEY_REF)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_PROVIDER'],
        message: 'AI_MODEL y AI_API_KEY_REF son obligatorios si AI_PROVIDER ≠ none',
      });
    }
    if (env.ARTIFACT_STORE !== 'fs' && !env.ARTIFACT_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['ARTIFACT_BUCKET'], message: 'Obligatorio para s3/minio' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;
export type ProcessKind = 'api' | 'control' | 'reports';

export class ConfigError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`Configuración inválida: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigError';
  }
}

/** Variables que admiten la forma `<VAR>_FILE` (secretos de conexión montados por deploy/). */
export const FILE_BACKED_VARS = ['DATABASE_URL', 'REDIS_URL'] as const;

/** Resuelve `<VAR>_FILE` → `<VAR>` (contenido del archivo, sin salto final) si `<VAR>` no está definida. */
export function resolveFileBackedEnv(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of FILE_BACKED_VARS) {
    const file = env[`${name}_FILE`];
    if ((out[name] === undefined || out[name] === '') && file) {
      try {
        out[name] = read(file).trim();
      } catch {
        throw new ConfigError([{ path: `${name}_FILE`, message: 'No se pudo leer el archivo indicado' }]);
      }
    }
  }
  return out;
}

/** Valida el entorno. Los mensajes no incluyen valores (pueden ser sensibles). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(resolveFileBackedEnv(env));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return parsed.data;
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Tamaño del pool del proceso (connection_limit de Prisma). */
export function poolSizeFor(config: Config, kind: ProcessKind): number {
  if (config.DATABASE_POOL_MAX !== undefined) return config.DATABASE_POOL_MAX;
  switch (kind) {
    case 'api':
      return config.DATABASE_POOL_API;
    case 'control':
      return config.DATABASE_POOL_CONTROL;
    case 'reports':
      return config.DATABASE_POOL_REPORTS;
  }
}

export interface EnvDoc {
  description: string;
  example: string;
  secret?: boolean;
}

/** Documentación de variables para `.env.example` (mismo orden que EnvSchema). */
export const ENV_DOCS: Record<keyof z.input<typeof EnvSchema>, EnvDoc> = {
  NODE_ENV: { description: 'development | test | production', example: 'development' },
  LOG_LEVEL: { description: 'Nivel de log pino', example: 'info' },
  SERVICE_VERSION: { description: 'Versión reportada en /healthz', example: '0.1.0' },
  API_HOST: { description: 'Interfaz de escucha de la API', example: '0.0.0.0' },
  API_PORT: { description: 'Puerto de la API (/api/v1, /healthz, /readyz)', example: '3000' },
  REPORTS_HOST: { description: 'Interfaz del visor de reportes', example: '0.0.0.0' },
  REPORTS_PORT: { description: 'Puerto del visor de reportes (origen separado)', example: '3001' },
  PUBLIC_BASE_URL: {
    description: 'URL pública del panel (enlaces autenticados en TestRail/notificaciones)',
    example: 'http://localhost:5173',
  },
  REPORTS_BASE_URL: { description: 'URL del origen separado de reportes HTML', example: 'http://localhost:3001' },
  TRUST_PROXY: { description: 'Confiar en X-Forwarded-* (detrás de Caddy)', example: 'false' },
  BODY_LIMIT_BYTES: { description: 'Límite de cuerpo HTTP (grabación ≤ 1 MiB + margen)', example: '1114112' },
  OPENAPI_UI_ENABLED: { description: 'Servir Swagger UI en /api/docs', example: 'true' },
  CORS_ALLOWED_ORIGINS: {
    description: 'Orígenes CORS permitidos separados por coma; vacío = cerrado (mismo origen)',
    example: '',
  },
  RATE_LIMIT_MAX: { description: 'Solicitudes por ventana y cliente', example: '300' },
  RATE_LIMIT_WINDOW_MS: { description: 'Ventana de rate limit (ms)', example: '60000' },
  DATABASE_URL: {
    description: 'URL PostgreSQL (sin credenciales reales en el repo)',
    example: 'postgresql://katalyst:katalyst_dev@localhost:5432/katalyst',
  },
  DATABASE_POOL_API: { description: 'connection_limit del proceso API', example: '10' },
  DATABASE_POOL_CONTROL: { description: 'connection_limit del proceso control', example: '6' },
  DATABASE_POOL_REPORTS: { description: 'connection_limit del visor de reportes', example: '3' },
  DATABASE_POOL_MAX: {
    description:
      'Override del pool del proceso actual (docker-compose lo fija por servicio); vacío = usar DATABASE_POOL_<PROCESO>',
    example: '',
  },
  TOTAL_DB_POOL_BUDGET: { description: 'Presupuesto total de conexiones (≤ 20, RNF-OPT-05)', example: '20' },
  DB_POOL_TIMEOUT_SECONDS: { description: 'pool_timeout de Prisma (s)', example: '10' },
  REDIS_URL: { description: 'URL Redis (BullMQ)', example: 'redis://localhost:6379/0' },
  QUEUE_PREFIX: { description: 'Prefijo de colas BullMQ', example: 'katalyst' },
  SESSION_COOKIE_NAME: { description: 'Nombre de la cookie de sesión HttpOnly', example: 'katalyst_session' },
  SESSION_TTL_HOURS: { description: 'Duración de sesión del panel (h)', example: '12' },
  SESSION_SECRET_REF: {
    description: 'Referencia al secreto de firma de cookies',
    example: 'env:KATALYST_SECRET__SESSION',
    secret: true,
  },
  COOKIE_SECURE: { description: 'Cookies Secure (false solo en loopback de desarrollo)', example: 'false' },
  CSRF_HEADER_NAME: { description: 'Encabezado del token CSRF', example: 'x-csrf-token' },
  SECRET_PROVIDER: { description: 'env | file | ssm', example: 'env' },
  SECRET_FILE_DIR: { description: 'Directorio para SECRET_PROVIDER=file', example: '/run/secrets/katalyst' },
  AWS_REGION: { description: 'Región AWS (pendiente ESP §12)', example: '' },
  SSM_PREFIX: { description: 'Prefijo de SSM Parameter Store', example: '/katalyst/internal' },
  ARTIFACT_STORE: { description: 'fs | s3 | minio', example: 'fs' },
  ARTIFACT_BUCKET: { description: 'Bucket privado de evidencia', example: 'katalyst-evidence' },
  ARTIFACT_FS_DIR: { description: 'Directorio local de artefactos (dev)', example: './.data/artifacts' },
  ARTIFACT_FS_SIGNING_KEY_REF: {
    description: 'Referencia a la clave HMAC de URLs firmadas del almacén fs (dev; vacío = derivada de SESSION_SECRET_REF)',
    example: 'env:KATALYST_SECRET__ARTIFACT_FS_SIGNING',
    secret: true,
  },
  S3_ENDPOINT: { description: 'Endpoint S3 compatible (MinIO dev)', example: 'http://localhost:9000' },
  S3_ACCESS_KEY_REF: {
    description: 'Referencia a access key (solo MinIO dev; en AWS usar instance profile)',
    example: 'env:KATALYST_SECRET__MINIO_ACCESS_KEY',
    secret: true,
  },
  S3_SECRET_KEY_REF: {
    description: 'Referencia a secret key (solo MinIO dev)',
    example: 'env:KATALYST_SECRET__MINIO_SECRET_KEY',
    secret: true,
  },
  SIGNED_URL_TTL_SECONDS: { description: 'Vigencia de URLs firmadas (máx. 300, RNF-SEG-05)', example: '300' },
  TESTRAIL_BASE_URL: {
    description: 'URL de TestRail (bootstrap; la conexión se administra en BD)',
    example: 'https://example.testrail.io',
  },
  TESTRAIL_USERNAME: { description: 'Usuario de servicio TestRail (bootstrap)', example: 'qa-runner@example.com' },
  TESTRAIL_API_KEY_REF: {
    description: 'Referencia a la API key de TestRail',
    example: 'env:KATALYST_SECRET__TESTRAIL_API_KEY',
    secret: true,
  },
  TESTRAIL_SYNC_INTERVAL_MS: { description: 'Intervalo de sincronización (ms, default 1 h)', example: '3600000' },
  GIT_PROVIDER: { description: 'github | gitlab | local | none (pendiente ESP §12; local = repo bare dev)', example: 'none' },
  GIT_LOCAL_REPO_PATH: { description: 'Ruta a repositorio bare local (GIT_PROVIDER=local, solo dev)', example: '' },
  GIT_BASE_URL: { description: 'URL API de la plataforma Git', example: 'https://api.github.com' },
  GIT_REPOSITORY: { description: 'Repositorio de tests (owner/repo)', example: 'deltax/qa-tests' },
  GIT_PROTECTED_BRANCH: { description: 'Rama protegida con el manifiesto aprobado', example: 'main' },
  GIT_TOKEN_REF: {
    description: 'Referencia al token del adaptador que abre PR (sin permiso de merge)',
    example: 'env:KATALYST_SECRET__GIT_TOKEN',
    secret: true,
  },
  NOTIFIER_CHANNELS: { description: 'Canales habilitados: correo,slack,teams (pendiente ESP §12)', example: '' },
  SMTP_HOST: { description: 'Servidor SMTP', example: 'smtp.example.com' },
  SMTP_PORT: { description: 'Puerto SMTP', example: '587' },
  SMTP_FROM: { description: 'Remitente', example: 'katalyst@example.com' },
  SMTP_CREDENTIALS_REF: {
    description: 'Referencia a credenciales SMTP',
    example: 'env:KATALYST_SECRET__SMTP',
    secret: true,
  },
  SLACK_WEBHOOK_REF: {
    description: 'Referencia al webhook de Slack',
    example: 'env:KATALYST_SECRET__SLACK_WEBHOOK',
    secret: true,
  },
  TEAMS_WEBHOOK_REF: {
    description: 'Referencia al webhook de Teams',
    example: 'env:KATALYST_SECRET__TEAMS_WEBHOOK',
    secret: true,
  },
  AI_PROVIDER: { description: 'none | anthropic (pendiente ESP §12)', example: 'none' },
  AI_MODEL: { description: 'Modelo configurable del proveedor', example: '' },
  AI_API_KEY_REF: {
    description: 'Referencia a la API key del proveedor IA',
    example: 'env:KATALYST_SECRET__AI_API_KEY',
    secret: true,
  },
  AI_BUDGET_USD_PER_REQUEST: { description: 'Presupuesto máximo por solicitud (USD)', example: '0.5' },
  AI_BUDGET_USD_PER_USER_DAY: { description: 'Presupuesto por usuario y día (USD)', example: '5' },
  AI_BUDGET_USD_PER_MONTH: { description: 'Presupuesto mensual total (USD)', example: '50' },
  AI_TIMEOUT_MS: { description: 'Timeout por solicitud IA (ms)', example: '120000' },
  GIT_PR_PROVIDER: { description: 'Override del proveedor de PR de grabaciones: github | gitlab | local | none (vacío = GIT_PROVIDER)', example: '' },
  GIT_PR_LOCAL_REPO_PATH: { description: 'Repositorio git local para PR de grabaciones (solo dev)', example: '' },
  RECORDING_TESTS_DIR: { description: 'Carpeta de tests grabados en el repositorio de tests', example: 'tests/grabaciones' },
  AI_DRAFTS_DIR: { description: 'Carpeta de borradores generados por IA', example: 'tests/borradores' },
  QA_TESTS_FIXTURE_IMPORT: { description: 'Módulo de fixtures que importa cada test generado', example: '../../fixtures/test.ts' },
  RECORDER_INSTALL_URL: { description: 'URL de descarga del asistente local (Windows 11)', example: '' },
  DEVICE_VERIFICATION_PATH: { description: 'Ruta del panel para aprobar dispositivos', example: '/dispositivos/vincular' },
  DEVICE_CREDENTIAL_TTL_DAYS: { description: 'Vigencia de la credencial del asistente (días)', example: '90' },
  DEVICE_ONLINE_WINDOW_SECONDS: { description: 'Ventana para considerar en línea al asistente (s)', example: '120' },
  NOTIFIER_WEBHOOK_ALLOW_LOOPBACK: { description: 'Permite webhooks loopback/http (solo dev/pruebas)', example: 'false' },
  AI_EFFORT: { description: 'Esfuerzo del modelo IA: low | medium | high', example: 'medium' },
  AI_MAX_OUTPUT_TOKENS: { description: 'Máximo de tokens de salida por solicitud IA', example: '16000' },
  AI_PRICE_INPUT_PER_MTOK: { description: 'Precio USD por millón de tokens de entrada (presupuesto)', example: '' },
  AI_PRICE_OUTPUT_PER_MTOK: { description: 'Precio USD por millón de tokens de salida (presupuesto)', example: '' },
  EXPORT_TTL_HOURS: { description: 'Vencimiento de archivos de exportación (h)', example: '24' },
  PERF_RAW_RETENTION_DAYS: { description: 'Retención de muestras crudas de rendimiento (días)', example: '90' },
  PERF_AGGREGATE_RETENTION_DAYS: { description: 'Retención de agregados de rendimiento (días)', example: '365' },
  PERF_GAP_THRESHOLD_MIN: { description: 'Minutos sin datos para marcar un hueco en series', example: '15' },
  DEFAULT_TIMEZONE: {
    description: 'Zona IANA de presentación y programaciones (RNF-USA-01)',
    example: 'America/La_Paz',
  },
  SCHEDULER_TICK_MS: { description: 'Tick del planificador (≤ 15000)', example: '15000' },
  RECONCILER_INTERVAL_MS: { description: 'Intervalo del reconciliador de ocurrencias', example: '60000' },
  OUTBOX_POLL_MS: { description: 'Intervalo del publicador de outbox', example: '5000' },
  WATCHDOG_INTERVAL_MS: { description: 'Watchdog de leases (≤ 15000)', example: '15000' },
  LEASE_TTL_MS: { description: 'Expiración de lease desde último heartbeat (75000)', example: '75000' },
  HEARTBEAT_INTERVAL_MS: { description: 'Heartbeat del ejecutor (15000)', example: '15000' },
  THRESHOLD_EVAL_INTERVAL_MS: { description: 'Evaluador de umbrales (60000)', example: '60000' },
  CLEANUP_HOUR_UTC: { description: 'Hora UTC de la limpieza diaria', example: '8' },
  GLOBAL_BROWSER_CONCURRENCY: { description: 'Navegadores concurrentes globales (1 inicial)', example: '1' },
  ALLOWED_TARGET_HOSTS: {
    description: 'Allowlist de hosts de ambientes/TestRail (SSRF), separados por coma',
    example: 'staging.deltax.example,example.testrail.io',
  },
  SSRF_PRIVATE_ALLOWED_HOSTS: {
    description: 'Excepciones SSRF registradas: hosts que pueden resolver a red privada (staging privado)',
    example: '',
  },
  SSRF_ALLOW_LOOPBACK: { description: 'Permitir loopback en URLs configurables (solo dev/pruebas)', example: 'false' },
  SSRF_ALLOW_HTTP: { description: 'Permitir http:// en URLs configurables (solo dev)', example: 'false' },
  OUTBOUND_HTTP_TIMEOUT_MS: { description: 'Timeout total de HTTP saliente (TestRail/Git) en ms', example: '30000' },
  TESTRAIL_BUSINESS_FIELDS: {
    description: 'Campos personalizados TestRail incluidos en content_hash (coma); los demás se registran',
    example: 'custom_preconds',
  },
  CATALOG_LISTING_QUEUE: { description: 'Cola BullMQ del listado aislado de tests', example: 'catalog-listing' },
  METRICS_PUBLIC: { description: 'Servir /metrics fuera de loopback/red privada', example: 'false' },
  HEALTH_FILE: {
    description:
      'Archivo cuyo mtime actualiza el proceso de control en cada ciclo (healthcheck); vacío = deshabilitado',
    example: '/tmp/health/alive',
  },
  LOGIN_MAX_FAILURES: { description: 'Fallos de login antes del bloqueo progresivo', example: '5' },
  LOGIN_LOCKOUT_BASE_SECONDS: { description: 'Bloqueo inicial tras exceder fallos (s, se duplica)', example: '60' },
  LOGIN_LOCKOUT_MAX_SECONDS: { description: 'Bloqueo máximo (s)', example: '3600' },
  PASSWORD_RESET_TTL_MINUTES: { description: 'Vigencia del token de recuperación (min)', example: '30' },
  SERVICE_CREDENTIAL_TTL_DAYS: { description: 'Vigencia máxima de credenciales de servicio (días)', example: '30' },
  BOOTSTRAP_ADMIN_EMAIL: { description: 'Correo del administrador inicial', example: 'admin@example.com' },
  BOOTSTRAP_ADMIN_PASSWORD_REF: {
    description: 'Referencia a la contraseña inicial del administrador',
    example: 'env:KATALYST_SECRET__BOOTSTRAP_ADMIN_PASSWORD',
    secret: true,
  },
  SUPERVISOR_TOKEN_REF: {
    description: 'Referencia al token de servicio del supervisor',
    example: 'env:KATALYST_SECRET__SUPERVISOR_TOKEN',
    secret: true,
  },
  OIDC_ISSUER_URL: { description: 'Issuer OIDC corporativo (opcional)', example: '' },
  OIDC_CLIENT_ID: { description: 'Client ID OIDC (opcional)', example: '' },
  OIDC_CLIENT_SECRET_REF: {
    description: 'Referencia al client secret OIDC',
    example: 'env:KATALYST_SECRET__OIDC_CLIENT_SECRET',
    secret: true,
  },
  OIDC_REDIRECT_URL: { description: 'Redirect URI OIDC', example: '' },
};
