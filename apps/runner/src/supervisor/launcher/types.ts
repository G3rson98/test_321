/**
 * Interfaz de lanzamiento del ejecutor (inyectable). Implementaciones: `docker` (producción: contenedor efímero
 * con las opciones de `x-katalyst-executor`) y `process` (desarrollo local sin Docker: proceso hijo con
 * directorio temporal propio y entorno mínimo). ESP §13.3 (correlación corrida/shard/contenedor, cancelación del
 * árbol de procesos), RNF-SEG-05, ARQ §2.
 */
export interface ExecutorLaunchSpec {
  runId: string;
  shardId: string;
  leaseId: string;
  /** `<KATALYST_SHARD_SECRETS_DIR>/<shardId>` (host). Contiene `secrets/` (0700). */
  shardDir: string;
  secretsDir: string;
  /** Raíz del checkout del commit (host) y subdirectorio de los tests dentro de ella. */
  checkoutRoot: string;
  testsSubdir: string;
  /** `/data/runner/runs/<runId>/<shardId>` (host). */
  outputDir: string;
  workerApiUrl: string;
  logLevel: string;
  image?: { image: string | null; digest: string | null };
}

export type StopReason = 'cancel' | 'shutdown' | 'revoke';

export interface ExecutorExit {
  exitCode: number | null;
  signal: string | null;
}

export interface ExecutorHandle {
  /** ID de contenedor (docker) o `pid:<n>` (process). */
  readonly id: string;
  readonly runId: string;
  readonly shardId: string;
  readonly exited: Promise<ExecutorExit>;
  /**
   * Detiene el ejecutor: escribe `control.json` con el motivo, envía SIGTERM y, si no terminó tras `graceMs`,
   * SIGKILL del árbol/contenedor. Resuelve cuando ya no queda nada vivo.
   */
  stop(reason: StopReason, graceMs: number): Promise<void>;
  /** Líneas de log ya sanitizadas por el ejecutor (se vuelven a sanitizar al registrarlas). */
  onLog(listener: (line: string) => void): void;
}

/** Rutas tal como las ve el proceso aislado (dentro del contenedor o en el host en modo `process`). */
export interface RuntimePaths {
  node: string;
  root: string;
  testsDir: string;
  outDir: string;
}

export interface IsolatedRunSpec {
  purpose: 'listing' | 'install';
  checkoutRoot: string;
  testsSubdir: string;
  /** Directorio de salida (host), escribible por el proceso aislado. */
  outputDir: string;
  command: (rt: RuntimePaths) => string[];
  env: (rt: RuntimePaths) => Record<string, string>;
  /** `none`: sin red (listado); `egress`: red de instalación (sin secretos). */
  network: 'none' | 'egress';
  writableCheckout: boolean;
  /** Directorio de trabajo relativo: raíz del checkout o de los tests. */
  cwd: 'root' | 'tests';
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface IsolatedRunResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Últimos bytes de stderr/stdout (para diagnóstico; se sanitizan antes de usarse). */
  outputTail: string;
}

export interface RunningExecutor {
  id: string;
  runId: string;
  shardId: string;
  running: boolean;
}

export interface ExecutorLauncher {
  readonly kind: 'docker' | 'process';
  launch(spec: ExecutorLaunchSpec): Promise<ExecutorHandle>;
  runIsolated(spec: IsolatedRunSpec): Promise<IsolatedRunResult>;
  /** Ejecutores existentes (de una instancia anterior del supervisor). */
  listExecutors(): Promise<RunningExecutor[]>;
  /** Retoma un ejecutor vivo (docker); `null` si no es posible (process). */
  adopt(e: RunningExecutor, shardDir: string): ExecutorHandle | null;
  /** Elimina un ejecutor huérfano (detenido o no adoptable). */
  destroy(e: RunningExecutor): Promise<void>;
}

export const CONTAINER_PATHS = {
  secrets: '/run/katalyst/secrets',
  state: '/run/katalyst/state',
  tests: '/work/tests',
  repo: '/work/repo',
  out: '/work/out',
  home: '/tmp/home',
} as const;

export const EXECUTOR_LABELS = {
  role: 'katalyst.role',
  run: 'katalyst.run',
  shard: 'katalyst.shard',
  lease: 'katalyst.lease',
} as const;
