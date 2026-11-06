/**
 * Proceso de control (plan §3; ESP §13.3–§13.5, §13.8). Orquesta TODOS los bucles, separados de los workers:
 *  - planificador (≤ 15 s): ocurrencias, admisión por capacidad, omisión por gracia vencida, finalización ≤ 60 s;
 *  - despacho rápido de `run.dispatch_shard` a BullMQ (`run-shards`, ~1 s);
 *  - reconciliador (Job Schedulers BullMQ ⇄ PostgreSQL, despacho perdido tras reinicio de Redis);
 *  - watchdog de leases (≤ 15 s), cancelaciones sin confirmar (30 s) y timeouts de corrida;
 *  - limpieza diaria idempotente (retenciones ESP §7);
 *  - módulos de otras áreas cargados con import dinámico TOLERANTE (si faltan o fallan al cargar, el resto sigue):
 *    `control/outbox-publisher` (API-A: `runOutboxPublisherTick`, métricas), `control/testrail-sync` (API-A:
 *    `runScheduledTestRailSync`, handlers TestRail), `modules/notifications/dispatch` (API-C: handlers),
 *    `control/perf-evaluator` (`evaluatePerfThresholds`, 60 s) y `control/perf-rollup` (`runPerfRollup`, 1 h).
 * `HEALTH_FILE` se toca en cada ciclo del planificador y del watchdog (≤ 15 s). Logs JSON con `runId`.
 * RF-PRG-04, RNF-REN-02, RNF-CON-01, RNF-CON-02, RNF-OBS-01, RNF-OBS-02, RF-REN-03, RF-TR-02.
 */
import { closeSync, mkdirSync, openSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Queue, Worker } from 'bullmq';
import { getConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { createPrisma } from './db.js';
import { createRedis } from './redis.js';
import { configureEventNotifier } from './lib/events-publish.js';
import { getSecretProvider, type SecretProvider } from './lib/secrets.js';
import { startDefaultMetrics } from './lib/metrics.js';
import { createArtifactStore, type ArtifactStore } from './adapters/artifact-store/index.js';
import { redisControlPublisher, type ControlPublisher } from './services/cancellation.js';
import { materializeDueOccurrences } from './services/scheduler.js';
import { admitPendingShards } from './services/run-admission.js';
import { schedulerTick } from './control/scheduler-loop.js';
import { registerRunMetrics, watchdogTick } from './control/lease-watchdog.js';
import { dailyCleanupGate, runCleanup } from './control/cleanup.js';
import {
  bullConnectionFromUrl,
  createShardQueue,
  dispatchPendingDeliveries,
  registerDispatchHandler,
  registerQueueMetrics,
} from './control/dispatcher.js';
import { createTriggerQueue, reconcileTick, startTriggerWorker, type ScheduleTriggerData } from './control/reconciler.js';

export interface ControlLoop {
  name: string;
  intervalMs: number;
  tick: (ctx: { logger: Logger; now: Date }) => Promise<void>;
}

export interface ControlContext {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  secrets: SecretProvider;
  publishControl: ControlPublisher;
  store: ArtifactStore | null;
  shardQueue: Queue | null;
  triggerQueue: Queue<ScheduleTriggerData> | null;
  /** Reloj inyectable. */
  clock?: () => Date;
}

/** Actualiza el mtime de `HEALTH_FILE` (healthcheck de deploy/: el proceso sigue vivo y ciclando). */
export function touchHealthFile(path: string, now: Date = new Date()): void {
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'a'));
  utimesSync(path, now, now);
}

function healthToucher(config: Config): (now: Date) => void {
  const file = config.HEALTH_FILE;
  return (now) => {
    if (file) {
      try {
        touchHealthFile(file, now);
      } catch {
        // el healthcheck lo detectará
      }
    }
  };
}

type Lazy<T> = () => Promise<T | null>;

/** Import dinámico tolerante y memoizado: si el módulo falta o falla al cargar, se registra una vez y se omite. */
export function lazyModule<T>(name: string, load: () => Promise<T>, logger?: Logger): Lazy<T> {
  let p: Promise<T | null> | undefined;
  return () => {
    p ??= load().catch((err: unknown) => {
      logger?.error({ err, module: name }, 'módulo de control no disponible; se continúa sin él');
      return null;
    });
    return p;
  };
}

export const externalModules = (logger?: Logger) => ({
  outbox: lazyModule('outbox-publisher', () => import('./control/outbox-publisher.js'), logger),
  testrail: lazyModule('testrail-sync', () => import('./control/testrail-sync.js'), logger),
  notifications: lazyModule('notifications', () => import('./modules/notifications/dispatch.js'), logger),
  perfEvaluator: lazyModule('perf-evaluator', () => import('./control/perf-evaluator.js'), logger),
  perfRollup: lazyModule('perf-rollup', () => import('./control/perf-rollup.js'), logger),
});

/**
 * Todos los bucles del proceso de control. Con solo `config` (pruebas) se construyen las definiciones; los ticks que
 * requieren BD/Redis exigen `ctx`.
 */
export function controlLoops(config: Config, ctx?: ControlContext): ControlLoop[] {
  const need = (): ControlContext => {
    if (!ctx) throw new Error('contexto de control no inicializado');
    return ctx;
  };
  const touch = healthToucher(config);
  const gate = dailyCleanupGate(config.CLEANUP_HOUR_UTC);
  const ext = externalModules(ctx?.logger);
  const base = () => ({
    prisma: need().prisma,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    globalBrowserCeiling: config.GLOBAL_BROWSER_CONCURRENCY,
  });
  const outboxWorkerId = `control-${process.pid}`;
  const loops: ControlLoop[] = [
    ...(config.HEALTH_FILE
      ? [{ name: 'health_file', intervalMs: Math.min(config.SCHEDULER_TICK_MS, 15_000), tick: async ({ now }: { now: Date }) => touch(now) }]
      : []),
    {
      name: 'planificador',
      intervalMs: Math.min(config.SCHEDULER_TICK_MS, 15_000),
      tick: async ({ logger, now }) => {
        await schedulerTick({ ...base(), logger }, now);
        touch(now);
      },
    },
    {
      name: 'despacho_shards',
      intervalMs: 1_000,
      tick: async ({ now }) => {
        const c = need();
        if (c.shardQueue) await dispatchPendingDeliveries(c.prisma, c.shardQueue, now);
      },
    },
    {
      name: 'watchdog_leases',
      intervalMs: Math.min(config.WATCHDOG_INTERVAL_MS, 15_000),
      tick: async ({ logger, now }) => {
        const c = need();
        await watchdogTick(
          { prisma: c.prisma, logger, publicBaseUrl: config.PUBLIC_BASE_URL, publishControl: c.publishControl, leaseTtlMs: config.LEASE_TTL_MS },
          now,
        );
        touch(now);
      },
    },
    {
      name: 'reconciliador',
      intervalMs: config.RECONCILER_INTERVAL_MS,
      tick: async ({ logger, now }) => {
        const c = need();
        await reconcileTick({ prisma: c.prisma, logger, ...(c.triggerQueue ? { triggers: c.triggerQueue } : {}) }, now);
      },
    },
    {
      name: 'limpieza_diaria',
      intervalMs: 60 * 60 * 1000,
      tick: async ({ logger, now }) => {
        if (!gate(now)) return;
        const c = need();
        const stats = await runCleanup({ prisma: c.prisma, logger, store: c.store }, now);
        logger.info({ stats }, 'limpieza diaria');
      },
    },
    // --- Módulos de otras áreas (import dinámico tolerante) ---------------------------------------------------------
    {
      name: 'publicador_outbox',
      intervalMs: config.OUTBOX_POLL_MS,
      tick: async ({ logger, now }) => {
        const m = await ext.outbox();
        if (!m) return;
        const c = need();
        const stats = await m.runOutboxPublisherTick({ prisma: c.prisma, logger, secrets: c.secrets, workerId: outboxWorkerId }, now);
        if (stats.claimed > 0 || stats.expired > 0 || stats.recovered > 0) logger.info({ stats }, 'outbox');
      },
    },
    {
      name: 'sync_testrail',
      intervalMs: config.TESTRAIL_SYNC_INTERVAL_MS,
      tick: async ({ logger }) => {
        const m = await ext.testrail();
        if (!m) return;
        const c = need();
        const r = await m.runScheduledTestRailSync({ prisma: c.prisma, logger, config, secrets: c.secrets });
        if (r) logger.info({ status: r }, 'sync TestRail programada');
      },
    },
    {
      name: 'evaluador_umbrales',
      intervalMs: config.THRESHOLD_EVAL_INTERVAL_MS,
      tick: async ({ logger, now }) => {
        const m = await ext.perfEvaluator();
        if (!m) return;
        await m.evaluatePerfThresholds({ prisma: need().prisma, config, logger, now });
      },
    },
    {
      name: 'rollup_rendimiento',
      intervalMs: 60 * 60 * 1000,
      tick: async ({ logger, now }) => {
        const m = await ext.perfRollup();
        if (!m) return;
        const r = await m.runPerfRollup({ prisma: need().prisma, logger, now });
        logger.info({ ...r }, 'rollup de rendimiento');
      },
    },
  ];
  return loops;
}

/** Registra handlers de outbox y métricas de otras áreas (tolerante). Devuelve módulos cargados/fallidos. */
export async function registerExternalHandlers(ctx: ControlContext): Promise<{ loaded: string[]; failed: string[] }> {
  const ext = externalModules(ctx.logger);
  const out = { loaded: [] as string[], failed: [] as string[] };
  const step = async (name: string, fn: () => Promise<boolean>) => {
    try {
      (await fn()) ? out.loaded.push(name) : out.failed.push(name);
    } catch (err) {
      out.failed.push(name);
      ctx.logger.error({ err, module: name }, 'registro de módulo fallido; se continúa');
    }
  };
  await step('testrail-sync', async () => {
    const m = await ext.testrail();
    m?.registerTestRailControl({ prisma: ctx.prisma, logger: ctx.logger, config: ctx.config, secrets: ctx.secrets });
    return !!m;
  });
  await step('notifications', async () => {
    const m = await ext.notifications();
    m?.registerNotificationHandlers({ config: ctx.config });
    return !!m;
  });
  await step('outbox-publisher', async () => {
    const m = await ext.outbox();
    m?.registerOutboxMetrics(ctx.prisma);
    return !!m;
  });
  return out;
}

/** Ejecuta un bucle sin solapamiento (un tick a la vez). Devuelve una función de parada. */
export function startLoop(loop: ControlLoop, logger: Logger, clock: () => Date = () => new Date()): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stopped = false;
  const log = logger.child({ loop: loop.name });
  const run = () => {
    if (stopped || running) return;
    running = loop
      .tick({ logger: log, now: clock() })
      .catch((err: unknown) => log.error({ err }, 'tick fallido'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(run, loop.intervalMs);
  setImmediate(run);
  log.info({ intervalMs: loop.intervalMs }, 'bucle iniciado');
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (running) await running;
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, service: 'katalyst-control' });
  startDefaultMetrics('katalyst-control');
  const prisma = createPrisma(config, 'control');
  const redis = createRedis(config.REDIS_URL);
  configureEventNotifier({ redis, channel: `${config.QUEUE_PREFIX}:events` });
  const secrets = getSecretProvider();
  const connection = bullConnectionFromUrl(config.REDIS_URL);
  const shardQueue = createShardQueue(connection, config.QUEUE_PREFIX);
  shardQueue.on('error', (err) => logger.warn({ err }, 'cola run-shards'));
  const triggerQueue = createTriggerQueue(connection, config.QUEUE_PREFIX);
  triggerQueue.on('error', (err) => logger.warn({ err }, 'cola schedule-triggers'));
  let store: ArtifactStore | null = null;
  try {
    store = await createArtifactStore(config, (ref) => secrets.get(ref));
  } catch (err) {
    logger.error({ err }, 'almacén de artefactos no disponible: la limpieza no borrará objetos');
  }
  const ctx: ControlContext = {
    config,
    logger,
    prisma,
    redis,
    secrets,
    publishControl: redisControlPublisher(redis, config.QUEUE_PREFIX),
    store,
    shardQueue,
    triggerQueue,
  };
  registerDispatchHandler(prisma, shardQueue);
  registerQueueMetrics(shardQueue);
  registerRunMetrics(prisma);

  const deps = { prisma, logger, publicBaseUrl: config.PUBLIC_BASE_URL, globalBrowserCeiling: config.GLOBAL_BROWSER_CONCURRENCY };
  const triggerWorker: Worker = startTriggerWorker(
    connection,
    config.QUEUE_PREFIX,
    async (scheduleId) => {
      const now = new Date();
      await materializeDueOccurrences(deps, now, { scheduleId });
      await admitPendingShards(deps, now);
    },
    logger,
  );

  const external = await registerExternalHandlers(ctx);
  logger.info(external, 'módulos de control externos');
  const stops = controlLoops(config, ctx).map((l) => startLoop(l, logger));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'cerrando control');
    await Promise.all(stops.map((s) => s()));
    await Promise.allSettled([triggerWorker.close(), shardQueue.close(), triggerQueue.close()]);
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error('No se pudo iniciar control:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
