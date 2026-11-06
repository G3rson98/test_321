/**
 * Transporte con Redis REAL (índice 4 del agente RUNNER): consumo BullMQ de `run-shards` con payload
 * `{runId, shardId}` y concurrencia 1, y control por pub/sub `<prefijo>:runs:control` (RunControlMessage de API-B).
 * Se omite si Redis no está disponible. RF-EJE-03, RF-EJE-04, ESP §13.3.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANCEL_DEADLINE_MARGIN_MS, CancelRegistry } from '../src/supervisor/cancel-registry.js';
import { CancelSubscriber, parseCancelMessage, parseControlMessage, startQueueWorker } from '../src/supervisor/queue.js';
import { silentLogger } from './helpers/logger.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/4';
const PREFIX = 'katalyst-test-runner';
let available = false;

beforeAll(async () => {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await r.connect();
    available = (await r.ping()) === 'PONG';
  } catch {
    available = false;
  } finally {
    r.disconnect();
  }
});

afterAll(async () => {
  if (!available) return;
  const r = new Redis(REDIS_URL);
  const keys = await r.keys(`${PREFIX}:*`);
  if (keys.length) await r.del(...keys);
  r.disconnect();
});

describe('parseControlMessage (contrato RunControlMessage de API-B)', () => {
  it('acepta RunControlMessage, {runId} o UUID plano; rechaza basura', () => {
    const id = randomUUID();
    const shard = randomUUID();
    const lease = randomUUID();
    const deadline = new Date(Date.now() + 30_000);
    const msg = { type: 'revoke', runId: id, shardIds: [shard], leaseIds: [lease], reason: 'lease_vencido', requestedAt: new Date().toISOString(), deadlineAt: deadline.toISOString() };
    expect(parseControlMessage(JSON.stringify(msg))).toEqual({
      type: 'revoke',
      runId: id,
      shardIds: [shard],
      leaseIds: [lease],
      reason: 'lease_vencido',
      deadlineAtMs: deadline.getTime(),
    });
    expect(parseControlMessage(JSON.stringify({ runId: id }))).toEqual({ type: 'cancel', runId: id, shardIds: [], leaseIds: [], reason: null, deadlineAtMs: null });
    expect(parseControlMessage(JSON.stringify({ runId: id, deadlineAt: 'no-es-fecha' }))?.deadlineAtMs).toBeNull();
    expect(parseCancelMessage(id)).toBe(id);
    expect(parseControlMessage('{"runId":"x"}')).toBeNull();
    expect(parseControlMessage('{"type":"rm","runId":"' + id + '"}')).toBeNull();
    expect(parseCancelMessage('rm -rf /')).toBeNull();
  });

  it('cancel con deadlineAt acota la gracia SIGTERM→SIGKILL para detener antes del límite (D-049)', () => {
    const now = 1_000_000;
    const registry = new CancelRegistry(15_000, () => now);
    const runId = randomUUID();
    const near = registry.register(runId, randomUUID(), randomUUID());
    const far = registry.register(randomUUID(), randomUUID(), randomUUID());
    const none = registry.register(randomUUID(), randomUUID(), randomUUID());
    registry.cancelRun(runId, [], now + 10_000);
    expect(near.cancelGraceMs).toBe(10_000 - CANCEL_DEADLINE_MARGIN_MS);
    registry.cancelRun(far.runId, [], now + 60_000);
    expect(far.cancelGraceMs).toBe(15_000);
    registry.cancelRun(none.runId, [], now - 5_000);
    expect(none.cancelGraceMs).toBe(500);
  });
});

describe('BullMQ + pub/sub con Redis real', () => {
  it('consume run-shards con concurrencia 1 y payload mínimo', async (ctx) => {
    if (!available) ctx.skip();
    const queueName = `run-shards-${randomUUID().slice(0, 8)}`;
    const queue = new Queue(queueName, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }), prefix: PREFIX });
    const seen: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    const worker = startQueueWorker({
      redisUrl: REDIS_URL,
      prefix: PREFIX,
      queueName,
      concurrency: 1,
      logger: silentLogger(),
      handler: async (data) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(data);
        await new Promise((r) => setTimeout(r, 100));
        active -= 1;
        return 'ok';
      },
    });
    const jobs = [0, 1, 2].map(() => ({ runId: randomUUID(), shardId: randomUUID() }));
    for (const j of jobs) await queue.add('shard', j);
    const end = Date.now() + 15_000;
    while (seen.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    await worker.close();
    await queue.close();
    expect(seen).toEqual(jobs);
    expect(maxActive).toBe(1);
  });

  it('cancel/revoke en <prefijo>:runs:control detienen solo los shards indicados', async (ctx) => {
    if (!available) ctx.skip();
    const channel = `${PREFIX}-${randomUUID().slice(0, 6)}:runs:control`;
    const registry = new CancelRegistry(1000);
    const runId = randomUUID();
    const entry = registry.register(runId, randomUUID(), randomUUID());
    const other = registry.register(randomUUID(), randomUUID(), randomUUID());
    const sub = new CancelSubscriber(REDIS_URL, channel, registry, silentLogger());
    await sub.start();
    const revoked = registry.register(other.runId, randomUUID(), randomUUID());
    const pub = new Redis(REDIS_URL);
    const now = new Date().toISOString();
    await pub.publish(channel, JSON.stringify({ type: 'cancel', runId, shardIds: [], leaseIds: [], reason: 'cancelado_por_usuario', requestedAt: now, deadlineAt: now }));
    await pub.publish(channel, JSON.stringify({ type: 'revoke', runId: other.runId, shardIds: [], leaseIds: [revoked.leaseId], reason: 'lease_vencido', requestedAt: now, deadlineAt: now }));
    const end = Date.now() + 5_000;
    while ((!entry.cancelled || !revoked.leaseLost) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await sub.stop();
    pub.disconnect();
    expect(entry.cancelled).toBe(true);
    expect(other.cancelled).toBe(false);
    expect(other.leaseLost).toBe(false);
    expect(revoked.leaseLost).toBe(true);
  });
});
