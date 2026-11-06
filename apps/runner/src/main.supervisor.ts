/**
 * Entrada del SUPERVISOR del host (único proceso con acceso a Docker; credencial de servicio propia).
 * Orden de arranque: configuración → limpieza de huérfanos (antes de aceptar trabajo) → salud → cancelación
 * (Redis pub/sub) → colas `run-shards` (concurrencia global de navegadores) y `catalog-listing`.
 * ESP §13.3, §13.7, ARQ §2/§4, RNF-OBS-02.
 */
import path from 'node:path';
import { systemClock } from './clock.js';
import { loadSupervisorConfig } from './config.js';
import { addKnownSecret, createLogger } from './logger.js';
import { createSecretProvider } from './secrets/secret-provider.js';
import { CancelRegistry } from './supervisor/cancel-registry.js';
import { CatalogProcessor } from './supervisor/catalog-processor.js';
import { IsolatedDependencyInstaller } from './supervisor/dependency-installer.js';
import { CliGitCheckout, LocalDirCheckout, type GitCheckout } from './supervisor/git-checkout.js';
import { startHealthTicker } from './supervisor/health.js';
import { HttpDockerEngine } from './supervisor/launcher/docker-engine.js';
import { DockerExecutorLauncher } from './supervisor/launcher/docker-launcher.js';
import { ProcessExecutorLauncher } from './supervisor/launcher/process-launcher.js';
import type { ExecutorHandle, ExecutorLauncher } from './supervisor/launcher/types.js';
import { cleanupOrphans } from './supervisor/orphan-cleanup.js';
import { CancelSubscriber, startQueueWorker } from './supervisor/queue.js';
import { ShardProcessor } from './supervisor/shard-processor.js';
import { rmrf } from './util/fs.js';
import { Semaphore } from './util/semaphore.js';
import { RUNNER_VERSION } from './version.js';
import { HttpSupervisorApiClient, HttpWorkerApiClient } from './worker-api/http.js';

async function main(): Promise<void> {
  const cfg = loadSupervisorConfig();
  const logger = createLogger({
    name: 'katalyst-supervisor',
    level: cfg.LOG_LEVEL,
    base: { runnerVersion: RUNNER_VERSION, supervisorId: cfg.KATALYST_SUPERVISOR_ID, launcher: cfg.executorLauncher },
  });
  const secrets = createSecretProvider(cfg);
  const serviceToken = await secrets.get(cfg.KATALYST_SUPERVISOR_TOKEN_REF);
  addKnownSecret(serviceToken);
  const api = new HttpSupervisorApiClient({
    baseUrl: cfg.KATALYST_API_INTERNAL_URL,
    token: () => serviceToken,
    userAgent: `katalyst-supervisor/${RUNNER_VERSION}`,
  });
  // Callbacks del supervisor con el leaseToken (heartbeat de preparación, fin de shard de respaldo): API interna.
  const createLeaseApi = (leaseToken: string) =>
    new HttpWorkerApiClient({ baseUrl: cfg.KATALYST_API_INTERNAL_URL, token: () => leaseToken, userAgent: `katalyst-supervisor/${RUNNER_VERSION}` });

  let launcher: ExecutorLauncher;
  if (cfg.executorLauncher === 'docker') {
    launcher = new DockerExecutorLauncher({
      engine: new HttpDockerEngine(cfg.KATALYST_DOCKER_SOCKET),
      image: cfg.KATALYST_EXECUTOR_IMAGE!,
      imageDigest: cfg.KATALYST_EXECUTOR_IMAGE_DIGEST ?? null,
      network: cfg.KATALYST_EXECUTOR_NETWORK,
      installNetwork: cfg.KATALYST_INSTALL_NETWORK ?? cfg.KATALYST_EXECUTOR_NETWORK,
      cpus: cfg.KATALYST_EXECUTOR_CPUS,
      memoryBytes: cfg.KATALYST_EXECUTOR_MEMORY_BYTES,
      pidsLimit: cfg.KATALYST_EXECUTOR_PIDS_LIMIT,
      shmBytes: cfg.KATALYST_EXECUTOR_SHM_BYTES,
      tmpQuotaBytes: cfg.KATALYST_RUN_TMP_QUOTA_BYTES,
      logger,
    });
  } else {
    const pl = new ProcessExecutorLauncher({ logger });
    pl.setShardsDir(cfg.shardSecretsDir);
    launcher = pl;
  }

  const checkout: GitCheckout =
    cfg.KATALYST_CHECKOUT_MODE === 'local-dir'
      ? new LocalDirCheckout(cfg.KATALYST_TESTS_LOCAL_DIR!, logger)
      : new CliGitCheckout({
          gitBin: cfg.KATALYST_GIT_BIN,
          repoUrl: cfg.KATALYST_TESTS_REPO_URL!,
          protectedBranch: cfg.KATALYST_TESTS_PROTECTED_BRANCH,
          testsSubdir: cfg.KATALYST_TESTS_SUBDIR,
          checkoutsDir: cfg.checkoutsDir,
          timeoutMs: cfg.KATALYST_GIT_TIMEOUT_MS,
          tokenUser: cfg.KATALYST_TESTS_REPO_TOKEN_USER,
          ...(cfg.KATALYST_TESTS_REPO_TOKEN_REF
            ? {
                token: async () => {
                  const t = await secrets.get(cfg.KATALYST_TESTS_REPO_TOKEN_REF!);
                  addKnownSecret(t);
                  return t;
                },
              }
            : {}),
          logger,
        });
  const workDir = path.join(cfg.runnerDataDir, 'work');
  const installer = new IsolatedDependencyInstaller({ launcher, mode: cfg.KATALYST_CHECKOUT_INSTALL, workDir, timeoutMs: 600_000, logger });
  const registry = new CancelRegistry(cfg.KATALYST_CANCEL_GRACE_MS);
  const semaphore = new Semaphore(cfg.KATALYST_GLOBAL_BROWSER_CONCURRENCY);

  // 1) Limpieza de huérfanos ANTES de aceptar trabajo nuevo (ESP §13.7).
  const report = await cleanupOrphans({
    launcher,
    shardSecretsDir: cfg.shardSecretsDir,
    runsDir: cfg.runsDir,
    checkoutsDir: cfg.checkoutsDir,
    checkoutMaxAgeDays: cfg.KATALYST_CHECKOUT_MAX_AGE_DAYS,
    workDir,
    logger,
  });
  const adopted: ExecutorHandle[] = report.adopted;
  for (const h of adopted) {
    // Los ejecutores retomados ocupan permisos de navegador hasta terminar.
    const gotSlot = semaphore.tryAcquire();
    const entry = registry.register(h.runId, h.shardId, '');
    entry.attach(h);
    void h.exited.finally(async () => {
      registry.unregister(entry);
      if (gotSlot) semaphore.release();
      await rmrf(path.join(cfg.shardSecretsDir, h.shardId));
      await rmrf(path.join(cfg.runsDir, h.runId, h.shardId));
    });
  }

  const stopHealth = startHealthTicker(cfg.KATALYST_HEALTH_FILE ?? process.env.HEALTH_FILE, cfg.KATALYST_HEALTH_INTERVAL_MS);
  const cancel = new CancelSubscriber(cfg.REDIS_URL, cfg.controlChannel, registry, logger);
  await cancel.start();

  const shardProcessor = new ShardProcessor({
    supervisorId: cfg.KATALYST_SUPERVISOR_ID,
    workerApiUrl: cfg.workerApiUrl,
    shardSecretsDir: cfg.shardSecretsDir,
    runsDir: cfg.runsDir,
    logLevel: cfg.LOG_LEVEL,
    ...(cfg.executorLauncher === 'docker'
      ? { image: { image: cfg.KATALYST_EXECUTOR_IMAGE ?? null, digest: cfg.KATALYST_EXECUTOR_IMAGE_DIGEST ?? null } }
      : {}),
    api,
    createLeaseApi,
    secrets,
    checkout,
    installer,
    launcher,
    registry,
    semaphore,
    clock: systemClock,
    logger,
  });
  const catalogProcessor = new CatalogProcessor({
    api,
    checkout,
    installer,
    launcher,
    workDir,
    timeoutMs: cfg.KATALYST_LISTING_TIMEOUT_MS,
    logger,
  });

  const shardWorker = startQueueWorker({
    redisUrl: cfg.REDIS_URL,
    prefix: cfg.KATALYST_QUEUE_PREFIX,
    queueName: cfg.KATALYST_SHARD_QUEUE,
    concurrency: cfg.KATALYST_GLOBAL_BROWSER_CONCURRENCY,
    logger,
    handler: (data) => shardProcessor.process(data),
  });
  const catalogWorker = startQueueWorker({
    redisUrl: cfg.REDIS_URL,
    prefix: cfg.KATALYST_QUEUE_PREFIX,
    queueName: cfg.KATALYST_CATALOG_QUEUE,
    concurrency: 1,
    logger,
    handler: (data) => catalogProcessor.process(data),
  });
  logger.info(
    { concurrency: cfg.KATALYST_GLOBAL_BROWSER_CONCURRENCY, shardQueue: cfg.KATALYST_SHARD_QUEUE, catalogQueue: cfg.KATALYST_CATALOG_QUEUE },
    'supervisor listo',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn({ signal }, 'deteniendo supervisor');
    await Promise.all([shardWorker.close(true), catalogWorker.close(true)]).catch(() => undefined);
    await cancel.stop();
    if (launcher.kind === 'process') {
      // Sin Docker los ejecutores no sobreviven al supervisor: se detienen con motivo `shutdown`.
      await registry.shutdownAll();
    }
    stopHealth();
    logger.flush();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  // Sin valores de configuración ni secretos en el mensaje.
  console.error(JSON.stringify({ level: 'fatal', service: 'katalyst-supervisor', msg: 'arranque fallido', err: (e as Error).message }));
  process.exit(1);
});
