/**
 * ShardExecutor con Playwright simulado: timeout de corrida ⇒ interrumpido; 409 en heartbeat ⇒ detener sin
 * cerrar el shard; login fallido ⇒ tests bloqueados `login_fallido` y shard completado; producción con escritura ⇒
 * bloqueado; storageState y credencial borrados en `finally`. RF-AMB-03, RF-EJE-06, RNF-CON-01, ESP §13.3.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manifestHash, ManifestSchema } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../src/clock.js';
import { loadExecutorConfig } from '../src/config.js';
import type { PlaywrightRunSpec } from '../src/executor/playwright-process.js';
import { EXIT, ShardExecutor, type PlaywrightLike } from '../src/executor/shard-executor.js';
import type { ReporterMessage, ReporterPlan } from '../src/reporter/protocol.js';
import type { LeaseFile } from '../src/shard-files.js';
import { pathExists } from '../src/util/fs.js';
import type { RunnerShardAssignment } from '../src/worker-api/types.js';
import { assignedTest, assignment } from './helpers/assignment.js';
import { FakeWorkerApi } from './helpers/fake-api.js';
import { silentLogger } from './helpers/logger.js';

const KEY_R = '55555555-5555-4555-8555-555555555551';
const KEY_W = '55555555-5555-4555-8555-555555555552';
const manifest = ManifestSchema.parse({
  schemaVersion: 1,
  tests: [
    { stableKey: KEY_R, file: 'tests/a.spec.ts', title: 'C1 a', cases: ['C1'], tags: [], classification: 'lectura', owner: 'qa' },
    { stableKey: KEY_W, file: 'tests/b.spec.ts', title: 'C2 b', cases: ['C2'], tags: ['@escritura'], classification: 'escritura', owner: 'qa' },
  ],
});

type Script = (spec: PlaywrightRunSpec, plan: ReporterPlan, ctl: { exit: (code: number) => void; stopped: () => boolean }) => Promise<void>;

async function setup(over: Partial<RunnerShardAssignment>, script: Script, api = new FakeWorkerApi()) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kexec-'));
  const dirs = { secrets: path.join(base, 'secrets'), state: path.join(base, 'state'), tests: path.join(base, 'tests'), out: path.join(base, 'out') };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(dirs.tests, 'katalyst.manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dirs.state, 'storageState.json'), '{"cookies":[]}');
  const a = assignment(over.tests ?? [assignedTest(KEY_R)], { manifestHash: manifestHash(manifest), ...over });
  const lease: LeaseFile = {
    schemaVersion: 1,
    runId: a.runId,
    shardId: a.shardId,
    leaseId: '66666666-6666-4666-8666-666666666666',
    generation: 1,
    leaseToken: 'L'.repeat(48),
    leaseExpiresAt: new Date().toISOString(),
    heartbeatIntervalMs: 15_000,
    assignment: a,
    checkout: { commit: a.gitCommit, manifestHash: a.manifestHash, commitVerified: true },
  };
  await fs.writeFile(path.join(dirs.secrets, 'lease.json'), JSON.stringify(lease), { mode: 0o600 });
  await fs.writeFile(path.join(dirs.secrets, 'test-user.json'), JSON.stringify({ username: 'qa.bot', password: 'Clave-Exec-1' }), { mode: 0o600 });
  const config = loadExecutorConfig({
    KATALYST_WORKER_API_URL: 'http://127.0.0.1:9',
    KATALYST_SECRETS_DIR: dirs.secrets,
    KATALYST_STATE_DIR: dirs.state,
    KATALYST_TESTS_DIR: dirs.tests,
    KATALYST_OUTPUT_DIR: dirs.out,
    KATALYST_PLAYWRIGHT_STOP_GRACE_MS: '500',
  });
  const spawned: PlaywrightRunSpec[] = [];
  const executor = new ShardExecutor({
    config,
    createApi: () => api,
    clock: systemClock,
    logger: silentLogger(),
    resolvePlaywright: () => ({ cliPath: '/fake/cli.js', version: '1.65.0', chromiumVersion: '158.0.0' }),
    spawnPlaywright: (spec) => {
      spawned.push(spec);
      let resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
      let stopped = false;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (resolveExit = r));
      const proc: PlaywrightLike = {
        start: () => {
          void (async () => {
            const plan = JSON.parse(await fs.readFile(String(spec.env.KATALYST_REPORTER_PLAN_FILE), 'utf8')) as ReporterPlan;
            await script(spec, plan, { exit: (c) => resolveExit({ code: c, signal: null }), stopped: () => stopped });
          })();
        },
        exited,
        stop: async () => {
          stopped = true;
          resolveExit({ code: null, signal: 'SIGKILL' });
          return [];
        },
      };
      return proc;
    },
  });
  return { executor, api, dirs, a, spawned };
}

const key = (k: string) => `${k}::default`;
const begin = (k: string, isSetup = false): ReporterMessage => ({
  type: 'testBegin', key: isSetup ? null : key(k), testId: `t-${k}`, title: 't', projectName: isSetup ? 'setup' : 'staging', isSetup, retry: 0, startTime: new Date().toISOString(),
});
const end = (k: string, status: 'passed' | 'failed', isSetup = false, errors: Array<{ message: string }> = []): ReporterMessage => ({
  type: 'testEnd', key: isSetup ? null : key(k), testId: `t-${k}`, title: 't', projectName: isSetup ? 'setup' : 'staging', isSetup, retry: 0, retries: 0,
  status, expectedStatus: 'passed', startTime: new Date().toISOString(), duration: 5, timeoutMs: 1000, errors, annotations: [], attachments: [], willRetry: false,
});
const planMsg = (keys: string[]): ReporterMessage => ({ type: 'plan', found: keys.map((k) => ({ key: key(k), testId: `t-${k}`, title: 't', file: 'f', line: 1, projectName: 'staging', retries: 0 })), missing: [], unmapped: [], duplicates: [], missingChromiumFlags: [] });

describe('ShardExecutor', () => {
  it('flujo normal: resultado, complete con versiones y borrado de storageState/credencial', async () => {
    const { executor, api, dirs, spawned } = await setup({}, async (spec, plan, ctl) => {
      await spec.onMessage(planMsg(plan.tests.map((t) => t.stableKey)));
      await spec.onMessage(begin(KEY_R));
      await spec.onMessage(end(KEY_R, 'passed'));
      ctl.exit(0);
    });
    expect(await executor.run()).toBe(EXIT.ok);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['--workers=1', '--retries=0', '--project=staging', '--timeout=120000']));
    expect(JSON.stringify(spawned[0]!.args)).not.toContain('Clave-Exec-1');
    expect(spawned[0]!.env.KATALYST_TEST_USER_FILE).toBe(path.join(dirs.secrets, 'test-user.json'));
    expect(api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'completado', runtimeVersions: expect.objectContaining({ playwright: '1.65.0', chromium: '158.0.0' }) })]);
    expect(await pathExists(path.join(dirs.state, 'storageState.json'))).toBe(false);
    expect(await pathExists(path.join(dirs.secrets, 'test-user.json'))).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dirs.out, 'executor-complete.json'), 'utf8'))).toMatchObject({ shardStatus: 'completado', delivered: true });
  });

  it('timeout de corrida ⇒ detener Playwright, test en curso error_infraestructura/timeout_corrida, shard interrumpido', async () => {
    const { executor, api } = await setup({ timeouts: { testMs: 120_000, setupMs: 120_000, runMs: 300, runDeadlineAt: new Date(Date.now() + 60_000).toISOString() } }, async (spec, plan) => {
      await spec.onMessage(planMsg(plan.tests.map((t) => t.stableKey)));
      await spec.onMessage(begin(KEY_R));
      // nunca termina
    });
    expect(await executor.run()).toBe(EXIT.interrupted);
    expect(api.ops('result')).toEqual([expect.objectContaining({ attemptStatus: 'error_infraestructura', errorCategory: 'timeout_corrida', final: true })]);
    expect(api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'interrumpido', reason: 'timeout_corrida' })]);
  });

  it('409 LEASE_STALE en heartbeat ⇒ detener sin más callbacks ni fin de shard', async () => {
    const api = new FakeWorkerApi();
    api.currentGeneration = 2;
    const { executor } = await setup({}, async (spec, plan) => {
      await spec.onMessage(planMsg(plan.tests.map((t) => t.stableKey)));
      await new Promise((r) => setTimeout(r, 2000));
    }, api);
    expect(await executor.run()).toBe(EXIT.leaseLost);
    expect(api.ops('complete')).toEqual([]);
    expect(api.ops('result')).toEqual([]);
  });

  it('login fallido en `setup` ⇒ tests bloqueados login_fallido (informado aparte) y shard completado', async () => {
    const { executor, api } = await setup({}, async (spec, plan, ctl) => {
      await spec.onMessage(planMsg(plan.tests.map((t) => t.stableKey)));
      await spec.onMessage(begin('setup', true));
      await spec.onMessage(end('setup', 'failed', true, [{ message: '[auth_desafio_mfa] El usuario requiere MFA' }]));
      ctl.exit(1);
    });
    expect(await executor.run()).toBe(EXIT.ok);
    expect(api.ops('result')).toEqual([expect.objectContaining({ attemptStatus: 'omitido', finalStatus: 'bloqueado', reason: 'login_fallido', errorCategory: 'login', error: expect.stringContaining('auth_desafio_mfa') })]);
    expect(api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'completado', reason: 'login_fallido' })]);
  });

  it('producción: test de escritura bloqueado en el worker aunque llegue asignado (doble control)', async () => {
    const { executor, api, spawned } = await setup(
      {
        environment: { appUrl: 'https://x.test', apiUrl: 'https://x.test', isProduction: true, name: 'prod' },
        tests: [assignedTest(KEY_W, { classification: 'escritura' })],
      },
      async (_s, _p, ctl) => ctl.exit(0),
    );
    expect(await executor.run()).toBe(EXIT.ok);
    expect(spawned).toHaveLength(0);
    expect(api.ops('result')).toEqual([expect.objectContaining({ finalStatus: 'bloqueado', reason: 'escritura_en_produccion' })]);
  });

  it('cancelRequested vía heartbeat ⇒ shard cancelado y test en curso cancelado', async () => {
    const api = new FakeWorkerApi();
    const { executor } = await setup({}, async (spec, plan) => {
      await spec.onMessage(planMsg(plan.tests.map((t) => t.stableKey)));
      await spec.onMessage(begin(KEY_R));
      api.cancelRequested = true;
      await (executor as unknown as { heartbeat: { beat(): Promise<void> } }).heartbeat.beat();
    }, api);
    expect(await executor.run()).toBe(EXIT.ok);
    expect(api.ops('result')).toEqual([expect.objectContaining({ attemptStatus: 'cancelado', finalStatus: 'cancelado' })]);
    expect(api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'cancelado', reason: 'cancelado_por_usuario' })]);
  });

  it('manifiesto con hash distinto ⇒ interrumpido sin lanzar Playwright', async () => {
    const { executor, api, spawned } = await setup({ manifestHash: 'd'.repeat(64) }, async (_s, _p, ctl) => ctl.exit(0));
    expect(await executor.run()).toBe(EXIT.interrupted);
    expect(spawned).toHaveLength(0);
    expect(api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'interrumpido', reason: 'manifiesto_invalido' })]);
  });
});
