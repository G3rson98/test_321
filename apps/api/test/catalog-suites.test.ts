/**
 * Catálogo y suites (RF-CAT-01..05, RF-TR-03, RF-TR-07, RF-RES-03, ESP §4, §13.1): refresco sin ejecutar tests en el
 * backend (encola `catalog-listing` con el SHA de la rama protegida resuelto en servidor), ingesta validada con
 * revisión consistente, identidad por stableKey tras renombrado, tests retirados, revisión fallida sin cambios,
 * revisión de vínculos, flaky score, filtros de /tests y CRUD de suites con selector validado; matriz de roles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import type { TestRailCase } from '@prisma/client';
import { LocalGitRepoReader, setGitRepoReader, GitHubRepoReader, GitLabRepoReader, getGitRepoReader } from '../src/adapters/git/index.js';
import { HttpGuard } from '../src/lib/http-guard.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import {
  bullmqCatalogEnqueuer,
  closeCatalogQueue,
  ingestCatalogListing,
  recomputeFlakyForRun,
  recomputeFlakyScores,
  recomputeRecentFlakyScores,
  setCatalogListingEnqueuer,
} from '../src/modules/catalog/service.js';
import { applyCatalogListing, MAX_LISTING_BYTES } from '../src/modules/catalog/listing.js';
import { resolveSuiteSelector } from '../src/modules/suites/service.js';
import { syncNow } from '../src/modules/testrail/sync.js';
import { actorMatrix, loginAs, makeCtx, type TestCtx } from './support/api-a.js';
import { createConnection, makeWorld, syncDeps } from './support/testrail-fixture.js';

let ctx: TestCtx;
let dev: Record<string, string>;
let qa: Record<string, string>;
let cases: TestRailCase[];
const SHA = 'e'.repeat(40);
const enqueued: { catalogRevisionId: string; gitCommit: string }[] = [];

beforeAll(async () => {
  ctx = await makeCtx();
  dev = (await loginAs(ctx, 'dev')).headers;
  qa = (await loginAs(ctx, 'qa')).headers;
  const repo = await mkdtemp(join(tmpdir(), 'kat-bare-'));
  await mkdir(join(repo, 'refs', 'heads'), { recursive: true });
  await writeFile(join(repo, 'refs', 'heads', 'main'), `${SHA}\n`);
  setGitRepoReader(new LocalGitRepoReader(repo, 'main'));
  setCatalogListingEnqueuer(async (p) => void enqueued.push(p));
  // Cerrar revisiones en curso de ejecuciones anteriores.
  await ctx.prisma.catalogRevision.updateMany({ where: { status: 'en_curso' }, data: { status: 'fallida', finishedAt: new Date() } });
  const w = makeWorld();
  const conn = await createConnection(ctx.prisma, w.projectId);
  await syncNow(syncDeps(ctx.prisma, w.fake), { trigger: 'manual', actor: 'system', connectionId: conn.id });
  cases = await ctx.prisma.testRailCase.findMany({ where: { connectionId: conn.id }, orderBy: { trCaseId: 'asc' } });
});
afterAll(async () => {
  setGitRepoReader(undefined);
  setCatalogListingEnqueuer(undefined);
  await closeCatalogQueue();
  await ctx.close();
});

function manifestFor(tests: { key: string; file: string; title: string; cases: string[]; tags: string[]; classification?: string; status?: string }[]) {
  return {
    manifest: {
      schemaVersion: 1,
      tests: tests.map((t) => ({
        stableKey: t.key,
        file: t.file,
        title: t.title,
        cases: t.cases,
        tags: t.tags,
        classification: t.classification ?? 'lectura',
        owner: 'qa-automation',
        ...(t.status ? { status: t.status } : {}),
      })),
    },
    playwrightList: {
      suites: tests.map((t) => ({
        title: t.file,
        file: t.file,
        specs: [{ title: t.title, file: t.file, tags: (t.title.match(/@[\w-]+/g) ?? []).map((x) => x.slice(1)), tests: [{ projectName: 'staging' }] }],
      })),
    },
  };
}

async function refresh(): Promise<string> {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/tests/refresh', headers: dev, payload: {} });
  expect(r.statusCode).toBe(202);
  return r.json().id;
}

describe('refresco del catálogo (RF-CAT-01, RF-CAT-05)', () => {
  const k1 = randomUUID();
  const k2 = randomUUID();
  const sfx = k2.slice(0, 8);
  let t1Id: string;

  it('RF-CAT-01 POST /tests/refresh resuelve el SHA en servidor, encola el listado aislado y bloquea concurrentes', async () => {
    const id = await refresh();
    expect(enqueued.at(-1)).toEqual({ catalogRevisionId: id, gitCommit: SHA });
    const rev = await ctx.prisma.catalogRevision.findUniqueOrThrow({ where: { id } });
    expect(rev).toMatchObject({ status: 'en_curso', gitCommit: SHA });
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/tests/refresh', headers: dev, payload: {} });
    expect(dup.statusCode).toBe(409);
    // Body con refs arbitrarias rechazado (esquema estricto).
    const refs = await ctx.app.inject({ method: 'POST', url: '/api/v1/tests/refresh', headers: dev, payload: { ref: 'refs/heads/otra' } });
    expect(refs.statusCode).toBe(422);
    const m = manifestFor([
      { key: k1, file: 'tests/oc/abrir.spec.ts', title: `C${cases[0]!.trCaseId} C${cases[1]!.trCaseId} Abrir OC @oc @humo`, cases: [`C${cases[0]!.trCaseId}`, `C${cases[1]!.trCaseId}`], tags: ['@oc', '@humo'] },
      { key: k2, file: `tests/agendamiento/lista-${sfx}.spec.ts`, title: `C${cases[3]!.trCaseId} Lista @agendamiento @escritura`, cases: [`C${cases[3]!.trCaseId}`], tags: ['@agendamiento'], classification: 'escritura' },
    ]);
    const res = await ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id, gitCommit: SHA, error: null, ...m });
    expect(res).toEqual({ ok: true, status: 'completa' });
    const done = await ctx.prisma.catalogRevision.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: 'completa', testCount: 2 });
    expect(done.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    const t1 = await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k1 }, include: { links: true } });
    t1Id = t1.id;
    expect(t1).toMatchObject({ status: 'aprobado', classification: 'lectura', manifestCommit: SHA });
    expect(t1.links).toHaveLength(2);
    const t2 = await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k2 } });
    expect(t2.tags).toEqual(['@agendamiento', '@escritura']);
    // Repetición del callback: acuse idempotente.
    expect(await ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id, gitCommit: SHA, error: null, ...m })).toEqual({ ok: true, status: 'completa' });
  });

  it('RF-CAT-05 renombrar mantiene identidad; quitar del manifiesto retira; vínculos se ajustan', async () => {
    const id = await refresh();
    const m = manifestFor([
      { key: k1, file: 'tests/oc/abrir-renombrado.spec.ts', title: `C${cases[0]!.trCaseId} Abrir órdenes (renombrado) @oc`, cases: [`C${cases[0]!.trCaseId}`], tags: ['@oc'] },
    ]);
    await ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id, gitCommit: SHA, error: null, ...m });
    const t1 = await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k1 }, include: { links: true } });
    expect(t1.id).toBe(t1Id);
    expect(t1).toMatchObject({ filePath: 'tests/oc/abrir-renombrado.spec.ts', catalogRevisionId: id });
    expect(t1.links.map((l) => l.caseId)).toEqual([cases[0]!.id]);
    expect((await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k2 } })).status).toBe('retirado');
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?q=renombrado`, headers: qa });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([t1Id]);
    const retired = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?status=retirado&q=lista-${sfx}`, headers: qa });
    expect(retired.json().items).toHaveLength(1);
  });

  it('RF-CAT-01 manifiesto inválido (caso inventado) o error del runner → revisión fallida sin tocar el catálogo', async () => {
    const before = await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k1 } });
    const id = await refresh();
    const m = manifestFor([{ key: k1, file: 'tests/oc/x.spec.ts', title: 'C999999999 Inventado @oc', cases: ['C999999999'], tags: ['@oc'] }]);
    expect((await ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id, gitCommit: SHA, error: null, ...m })).status).toBe('fallida');
    const rev = await ctx.app.inject({ method: 'GET', url: `/api/v1/catalog/revisions/${id}`, headers: qa });
    expect(rev.json().errors.map((e: { code: string }) => e.code)).toContain('UNKNOWN_CASE');
    const after = await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { stableKey: k1 } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const id2 = await refresh();
    await expect(ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id2, gitCommit: 'f'.repeat(40), error: null, manifest: null, playwrightList: null })).rejects.toMatchObject({ code: 'CONFLICT' });
    const r = await ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: id2, gitCommit: SHA, error: 'commit_no_disponible: token=secretisimo123456789', manifest: null, playwrightList: null });
    expect(r.status).toBe('fallida');
    const rev2 = await ctx.prisma.catalogRevision.findUniqueOrThrow({ where: { id: id2 } });
    expect(JSON.stringify(rev2.errors)).not.toContain('secretisimo');
    await expect(ingestCatalogListing(ctx.prisma, 'system', { catalogRevisionId: randomUUID(), gitCommit: SHA, error: null, manifest: null, playwrightList: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const revs = await ctx.app.inject({ method: 'GET', url: '/api/v1/catalog/revisions?limit=2', headers: qa });
    expect(revs.json().items).toHaveLength(2);
  });

  it('RF-CAT-01 POST /worker/catalog/listing: solo el supervisor entrega el listado; se aplica y repetir es idempotente', async () => {
    const id = await refresh();
    const m = manifestFor([
      { key: k1, file: 'tests/oc/abrir-renombrado.spec.ts', title: `C${cases[0]!.trCaseId} Abrir órdenes (renombrado) @oc`, cases: [`C${cases[0]!.trCaseId}`], tags: ['@oc'] },
    ]);
    const payload = { catalogRevisionId: id, gitCommit: SHA, error: null, ...m };
    const actors = await actorMatrix(ctx);
    for (const [actor, status] of Object.entries({ dev: 403, admin: 403, anonimo: 401 })) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/worker/catalog/listing', headers: actors[actor as keyof typeof actors], payload });
      expect(r.statusCode, actor).toBe(status);
    }
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/worker/catalog/listing', headers: actors.servicio, payload: { ...payload, gitCommit: 'x' } });
    expect(bad.statusCode).toBe(422);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/worker/catalog/listing', headers: actors.servicio, payload });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true, status: 'completa' });
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/worker/catalog/listing', headers: actors.servicio, payload });
    expect(again.json()).toEqual({ ok: true, status: 'completa' });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'catalog.refresh' }, orderBy: { createdAt: 'desc' } });
    expect(audit.actorKind).toBe('servicio');
    // Llamada directa con principal no-servicio (defensa en profundidad) y cuerpo inválido.
    await expect(applyCatalogListing(ctx.prisma, payload, { kind: 'panel_user', id: randomUUID(), role: 'admin', email: 'a@b.test', sessionId: 's' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(applyCatalogListing(ctx.prisma, { nada: 1 }, { kind: 'service', id: randomUUID(), scopes: ['worker.claim'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('RF-CAT-01 listado que excede el tamaño máximo se registra como revisión fallida', async () => {
    const id = await refresh();
    const huge = { suites: [{ title: 'x'.repeat(MAX_LISTING_BYTES + 1), specs: [] }] };
    const r = await applyCatalogListing(ctx.prisma, { catalogRevisionId: id, gitCommit: SHA, error: null, manifest: null, playwrightList: huge }, { kind: 'service', id: randomUUID(), scopes: ['worker.claim'] });
    expect(r.status).toBe('fallida');
    const rev = await ctx.prisma.catalogRevision.findUniqueOrThrow({ where: { id } });
    expect(JSON.stringify(rev.errors)).toContain('LISTADO_FALLIDO');
  });

  it('RF-TR-07 revisión de vínculo: requiere la revisión vigente del caso; dev sí, qa no; auditada', async () => {
    const link = await ctx.prisma.testCaseLink.findFirstOrThrow({ where: { automatedTestId: t1Id } });
    await ctx.prisma.testCaseLink.update({ where: { id: link.id }, data: { reviewStatus: 'requiere_revision' } });
    await ctx.prisma.testRailCase.update({ where: { id: link.caseId }, data: { revision: 2 } });
    const url = `/api/v1/tests/${t1Id}/case-links/${link.caseId}/review`;
    expect((await ctx.app.inject({ method: 'PUT', url, headers: qa, payload: { caseRevision: 2 } })).statusCode).toBe(403);
    const old = await ctx.app.inject({ method: 'PUT', url, headers: dev, payload: { caseRevision: 1 } });
    expect(old.json().error.code).toBe('VERSION_CONFLICT');
    const ok = await ctx.app.inject({ method: 'PUT', url, headers: dev, payload: { caseRevision: 2, comment: 'Pasos revisados' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ reviewStatus: 'vigente', reviewedCaseRevision: 2, currentCaseRevision: 2 });
    expect(ok.json().reviewedBy).not.toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { entityId: link.id, action: 'test_case_link.review' } })).toBe(1);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/v1/tests/${t1Id}/case-links/${randomUUID()}/review`, headers: dev, payload: { caseRevision: 1 } })).statusCode).toBe(404);
  });

  it('RF-CAT-04 flaky score: ≥10 observaciones y ≥0,20 inestables; filtros de /tests e historial', async () => {
    const env = await ctx.prisma.environment.create({ data: { name: `f-${randomUUID().slice(0, 6)}`, appUrl: 'https://a.example.test', apiUrl: 'https://b.example.test', isProduction: false, allowedHosts: [] } });
    for (let i = 0; i < 12; i++) {
      const run = await ctx.prisma.run.create({
        data: {
          trigger: 'manual',
          environmentId: env.id,
          status: 'terminada',
          selectionSnapshot: {},
          manifestHash: 'a'.repeat(64),
          gitCommit: SHA,
          finishedAt: new Date(Date.now() - (12 - i) * 60_000),
        },
      });
      await ctx.prisma.runResult.create({
        data: { runId: run.id, automatedTestId: t1Id, status: i % 4 === 0 ? 'inestable' : 'pasado', durationMs: 1000 + i, retryCount: i % 4 === 0 ? 1 : 0 },
      });
    }
    await recomputeFlakyScores(ctx.prisma, [t1Id]);
    // Recalculo por corrida (finalización) y red de seguridad horaria.
    const lastRun = await ctx.prisma.runResult.findFirstOrThrow({ where: { automatedTestId: t1Id }, orderBy: { createdAt: 'desc' } });
    await ctx.prisma.automatedTest.update({ where: { id: t1Id }, data: { flakyScore: null, flakyDenominator: 0, flakyNumerator: 0 } });
    expect(await recomputeFlakyForRun(ctx.prisma, lastRun.runId)).toBe(1);
    expect((await ctx.prisma.automatedTest.findUniqueOrThrow({ where: { id: t1Id } })).flakyDenominator).toBe(12);
    expect(await recomputeRecentFlakyScores(ctx.prisma, new Date(Date.now() - 3600_000))).toBeGreaterThanOrEqual(1);
    const t = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests/${t1Id}`, headers: qa });
    expect(t.json().flaky).toMatchObject({ numerator: 3, denominator: 12, isFlaky: true });
    expect(t.json().lastResult.status).toBe('pasado');
    const flaky = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?flaky=true&q=renombrado`, headers: qa });
    expect(flaky.json().items).toHaveLength(1);
    const notFlaky = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?flaky=false&q=renombrado`, headers: qa });
    expect(notFlaky.json().items).toHaveLength(0);
    const h = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests/${t1Id}/history?limit=5&environmentId=${env.id}`, headers: qa });
    expect(h.json()).toMatchObject({ hasNext: true, trend: { successRate: 1, observations: 12 }, flaky: { isFlaky: true, environmentId: env.id } });
    expect(h.json().items).toHaveLength(5);
    const byCase = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?case=C${cases[0]!.trCaseId}`, headers: qa });
    expect(byCase.json().items.map((i: { id: string }) => i.id)).toContain(t1Id);
    const byTag = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?tag=@oc&classification=lectura&lastResult=pasado&q=renombrado`, headers: qa });
    expect(byTag.json().items).toHaveLength(1);
    const bySection = await ctx.app.inject({ method: 'GET', url: `/api/v1/tests?section=${cases[0]!.sectionId}&caseId=${cases[0]!.id}`, headers: qa });
    expect(bySection.json().items).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/tests/${randomUUID()}`, headers: qa })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/tests/${randomUUID()}/history`, headers: qa })).statusCode).toBe(404);
  });

  it('RNF-SEG-03 matriz /tests/refresh: solo dev/admin; servicio y qa no', async () => {
    const m = await actorMatrix(ctx);
    for (const [actor, status] of Object.entries({ qa: 403, servicio: 403, anonimo: 401 })) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/tests/refresh', headers: m[actor as keyof typeof m], payload: {} });
      expect(r.statusCode, actor).toBe(status);
    }
    setGitRepoReader(null);
    const none = await ctx.app.inject({ method: 'POST', url: '/api/v1/tests/refresh', headers: m.admin, payload: {} });
    expect(none.json().error.code).toBe('GIT_PROVIDER_UNAVAILABLE');
  });
});

describe('adaptadores Git y cola (RF-CAT-01)', () => {
  it('RF-CAT-01 local con packed-refs; GitHub/GitLab vía API con host fijo; fábrica según configuración', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kat-packed-'));
    await writeFile(join(repo, 'packed-refs'), `# pack-refs\n${'1'.repeat(40)} refs/heads/release/v1\n`);
    expect(await new LocalGitRepoReader(repo, 'release/v1').resolveProtectedCommit()).toBe('1'.repeat(40));
    await expect(new LocalGitRepoReader(repo, 'main').resolveProtectedCommit()).rejects.toMatchObject({ code: 'COMMIT_UNAVAILABLE' });
    expect(() => new LocalGitRepoReader(repo, '../etc')).toThrow();
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      if (req.url?.startsWith('/repos/o/r/commits/main')) return res.end(JSON.stringify({ sha: '2'.repeat(40) }));
      if (req.url?.startsWith('/projects/g%2Fr/repository/branches/main')) return res.end(JSON.stringify({ commit: { id: '3'.repeat(40) }, protected: true }));
      return res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const http = new HttpGuard({ policy: { allowedHosts: [], allowLoopback: true, allowedSchemes: ['http'] } });
    expect(await new GitHubRepoReader({ apiBaseUrl: base, repository: 'o/r', branch: 'main', token: async () => 't', http }).resolveProtectedCommit()).toBe('2'.repeat(40));
    await expect(new GitHubRepoReader({ apiBaseUrl: base, repository: 'o/x', branch: 'main', token: async () => null, http }).resolveProtectedCommit()).rejects.toMatchObject({ code: 'COMMIT_UNAVAILABLE' });
    expect(await new GitLabRepoReader({ apiBaseUrl: base, repository: 'g/r', branch: 'main', token: async () => 't', http }).resolveProtectedCommit()).toBe('3'.repeat(40));
    await expect(new GitLabRepoReader({ apiBaseUrl: base, repository: 'g/x', branch: 'main', token: async () => null, http }).resolveProtectedCommit()).rejects.toMatchObject({ code: 'COMMIT_UNAVAILABLE' });
    srv.close();
    setGitRepoReader(undefined);
    const secrets = new MemorySecretProvider();
    expect(getGitRepoReader(ctx.config, secrets)).toBeNull();
    expect(getGitRepoReader({ ...ctx.config, GIT_PROVIDER: 'local', GIT_LOCAL_REPO_PATH: repo }, secrets)?.provider).toBe('local');
    expect(getGitRepoReader({ ...ctx.config, GIT_PROVIDER: 'github', GIT_REPOSITORY: 'o/r' }, secrets)?.provider).toBe('github');
    expect(getGitRepoReader({ ...ctx.config, GIT_PROVIDER: 'gitlab', GIT_BASE_URL: 'https://gitlab.example.test/api/v4', GIT_REPOSITORY: 'g/r' }, secrets)?.provider).toBe('gitlab');
  });

  it('RF-CAT-01 encolador BullMQ real: trabajo `catalog-listing` con jobId = revisión y payload mínimo', async () => {
    const config = { ...ctx.config, QUEUE_PREFIX: `katalyst-test-api-a-${randomUUID().slice(0, 6)}` };
    const id = randomUUID();
    await bullmqCatalogEnqueuer(config)({ catalogRevisionId: id, gitCommit: SHA });
    const u = new URL(config.REDIS_URL);
    const connection = { host: u.hostname, port: Number(u.port || 6379), db: Number(u.pathname.slice(1) || 0) };
    const q = new Queue(config.CATALOG_LISTING_QUEUE, { connection, prefix: config.QUEUE_PREFIX });
    const job = await q.getJob(id);
    expect(job?.data).toEqual({ catalogRevisionId: id, gitCommit: SHA });
    await q.obliterate({ force: true });
    await q.close();
    await closeCatalogQueue();
  });
});

describe('suites (RF-CAT-03)', () => {
  it('RF-CAT-03 CRUD con selector validado (casos/etiquetas/secciones), conteos resueltos, versión y borrado lógico', async () => {
    const tag = `@suite-${randomUUID().slice(0, 6)}`;
    const sectionId = cases[0]!.sectionId;
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/suites', headers: qa, payload: { name: 'X', selector: { caseIds: [randomUUID()] } } });
    expect(bad.json().error.code).toBe('SELECTION_FOREIGN_IDS');
    const empty = await ctx.app.inject({ method: 'POST', url: '/api/v1/suites', headers: qa, payload: { name: 'X', selector: {} } });
    expect(empty.statusCode).toBe(422);
    const badSection = await ctx.app.inject({ method: 'POST', url: '/api/v1/suites', headers: qa, payload: { name: 'X', selector: { sectionIds: [randomUUID()] } } });
    expect(badSection.json().error.code).toBe('SELECTION_FOREIGN_IDS');
    const c = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/suites',
      headers: qa,
      payload: { name: 'Humo diario', description: 'Casos críticos', selector: { sectionIds: [sectionId], tags: [tag] } },
    });
    expect(c.statusCode).toBe(201);
    const s = c.json();
    expect(s.resolved.cases).toBeGreaterThanOrEqual(3); // sección raíz incluye descendientes
    expect(s.version).toBe(0);
    const up = await ctx.app.inject({ method: 'PUT', url: `/api/v1/suites/${s.id}`, headers: qa, payload: { name: 'Humo diario v2', selector: { caseIds: [cases[0]!.id], excludeFlaky: true }, version: 0 } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: 'Humo diario v2', version: 1, resolved: { cases: 1, tests: 0 } });
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/v1/suites/${s.id}`, headers: qa, payload: { name: 'x', selector: { tags: [tag] }, version: 0 } });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const r = await resolveSuiteSelector(ctx.prisma, { caseIds: [cases[0]!.id], excludeFlaky: true });
    expect(r.excludedFlakyTestIds.length).toBeGreaterThanOrEqual(1); // el test flaky del caso queda excluido
    const r2 = await resolveSuiteSelector(ctx.prisma, { tags: ['@oc'] });
    expect(r2.testIds.length).toBeGreaterThan(0);
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/suites?q=${encodeURIComponent('Humo diario v2')}`, headers: qa });
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(s.id);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/suites/${s.id}`, headers: qa });
    expect(del.json().deletedAt).not.toBeNull();
    const g = await ctx.app.inject({ method: 'GET', url: `/api/v1/suites/${s.id}`, headers: qa });
    expect(g.json().deletedAt).not.toBeNull();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/suites/${s.id}`, headers: qa })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/v1/suites/${s.id}`, headers: qa, payload: { name: 'x', selector: { tags: [tag] }, version: 2 } })).statusCode).toBe(404);
    const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: s.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['suite.create', 'suite.update', 'suite.delete']);
    const archived = await ctx.prisma.testRailCase.update({ where: { id: cases[4]!.id }, data: { archivedAt: new Date() } });
    const arch = await ctx.app.inject({ method: 'POST', url: '/api/v1/suites', headers: qa, payload: { name: 'A', selector: { caseIds: [archived.id] } } });
    expect(arch.json().error.code).toBe('CASE_ARCHIVED');
    const m = await actorMatrix(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/suites', headers: m.servicio })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/suites', headers: m.anonimo })).statusCode).toBe(401);
  });
});
