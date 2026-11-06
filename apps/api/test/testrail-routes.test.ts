/**
 * Rutas TestRail y catálogo de casos (RF-TR-01, RF-TR-02, RF-TR-03, RF-TR-06, RF-CAT-02, RF-RES-03, RNF-SEG-03):
 * conexión con referencia de secreto (nunca la key), validación SSRF, prueba de conexión, sync bajo demanda (202),
 * árbol y listado con filtros de servidor (sección con descendientes, texto, ID, automatización, etiqueta, último
 * resultado, paginación), detalle con revisiones, historial y planes; matriz qa/dev/admin/servicio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTestRailClientFactory } from '../src/adapters/testrail/index.js';
import { TestRailError } from '../src/adapters/testrail/types.js';
import { actorMatrix, loginAs, makeCtx, type TestCtx } from './support/api-a.js';
import { makeWorld, type TrWorld } from './support/testrail-fixture.js';

let ctx: TestCtx;
let w: TrWorld;
let admin: Record<string, string>;
let qa: Record<string, string>;

async function waitSync(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/sync-runs/${id}`, headers: qa });
    if (r.json().status !== 'en_curso') return r.json();
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error('sync no terminó');
}

beforeAll(async () => {
  ctx = await makeCtx({ ALLOWED_TARGET_HOSTS: '*.example.test' });
  w = makeWorld();
  setTestRailClientFactory(async () => w.fake);
  admin = (await loginAs(ctx, 'admin')).headers;
  qa = (await loginAs(ctx, 'qa')).headers;
});
afterAll(async () => {
  setTestRailClientFactory(undefined);
  await ctx.close();
});

describe('conexión TestRail (RF-TR-01)', () => {
  it('RF-TR-01 PUT guarda solo referencia, valida SSRF/allowlist y referencia administrable; auditado', async () => {
    const cur = await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/connection', headers: admin });
    const version = cur.statusCode === 200 ? cur.json().version : undefined;
    const body = {
      baseUrl: 'https://tr.example.test/',
      username: 'svc@example.test',
      secretRef: 'env:KATALYST_SECRET__TESTRAIL_API_KEY',
      projectExternalId: w.projectId,
      suiteExternalIds: [],
      enabled: true,
      ...(version !== undefined ? { version } : {}),
    };
    const meta = await ctx.app.inject({ method: 'PUT', url: '/api/v1/testrail/connection', headers: admin, payload: { ...body, baseUrl: 'https://169.254.169.254/' } });
    expect(meta.statusCode).toBe(422);
    expect(meta.json().error.code).toBe('HOST_NOT_ALLOWED');
    const outside = await ctx.app.inject({ method: 'PUT', url: '/api/v1/testrail/connection', headers: admin, payload: { ...body, baseUrl: 'https://evil.example.com' } });
    expect(outside.json().error.code).toBe('HOST_NOT_ALLOWED');
    const badRef = await ctx.app.inject({ method: 'PUT', url: '/api/v1/testrail/connection', headers: admin, payload: { ...body, secretRef: 'env:DATABASE_URL' } });
    expect(badRef.json().error.code).toBe('SECRET_REF_INVALID');
    const ok = await ctx.app.inject({ method: 'PUT', url: '/api/v1/testrail/connection', headers: admin, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ baseUrl: 'https://tr.example.test', secretRef: 'env:KATALYST_SECRET__TESTRAIL_API_KEY' });
    const stale = await ctx.app.inject({ method: 'PUT', url: '/api/v1/testrail/connection', headers: admin, payload: { ...body, version: ok.json().version + 5 } });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const audit = await ctx.prisma.auditLog.findFirst({ where: { entityId: ok.json().id, action: 'testrail_connection.update' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit?.diff ?? {})).not.toMatch(/clave|apikey/i);
  });

  it('RF-TR-01 prueba de conexión: éxito con proyectos; 401 → TESTRAIL_AUTH_FAILED; candidato con host no permitido', async () => {
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/connection/test', headers: admin, payload: {} });
    expect(ok.json()).toMatchObject({ ok: true, errorCode: null, projects: [{ externalId: w.projectId }] });
    w.fake.failNext('getProjects', new TestRailError('auth', 'HTTP 401', 401));
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/connection/test', headers: admin, payload: {} });
    expect(bad.json()).toMatchObject({ ok: false, errorCode: 'TESTRAIL_AUTH_FAILED' });
    const host = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/connection/test', headers: admin, payload: { baseUrl: 'https://10.0.0.1/' } });
    expect(host.json()).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    const ref = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/connection/test', headers: admin, payload: { secretRef: 'env:PATH' } });
    expect(ref.json()).toMatchObject({ ok: false, errorCode: 'SECRET_REF_INVALID' });
    w.fake.failNext('getProjects', new TestRailError('timeout', 'timeout'));
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/connection/test', headers: admin, payload: {} })).json().errorCode).toBe('TESTRAIL_UNAVAILABLE');
  });

  it('RNF-SEG-03 matriz: conexión y sync solo admin; lectura de casos qa; servicio sin acceso', async () => {
    const m = await actorMatrix(ctx);
    const expectations: [string, string, Record<string, number>][] = [
      ['GET', '/api/v1/testrail/connection', { qa: 403, dev: 403, admin: 200, servicio: 403, anonimo: 401 }],
      ['POST', '/api/v1/testrail/sync', { qa: 403, dev: 403, servicio: 403, anonimo: 401 }],
      ['GET', '/api/v1/testrail/cases', { qa: 200, dev: 200, admin: 200, servicio: 403, anonimo: 401 }],
      ['GET', '/api/v1/testrail/sync-runs', { qa: 200, dev: 200, admin: 200, servicio: 403, anonimo: 401 }],
      ['GET', '/api/v1/integrations/testrail/deliveries', { qa: 200, dev: 200, admin: 200, servicio: 403, anonimo: 401 }],
    ];
    for (const [method, url, by] of expectations) {
      for (const [actor, status] of Object.entries(by)) {
        const r = await ctx.app.inject({ method: method as 'GET', url, headers: m[actor as keyof typeof m], ...(method === 'POST' ? { payload: {} } : {}) });
        expect(r.statusCode, `${actor} ${method} ${url}`).toBe(status);
      }
    }
  });
});

describe('sync y catálogo de casos (RF-TR-02/03, RF-CAT-02)', () => {
  let suiteA: string;
  let suiteB: string;

  it('RF-TR-02 POST /testrail/sync responde 202 y la corrida termina exitosa; segunda simultánea → 409', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/sync', headers: admin, payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('en_curso');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/testrail/sync', headers: admin, payload: {} });
    expect([409, 202]).toContain(dup.statusCode);
    const done = await waitSync(r.json().id);
    expect(done.status).toBe('exitosa');
    if (dup.statusCode === 202) await waitSync(dup.json().id);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/sync-runs?limit=1', headers: qa });
    expect(list.json().items).toHaveLength(1);
    const suites = await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/suites?limit=100', headers: qa });
    const conn = (await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/connection', headers: admin })).json();
    const local = await ctx.prisma.testRailSuite.findMany({ where: { connectionId: conn.id } });
    suiteA = local.find((s) => s.externalId === w.suiteA)!.id;
    suiteB = local.find((s) => s.externalId === w.suiteB)!.id;
    expect(suites.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/projects', headers: qa })).statusCode).toBe(200);
  });

  it('RF-CAT-02 secciones con conteos; filtro por sección incluye descendientes; texto e ID; paginación y orden', async () => {
    const secs = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/sections?suiteId=${suiteA}`, headers: qa });
    expect(secs.statusCode).toBe(200);
    const root = secs.json().items.find((s: { externalId: number }) => s.externalId === w.root);
    expect(root).toMatchObject({ caseCount: 1, depth: 0 });
    const all = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?section=${root.id}`, headers: qa });
    expect(all.json().items).toHaveLength(3);
    const only = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?section=${root.id}&includeDescendants=false`, headers: qa });
    expect(only.json().items).toHaveLength(1);
    const txt = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteA}&q=${encodeURIComponent('distribuidores')}`, headers: qa });
    expect(txt.json().items).toHaveLength(2);
    const first = all.json().items[0];
    const byId = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?q=C${first.trCaseId}`, headers: qa });
    expect(byId.json().items.map((i: { id: string }) => i.id)).toContain(first.id);
    const p1 = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteA}&limit=2&sort=-trCaseId`, headers: qa });
    const b1 = p1.json();
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0].trCaseId).toBeGreaterThan(b1.items[1].trCaseId);
    const p2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteA}&limit=2&sort=-trCaseId&cursor=${b1.nextCursor}`, headers: qa });
    expect(p2.json()).toMatchObject({ hasNext: false });
    expect(p2.json().items).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?limit=101`, headers: qa })).statusCode).toBe(422);
  });

  it('RF-TR-03 automatización, etiqueta y último resultado; detalle con revisiones y vínculos; historial', async () => {
    const list = (await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}`, headers: qa })).json().items;
    const [c1, c2] = list as { id: string; trCaseId: number }[];
    const uniqueTag = `@ag-${randomUUID().slice(0, 8)}`;
    const t = await ctx.prisma.automatedTest.create({
      data: { stableKey: randomUUID(), filePath: 'tests/agendamiento/a.spec.ts', title: `C${c1!.trCaseId} lista @agendamiento`, tags: [uniqueTag], classification: 'lectura', status: 'aprobado' },
    });
    await ctx.prisma.testCaseLink.create({ data: { automatedTestId: t.id, caseId: c1!.id, reviewStatus: 'requiere_revision', reviewedCaseRevision: 1 } });
    const auto = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}&automated=true`, headers: qa });
    expect(auto.json().items.map((i: { id: string }) => i.id)).toEqual([c1!.id]);
    expect(auto.json().items[0]).toMatchObject({ automated: true, automatedTestCount: 1, linksRequiringReview: 1, ref: `C${c1!.trCaseId}` });
    const manual = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}&automated=false`, headers: qa });
    expect(manual.json().items.map((i: { id: string }) => i.id)).toEqual([c2!.id]);
    // WEB→API-A: resumen con tags/classification/flaky agregados (sin consultar /tests por fila).
    expect(auto.json().items[0]).toMatchObject({ tags: [uniqueTag], classification: 'lectura', flaky: { score: null, numerator: 0, denominator: 0, isFlaky: false, environmentId: null } });
    expect(manual.json().items[0]).toMatchObject({ tags: [], classification: null, flaky: null });
    const t2 = await ctx.prisma.automatedTest.create({
      data: {
        stableKey: randomUUID(),
        filePath: 'tests/agendamiento/b.spec.ts',
        title: `C${c1!.trCaseId} escritura`,
        tags: ['@aa-zz', uniqueTag],
        classification: 'escritura',
        status: 'aprobado',
        flakyScore: 0.4,
        flakyNumerator: 4,
        flakyDenominator: 10,
      },
    });
    const gone = await ctx.prisma.automatedTest.create({
      data: { stableKey: randomUUID(), filePath: 'tests/x/retirado.spec.ts', title: 'retirado', tags: ['@retirado'], classification: 'escritura', status: 'retirado', flakyScore: 0.9, flakyNumerator: 9, flakyDenominator: 10 },
    });
    await ctx.prisma.testCaseLink.create({ data: { automatedTestId: t2.id, caseId: c1!.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 } });
    await ctx.prisma.testCaseLink.create({ data: { automatedTestId: gone.id, caseId: c1!.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 } });
    const agg = (await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases/${c1!.id}`, headers: qa })).json();
    expect(agg).toMatchObject({
      automatedTestCount: 2,
      tags: [uniqueTag, '@aa-zz'].sort(),
      classification: 'escritura',
      flaky: { score: 0.4, numerator: 4, denominator: 10, isFlaky: true },
    });
    expect(agg.tags).not.toContain('@retirado');
    await ctx.prisma.testCaseLink.deleteMany({ where: { automatedTestId: { in: [t2.id, gone.id] } } });
    // WEB→API-A: filtro `ids` (repetible, máx. 100) combinado con los demás filtros.
    const byIds = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?ids=${c1!.id}&ids=${c2!.id}&limit=100`, headers: qa });
    expect(byIds.json().items.map((i: { id: string }) => i.id).sort()).toEqual([c1!.id, c2!.id].sort());
    const oneId = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?ids=${c2!.id}`, headers: qa });
    expect(oneId.json().items.map((i: { id: string }) => i.id)).toEqual([c2!.id]);
    const idsAnd = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?ids=${c1!.id}&ids=${c2!.id}&automated=true`, headers: qa });
    expect(idsAnd.json().items.map((i: { id: string }) => i.id)).toEqual([c1!.id]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?ids=no-es-uuid`, headers: qa })).statusCode).toBe(422);
    // WEB→API-A: `sin_ejecutar` = casos sin ningún resultado local (c1 no tiene; c2 tendrá uno fallido).
    const never = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}&lastResult=sin_ejecutar`, headers: qa });
    expect(never.json().items.map((i: { id: string }) => i.id)).toEqual([c1!.id, c2!.id]);
    const tag = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?tag=${encodeURIComponent(uniqueTag)}`, headers: qa });
    expect(tag.json().items.map((i: { id: string }) => i.id)).toEqual([c1!.id]);
    const env = await ctx.prisma.environment.create({ data: { name: `h-${randomUUID().slice(0, 6)}`, appUrl: 'https://a.example.test', apiUrl: 'https://b.example.test', isProduction: false, allowedHosts: [] } });
    const run = await ctx.prisma.run.create({
      data: { trigger: 'manual', environmentId: env.id, status: 'terminada', selectionSnapshot: {}, manifestHash: 'c'.repeat(64), gitCommit: 'd'.repeat(40), finishedAt: new Date() },
    });
    await ctx.prisma.caseResult.create({ data: { runId: run.id, caseId: c2!.id, caseRevision: 1, status: 'fallido', durationMs: 1000 } });
    const lr = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}&lastResult=fallido`, headers: qa });
    expect(lr.json().items.map((i: { id: string }) => i.id)).toEqual([c2!.id]);
    expect(lr.json().items[0].lastResult).toMatchObject({ status: 'fallido', runId: run.id });
    const neverAfter = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?suiteId=${suiteB}&lastResult=sin_ejecutar`, headers: qa });
    expect(neverAfter.json().items.map((i: { id: string }) => i.id)).toEqual([c1!.id]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases?lastResult=raro`, headers: qa })).statusCode).toBe(422);
    const det = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases/${c1!.id}`, headers: qa });
    expect(det.statusCode).toBe(200);
    expect(det.json()).toMatchObject({ steps: [{ content: expect.stringMatching(/^Abrir /) }], revisions: [{ revision: 1 }], links: [{ stableKey: t.stableKey, reviewStatus: 'requiere_revision' }] });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases/${randomUUID()}`, headers: qa })).statusCode).toBe(404);
    const hist = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases/${c2!.id}/history?environmentId=${env.id}`, headers: qa });
    expect(hist.json()).toMatchObject({ items: [{ runId: run.id, status: 'fallido' }], trend: { successRate: 0, observations: 1 } });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/cases/${randomUUID()}/history`, headers: qa })).statusCode).toBe(404);
  });

  it('RF-TR-06 planes y tests de corridas existentes desde TestRail en vivo', async () => {
    w.fake.plans.push({ id: 77, name: 'Plan regresión', project_id: w.projectId, is_completed: false, entries: [{ id: 'e1', suite_id: w.suiteA, name: 'A', runs: [{ id: 5, name: 'R', suite_id: w.suiteA, project_id: w.projectId, is_completed: false }] }] });
    const plan = await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/plans/77', headers: qa });
    expect(plan.json()).toEqual({ planId: 77, name: 'Plan regresión', entries: [{ suiteExternalId: w.suiteA, runs: [{ trRunId: 5, name: 'R', isCompleted: false }] }] });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/testrail/plans/78', headers: qa })).statusCode).toBe(404);
    const run = await w.fake.addRun(w.projectId, { suite_id: w.suiteA, name: 'x', include_all: false, case_ids: [w.fake.cases[0]!.id] });
    const tests = await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/runs/${run.id}/tests`, headers: qa });
    expect(tests.json().tests).toHaveLength(1);
    w.fake.failNext('getTests', new TestRailError('auth', '401', 401));
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/runs/${run.id}/tests`, headers: qa })).json().error.code).toBe('TESTRAIL_AUTH_FAILED');
    w.fake.failNext('getTests', new TestRailError('server', '500', 500));
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/testrail/runs/${run.id}/tests`, headers: qa })).json().error.code).toBe('TESTRAIL_UNAVAILABLE');
  });
});

describe('health y métricas (RNF-OBS-01/02)', () => {
  it('RNF-OBS-02 /metrics expone outbox, última sync y almacenamiento solo a red interna', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    for (const m of [
      'katalyst_outbox_overdue',
      'katalyst_outbox_pending',
      'katalyst_testrail_last_successful_sync_timestamp_seconds',
      'katalyst_queue_oldest_waiting_seconds',
      'katalyst_worker_leases_expired_recent',
      'katalyst_artifacts_stored_bytes',
      'katalyst_http_requests_total',
    ]) {
      expect(r.body, m).toContain(m);
    }
    expect(r.body).not.toMatch(/postgres(ql)?:\/\/|redis:\/\//);
    const pub = await ctx.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '8.8.8.8' });
    expect(pub.statusCode).toBe(403);
  });
});
