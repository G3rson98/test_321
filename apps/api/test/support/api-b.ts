/**
 * Fixtures sintéticos de API-B (ejecución, worker, programación, artefactos). Sin datos reales ni secretos.
 * BD propia `katalyst_test_api_b` y Redis índice 2 (docs/fase2-coordinacion.md) cuando se ejecutan aisladas.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { manifestHash, type Classification, type ManifestInput, ManifestSchema } from '@katalyst/shared';
import { FsArtifactStore } from '../../src/adapters/artifact-store/index.js';
import { setRunsTestDoubles } from '../../src/modules/runs/deps.js';
import { setScheduleTriggersEnabled } from '../../src/modules/schedules/triggers.js';
import type { RunControlMessage } from '../../src/services/cancellation.js';
import { createLogger } from '../../src/logger.js';
import { apiTokenFor, createUser, makeCtx, serviceTokenFor, type TestCtx } from './api-a.js';

export const silent = createLogger({ level: 'silent', service: 'test-api-b' });

/** Vacía todas las tablas (BD de pruebas; los archivos de prueba corren en serie). */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}

export interface TestSpec {
  key: string;
  classification?: Classification;
  cases: string[];
  tags?: string[];
  params?: string[];
  status?: 'aprobado' | 'retirado' | 'borrador';
  writeIdempotencyApproved?: boolean;
  review?: 'vigente' | 'requiere_revision';
}

export interface Seed {
  connectionId: string;
  suiteId: string;
  sectionId: string;
  revisionId: string;
  cases: Record<string, { id: string; trCaseId: number }>;
  tests: Record<string, { id: string; stableKey: string }>;
}

/** Catálogo consistente: conexión/suite/sección TestRail, casos, revisión completa con manifiesto y vínculos. */
export async function seedCatalog(prisma: PrismaClient, caseKeys: string[], tests: TestSpec[]): Promise<Seed> {
  const conn = await prisma.testRailConnection.create({
    data: {
      baseUrl: 'https://example.testrail.io',
      username: 'svc@example.test',
      secretRef: 'env:KATALYST_SECRET__TR',
      projectExternalId: 1,
    },
  });
  const project = await prisma.testRailProject.create({
    data: { connectionId: conn.id, externalId: randomInt(1, 1_000_000), name: 'Proyecto' },
  });
  const suite = await prisma.testRailSuite.create({
    data: { connectionId: conn.id, projectId: project.id, externalId: randomInt(1, 1_000_000), name: 'Suite FMS' },
  });
  const section = await prisma.testRailSection.create({
    data: { connectionId: conn.id, suiteId: suite.id, trSectionId: randomInt(1, 1_000_000), name: 'Órdenes' },
  });
  const cases: Seed['cases'] = {};
  for (const k of caseKeys) {
    const trCaseId = randomInt(100_000, 9_000_000);
    const c = await prisma.testRailCase.create({
      data: {
        connectionId: conn.id,
        trCaseId,
        sectionId: section.id,
        suiteId: suite.id,
        title: `Caso ${k}`,
        contentHash: 'a'.repeat(64),
        syncedAt: new Date(),
      },
    });
    cases[k] = { id: c.id, trCaseId };
  }
  const manifestTests = tests.map((t) => ({
    stableKey: randomUUID(),
    file: `tests/${t.key}.spec.ts`,
    title: `${t.cases.map((c) => `C${cases[c]!.trCaseId}`).join(' ')} Test ${t.key}`,
    cases: t.cases.map((c) => `C${cases[c]!.trCaseId}`),
    tags: t.tags ?? [],
    classification: t.classification ?? 'lectura',
    parameterKeys: t.params ?? ['default'],
    writeIdempotencyApproved: t.writeIdempotencyApproved ?? false,
    owner: 'qa-automation',
    status: (t.status === 'retirado' ? 'retirado' : 'aprobado') as 'aprobado' | 'retirado',
  }));
  const manifest = ManifestSchema.parse({ schemaVersion: 1, tests: manifestTests } satisfies ManifestInput);
  const gitCommit = randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40);
  const rev = await prisma.catalogRevision.create({
    data: {
      status: 'completa',
      gitCommit,
      manifestHash: manifestHash(manifest),
      manifest: manifest as never,
      testCount: tests.length,
      finishedAt: new Date(),
    },
  });
  const testIds: Seed['tests'] = {};
  for (const [i, t] of tests.entries()) {
    const m = manifestTests[i]!;
    const row = await prisma.automatedTest.create({
      data: {
        stableKey: m.stableKey,
        filePath: m.file,
        title: m.title,
        tags: [...m.tags, ...(m.classification === 'escritura' ? ['@escritura'] : [])],
        classification: m.classification,
        status: t.status ?? 'aprobado',
        parameterKeys: m.parameterKeys,
        writeIdempotencyApproved: m.writeIdempotencyApproved,
        catalogRevisionId: rev.id,
        manifestCommit: gitCommit,
      },
    });
    for (const c of t.cases) {
      await prisma.testCaseLink.create({
        data: { automatedTestId: row.id, caseId: cases[c]!.id, reviewStatus: t.review ?? 'vigente', reviewedCaseRevision: 1 },
      });
    }
    testIds[t.key] = { id: row.id, stableKey: m.stableKey };
  }
  return { connectionId: conn.id, suiteId: suite.id, sectionId: section.id, revisionId: rev.id, cases, tests: testIds };
}

export async function createEnv(
  prisma: PrismaClient,
  opts: { production?: boolean; userReadOnly?: boolean | null; maxConcurrency?: number; artifactPolicy?: unknown } = {},
) {
  const env = await prisma.environment.create({
    data: {
      name: `${opts.production ? 'produccion' : 'staging'}-${randomUUID().slice(0, 6)}`,
      appUrl: 'https://app.example.test',
      apiUrl: 'https://api.example.test',
      isProduction: opts.production ?? false,
      maxConcurrency: opts.maxConcurrency ?? 1,
      allowedHosts: [],
      artifactPolicy: (opts.artifactPolicy ?? {}) as never,
    },
  });
  let user = null;
  if (opts.userReadOnly !== null) {
    user = await prisma.testUser.create({
      data: {
        environmentId: env.id,
        label: 'qa-auto',
        username: 'qa.auto@example.test',
        secretRef: 'env:KATALYST_SECRET__TEST_USER',
        readOnly: opts.userReadOnly ?? true,
      },
    });
  }
  return { env, user };
}

export interface ApiBCtx extends TestCtx {
  qa: { authorization: string; userId: string };
  admin: { authorization: string; userId: string };
  service: { authorization: string };
  store: FsArtifactStore;
  controlMessages: RunControlMessage[];
}

export async function makeApiBCtx(overrides: Record<string, string> = {}): Promise<ApiBCtx> {
  setScheduleTriggersEnabled(false);
  const dir = mkdtempSync(join(tmpdir(), 'katalyst-artifacts-'));
  const store = new FsArtifactStore({
    rootDir: dir,
    publicBaseUrl: 'http://reports.example.test',
    signingSecret: 'clave-de-firma-de-pruebas-0123456789',
  });
  const controlMessages: RunControlMessage[] = [];
  setRunsTestDoubles({ store, control: async (m) => void controlMessages.push(m) });
  const ctx = await makeCtx({ QUEUE_PREFIX: `katalyst-test-runs-${process.pid}`, ...overrides });
  await resetDb(ctx.prisma);
  const qaUser = await createUser(ctx.prisma, 'qa');
  const adminUser = await createUser(ctx.prisma, 'admin');
  const all = ['runs.read', 'runs.create', 'runs.cancel', 'artifacts.read', 'schedules.read', 'schedules.write', 'catalog.read', 'exclusion_windows.write', 'testrail.read', 'alerts.read'];
  const qa = await apiTokenFor(ctx.prisma, qaUser.id, all);
  const admin = await apiTokenFor(ctx.prisma, adminUser.id, all);
  const service = await serviceTokenFor(ctx.prisma);
  return {
    ...ctx,
    qa: { authorization: qa.authorization, userId: qaUser.id },
    admin: { authorization: admin.authorization, userId: adminUser.id },
    service,
    store,
    controlMessages,
  };
}

export function idemKey(): string {
  return `test-${randomUUID()}`;
}

/** Simulación de ejecutor contra la API real (claim con token de servicio, callbacks con token de lease). */
export class FakeWorker {
  leaseId = '';
  generation = 0;
  token = '';
  assignment!: {
    runId: string;
    shardId: string;
    tests: { runResultId: string; stableKey: string; nextAttemptNo: number; nextAttemptKind: string; classification: string }[];
  };

  constructor(
    private readonly ctx: ApiBCtx,
    readonly workerId = `host-1/${randomUUID().slice(0, 6)}`,
  ) {}

  async claim(runId: string, shardId: string) {
    const res = await this.ctx.app.inject({
      method: 'POST',
      url: '/api/v1/worker/claim',
      headers: { authorization: this.ctx.service.authorization },
      payload: { runId, shardId, workerId: this.workerId },
    });
    if (res.statusCode === 200) {
      const b = res.json();
      this.leaseId = b.leaseId;
      this.generation = b.generation;
      this.token = b.leaseToken;
      this.assignment = b.assignment;
    }
    return res;
  }

  private post(path: string, body: Record<string, unknown>) {
    return this.ctx.app.inject({
      method: 'POST',
      url: `/api/v1/worker/${path}`,
      headers: { authorization: `Bearer ${this.token}` },
      payload: { leaseId: this.leaseId, generation: this.generation, ...body },
    });
  }

  heartbeat() {
    return this.post('heartbeat', {});
  }

  start(runResultId: string, attemptNo = 1, kind = 'inicial') {
    return this.post('attempts', { runResultId, attemptNo, kind, startedAt: new Date().toISOString() });
  }

  result(
    runResultId: string,
    attemptNo: number,
    status: 'pasado' | 'fallido' | 'error_infraestructura' | 'omitido' | 'cancelado',
    opts: { final?: boolean; errorCategory?: string | null; error?: string | null; durationMs?: number } = {},
  ) {
    return this.post('results', {
      runResultId,
      attemptNo,
      attemptStatus: status,
      finishedAt: new Date().toISOString(),
      durationMs: opts.durationMs ?? 1500,
      errorCategory: opts.errorCategory ?? (status === 'fallido' ? 'asercion' : null),
      error: opts.error ?? (status === 'fallido' ? 'expect(locator).toBeVisible() falló' : null),
      final: opts.final ?? status === 'pasado',
    });
  }

  complete(shardStatus: 'completado' | 'cancelado' | 'interrumpido' = 'completado', reason: string | null = null) {
    return this.post('complete', { shardStatus, reason, runtimeVersions: { playwright: '1.65.0' } });
  }

  upload(body: Record<string, unknown>) {
    return this.post('artifacts/upload', body);
  }

  finalize(artifactId: string, body: Record<string, unknown>) {
    return this.post(`artifacts/${artifactId}/finalize`, body);
  }
}

export async function shardsOf(prisma: PrismaClient, runId: string) {
  return prisma.runShard.findMany({ where: { runId }, orderBy: { shardKey: 'asc' } });
}
