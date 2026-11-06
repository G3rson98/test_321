/**
 * Entrada del proceso API (puerto 3000): /api/v1, /healthz, /readyz, OpenAPI en /api/docs.
 */
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPrisma } from './db.js';
import { createRedis } from './redis.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, service: 'katalyst-api' });
  const prisma = createPrisma(config, 'api');
  const redis = createRedis(config.REDIS_URL);
  const app = await buildApp({ config, logger, prisma, redis });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'cerrando API');
    try {
      await app.close();
    } finally {
      await prisma.$disconnect();
      redis.disconnect();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err: unknown) => {
  console.error('No se pudo iniciar la API:', err instanceof Error ? err.message : err);
  process.exit(1);
});
