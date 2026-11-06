/**
 * Supervisor: claim, secreto en tmpfs 0600 (nunca argv/env), doble control de producción, revalidación de
 * manifiesto, commit inexistente ⇒ interrumpido con causa (sin sustituir), cancelación en preparación, fin de
 * shard de respaldo y limpieza. RF-AMB-03, RF-EJE-06, RF-EJE-08, RNF-SEG-01, ESP §13.1, §13.3, §13.7.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manifestHash, ManifestSchema } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../src/clock.js';
import { EnvSecretProvider } from '../src/secrets/secret-provider.js';
import { CancelRegistry } from '../src/supervisor/cancel-registry.js';
import type { DependencyInstaller } from '../src/supervisor/dependency-installer.js';
import { CommitNotAvailableError, type CheckoutResult, type GitCheckout } from '../src/supervisor/git-checkout.js';
import type { ExecutorHandle, ExecutorLaunchSpec, ExecutorLauncher } from '../src/supervisor/launcher/types.js';
import { ShardProcessor } from '../src/supervisor/shard-processor.js';
import { pathExists } from '../src/util/fs.js';
import { Semaphore } from '../src/util/semaphore.js';
import { WorkerApiError } from '../src/worker-api/errors.js';
import type { RunnerClaimResponse, RunnerShardAssignment, SupervisorApiClient } from '../src/worker-api/types.js';
import { assignedTest, assignment } from './helpers/assignment.js';
import { FakeWorkerApi } from './helpers/fake-api.js';
import { silentLogger } from './helpers/logger.js';

const PASSWORD = 'Clave-Unit-Secreta-42';
const manifest = ManifestSchema.parse({
  schemaVersion: 1,
  tests: [
    {
      stableKey: '22222222-2222-4222-8222-222222222222',
      file: 'tests/a.spec.ts',
      title: 'C1 A @humo',
      cases: ['C1'],
      tags: ['@humo'],
      classification: 'lectura',
      owner: 'qa',
    },
  ],
});

async function setup(over: Partial<RunnerShardAssignment> = {}, opts: { claimError?: Error; checkoutError?: Error; slowCheckout?: boolean } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kproc-'));
  const testsDir = path.join(base, 'checkout');
  await fs.mkdir(testsDir, { recursive: true });
  await fs.writeFile(path.join(testsDir, 'katalyst.manifest.json'), JSON.stringify(manifest));
  const a = assignment([assignedTest('22222222-2222-4222-8222-222222222222')], { manifestHash: manifestHash(manifest), ...over });
  const leaseApi = new FakeWorkerApi();
  const claim: RunnerClaimResponse = {
    leaseId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    leaseToken: 't'.repeat(48),
    leaseExpiresAt: new Date(Date.now() + 75_000).toISOString(),
    heartbeatIntervalMs: 15_000,
    assignment: a,
  };
  const api: SupervisorApiClient = {
    claim: async () => {
      if (opts.claimError) throw opts.claimError;
      return claim;
    },
    postCatalogListing: async () => ({ ok: true, status: 'ok' }),
  };
  const launched: Array<{ spec: ExecutorLaunchSpec; files: Record<string, { mode: number; content: string }> }> = [];
  const registry = new CancelRegistry(1000);
  let releaseCheckout: () => void = () => undefined;
  const checkout: GitCheckout = {
    prepare: async (commit, signal) => {
      if (opts.checkoutError) throw opts.checkoutError;
      if (opts.slowCheckout) {
        await new Promise<void>((resolve) => {
          releaseCheckout = resolve;
          signal?.addEventListener('abort', () => resolve());
        });
      }
      const r: CheckoutResult = { root: testsDir, testsSubdir: '', testsDir, commit, commitVerified: true };
      return r;
    },
  };
  const installer: DependencyInstaller = { ensure: async () => ({ playwrightVersion: '1.65.0' }) };
  let marker: object | null = { shardStatus: 'completado', reason: null, delivered: true, at: new Date().toISOString() };
  const launcher: ExecutorLauncher = {
    kind: 'process',
    launch: async (spec) => {
      const files: Record<string, { mode: number; content: string }> = {};
      for (const f of await fs.readdir(spec.secretsDir)) {
        const p = path.join(spec.secretsDir, f);
        files[f] = { mode: (await fs.stat(p)).mode & 0o777, content: await fs.readFile(p, 'utf8') };
      }
      launched.push({ spec, files });
      if (marker) await fs.writeFile(path.join(spec.outputDir, 'executor-complete.json'), JSON.stringify(marker));
      const h: ExecutorHandle = {
        id: 'pid:1',
        runId: spec.runId,
        shardId: spec.shardId,
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        stop: async () => undefined,
        onLog: () => undefined,
      };
      return h;
    },
    runIsolated: async () => ({ exitCode: 0, timedOut: false, outputTail: '' }),
    listExecutors: async () => [],
    adopt: () => null,
    destroy: async () => undefined,
  };
  const dirs = { shards: path.join(base, 'shards'), runs: path.join(base, 'runs') };
  const p = new ShardProcessor({
    supervisorId: 'host-1',
    workerApiUrl: 'http://worker-gw:8081',
    shardSecretsDir: dirs.shards,
    runsDir: dirs.runs,
    logLevel: 'silent',
    api,
    createLeaseApi: () => leaseApi,
    secrets: new EnvSecretProvider({ KATALYST_SECRET__QA_BOT_PASSWORD: PASSWORD }),
    checkout,
    installer,
    launcher,
    registry,
    semaphore: new Semaphore(1),
    clock: systemClock,
    logger: silentLogger(),
  });
  return { p, a, launched, leaseApi, registry, dirs, release: () => releaseCheckout(), setMarker: (m: object | null) => (marker = m) };
}

describe('ShardProcessor (supervisor)', () => {
  it('monta lease y credencial como archivos 0600 en el directorio de secretos del shard y limpia al terminar', async () => {
    const { p, a, launched, dirs } = await setup();
    expect(await p.process({ runId: a.runId, shardId: a.shardId })).toBe('completed');
    const [{ spec, files }] = launched as [(typeof launched)[number]];
    expect(spec.secretsDir).toBe(path.join(dirs.shards, a.shardId, 'secrets'));
    expect(files['test-user.json']).toEqual({ mode: 0o600, content: JSON.stringify({ username: 'qa.bot', password: PASSWORD }) });
    expect(files['lease.json']!.mode).toBe(0o600);
    expect(JSON.parse(files['lease.json']!.content)).toMatchObject({ leaseId: '33333333-3333-4333-8333-333333333333', checkout: { commit: a.gitCommit, commitVerified: true } });
    // Nada sensible en la especificación de lanzamiento (args/env los construye el launcher a partir de esto).
    expect(JSON.stringify(spec)).not.toContain(PASSWORD);
    expect(JSON.stringify(spec)).not.toContain('t'.repeat(48));
    expect(await pathExists(path.join(dirs.shards, a.shardId))).toBe(false);
    expect(await pathExists(path.join(dirs.runs, a.runId))).toBe(false);
  });

  it('producción con usuario sin declaración de solo lectura: NO se entrega la credencial (doble control)', async () => {
    const { p, a, launched } = await setup({
      environment: { appUrl: 'https://x.test', apiUrl: 'https://x.test', isProduction: true },
      testUserRef: { testUserId: '44444444-4444-4444-8444-444444444444', username: 'qa.bot', secretRef: 'env:KATALYST_SECRET__QA_BOT_PASSWORD', readOnly: false },
    });
    await p.process({ runId: a.runId, shardId: a.shardId });
    expect(Object.keys(launched[0]!.files)).toEqual(['lease.json']);
  });

  it('claim 409 (entrega repetida) ⇒ trabajo confirmado sin ejecutar', async () => {
    const { p, a, launched } = await setup({}, { claimError: new WorkerApiError(409, 'SHARD_NOT_CLAIMABLE', 'x', false) });
    expect(await p.process({ runId: a.runId, shardId: a.shardId })).toBe('not_claimable');
    expect(launched).toHaveLength(0);
  });

  it('error transitorio de claim se propaga (BullMQ reintenta)', async () => {
    const { p, a } = await setup({}, { claimError: new WorkerApiError(503, 'HTTP_503', 'x', true) });
    await expect(p.process({ runId: a.runId, shardId: a.shardId })).rejects.toThrow();
  });

  it('commit no disponible ⇒ shard interrumpido con causa `commit_no_disponible` (sin sustituir por la rama)', async () => {
    const { p, a, launched, leaseApi } = await setup({}, { checkoutError: new CommitNotAvailableError() });
    expect(await p.process({ runId: a.runId, shardId: a.shardId })).toBe('interrupted');
    expect(launched).toHaveLength(0);
    expect(leaseApi.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'interrumpido', reason: 'commit_no_disponible' })]);
  });

  it('hash de manifiesto distinto ⇒ interrumpido `manifiesto_invalido`', async () => {
    const { p, a, leaseApi, launched } = await setup({ manifestHash: 'e'.repeat(64) });
    expect(await p.process({ runId: a.runId, shardId: a.shardId })).toBe('interrupted');
    expect(launched).toHaveLength(0);
    expect(leaseApi.ops('complete')).toEqual([expect.objectContaining({ reason: 'manifiesto_invalido' })]);
  });

  it('cancelación durante la preparación ⇒ no se lanza el ejecutor y el shard queda cancelado', async () => {
    const { p, a, registry, launched, leaseApi } = await setup({}, { slowCheckout: true });
    const run = p.process({ runId: a.runId, shardId: a.shardId });
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.list()[0]).toMatchObject({ phase: 'preparando' });
    registry.cancelRun(a.runId);
    expect(await run).toBe('cancelled');
    expect(launched).toHaveLength(0);
    expect(leaseApi.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'cancelado', reason: 'cancelado_por_usuario' })]);
  });

  it('heartbeat de preparación con cancelRequested también cancela', async () => {
    const { p, a, leaseApi, launched } = await setup({}, { slowCheckout: true });
    leaseApi.cancelRequested = true;
    expect(await p.process({ runId: a.runId, shardId: a.shardId })).toBe('cancelled');
    expect(launched).toHaveLength(0);
  });

  it('ejecutor que muere sin cerrar el shard ⇒ fin de shard de respaldo `interrumpido/error_interno`', async () => {
    const s = await setup();
    s.setMarker(null);
    expect(await s.p.process({ runId: s.a.runId, shardId: s.a.shardId })).toBe('interrupted');
    expect(s.leaseApi.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'interrumpido', reason: 'error_interno' })]);
  });

  it('payload distinto de {runId, shardId} se rechaza', async () => {
    const { p } = await setup();
    await expect(p.process({ runId: 'x' })).rejects.toThrow();
  });
});
