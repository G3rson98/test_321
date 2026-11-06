/**
 * PrismaClient por proceso con `connection_limit` acotado (pool total ≤ 20 entre procesos, RNF-OPT-05).
 */
import { PrismaClient } from '@prisma/client';
import { getConfig, poolSizeFor, type Config, type ProcessKind } from './config.js';

/** Añade `connection_limit` y `pool_timeout` a la URL sin duplicar parámetros existentes. */
export function withPoolParams(databaseUrl: string, connectionLimit: number, poolTimeoutSeconds: number): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', String(connectionLimit));
  url.searchParams.set('pool_timeout', String(poolTimeoutSeconds));
  return url.toString();
}

export function createPrisma(config: Config, kind: ProcessKind): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: withPoolParams(config.DATABASE_URL, poolSizeFor(config, kind), config.DB_POOL_TIMEOUT_SECONDS) },
    },
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
}

let singleton: PrismaClient | undefined;

/** Cliente compartido del proceso. */
export function getPrisma(kind: ProcessKind = 'api'): PrismaClient {
  singleton ??= createPrisma(getConfig(), kind);
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    const c = singleton;
    singleton = undefined;
    await c.$disconnect();
  }
}
