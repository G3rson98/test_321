/**
 * Cliente Redis perezoso (readiness y, más adelante, BullMQ). `maxRetriesPerRequest: null` es requisito de BullMQ.
 */
import { Redis } from 'ioredis';
import { getConfig } from './config.js';

export function createRedis(url: string, opts: { forBullMq?: boolean; onError?: (err: Error) => void } = {}): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    maxRetriesPerRequest: opts.forBullMq ? null : 1,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  // Evita "Unhandled error event": la disponibilidad se reporta vía /readyz.
  client.on('error', opts.onError ?? (() => {}));
  return client;
}

let singleton: Redis | undefined;

export function getRedis(): Redis {
  singleton ??= createRedis(getConfig().REDIS_URL);
  return singleton;
}

/** PING con timeout; conecta si hace falta. */
export async function pingRedis(client: Redis, timeoutMs = 1_000): Promise<void> {
  if (client.status === 'wait' || client.status === 'end') await client.connect();
  await Promise.race([
    client.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('redis_timeout')), timeoutMs).unref()),
  ]);
}

export async function disconnectRedis(): Promise<void> {
  if (singleton) {
    const c = singleton;
    singleton = undefined;
    c.disconnect();
  }
}
