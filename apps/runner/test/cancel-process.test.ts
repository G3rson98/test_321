/**
 * Cancelación < 30 s con proceso hijo REAL (launcher `process`): SIGTERM con motivo en control.json, gracia y
 * SIGKILL de todo el árbol, incluido un nieto en su propio grupo de procesos (como Chromium). Entorno mínimo sin
 * credenciales del supervisor. RF-EJE-03, ESP §13.3, RNF-SEG-01.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CANCEL_DEADLINE_MS } from '@katalyst/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CancelRegistry } from '../src/supervisor/cancel-registry.js';
import { ProcessExecutorLauncher } from '../src/supervisor/launcher/process-launcher.js';
import { isAlive } from '../src/util/process-tree.js';
import { silentLogger } from './helpers/logger.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');
const cleanup: number[] = [];
afterEach(() => {
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ya terminó
    }
  }
});

async function waitFor<T>(fn: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function launch(mode: 'stubborn' | 'cooperative') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kcancel-'));
  const shardId = randomUUID();
  const runId = randomUUID();
  const shardDir = path.join(base, 'shards', shardId);
  const secretsDir = path.join(shardDir, 'secrets');
  const outputDir = path.join(base, 'runs', runId, shardId);
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  process.env.KATALYST_TEST_SUPERVISOR_SECRET = 'no-debe-heredarse';
  const launcher = new ProcessExecutorLauncher({
    logger: silentLogger(),
    entry: { command: process.execPath, args: [FIXTURE] },
    extraEnv: { FAKE_MODE: mode },
  });
  const handle = await launcher.launch({
    runId,
    shardId,
    leaseId: randomUUID(),
    shardDir,
    secretsDir,
    checkoutRoot: base,
    testsSubdir: '',
    outputDir,
    workerApiUrl: 'http://127.0.0.1:9',
    logLevel: 'silent',
  });
  const pids = await waitFor(async () => JSON.parse(await fs.readFile(path.join(outputDir, 'pids.json'), 'utf8')) as { self: number; grandchild: number; worker: number });
  cleanup.push(pids.self, pids.grandchild, pids.worker);
  return { handle, pids, outputDir, runId, shardId };
}

describe('Cancelación del árbol de procesos (RF-EJE-03, ESP §13.3)', () => {
  it('ejecutor que ignora SIGTERM: SIGKILL del árbol completo tras la gracia, total < 30 s', async () => {
    const { handle, pids, outputDir, runId, shardId } = await launch('stubborn');
    const registry = new CancelRegistry(2_000);
    const entry = registry.register(runId, shardId, randomUUID());
    entry.attach(handle);
    expect(registry.list()[0]).toMatchObject({ runId, shardId, executorId: `pid:${pids.self}`, phase: 'ejecutando' });
    const t0 = Date.now();
    expect(registry.cancelRun(runId)).toBe(1);
    expect(registry.cancelRun(runId)).toBe(1); // idempotente
    await entry.stopPromise;
    await handle.exited;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(CANCEL_DEADLINE_MS);
    for (const pid of [pids.self, pids.grandchild, pids.worker]) expect(isAlive(pid)).toBe(false);
    const sig = JSON.parse(await fs.readFile(path.join(outputDir, 'sigterm.json'), 'utf8')) as { stop: string; env: string[] };
    expect(sig.stop).toBe('cancel');
    // Entorno mínimo: no hereda variables del supervisor.
    expect(sig.env).not.toContain('KATALYST_TEST_SUPERVISOR_SECRET');
    expect(sig.env).toContain('KATALYST_WORKER_API_URL');
  });

  it('ejecutor cooperativo: termina al recibir SIGTERM con motivo `cancel` (sin esperar la gracia)', async () => {
    const { handle, pids } = await launch('cooperative');
    const t0 = Date.now();
    await handle.stop('cancel', 20_000);
    const exit = await handle.exited;
    expect(exit.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(isAlive(pids.self)).toBe(false);
  });

  it('cancelación recibida antes del claim se aplica al registrar el shard', () => {
    const registry = new CancelRegistry(1000);
    const runId = randomUUID();
    registry.cancelRun(runId);
    const e = registry.register(runId, randomUUID(), randomUUID());
    expect(e.cancelled).toBe(true);
    expect(e.signal.aborted).toBe(true);
  });
});
