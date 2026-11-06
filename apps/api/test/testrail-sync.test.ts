/**
 * RF-TR-02, RF-TR-07, ESP §8, §13.1, §14 (TestRail y catálogo): paginación completa con staging, múltiples suites,
 * árbol de secciones, cambio de caso (pasos → nueva revisión + requiere_revision; título/refs → solo metadatos),
 * archivado solo tras sync completa, fallo parcial sin cambios, campos no soportados, concurrencia.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KatalystError } from '@katalyst/shared';
import { createPrisma } from '../src/db.js';
import { TestRailError } from '../src/adapters/testrail/types.js';
import { extractCaseContent, executeSync, startSync, syncNow, toSyncRunDto } from '../src/modules/testrail/sync.js';
import { createConnection, makeWorld, syncDeps } from './support/testrail-fixture.js';
import { testConfig } from './support/api-a.js';

const prisma = createPrisma(testConfig(), 'api');
afterAll(() => prisma.$disconnect());

async function casesOf(connectionId: string) {
  return prisma.testRailCase.findMany({ where: { connectionId }, orderBy: { trCaseId: 'asc' } });
}

describe('extractCaseContent (RF-TR-07)', () => {
  it('RF-TR-07 hash depende de pasos/esperado/precondiciones/negocio, no de título ni refs; registra no soportados', () => {
    const base = { id: 1, title: 'A', section_id: 1, suite_id: 1, custom_steps_separated: [{ content: 'paso', expected: 'ok' }] };
    const a = extractCaseContent(base);
    expect(extractCaseContent({ ...base, title: 'B', refs: 'X-1' }).contentHash).toBe(a.contentHash);
    expect(extractCaseContent({ ...base, custom_steps_separated: [{ content: 'paso', expected: 'otro' }] }).contentHash).not.toBe(a.contentHash);
    expect(extractCaseContent({ ...base, custom_preconds: 'login' }).contentHash).not.toBe(a.contentHash);
    const withCustom = extractCaseContent({ ...base, custom_negocio: 'v1', custom_raro: 'z' }, ['custom_negocio']);
    expect(withCustom.unsupported).toEqual(['custom_raro']);
    expect(withCustom.contentHash).not.toBe(a.contentHash);
    expect(extractCaseContent({ ...base, custom_raro: 'otro' }).contentHash).toBe(a.contentHash);
    const shared = extractCaseContent({ ...base, custom_steps_separated: [{ content: 'p', expected: null, shared_step_id: 9, additional_info: 'info' }] });
    expect(shared.unsupported).toContain('custom_steps_separated.shared_step_id');
    expect(shared.content.steps[0]).toMatchObject({ additionalInfo: 'info', sharedStepId: 9 });
    expect(extractCaseContent({ ...base, custom_steps_separated: 'texto' as never }).unsupported).toContain('custom_steps_separated');
    expect(extractCaseContent({ id: 2, title: 'x', section_id: 1, suite_id: 1, custom_testrail_bdd_scenario: 'Given' }).content.steps).toHaveLength(1);
    const secret = extractCaseContent({ ...base, custom_steps_separated: [{ content: 'usar Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmn', expected: null }] });
    expect(JSON.stringify(secret.content)).not.toContain('eyJhbGci');
  });
});

describe('sincronización (RF-TR-02, RF-TR-07)', () => {
  it('RF-TR-02 recorre todas las páginas de múltiples suites, árbol de secciones y revisiones iniciales', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId);
    const run = await syncNow(syncDeps(prisma, w.fake), { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(run.status).toBe('exitosa');
    const dto = toSyncRunDto(run);
    expect(dto.stats).toMatchObject({ suites: 2, sections: 3, casesSeen: 5, casesCreated: 5, casesArchived: 0 });
    // pageSize 2: suite A 3 casos (2 págs), suite B 2 casos (1 pág) + secciones (1+1).
    expect(dto.stats.pages).toBe(5);
    expect(dto.stats.unsupportedFields).toEqual(['custom_rare_field']);
    const cases = await casesOf(conn.id);
    expect(cases).toHaveLength(5);
    expect(cases.every((c) => c.revision === 1 && c.archivedAt === null)).toBe(true);
    expect(cases[0]).toMatchObject({ priority: 'Medium', type: 'Functional', expected: 'Grilla visible' });
    expect(await prisma.caseRevision.count({ where: { caseId: { in: cases.map((c) => c.id) } } })).toBe(5);
    const child = await prisma.testRailSection.findFirstOrThrow({ where: { connectionId: conn.id, trSectionId: w.child } });
    const root = await prisma.testRailSection.findFirstOrThrow({ where: { connectionId: conn.id, trSectionId: w.root } });
    expect(child).toMatchObject({ parentId: root.id, depth: 1, suiteId: root.suiteId });
    expect(await prisma.testRailCaseStaging.count({ where: { syncRunId: run.id } })).toBe(0);
    const c = await prisma.testRailConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(c.lastSyncStatus).toBe('exitosa');
    expect(await prisma.auditLog.count({ where: { entityId: run.id, action: 'testrail.sync' } })).toBe(1);
    expect(await prisma.eventLog.count({ where: { entityId: run.id, type: 'testrail.sync' } })).toBe(2);
  });

  it('RF-TR-07 cambio de pasos ⇒ nueva revisión y vínculos requiere_revision; título/refs ⇒ solo metadatos', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId);
    const deps = syncDeps(prisma, w.fake);
    await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    const [c1, c2] = await casesOf(conn.id);
    const test = await prisma.automatedTest.create({
      data: { stableKey: randomUUID(), filePath: 'tests/x.spec.ts', title: 'C1 x', tags: ['@oc'], classification: 'lectura', status: 'aprobado' },
    });
    await prisma.testCaseLink.createMany({
      data: [
        { automatedTestId: test.id, caseId: c1!.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 },
        { automatedTestId: test.id, caseId: c2!.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 },
      ],
    });
    const tr1 = w.fake.cases.find((c) => c.id === c1!.trCaseId)!;
    tr1.custom_steps_separated = [{ content: 'Ir a /loadOrder', expected: 'Se ve la grilla con filas' }];
    const tr2 = w.fake.cases.find((c) => c.id === c2!.trCaseId)!;
    tr2.title = 'Cambiar a distribuidores (renombrado)';
    tr2.refs = 'JIRA-2';
    const run = await syncNow(deps, { trigger: 'programada', actor: 'system', connectionId: conn.id });
    expect(toSyncRunDto(run).stats).toMatchObject({ casesNewRevision: 1, casesUpdated: 1, linksRequiringReview: 1, casesCreated: 0 });
    const after1 = await prisma.testRailCase.findUniqueOrThrow({ where: { id: c1!.id } });
    const after2 = await prisma.testRailCase.findUniqueOrThrow({ where: { id: c2!.id } });
    expect(after1.revision).toBe(2);
    expect(after1.contentHash).not.toBe(c1!.contentHash);
    expect(after2).toMatchObject({ revision: 1, title: 'Cambiar a distribuidores (renombrado)', refs: 'JIRA-2', contentHash: c2!.contentHash });
    const links = await prisma.testCaseLink.findMany({ where: { automatedTestId: test.id } });
    expect(links.find((l) => l.caseId === c1!.id)!.reviewStatus).toBe('requiere_revision');
    expect(links.find((l) => l.caseId === c2!.id)!.reviewStatus).toBe('vigente');
    const revs = await prisma.caseRevision.findMany({ where: { caseId: c1!.id }, orderBy: { revision: 'asc' } });
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
  });

  it('RF-TR-07 archiva casos/secciones/suites desaparecidos solo tras sync completa; reaparición desarchiva', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId);
    const deps = syncDeps(prisma, w.fake);
    await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    const removed = w.fake.cases.pop()!; // de suite B
    const run = await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(toSyncRunDto(run).stats.casesArchived).toBe(1);
    const gone = await prisma.testRailCase.findFirstOrThrow({ where: { connectionId: conn.id, trCaseId: removed.id } });
    expect(gone.archivedAt).not.toBeNull();
    w.fake.cases.push(removed);
    await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect((await prisma.testRailCase.findUniqueOrThrow({ where: { id: gone.id } })).archivedAt).toBeNull();
    // Suite eliminada en TestRail → suite, secciones y casos archivados.
    w.fake.suites = w.fake.suites.filter((s) => s.id !== w.suiteB);
    w.fake.sections = w.fake.sections.filter((s) => s.suite_id !== w.suiteB);
    w.fake.cases = w.fake.cases.filter((c) => c.suite_id !== w.suiteB);
    const r3 = await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(toSyncRunDto(r3).stats.casesArchived).toBe(2);
    const suiteB = await prisma.testRailSuite.findFirstOrThrow({ where: { connectionId: conn.id, externalId: w.suiteB } });
    expect(suiteB.archivedAt).not.toBeNull();
    expect(await prisma.testRailSection.count({ where: { suiteId: suiteB.id, archivedAt: null } })).toBe(0);
  });

  it('RF-TR-02 fallo parcial (página 2, 429 agotado o 401) no archiva ni reemplaza el catálogo', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId);
    const deps = syncDeps(prisma, w.fake);
    await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    const before = await casesOf(conn.id);
    // Cambios en TestRail que NO deben aplicarse si la sync falla.
    w.fake.cases.pop();
    w.fake.cases[0]!.custom_steps_separated = [{ content: 'otro paso', expected: null }];
    w.fake.failNext('getCases', new TestRailError('server', 'HTTP 500', 500), 1, 1);
    const failed = await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(failed.status).toBe('fallida');
    expect(failed.error).toContain('500');
    const after = await casesOf(conn.id);
    expect(after.map((c) => [c.id, c.revision, c.archivedAt, c.contentHash])).toEqual(
      before.map((c) => [c.id, c.revision, c.archivedAt, c.contentHash]),
    );
    expect(await prisma.testRailCaseStaging.count({ where: { syncRunId: failed.id } })).toBe(0);
    expect((await prisma.testRailConnection.findUniqueOrThrow({ where: { id: conn.id } })).lastSyncStatus).toBe('fallida');
    w.fake.failNext('getProjects', new TestRailError('auth', 'HTTP 401', 401));
    expect((await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id })).status).toBe('fallida');
    // Recuperación: la siguiente sync aplica todo.
    const ok = await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(toSyncRunDto(ok).stats).toMatchObject({ casesArchived: 1, casesNewRevision: 1 });
  });

  it('RF-TR-02 una sincronización a la vez; en_curso abandonada se libera; proyecto inexistente falla', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId);
    const deps = syncDeps(prisma, w.fake);
    const r1 = await startSync(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    await expect(startSync(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id })).rejects.toMatchObject({
      code: 'TESTRAIL_SYNC_IN_PROGRESS',
    });
    await prisma.testRailSyncRun.update({ where: { id: r1.id }, data: { startedAt: new Date(Date.now() - 3 * 3600_000) } });
    const r2 = await startSync(deps, { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect((await prisma.testRailSyncRun.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe('fallida');
    expect((await executeSync(deps, r2.id)).status).toBe('exitosa');
    const bad = await createConnection(prisma, 999_999_999);
    expect((await syncNow(deps, { trigger: 'manual', actor: 'system', connectionId: bad.id })).status).toBe('fallida');
    const noProject = await prisma.testRailConnection.create({
      data: { baseUrl: 'https://x.example.test', username: 'u', secretRef: 'env:KATALYST_SECRET__X', enabled: true, createdAt: new Date(Date.now() + 7200_000) },
    });
    await expect(startSync(deps, { trigger: 'manual', actor: 'system', connectionId: noProject.id })).rejects.toBeInstanceOf(KatalystError);
    await prisma.testRailConnection.update({ where: { id: noProject.id }, data: { enabled: false } });
    await expect(startSync(deps, { trigger: 'manual', actor: 'system', connectionId: noProject.id })).rejects.toMatchObject({
      code: 'TESTRAIL_CONNECTION_INVALID',
    });
  });

  it('RF-TR-02 filtro de suites configuradas: solo sincroniza las elegidas', async () => {
    const w = makeWorld();
    const conn = await createConnection(prisma, w.projectId, [w.suiteB]);
    const run = await syncNow(syncDeps(prisma, w.fake), { trigger: 'manual', actor: 'system', connectionId: conn.id });
    expect(toSyncRunDto(run).stats).toMatchObject({ suites: 1, casesSeen: 2 });
  });
});
