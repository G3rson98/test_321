/**
 * Integración local END-TO-END sin Docker ni internet (launcher `process`):
 * ShardProcessor (claim → secreto en tmpfs 0600 → checkout local + revalidación de manifiesto) → proceso ejecutor
 * real (src/main.executor.ts) → `playwright test` del proyecto de fixtures con Chromium real → reporter de Katalyst
 * por IPC → API de worker FALSA por HTTP. Verifica resultados, intentos, evidencia sanitizada, fin de shard,
 * limpieza y cancelación < 30 s del árbol de procesos.
 * RF-AMB-03, RF-EJE-03, RF-EJE-05, RF-EJE-08, RF-RES-01/02, RNF-CON-01/03, RNF-SEG-01/02, ESP §13.3, §13.7.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CANCEL_DEADLINE_MS, CHROMIUM_NO_THROTTLE_FLAGS, manifestHash, ManifestSchema, type AssignedTest } from '@katalyst/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/clock.js';
import { EnvSecretProvider } from '../../src/secrets/secret-provider.js';
import { CancelRegistry } from '../../src/supervisor/cancel-registry.js';
import { IsolatedDependencyInstaller } from '../../src/supervisor/dependency-installer.js';
import { LocalDirCheckout } from '../../src/supervisor/git-checkout.js';
import { ProcessExecutorLauncher } from '../../src/supervisor/launcher/process-launcher.js';
import { ShardProcessor } from '../../src/supervisor/shard-processor.js';
import { readZip } from '../../src/executor/artifacts/zip.js';
import { pathExists } from '../../src/util/fs.js';
import { Semaphore } from '../../src/util/semaphore.js';
import { HttpSupervisorApiClient, HttpWorkerApiClient } from '../../src/worker-api/http.js';
import type { RunnerShardAssignment } from '../../src/worker-api/types.js';
import { startAppServer } from '../helpers/app-server.js';
import { startFakeApiServer, type FakeApiServer } from '../helpers/fake-api-server.js';
import { silentLogger } from '../helpers/logger.js';
import { createLogger } from '../../src/logger.js';

const log = () => (process.env.DEBUG_E2E ? createLogger({ name: 'e2e', level: 'debug', destination: process.stderr as never }) : silentLogger());

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'pw-project');
const USER = { username: 'qa.e2e', password: 'Clave-E2E-Secreta-77' };
const KEY = (n: number) => `0f6c2a51-6f0e-4d0a-9c11-00000000000${n}`;
const CANARY = 'KATALYST_CANARY_TOKEN_e2e';

let app: Awaited<ReturnType<typeof startAppServer>>;
let base: string;
let hash: string;

beforeAll(async () => {
  app = await startAppServer(USER);
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ke2e-'));
  hash = manifestHash(ManifestSchema.parse(JSON.parse(await fs.readFile(path.join(FIXTURE, 'katalyst.manifest.json'), 'utf8'))));
  await fs.rm(path.join(FIXTURE, 'test-results'), { recursive: true, force: true });
});
afterAll(async () => {
  await app.close();
});

function test_(n: number, over: Partial<AssignedTest> = {}): AssignedTest {
  return {
    runResultId: randomUUID(),
    stableKey: KEY(n),
    file: 'tests/basic.spec.ts',
    title: `C${n}`,
    parameterKey: 'default',
    classification: 'lectura',
    retries: 0,
    writeIdempotencyApproved: false,
    nextAttemptNo: 1,
    nextAttemptKind: 'inicial',
    ...over,
  };
}

function makeAssignment(tests: AssignedTest[]): RunnerShardAssignment {
  return {
    runId: randomUUID(),
    shardId: randomUUID(),
    shardKey: 'e2e-1',
    kind: 'funcional',
    gitCommit: 'c'.repeat(40),
    manifestHash: hash,
    tests,
    environment: { appUrl: app.url, apiUrl: app.url, isProduction: false, name: 'e2e' },
    testUserRef: { testUserId: randomUUID(), username: USER.username, secretRef: 'env:KATALYST_SECRET__QA_E2E_PASSWORD', readOnly: true },
    timeouts: { testMs: 30_000, setupMs: 60_000, runMs: 600_000, runDeadlineAt: new Date(Date.now() + 600_000).toISOString() },
    artifactPolicy: {
      enabledKinds: ['reporte', 'log', 'captura'],
      screenshotsOnFailureOnly: true,
      videoOnFailureOnly: true,
      traceOnFailureOnly: true,
      maxEvidenceBytesPerRun: 250 * 1024 * 1024,
      maxTempBytesPerRun: 1024 * 1024 * 1024,
      retentionDays: 30,
      disabledReasons: {},
    },
    runtime: {
      playwrightVersion: '1.65.0',
      image: 'local-process',
      imageDigest: null,
      browserConcurrency: 1,
      chromiumFlags: [...CHROMIUM_NO_THROTTLE_FLAGS],
    },
  };
}

function processor(server: FakeApiServer, registry: CancelRegistry, dirs: { shards: string; runs: string }) {
  const launcher = new ProcessExecutorLauncher({ logger: log() });
  return new ShardProcessor({
    supervisorId: 'e2e-host',
    workerApiUrl: server.url,
    shardSecretsDir: dirs.shards,
    runsDir: dirs.runs,
    logLevel: 'info',
    api: new HttpSupervisorApiClient({ baseUrl: server.url, token: () => server.serviceToken }),
    createLeaseApi: (t) => new HttpWorkerApiClient({ baseUrl: server.url, token: () => t, backoffBaseMs: 50 }),
    secrets: new EnvSecretProvider({ KATALYST_SECRET__QA_E2E_PASSWORD: USER.password }),
    checkout: new LocalDirCheckout(FIXTURE, silentLogger()),
    installer: new IsolatedDependencyInstaller({ launcher, mode: 'never', workDir: path.join(base, 'work'), timeoutMs: 60_000, logger: silentLogger() }),
    launcher,
    registry,
    semaphore: new Semaphore(1),
    clock: systemClock,
    logger: log(),
  });
}

type Rec = Record<string, unknown>;

describe('E2E launcher process + Chromium real + API falsa', () => {
  it(
    'ejecuta el shard: pasado, fallido sanitizado, inestable, timeout, skip, variante faltante; evidencia y limpieza',
    async () => {
      const server = await startFakeApiServer();
      try {
        const tests = [test_(1), test_(2), test_(3, { retries: 1 }), test_(4), test_(5), test_(7)];
        const a = makeAssignment(tests);
        server.setAssignment(a);
        const dirs = { shards: path.join(base, 'shards'), runs: path.join(base, 'runs') };
        const outcome = await processor(server, new CancelRegistry(15_000), dirs).process({ runId: a.runId, shardId: a.shardId });
        const api = server.api;
        const results = api.ops('result') as Rec[];
        const byKey = (n: number) => results.filter((r) => r.runResultId === tests.find((t) => t.stableKey === KEY(n))!.runResultId);

        expect(outcome).toBe('completed');
        expect(server.claims).toEqual([{ runId: a.runId, shardId: a.shardId, workerId: `e2e-host/${a.shardId}` }]);
        expect(byKey(1)).toEqual([expect.objectContaining({ attemptNo: 1, attemptStatus: 'pasado', final: true, finalStatus: 'pasado' })]);
        const [c2] = byKey(2);
        expect(c2).toMatchObject({ attemptStatus: 'fallido', errorCategory: 'asercion', final: true, finalStatus: 'fallido' });
        expect(String(c2!.error)).not.toContain(CANARY);
        expect(byKey(3)).toEqual([
          expect.objectContaining({ attemptNo: 1, attemptStatus: 'fallido', errorCategory: 'asercion', final: false }),
          expect.objectContaining({ attemptNo: 2, attemptStatus: 'pasado', final: true, finalStatus: 'inestable' }),
        ]);
        expect(byKey(4)).toEqual([expect.objectContaining({ attemptStatus: 'fallido', errorCategory: 'timeout_aplicacion', finalStatus: 'fallido' })]);
        expect(byKey(5)).toEqual([expect.objectContaining({ attemptStatus: 'omitido', finalStatus: 'omitido', error: expect.stringContaining('dxmon_no_disponible') })]);
        expect(byKey(7)).toEqual([expect.objectContaining({ attemptStatus: 'omitido', finalStatus: 'bloqueado', reason: 'variante_faltante' })]);
        // C6 (no asignado) fue excluido por el reporter: ningún intento con su título/clave.
        expect((api.ops('attempt') as Rec[]).length).toBe(7);

        // Inicio de intento persistido antes del resultado de cada intento.
        for (const r of results) {
          const ai = api.calls.findIndex((c) => c.op === 'attempt' && (c.body as Rec).runResultId === r.runResultId && (c.body as Rec).attemptNo === r.attemptNo);
          const ri = api.calls.findIndex((c) => c.op === 'result' && c.body === r);
          expect(ai).toBeGreaterThanOrEqual(0);
          expect(ai).toBeLessThan(ri);
        }
        expect((api.ops('heartbeat') as Rec[])[0]).toMatchObject({ leaseId: server.leaseId, generation: 1 });

        // Evidencia: captura de la falla y reportes JSON/HTML subidos SANITIZADOS (sin canario ni contraseña).
        const arts = api.ops('artifact') as Array<{ kind: string; sanitization: { status: string } }>;
        expect(arts.filter((x) => x.kind === 'captura' && x.sanitization.status === 'sanitizado').length).toBeGreaterThanOrEqual(1);
        expect(arts.filter((x) => x.kind === 'reporte').map((x) => x.sanitization.status)).toEqual(['sanitizado', 'sanitizado']);
        expect(arts.filter((x) => x.sanitization.status !== 'sanitizado')).toEqual([]);
        expect(api.uploaded.length).toBe(api.ops('finalize').length);
        let embedded = 0;
        for (const u of api.uploaded) {
          let txt = u.content.toString('latin1');
          const b64 = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(txt)?.[1];
          if (b64) {
            embedded += 1;
            txt += readZip(Buffer.from(b64, 'base64')).map((e) => e.data.toString('utf8')).join('\n');
            expect(txt).toContain('C2 Título incorrecto');
          }
          expect(txt).not.toContain(USER.password);
          expect(txt).not.toContain(CANARY);
        }
        expect(embedded).toBe(1);
        for (const body of server.rawBodies) {
          expect(body).not.toContain(USER.password);
          expect(body).not.toContain(server.leaseToken);
        }

        const [complete] = api.ops('complete') as Rec[];
        expect(complete).toMatchObject({ shardStatus: 'completado', reason: null, leaseId: server.leaseId });
        expect(complete!.runtimeVersions).toMatchObject({ playwright: '1.65.0', node: process.versions.node });
        expect((complete!.runtimeVersions as Rec).chromium).toMatch(/^\d+\./);

        // Limpieza: secretos, storageState y temporales borrados.
        expect(await pathExists(path.join(dirs.shards, a.shardId))).toBe(false);
        expect(await pathExists(path.join(dirs.runs, a.runId, a.shardId))).toBe(false);
      } finally {
        await server.close();
      }
    },
    240_000,
  );

  it(
    'cancelación por pub/sub durante un test: árbol (incl. Chromium) detenido < 30 s, intento cancelado y shard cancelado',
    async () => {
      const server = await startFakeApiServer();
      try {
        const t6 = test_(6);
        const a = makeAssignment([t6]);
        server.setAssignment(a);
        const registry = new CancelRegistry(15_000);
        const dirs = { shards: path.join(base, 'shards-c'), runs: path.join(base, 'runs-c') };
        const run = processor(server, registry, dirs).process({ runId: a.runId, shardId: a.shardId });
        const end = Date.now() + 90_000;
        while (!(server.api.ops('attempt') as Rec[]).some((x) => x.runResultId === t6.runResultId)) {
          if (Date.now() > end) throw new Error('el test lento no inició');
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 1500));
        const t0 = Date.now();
        expect(registry.cancelRun(a.runId)).toBe(1);
        const outcome = await run;
        const elapsed = Date.now() - t0;
        expect(outcome).toBe('cancelled');
        expect(elapsed).toBeLessThan(CANCEL_DEADLINE_MS);
        const results = server.api.ops('result') as Rec[];
        expect(results).toEqual([expect.objectContaining({ runResultId: t6.runResultId, attemptStatus: 'cancelado', final: true, finalStatus: 'cancelado' })]);
        expect(server.api.ops('complete')).toEqual([expect.objectContaining({ shardStatus: 'cancelado', reason: 'cancelado_por_usuario' })]);
        // Ningún proceso (ejecutor, Playwright, Chromium) queda vivo con rutas del shard.
        const ps = execFileSync('ps', ['-A', '-o', 'command=']).toString();
        expect(ps).not.toContain(path.join(dirs.shards, a.shardId));
      } finally {
        await server.close();
      }
    },
    180_000,
  );
});
