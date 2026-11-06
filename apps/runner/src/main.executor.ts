/**
 * Entrada del EJECUTOR de shard (contenedor `katalyst-executor` o proceso hijo en desarrollo).
 * Lee la asignación y el leaseToken de `KATALYST_SECRETS_DIR/lease.json` (tmpfs, montado por el supervisor) y
 * habla SOLO con `KATALYST_WORKER_API_URL`. Códigos de salida: 0 ok, 2 interrumpido, 3 lease perdido,
 * 4 fin de shard no entregado, 1 error interno. ESP §13.3, RNF-SEG-05.
 */
import path from 'node:path';
import pino from 'pino';
import { systemClock } from './clock.js';
import { loadExecutorConfig } from './config.js';
import { ShardExecutor, EXIT } from './executor/shard-executor.js';
import { createLogger } from './logger.js';
import { RUNNER_VERSION } from './version.js';
import { HttpWorkerApiClient } from './worker-api/http.js';

async function main(): Promise<number> {
  const config = loadExecutorConfig();
  const destination = config.KATALYST_EXECUTOR_LOG_FILE
    ? pino.multistream([
        { stream: pino.destination({ fd: 1, sync: false }) },
        { stream: pino.destination({ dest: config.KATALYST_EXECUTOR_LOG_FILE, mkdir: true, sync: false }) },
      ])
    : undefined;
  const logger = createLogger({
    name: 'katalyst-executor',
    level: config.LOG_LEVEL,
    base: { runnerVersion: RUNNER_VERSION },
    ...(destination ? { destination } : {}),
  });
  const executor = new ShardExecutor({
    config,
    clock: systemClock,
    logger,
    basePath: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    createApi: (leaseToken) =>
      new HttpWorkerApiClient({
        baseUrl: config.KATALYST_WORKER_API_URL,
        token: () => leaseToken,
        userAgent: `katalyst-executor/${RUNNER_VERSION}`,
      }),
  });
  const onSignal = (): void => void executor.onSignal();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    return await executor.run();
  } catch (e) {
    logger.fatal({ err: (e as Error).message }, 'el ejecutor no pudo iniciar');
    return EXIT.internal;
  } finally {
    logger.flush();
  }
}

main().then(
  (code) => setTimeout(() => process.exit(code), 50),
  () => process.exit(EXIT.internal),
);
