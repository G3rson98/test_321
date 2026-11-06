/**
 * Integración RUNNER ↔ API REAL (apps/api en proceso, Fastify escuchando en loopback) con PostgreSQL
 * `katalyst_test_runner` migrada y Redis índice 4 (docs/fase2-coordinacion.md):
 * POST /runs → outbox `run.dispatch_shard` → `dispatchPendingDeliveries` → BullMQ `run-shards` (job `shard`
 * {runId, shardId}) → worker BullMQ del supervisor → ShardProcessor (claim con credencial `ksv_`) → ejecutor real
 * (launcher `process`) → Playwright + Chromium contra la página HTML local → callbacks HTTP con `kls_` → corrida
 * `terminada` con outcome y resultados persistidos. Variante: cancelación por `POST /runs/:id/cancel` → pub/sub
 * `<QUEUE_PREFIX>:runs:control` → árbol detenido y `complete cancelado` < 30 s.
 * Contrato final D-049. RF-AMB-03, RF-EJE-03, RF-EJE-05, RF-EJE-08, RNF-CON-01, RNF-SEG-05.
 *
 * Se omite (skip con motivo) si PostgreSQL o Redis no están disponibles. Los módulos de apps/api se importan
 * dinámicamente (sin acoplar el typecheck del runner al de la API).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { CANCEL_DEADLINE_MS, ManifestSchema, manifestHash } from '@katalyst/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/clock.js';
import { EnvSecretProvider } from '../../src/secrets/secret-provider.js';
import { CancelRegistry } from '../../src/supervisor/cancel-registry.js';
import { IsolatedDependencyInstaller } from '../../src/supervisor/dependency-installer.js';
import { LocalDirCheckout } from '../../src/supervisor/git-checkout.js';
import { ProcessExecutorLauncher } from '../../src/supervisor/launcher/process-launcher.js';
import { CancelSubscriber, startQueueWorker } from '../../src/supervisor/queue.js';
import { ShardProcessor, type ShardJobOutcome } from '../../src/supervisor/shard-processor.js';
import { Semaphore } from '../../src/util/semaphore.js';
import { HttpSupervisorApiClient, HttpWorkerApiClient } from '../../src/worker-api/http.js';
import { startAppServer } from '../helpers/app-server.js';
import { silentLogger } from '../helpers/logger.js';
import { createLogger } from '../../src/logger.js';

const log = () => (process.env.DEBUG_INT ? createLogger({ name: 'int', level: 'debug', destination: process.stderr as never }) : silentLogger());

const API_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'api');
const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'pw-project');
const DATABASE_URL = process.env.RUNNER_TEST_DATABASE_URL ?? 'postgresql://katalyst:katalyst_dev@localhost:5432/katalyst_test_runner';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/4';
const PREFIX = `katalyst-test-runner-${process.pid}`;
const USER = { username: 'qa.integracion', password: 'Clave-Integracion-Secreta-91' };
const SECRET_REF = 'env:KATALYST_SECRET__QA_INTEGRACION';

// La API lee su configuración de process.env (antes de importar sus módulos).
Object.assign(process.env, { DATABASE_URL, TEST_DATABASE_URL: DATABASE_URL, REDIS_URL, COOKIE_SECURE: 'false', QUEUE_PREFIX: PREFIX });

/* Formas mínimas de los módulos de la API usados (import dinámico): el JSON y los modelos son de forma libre. */
interface Inject {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (o: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<{ statusCode: number; json(): any }>;
}
interface Prisma {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [model: string]: any;
  $disconnect(): Promise<void>;
}
interface ApiCtx {
  app: { inject: Inject; listen(o: { port: number; host: string }): Promise<string>; close(): Promise<void> };
  prisma: Prisma;
  redis: Redis;
  config: { QUEUE_PREFIX: string; REDIS_URL: string };
  qa: { authorization: string };
  service: { authorization: string };
  close(): Promise<void>;
}

async function reachable(): Promise<string | null> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
  } catch {
    return 'Redis no disponible en ' + REDIS_URL;
  } finally {
    r.disconnect();
  }
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: API_DIR, env: { ...process.env, DATABASE_URL }, stdio: 'pipe', timeout: 120_000 });
  } catch (e) {
    return `PostgreSQL ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')} no disponible o sin migrar: ${(e as Error).message.slice(0, 200)}`;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const apiImport = <T>(rel: string): Promise<T> => import(pathToFileURL(path.join(API_DIR, rel)).href) as Promise<T>;

let skipReason: string | null = null;
let ctx: ApiCtx;
let apiUrl = '';
let reports: { close(): Promise<void> } | null = null;
let appServer: Awaited<ReturnType<typeof startAppServer>>;
let shardWorker: Worker | null = null;
let cancelSub: CancelSubscriber | null = null;
let registry: CancelRegistry;
let dispatch: () => Promise<{ delivered: number }>;
let closeQueue: () => Promise<void> = async () => undefined;
let finalizeDueRuns: (p: Prisma, now: Date, publicBaseUrl: string) => Promise<string[]>;
const outcomes: ShardJobOutcome[] = [];
let base = '';
const KEYS: Record<string, string> = {};
const CASES: Record<string, string> = {};
let envId = '';

beforeAll(async () => {
  skipReason = await reachable();
  if (skipReason) return;
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'kint-'));
  appServer = await startAppServer(USER);

  const supportB = await apiImport<{ makeApiBCtx(o?: Record<string, string>): Promise<ApiCtx> }>('test/support/api-b.ts');
  const { FsArtifactStore } = await apiImport<{ FsArtifactStore: new (o: object) => object }>('src/adapters/artifact-store/fs.ts');
  const { setRunsTestDoubles } = await apiImport<{ setRunsTestDoubles(o: object): void }>('src/modules/runs/deps.ts');
  const { redisControlPublisher } = await apiImport<{ redisControlPublisher(r: Redis, p: string): unknown }>('src/services/cancellation.ts');
  const { buildReportsApp } = await apiImport<{ buildReportsApp(c: object, d: object): ApiCtx['app'] }>('src/main.reports.ts');
  const dispatcher = await apiImport<{
    createShardQueue(c: unknown, prefix: string): { close(): Promise<void> };
    bullConnectionFromUrl(u: string): unknown;
    dispatchPendingDeliveries(p: Prisma, q: unknown): Promise<{ delivered: number }>;
  }>('src/control/dispatcher.ts');

  ({ finalizeDueRuns } = await apiImport<{ finalizeDueRuns: typeof finalizeDueRuns }>('src/services/results.ts'));
  ctx = await supportB.makeApiBCtx({ QUEUE_PREFIX: PREFIX, REDIS_URL, DATABASE_URL });
  // Almacén fs con URLs firmadas atendidas por el visor real (`/_store/*` de main.reports.ts).
  const reportsPort = await freePort();
  const store = new FsArtifactStore({
    rootDir: path.join(base, 'store'),
    publicBaseUrl: `http://127.0.0.1:${reportsPort}`,
    signingSecret: 'clave-de-firma-integracion-runner-0123',
  });
  setRunsTestDoubles({ store, control: redisControlPublisher(ctx.redis, PREFIX) });
  const reportsApp = buildReportsApp(ctx.config, { redis: ctx.redis, store });
  await reportsApp.listen({ port: reportsPort, host: '127.0.0.1' });
  reports = reportsApp;
  apiUrl = await ctx.app.listen({ port: 0, host: '127.0.0.1' });

  const queue = dispatcher.createShardQueue(dispatcher.bullConnectionFromUrl(REDIS_URL), PREFIX);
  dispatch = () => dispatcher.dispatchPendingDeliveries(ctx.prisma, queue);
  closeQueue = () => queue.close();

  await seedFixtureCatalog();

  // Supervisor: worker BullMQ `run-shards` + suscriptor del canal de control (launcher `process`).
  const serviceToken = ctx.service.authorization.replace(/^Bearer /, '');
  registry = new CancelRegistry(10_000);
  const launcher = new ProcessExecutorLauncher({ logger: log() });
  const processor = new ShardProcessor({
    supervisorId: 'int-host',
    workerApiUrl: apiUrl,
    shardSecretsDir: path.join(base, 'shards'),
    runsDir: path.join(base, 'runs'),
    logLevel: 'info',
    api: new HttpSupervisorApiClient({ baseUrl: apiUrl, token: () => serviceToken }),
    createLeaseApi: (t) => new HttpWorkerApiClient({ baseUrl: apiUrl, token: () => t, backoffBaseMs: 50 }),
    secrets: new EnvSecretProvider({ KATALYST_SECRET__QA_INTEGRACION: USER.password }),
    checkout: new LocalDirCheckout(FIXTURE, silentLogger()),
    installer: new IsolatedDependencyInstaller({ launcher, mode: 'never', workDir: path.join(base, 'work'), timeoutMs: 60_000, logger: silentLogger() }),
    launcher,
    registry,
    semaphore: new Semaphore(1),
    clock: systemClock,
    logger: log(),
  });
  cancelSub = new CancelSubscriber(REDIS_URL, `${PREFIX}:runs:control`, registry, silentLogger());
  await cancelSub.start();
  shardWorker = startQueueWorker({
    redisUrl: REDIS_URL,
    prefix: PREFIX,
    queueName: 'run-shards',
    concurrency: 1,
    logger: silentLogger(),
    handler: async (data) => {
      const o = await processor.process(data);
      outcomes.push(o);
      return o;
    },
  });
}, 180_000);

afterAll(async () => {
  if (skipReason) return;
  await shardWorker?.close().catch(() => undefined);
  await cancelSub?.stop();
  await closeQueue().catch(() => undefined);
  await reports?.close().catch(() => undefined);
  await ctx?.close().catch(() => undefined);
  await appServer?.close();
  const r = new Redis(REDIS_URL);
  const keys = await r.keys(`${PREFIX}:*`);
  if (keys.length) await r.del(...keys);
  r.disconnect();
  if (base) await fs.rm(base, { recursive: true, force: true });
});

/** Catálogo con EL MISMO manifiesto del proyecto de fixtures (hash revalidado por el supervisor) y casos C1..C7. */
async function seedFixtureCatalog(): Promise<void> {
  const p = ctx.prisma;
  const manifest = ManifestSchema.parse(JSON.parse(await fs.readFile(path.join(FIXTURE, 'katalyst.manifest.json'), 'utf8')));
  const conn = await p.testRailConnection.create({
    data: { baseUrl: 'https://example.testrail.io', username: 'svc@example.test', secretRef: 'env:KATALYST_SECRET__TR', projectExternalId: 1 },
  });
  const project = await p.testRailProject.create({ data: { connectionId: conn.id, externalId: 77, name: 'Proyecto' } });
  const suite = await p.testRailSuite.create({ data: { connectionId: conn.id, projectId: project.id, externalId: 77, name: 'Suite' } });
  const section = await p.testRailSection.create({ data: { connectionId: conn.id, suiteId: suite.id, trSectionId: 77, name: 'Sección' } });
  const gitCommit = randomUUID().replace(/-/g, '').padEnd(40, 'b').slice(0, 40);
  const rev = await p.catalogRevision.create({
    data: { status: 'completa', gitCommit, manifestHash: manifestHash(manifest), manifest, testCount: manifest.tests.length, finishedAt: new Date() },
  });
  for (const t of manifest.tests) {
    const n = Number(t.cases[0]!.slice(1));
    const c = await p.testRailCase.create({
      data: { connectionId: conn.id, trCaseId: n, sectionId: section.id, suiteId: suite.id, title: `Caso C${n}`, contentHash: 'a'.repeat(64), syncedAt: new Date() },
    });
    const row = await p.automatedTest.create({
      data: {
        stableKey: t.stableKey,
        filePath: t.file,
        title: t.title,
        tags: t.tags,
        classification: t.classification,
        status: 'aprobado',
        parameterKeys: t.parameterKeys,
        writeIdempotencyApproved: t.writeIdempotencyApproved,
        catalogRevisionId: rev.id,
        manifestCommit: gitCommit,
      },
    });
    await p.testCaseLink.create({ data: { automatedTestId: row.id, caseId: c.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 } });
    KEYS[`C${n}`] = t.stableKey;
    CASES[`C${n}`] = c.id;
  }
  const env = await p.environment.create({
    data: {
      name: `integracion-${randomUUID().slice(0, 6)}`,
      appUrl: appServer.url,
      apiUrl: appServer.url,
      isProduction: false,
      maxConcurrency: 1,
      allowedHosts: [],
      artifactPolicy: {},
    },
  });
  await p.testUser.create({ data: { environmentId: env.id, label: 'qa-auto', username: USER.username, secretRef: SECRET_REF, readOnly: true } });
  envId = env.id;
}

async function createRun(cases: string[], retries = 0): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: { authorization: ctx.qa.authorization, 'idempotency-key': `int-${randomUUID()}` },
    payload: { caseIds: cases.map((c) => CASES[c]), environmentId: envId, retries },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return (res.json() as { id: string }).id;
}

async function getRun(id: string): Promise<{ status: string; outcome: string | null; reason?: string | null }> {
  return (await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${id}`, headers: { authorization: ctx.qa.authorization } })).json();
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const TERMINAL = new Set(['terminada', 'cancelada', 'interrumpida']);

describe('RUNNER ↔ API real (PostgreSQL katalyst_test_runner + Redis 4 + Chromium)', () => {
  it(
    'corrida completa: dispatch BullMQ → claim ksv_ → ejecutor → callbacks kls_ ⇒ terminada/fallido con resultados persistidos',
    async (t) => {
      if (skipReason) t.skip();
      const runId = await createRun(['C1', 'C2', 'C3'], 1);
      expect((await dispatch()).delivered).toBe(1);
      await waitFor(async () => (outcomes.length > 0 ? true : null), 150_000, 'shard procesado por el supervisor');
      const settled = await waitFor(async () => {
        const r = await getRun(runId);
        return TERMINAL.has(r.status) || r.status === 'finalizando' ? r : null;
      }, 20_000, 'corrida terminal o finalizando');
      if (settled.status === 'finalizando') {
        // [RUNNER→API-B] (docs/pendientes-integracion.md): el `/_store/*` fs del visor rechaza PUT `text/plain` y
        // `application/json` (parsers integrados de Fastify ganan al '*'), así que esos artefactos quedan
        // `pendiente`. Se simula el tick del proceso de control (`finalizeDueRuns`, plazo ≤ 60 s).
        await finalizeDueRuns(ctx.prisma, new Date(Date.now() + 61_000), 'http://panel.example.test');
      }
      const run = await waitFor(async () => {
        const r = await getRun(runId);
        return TERMINAL.has(r.status) ? r : null;
      }, 10_000, 'corrida terminal').catch(async (e) => {
        const st = await ctx.prisma.runResult.findMany({ where: { runId }, include: { attempts: true } });
        throw new Error(`${(e as Error).message}: run=${JSON.stringify(await getRun(runId))} outcomes=${outcomes} results=${JSON.stringify(st.map((r: { status: string; attempts: { status: string }[] }) => [r.status, r.attempts.map((a) => a.status)]))}`);
      });
      expect(run).toMatchObject({ status: 'terminada', outcome: 'fallido' });
      expect(outcomes.at(-1)).toBe('completed');

      const results = await ctx.prisma.runResult.findMany({ where: { runId }, include: { automatedTest: { select: { stableKey: true } }, attempts: { orderBy: { attemptNo: 'asc' } } } });
      const by = (c: string) => results.find((r: { automatedTest: { stableKey: string } }) => r.automatedTest.stableKey === KEYS[c]);
      expect(by('C1')).toMatchObject({ status: 'pasado' });
      expect(by('C1').attempts.map((a: { status: string }) => a.status)).toEqual(['pasado']);
      expect(by('C2')).toMatchObject({ status: 'fallido' });
      expect(by('C2').attempts.map((a: { status: string; errorCategory: string | null }) => [a.status, a.errorCategory])).toEqual([
        ['fallido', 'asercion'],
        ['fallido', 'asercion'],
      ]);
      expect(by('C3')).toMatchObject({ status: 'inestable', retryCount: 1 });
      expect(by('C3').attempts.map((a: { status: string; kind: string }) => [a.kind, a.status])).toEqual([
        ['inicial', 'fallido'],
        ['retry', 'pasado'],
      ]);
      // Mensaje de error sanitizado persistido (sin canario ni contraseña).
      for (const r of results) for (const a of r.attempts) expect(String(a.error ?? '')).not.toMatch(/KATALYST_CANARY_TOKEN|Clave-Integracion/);

      // Shard completado y lease liberado; evidencia registrada y finalizada en el almacén real.
      const shard = await ctx.prisma.runShard.findFirstOrThrow({ where: { runId } });
      expect(shard.status).toBe('completado');
      const leases = await ctx.prisma.workerLease.findMany({ where: { runShardId: shard.id } });
      expect(leases).toHaveLength(1);
      expect(leases[0].releasedAt).not.toBeNull();
      const artifacts = await ctx.prisma.artifact.findMany({ where: { runId } });
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      // El reporte HTML sanitizado por el runner se cargó en el almacén real y quedó finalizado.
      expect(artifacts.some((a: { kind: string; contentType: string; sanitizationStatus: string }) => a.kind === 'reporte' && a.contentType === 'text/html' && a.sanitizationStatus === 'sanitizado')).toBe(true);
      // Nada del secreto ni del lease en la BD de eventos.
      const events = JSON.stringify(await ctx.prisma.eventLog.findMany({ where: { runId } }), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
      expect(events).not.toContain(USER.password);
    },
    200_000,
  );

  it(
    'cancelación: POST /runs/:id/cancel → pub/sub runs:control → árbol detenido y complete cancelado < 30 s ⇒ cancelada',
    async (t) => {
      if (skipReason) t.skip();
      const runId = await createRun(['C6']);
      expect((await dispatch()).delivered).toBe(1);
      await waitFor(
        async () => (await ctx.prisma.testAttempt.count({ where: { runResult: { runId }, status: 'corriendo' } })) > 0,
        90_000,
        'intento C6 corriendo',
      );
      await new Promise((r) => setTimeout(r, 1000));
      const t0 = Date.now();
      const c = await ctx.app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/cancel`, headers: { authorization: ctx.qa.authorization }, payload: { reason: 'prueba integración' } });
      expect(c.statusCode).toBe(200);
      const run = await waitFor(async () => {
        const r = await getRun(runId);
        return TERMINAL.has(r.status) ? r : null;
      }, CANCEL_DEADLINE_MS + 10_000, 'corrida cancelada');
      const elapsed = Date.now() - t0;
      expect(run.status).toBe('cancelada');
      expect(elapsed).toBeLessThan(CANCEL_DEADLINE_MS);
      const shard = await ctx.prisma.runShard.findFirstOrThrow({ where: { runId } });
      expect(shard.status).toBe('cancelado');
      const rr = await ctx.prisma.runResult.findFirstOrThrow({ where: { runId }, include: { attempts: true } });
      expect(rr.status).toBe('cancelado');
      // Cancelación confirmada por el worker (no por revocación a los 30 s).
      expect(await ctx.prisma.auditLog.count({ where: { action: 'run.cancel_unconfirmed', entityId: runId } })).toBe(0);
      await waitFor(async () => (registry.size === 0 ? true : null), 10_000, 'registro vacío');
      const ps = execFileSync('ps', ['-A', '-o', 'command=']).toString();
      expect(ps).not.toContain(path.join(base, 'shards'));
    },
    150_000,
  );
});
