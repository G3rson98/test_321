/**
 * Configuración del runner validada con Zod (plan §3). Nombres alineados con deploy/docker-compose.yml
 * (servicio `supervisor`, bloque `x-katalyst-executor`) y docs/infraestructura.md §5.
 * Los secretos se leen SIEMPRE por referencia (`*_REF`: `env:NOMBRE` | `file:/ruta` | `ssm:/prefijo/nombre`).
 * RNF-SEG-01, RNF-SEG-05, RNF-OPT-05, RNF-OBS-01/02, ESP §13.3, §13.7.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SecretRefSchema } from '@katalyst/shared';

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());
const httpUrl = z.string().regex(/^https?:\/\/[^\s]+$/, 'URL http(s) inválida');

/** Lee `<NOMBRE>_FILE` si `<NOMBRE>` no está definido (contrato de deploy: REDIS_URL_FILE). */
function withFileFallback(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct && direct.trim()) return direct.trim();
  const file = env[`${name}_FILE`];
  if (file && file.trim()) return readFileSync(file.trim(), 'utf8').trim();
  return undefined;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const devDefaultBase = path.join(os.tmpdir(), `katalyst-runner-${process.getuid?.() ?? 'u'}`);

export const SupervisorEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  KATALYST_ENVIRONMENT: z.string().default('internal'),
  /** Identificador del supervisor/host (se envía en `workerId`). */
  KATALYST_SUPERVISOR_ID: z.string().min(1).max(120).default(os.hostname()),
  /** API interna para claim y listado de catálogo (credencial de servicio del supervisor). */
  KATALYST_API_INTERNAL_URL: httpUrl.default('http://localhost:3000'),
  /** URL que usan los EJECUTORES (worker-gw en Compose). Por defecto, la misma API interna. */
  KATALYST_WORKER_API_URL: opt(httpUrl),
  /** Credencial de servicio propia del supervisor (Bearer). Se resuelve con el SecretProvider. */
  KATALYST_SUPERVISOR_TOKEN_REF: SecretRefSchema,
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, 'REDIS_URL debe ser redis://')
    .default('redis://localhost:6379/0'),
  KATALYST_QUEUE_PREFIX: z.string().min(1).default('katalyst'),
  KATALYST_SHARD_QUEUE: z.string().min(1).default('run-shards'),
  KATALYST_CATALOG_QUEUE: z.string().min(1).default('catalog-listing'),
  /**
   * Canal Redis pub/sub de control de corridas (contrato de API-B, `apps/api/src/services/cancellation.ts`):
   * por defecto `<KATALYST_QUEUE_PREFIX>:runs:control`, mensajes `RunControlMessage` (`cancel` | `revoke`).
   */
  KATALYST_CANCEL_CHANNEL: opt(z.string().min(1)),
  KATALYST_GLOBAL_BROWSER_CONCURRENCY: int(1, 1, 32),
  KATALYST_HEALTH_FILE: opt(z.string()),
  KATALYST_HEALTH_INTERVAL_MS: int(10_000, 1_000, 15_000),
  // Secretos
  KATALYST_SECRET_PROVIDER: z.enum(['env', 'file', 'ssm']).default('env'),
  KATALYST_SECRET_FILE_DIR: z.string().default('/run/secrets/katalyst'),
  KATALYST_SSM_PREFIX: z
    .string()
    .regex(/^\/[A-Za-z0-9_./-]*$/)
    .default('/katalyst/internal'),
  AWS_REGION: opt(z.string()),
  // Ejecutor
  KATALYST_EXECUTOR_LAUNCHER: opt(z.enum(['docker', 'process'])),
  KATALYST_EXECUTOR_IMAGE: opt(z.string().min(1)),
  KATALYST_EXECUTOR_IMAGE_DIGEST: opt(z.string()),
  KATALYST_EXECUTOR_NETWORK: z.string().default('katalyst-runner-net'),
  KATALYST_EXECUTOR_CPUS: z.coerce.number().positive().max(64).default(1.5),
  KATALYST_EXECUTOR_MEMORY_BYTES: int(2_684_354_560, 256 * 1024 * 1024, 64 * 1024 ** 3),
  KATALYST_EXECUTOR_PIDS_LIMIT: int(512, 64, 65_536),
  KATALYST_EXECUTOR_SHM_BYTES: int(1024 ** 3, 64 * 1024 * 1024, 8 * 1024 ** 3),
  KATALYST_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /** Red de los contenedores de instalación de dependencias del checkout (sin secretos). */
  KATALYST_INSTALL_NETWORK: opt(z.string()),
  KATALYST_SHARD_SECRETS_DIR: opt(z.string()),
  KATALYST_RUNNER_DATA_DIR: opt(z.string()),
  KATALYST_RUN_TMP_QUOTA_BYTES: int(1024 ** 3, 1024 * 1024, 64 * 1024 ** 3),
  KATALYST_RUN_EVIDENCE_QUOTA_BYTES: int(250 * 1024 * 1024, 1024 * 1024, 64 * 1024 ** 3),
  /** Gracia entre SIGTERM y SIGKILL al cancelar (total < 30 s, ESP §13.3). */
  KATALYST_CANCEL_GRACE_MS: int(15_000, 1_000, 25_000),
  // Repositorio de tests
  KATALYST_CHECKOUT_MODE: z.enum(['git', 'local-dir']).default('git'),
  KATALYST_TESTS_REPO_URL: opt(z.string().min(1)),
  KATALYST_TESTS_REPO_TOKEN_REF: opt(SecretRefSchema),
  KATALYST_TESTS_REPO_TOKEN_USER: z.string().default('x-access-token'),
  KATALYST_TESTS_PROTECTED_BRANCH: z.string().regex(/^[A-Za-z0-9._/-]+$/).default('main'),
  /** Subdirectorio del repo que contiene playwright.config.ts (p. ej. `qa-tests` en un monorepo). */
  KATALYST_TESTS_SUBDIR: z
    .string()
    .regex(/^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/)
    .refine((v) => !v.split('/').includes('..'))
    .default(''),
  /** Solo desarrollo (`local-dir`): directorio local con los tests; el commit no puede verificarse. */
  KATALYST_TESTS_LOCAL_DIR: opt(z.string()),
  KATALYST_CHECKOUT_INSTALL: z.enum(['auto', 'never']).default('auto'),
  KATALYST_CHECKOUT_MAX_AGE_DAYS: int(14, 1, 365),
  KATALYST_GIT_BIN: z.string().default('git'),
  KATALYST_GIT_TIMEOUT_MS: int(300_000, 10_000, 3_600_000),
  KATALYST_LISTING_TIMEOUT_MS: int(120_000, 10_000, 900_000),
});
export type SupervisorEnv = z.infer<typeof SupervisorEnvSchema>;

export interface SupervisorConfig extends SupervisorEnv {
  executorLauncher: 'docker' | 'process';
  workerApiUrl: string;
  shardSecretsDir: string;
  runnerDataDir: string;
  checkoutsDir: string;
  runsDir: string;
  controlChannel: string;
}

export function loadSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const raw = { ...env, REDIS_URL: withFileFallback(env, 'REDIS_URL') ?? env.REDIS_URL };
  const parsed = SupervisorEnvSchema.parse(raw);
  const production = parsed.NODE_ENV === 'production';
  const executorLauncher = parsed.KATALYST_EXECUTOR_LAUNCHER ?? (production ? 'docker' : 'process');
  if (executorLauncher === 'docker' && !parsed.KATALYST_EXECUTOR_IMAGE) {
    throw new Error('KATALYST_EXECUTOR_IMAGE es obligatorio con el launcher docker');
  }
  if (production && executorLauncher === 'process') {
    throw new Error('El launcher `process` es solo para desarrollo local (sin aislamiento de contenedor)');
  }
  if (production && parsed.KATALYST_CHECKOUT_MODE === 'local-dir') {
    throw new Error('KATALYST_CHECKOUT_MODE=local-dir no puede usarse en producción (commit no verificable)');
  }
  if (parsed.KATALYST_CHECKOUT_MODE === 'git' && !parsed.KATALYST_TESTS_REPO_URL) {
    throw new Error('KATALYST_TESTS_REPO_URL es obligatorio con KATALYST_CHECKOUT_MODE=git');
  }
  if (parsed.KATALYST_CHECKOUT_MODE === 'local-dir' && !parsed.KATALYST_TESTS_LOCAL_DIR) {
    throw new Error('KATALYST_TESTS_LOCAL_DIR es obligatorio con KATALYST_CHECKOUT_MODE=local-dir');
  }
  const shardSecretsDir = path.resolve(
    parsed.KATALYST_SHARD_SECRETS_DIR ?? (production ? '/run/katalyst/shards' : path.join(devDefaultBase, 'shards')),
  );
  const runnerDataDir = path.resolve(
    parsed.KATALYST_RUNNER_DATA_DIR ?? (production ? '/data/runner' : path.join(devDefaultBase, 'data')),
  );
  return {
    ...parsed,
    executorLauncher,
    workerApiUrl: parsed.KATALYST_WORKER_API_URL ?? parsed.KATALYST_API_INTERNAL_URL,
    shardSecretsDir,
    runnerDataDir,
    checkoutsDir: path.join(runnerDataDir, 'checkouts'),
    runsDir: path.join(runnerDataDir, 'runs'),
    controlChannel: parsed.KATALYST_CANCEL_CHANNEL ?? `${parsed.KATALYST_QUEUE_PREFIX}:runs:control`,
  };
}

/** Variables del EJECUTOR (dentro del contenedor o proceso hijo). Rutas por defecto = executor.Dockerfile. */
export const ExecutorEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  KATALYST_WORKER_API_URL: httpUrl,
  KATALYST_SECRETS_DIR: z.string().default('/run/katalyst/secrets'),
  KATALYST_LEASE_FILE: opt(z.string()),
  KATALYST_STATE_DIR: z.string().default('/run/katalyst/state'),
  KATALYST_TESTS_DIR: z.string().default('/work/tests'),
  KATALYST_OUTPUT_DIR: z.string().default('/work/out'),
  /** Si se define, el ejecutor duplica su log JSON sanitizado en este archivo (el supervisor lo retransmite). */
  KATALYST_EXECUTOR_LOG_FILE: opt(z.string()),
  KATALYST_PLAYWRIGHT_VERSION: opt(z.string()),
  KATALYST_IMAGE: opt(z.string()),
  KATALYST_IMAGE_DIGEST: opt(z.string()),
  PLAYWRIGHT_BROWSERS_PATH: opt(z.string()),
  /** Gracia de Playwright tras SIGINT antes de SIGKILL del árbol (cancelación < 30 s). */
  KATALYST_PLAYWRIGHT_STOP_GRACE_MS: int(6_000, 500, 20_000),
});
export type ExecutorEnv = z.infer<typeof ExecutorEnvSchema>;

export interface ExecutorConfig extends ExecutorEnv {
  leaseFile: string;
  testUserFile: string;
  controlFile: string;
}

export function loadExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const parsed = ExecutorEnvSchema.parse(env);
  return {
    ...parsed,
    leaseFile: parsed.KATALYST_LEASE_FILE ?? path.join(parsed.KATALYST_SECRETS_DIR, SHARD_FILES.lease),
    testUserFile: path.join(parsed.KATALYST_SECRETS_DIR, SHARD_FILES.testUser),
    controlFile: path.join(parsed.KATALYST_SECRETS_DIR, SHARD_FILES.control),
  };
}

/** Nombres de archivo dentro de `/run/katalyst/shards/<shardId>/secrets` (tmpfs del host). */
export const SHARD_FILES = {
  lease: 'lease.json',
  testUser: 'test-user.json',
  control: 'control.json',
} as const;

/** Archivos dentro del directorio de salida del shard (`/data/runner/runs/<runId>/<shardId>`). */
export const OUTPUT_FILES = {
  complete: 'executor-complete.json',
  executorLog: 'executor.log',
} as const;
