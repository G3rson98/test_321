/**
 * Limpieza de huérfanos al arrancar, antes de aceptar trabajo (ESP §13.7, RF-AMB-03): secretos/storageState de
 * shards sin ejecutor vivo, temporales de corridas, checkouts a medio preparar o viejos; ejecutores vivos se
 * retoman (docker) y los muertos se eliminan.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecutorHandle, ExecutorLauncher, RunningExecutor } from '../src/supervisor/launcher/types.js';
import { cleanupOrphans } from '../src/supervisor/orphan-cleanup.js';
import { pathExists } from '../src/util/fs.js';
import { silentLogger } from './helpers/logger.js';

function fakeLauncher(executors: RunningExecutor[]) {
  const destroyed: string[] = [];
  const launcher: ExecutorLauncher = {
    kind: 'docker',
    launch: async () => {
      throw new Error('no');
    },
    runIsolated: async () => ({ exitCode: 0, timedOut: false, outputTail: '' }),
    listExecutors: async () => executors,
    adopt: (e) =>
      e.running
        ? ({ id: e.id, runId: e.runId, shardId: e.shardId, exited: new Promise(() => undefined), stop: async () => undefined, onLog: () => undefined } as ExecutorHandle)
        : null,
    destroy: async (e) => void destroyed.push(e.id),
  };
  return { launcher, destroyed };
}

describe('cleanupOrphans (ESP §13.7)', () => {
  it('borra secretos/storageState y temporales sin ejecutor vivo; retoma los vivos', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'korph-'));
    const shards = path.join(base, 'shards');
    const runs = path.join(base, 'runs');
    const checkouts = path.join(base, 'checkouts');
    const live = { run: randomUUID(), shard: randomUUID() };
    const dead = { run: randomUUID(), shard: randomUUID() };
    for (const s of [live, dead]) {
      await fs.mkdir(path.join(shards, s.shard, 'secrets'), { recursive: true });
      await fs.writeFile(path.join(shards, s.shard, 'secrets', 'test-user.json'), '{"username":"u","password":"p"}');
      await fs.mkdir(path.join(shards, s.shard, 'state'), { recursive: true });
      await fs.writeFile(path.join(shards, s.shard, 'state', 'storageState.json'), '{}');
      await fs.mkdir(path.join(runs, s.run, s.shard), { recursive: true });
      await fs.writeFile(path.join(runs, s.run, s.shard, 'raw.png'), 'x');
    }
    const orphanShard = randomUUID();
    await fs.mkdir(path.join(shards, orphanShard, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(checkouts, `.tmp-${'a'.repeat(12)}-x`), { recursive: true });
    const old = path.join(checkouts, 'c'.repeat(40));
    const fresh = path.join(checkouts, 'd'.repeat(40));
    await fs.mkdir(old, { recursive: true });
    await fs.mkdir(fresh, { recursive: true });
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await fs.utimes(old, longAgo, longAgo);
    const work = path.join(base, 'work');
    await fs.mkdir(path.join(work, 'listing-x'), { recursive: true });

    const { launcher, destroyed } = fakeLauncher([
      { id: 'c-live', runId: live.run, shardId: live.shard, running: true },
      { id: 'c-dead', runId: dead.run, shardId: dead.shard, running: false },
    ]);
    const r = await cleanupOrphans({ launcher, shardSecretsDir: shards, runsDir: runs, checkoutsDir: checkouts, checkoutMaxAgeDays: 14, workDir: work, logger: silentLogger() });
    expect(r.adopted.map((h) => h.id)).toEqual(['c-live']);
    expect(destroyed).toEqual(['c-dead']);
    expect(await pathExists(path.join(shards, live.shard, 'secrets', 'test-user.json'))).toBe(true);
    expect(await pathExists(path.join(shards, dead.shard))).toBe(false);
    expect(await pathExists(path.join(shards, orphanShard))).toBe(false);
    expect(await pathExists(path.join(runs, live.run, live.shard))).toBe(true);
    expect(await pathExists(path.join(runs, dead.run))).toBe(false);
    expect(await pathExists(old)).toBe(false);
    expect(await pathExists(fresh)).toBe(true);
    expect(await pathExists(path.join(checkouts, `.tmp-${'a'.repeat(12)}-x`))).toBe(false);
    expect(await pathExists(work)).toBe(false);
  });
});
