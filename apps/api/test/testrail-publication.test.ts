/**
 * Publicación a TestRail por outbox (RF-TR-04, RF-TR-05, RF-TR-06, RF-TR-08, RNF-CON-02, ESP §13.4, §14 Resiliencia):
 * orden crear → resultados → adjuntos → cerrar, 429 con Retry-After, timeout ambiguo + reconciliación por marcador
 * (sin duplicar), reinicio con entregas en proceso, 401 permanente → intervención + reintento administrativo auditado,
 * vencimiento 24 h, destinos independientes y corrida preexistente sin cambiar su selección ni cerrarla.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runMarker, TESTRAIL_STATUS_IDS } from '@katalyst/shared';
import { TestRailError } from '../src/adapters/testrail/types.js';
import type { FakeTestRailClient } from '../src/adapters/testrail/fake-client.js';
import { setTestRailClientFactory } from '../src/adapters/testrail/index.js';
import { createLogger } from '../src/logger.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import { runOutboxPublisherTick, adminRetryDelivery, type OutboxPublisherDeps } from '../src/control/outbox-publisher.js';
import { enqueueTestRailPublication, registerTestRailOutboxHandlers, localDateTime, mapTestRailError } from '../src/modules/testrail/publication.js';
import { syncNow } from '../src/modules/testrail/sync.js';
import { createConnection, makeWorld, syncDeps, type TrWorld } from './support/testrail-fixture.js';
import { loginAs, makeCtx, type TestCtx } from './support/api-a.js';

let ctx: TestCtx;
let prisma: PrismaClient;
const TR_OPS = ['testrail.add_run', 'testrail.add_results_for_cases', 'testrail.add_attachment_to_result', 'testrail.close_run'];

beforeAll(async () => {
  ctx = await makeCtx();
  prisma = ctx.prisma;
});
afterAll(async () => {
  setTestRailClientFactory(undefined);
  await ctx.close();
});
beforeEach(async () => {
  // Aislamiento: entregas TestRail vivas de otras pruebas no se procesan aquí.
  await prisma.outboxDelivery.updateMany({
    where: { operation: { in: TR_OPS }, status: { in: ['pendiente', 'en_proceso'] } },
    data: { status: 'cancelada' },
  });
});

interface Seeded {
  w: TrWorld;
  runId: string;
  targetA: string;
  targetB: string;
  caseIds: Record<string, string>;
  artifactId: string;
}

async function seed(opts: { existingRunCases?: number[]; closeExisting?: boolean } = {}): Promise<Seeded> {
  const w = makeWorld();
  const conn = await createConnection(prisma, w.projectId);
  await syncNow(syncDeps(prisma, w.fake), { trigger: 'manual', actor: 'system', connectionId: conn.id });
  const cases = await prisma.testRailCase.findMany({ where: { connectionId: conn.id }, orderBy: { trCaseId: 'asc' } });
  const suites = await prisma.testRailSuite.findMany({ where: { connectionId: conn.id } });
  const suiteA = suites.find((s) => s.externalId === w.suiteA)!;
  const suiteB = suites.find((s) => s.externalId === w.suiteB)!;
  const env = await prisma.environment.create({
    data: { name: `staging-${randomUUID().slice(0, 8)}`, appUrl: 'https://app.example.test', apiUrl: 'https://api.example.test', isProduction: false, allowedHosts: [] },
  });
  const run = await prisma.run.create({
    data: {
      trigger: 'manual',
      environmentId: env.id,
      status: 'terminada',
      outcome: 'fallido',
      selectionSnapshot: {},
      manifestHash: 'a'.repeat(64),
      gitCommit: 'b'.repeat(40),
      finishedAt: new Date(),
    },
  });
  let existingTrRun: number | null = null;
  if (opts.existingRunCases) {
    const r = await w.fake.addRun(w.projectId, { suite_id: w.suiteA, name: 'Corrida preexistente', include_all: false, case_ids: opts.existingRunCases });
    existingTrRun = r.id;
    w.fake.calls = [];
  }
  const targetA = await prisma.runTestRailTarget.create({
    data: {
      runId: run.id,
      testrailSuiteId: suiteA.id,
      existingRun: existingTrRun !== null,
      trRunId: existingTrRun,
      closeExistingRun: opts.closeExisting ?? false,
    },
  });
  const targetB = await prisma.runTestRailTarget.create({ data: { runId: run.id, testrailSuiteId: suiteB.id } });
  const [a1, a2, a3, b1, b2] = cases;
  const mk = (c: (typeof cases)[number], target: string, status: string, publishable: boolean, comment: string | null) =>
    prisma.caseResult.create({
      data: { runId: run.id, caseId: c.id, caseRevision: 1, runTestRailTargetId: target, status: status as never, publishable, comment, durationMs: 1500, coverage: 'completa' },
    });
  await mk(a1!, targetA.id, 'fallido', true, `Katalyst · staging\nFalla funcional\n${runMarker(run.id)}`);
  await mk(a2!, targetA.id, 'pasado', true, null);
  await mk(a3!, targetA.id, 'inestable', true, 'Inestable: pasó en el reintento 1.');
  await mk(b1!, targetB.id, 'bloqueado', true, null);
  await mk(b2!, targetB.id, 'no_ejecutado', false, null);
  // Test fallido vinculado al caso a1 con captura sanitizada (RF-TR-05).
  const test = await prisma.automatedTest.create({
    data: { stableKey: randomUUID(), filePath: 'tests/oc/a.spec.ts', title: `C${a1!.trCaseId} a`, tags: ['@oc'], classification: 'lectura', status: 'aprobado' },
  });
  await prisma.testCaseLink.create({ data: { automatedTestId: test.id, caseId: a1!.id, reviewStatus: 'vigente', reviewedCaseRevision: 1 } });
  const rr = await prisma.runResult.create({ data: { runId: run.id, automatedTestId: test.id, status: 'fallido' } });
  const art = await prisma.artifact.create({
    data: { runId: run.id, runResultId: rr.id, kind: 'captura', contentType: 'image/png', storageKey: `runs/${run.id}/${randomUUID()}.png`, sizeBytes: 3, sanitizationStatus: 'sanitizado' },
  });
  // Captura no sanitizada: nunca se encola.
  await prisma.artifact.create({ data: { runId: run.id, runResultId: rr.id, kind: 'captura', contentType: 'image/png', storageKey: `runs/${run.id}/${randomUUID()}.png`, sanitizationStatus: 'fallido' } });
  return {
    w,
    runId: run.id,
    targetA: targetA.id,
    targetB: targetB.id,
    caseIds: { a1: a1!.id, a2: a2!.id, a3: a3!.id, b1: b1!.id, b2: b2!.id },
    artifactId: art.id,
  };
}

function publisher(fake: FakeTestRailClient): OutboxPublisherDeps {
  registerTestRailOutboxHandlers({
    config: { PUBLIC_BASE_URL: 'https://katalyst.example.test', DEFAULT_TIMEZONE: 'America/La_Paz' },
    clientFactory: async () => fake,
    artifactReader: async () => Buffer.from('png'),
  });
  setTestRailClientFactory(async () => fake);
  return {
    prisma,
    logger: createLogger({ level: 'silent', service: 'test' }),
    secrets: new MemorySecretProvider(),
    random: () => 0.5,
    operations: TR_OPS,
    workerId: `w-${randomUUID().slice(0, 6)}`,
  };
}

async function enqueue(runId: string) {
  return prisma.$transaction((tx) => enqueueTestRailPublication(tx, runId));
}

async function drain(deps: OutboxPublisherDeps, start = new Date(), maxTicks = 20) {
  let now = start;
  for (let i = 0; i < maxTicks; i++) {
    const s = await runOutboxPublisherTick(deps, now);
    if (s.claimed === 0 && s.recovered === 0) return now;
    now = new Date(now.getTime() + 61 * 60_000); // supera cualquier backoff (máx 1 h)
  }
  return now;
}

const deliveriesOf = (runId: string) => prisma.outboxDelivery.findMany({ where: { runId }, orderBy: [{ targetId: 'asc' }, { sequence: 'asc' }] });

describe('publicación TestRail (RF-TR-04/05/08)', () => {
  it('RF-TR-04 crea corrida por suite con casos seleccionados, publica agregados finales, adjunta captura y cierra', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    const r = await enqueue(s.runId);
    expect(r.targets.map((t) => t.deliveries).sort()).toEqual([3, 4]);
    const ds = await deliveriesOf(s.runId);
    expect(ds.filter((d) => d.targetId === s.targetA).map((d) => d.operation)).toEqual([
      'testrail.add_run',
      'testrail.add_results_for_cases',
      'testrail.add_attachment_to_result',
      'testrail.close_run',
    ]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('pendiente');
    // Primer tick: solo crear corridas (orden por destino).
    const t1 = await runOutboxPublisherTick(deps, new Date());
    expect(t1.claimed).toBe(2);
    expect(s.w.fake.count('addResultsForCases')).toBe(0);
    await drain(deps);
    const fake = s.w.fake;
    expect(fake.count('addRun')).toBe(2);
    const created = fake.runs.filter((x) => x.name.includes(runMarker(s.runId)));
    expect(created).toHaveLength(2);
    expect(created[0]!.name).toMatch(/^QA Runner · Suite [AB] · staging-[0-9a-f]{8} · \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[katalyst-run:/);
    // Suite B: incluye el caso no ejecutado en la corrida, pero no publica su resultado.
    const runB = created.find((x) => x.suite_id === s.w.suiteB)!;
    expect(fake.tests.filter((t) => t.run_id === runB.id)).toHaveLength(2);
    const statuses = fake.results.map((x) => x.status_id).sort();
    expect(statuses).toEqual([TESTRAIL_STATUS_IDS.passed, TESTRAIL_STATUS_IDS.passed, TESTRAIL_STATUS_IDS.blocked, TESTRAIL_STATUS_IDS.failed].sort());
    expect(fake.results.every((x) => (x.comment ?? '').includes(runMarker(s.runId)))).toBe(true);
    expect(fake.results.some((x) => (x.comment ?? '').includes('pasó en el reintento 1'))).toBe(true);
    expect(fake.attachments).toHaveLength(1);
    expect(fake.attachments[0]!.name).toBe(`katalyst-${s.artifactId}.png`);
    expect(created.every((x) => x.is_completed)).toBe(true);
    const targets = await prisma.runTestRailTarget.findMany({ where: { runId: s.runId } });
    expect(targets.every((t) => t.syncStatus === 'sincronizada' && t.trRunId)).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('sincronizada');
    const crs = await prisma.caseResult.findMany({ where: { runId: s.runId } });
    expect(crs.filter((c) => c.trResultId !== null)).toHaveLength(4);
    expect(crs.find((c) => c.caseId === s.caseIds.b2)!.trResultId).toBeNull();
    expect((await deliveriesOf(s.runId)).every((d) => d.status === 'entregada')).toBe(true);
    // Encolar de nuevo es idempotente (dedupKey).
    await enqueue(s.runId);
    expect(await prisma.outboxDelivery.count({ where: { runId: s.runId } })).toBe(7);
  });

  it('RNF-CON-02 429 respeta Retry-After; la entrega espera sin bloquear otros destinos', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    const now = new Date();
    await runOutboxPublisherTick(deps, now); // add_run x2
    s.w.fake.failNext('addResultsForCases', new TestRailError('rate_limited', 'HTTP 429', 429, 30_000));
    await runOutboxPublisherTick(deps, now);
    const ds = await deliveriesOf(s.runId);
    const limited = ds.find((d) => d.operation === 'testrail.add_results_for_cases' && d.lastHttpStatus === 429)!;
    expect(limited.status).toBe('pendiente');
    expect(limited.nextAttemptAt!.getTime() - now.getTime()).toBe(30_000);
    // El otro destino avanzó.
    expect(ds.filter((d) => d.operation === 'testrail.add_results_for_cases' && d.status === 'entregada')).toHaveLength(1);
    // Antes de Retry-After no se reintenta.
    expect((await runOutboxPublisherTick(deps, new Date(now.getTime() + 10_000))).claimed).toBe(1); // close del otro destino
    await drain(deps, new Date(now.getTime() + 31_000));
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('sincronizada');
  });

  it('RF-TR-08 timeout ambiguo en add_run y en resultados: reconcilia por marcador y no duplica', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    s.w.fake.applyThenFail('addRun');
    const now = new Date();
    await runOutboxPublisherTick(deps, now);
    const ambiguous = (await deliveriesOf(s.runId)).find((d) => d.operation === 'testrail.add_run' && d.status === 'pendiente')!;
    expect(ambiguous.lastError).toMatch(/^\[ambiguo\]/);
    s.w.fake.applyThenFail('addResultsForCases');
    await drain(deps, new Date(now.getTime() + 60_000));
    const ours = s.w.fake.runs.filter((x) => x.name.includes(runMarker(s.runId)));
    expect(ours).toHaveLength(2); // una por suite: la creación ambigua no se repitió a ciegas
    expect(s.w.fake.count('addRun')).toBe(2);
    expect(s.w.fake.count('getRuns')).toBeGreaterThanOrEqual(1);
    expect(s.w.fake.results).toHaveLength(4); // sin resultados duplicados
    expect(s.w.fake.count('getResultsForRun')).toBeGreaterThanOrEqual(1);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('sincronizada');
  });

  it('RNF-CON-02 reinicio: entrega en proceso de un proceso caído se recupera como ambigua y persiste en BD', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    const d = (await deliveriesOf(s.runId)).find((x) => x.targetId === s.targetA && x.operation === 'testrail.add_run')!;
    // Simula proceso caído tras aplicar en TestRail: corrida externa creada, entrega quedó en_proceso.
    const t = await prisma.runTestRailTarget.findUniqueOrThrow({ where: { id: s.targetA }, include: { testrailSuite: true } });
    await s.w.fake.addRun(s.w.projectId, { suite_id: t.testrailSuite.externalId, name: `x ${runMarker(s.runId)}`, include_all: false, case_ids: [] });
    await prisma.outboxDelivery.update({
      where: { id: d.id },
      data: { status: 'en_proceso', attempts: 1, lockedBy: 'proceso-muerto', lockedUntil: new Date(Date.now() - 1000) },
    });
    const fresh = { ...deps, workerId: 'nuevo-proceso' };
    const st = await runOutboxPublisherTick(fresh, new Date());
    expect(st.recovered).toBe(1);
    await drain(fresh, new Date(Date.now() + 60_000));
    expect(s.w.fake.runs.filter((x) => x.suite_id === t.testrailSuite.externalId && x.name.includes(runMarker(s.runId)))).toHaveLength(1);
    expect((await prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('entregada');
  });

  it('RF-TR-08 401 permanente → requiere_intervencion sin bucle; bloquea solo su destino; reintento admin auditado', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    s.w.fake.failNext('addRun', new TestRailError('auth', 'HTTP 401', 401));
    await drain(deps);
    const ds = await deliveriesOf(s.runId);
    const failed = ds.find((d) => d.status === 'requiere_intervencion')!;
    expect(failed).toMatchObject({ operation: 'testrail.add_run', lastHttpStatus: 401, attempts: 1 });
    const blockedTarget = failed.targetId!;
    expect(ds.filter((d) => d.targetId === blockedTarget && d.status === 'pendiente')).toHaveLength(failed.targetId === s.targetA ? 3 : 2);
    const other = ds.filter((d) => d.targetId !== blockedTarget);
    expect(other.every((d) => d.status === 'entregada')).toBe(true);
    expect((await prisma.runTestRailTarget.findUniqueOrThrow({ where: { id: blockedTarget } })).syncStatus).toBe('requiere_intervencion');
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('requiere_intervencion');
    // Matriz: qa ve entregas, solo admin reintenta.
    const qa = await loginAs(ctx, 'qa');
    const admin = await loginAs(ctx, 'admin');
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/integrations/testrail/deliveries?runId=${s.runId}&status=requiere_intervencion`, headers: qa.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([failed.id]);
    const denied = await ctx.app.inject({ method: 'POST', url: `/api/v1/integrations/testrail/deliveries/${failed.id}/retry`, headers: qa.headers, payload: {} });
    expect(denied.statusCode).toBe(403);
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/integrations/testrail/deliveries/${failed.id}/retry`,
      headers: admin.headers,
      payload: { note: 'API key rotada' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ reconciliation: 'no_aplicada', delivery: { status: 'pendiente' } });
    expect(await prisma.auditLog.count({ where: { entityId: failed.id, action: 'outbox_delivery.retry' } })).toBe(1);
    await drain(deps);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('sincronizada');
    const again = await ctx.app.inject({ method: 'POST', url: `/api/v1/integrations/testrail/deliveries/${failed.id}/retry`, headers: admin.headers, payload: {} });
    expect(again.statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/integrations/testrail/deliveries/${randomUUID()}/retry`, headers: admin.headers, payload: {} })).statusCode).toBe(404);
  });

  it('RF-TR-08 reintento admin reconcilia: si ya se aplicó, marca entregada sin reenviar', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    s.w.fake.applyThenFail('addRun', new TestRailError('forbidden', 'HTTP 403 tras aplicar', 403));
    await runOutboxPublisherTick(deps, new Date());
    const d = (await deliveriesOf(s.runId)).find((x) => x.status === 'requiere_intervencion')!;
    const r = await adminRetryDelivery(deps, d.id, { kind: 'service', id: randomUUID(), scopes: [] }, { note: 'x' });
    expect(r.reconciliation).toBe('ya_aplicada');
    expect(r.delivery.status).toBe('entregada');
    expect(s.w.fake.count('addRun')).toBe(2);
  });

  it('RNF-CON-02 vencimiento 24 h → vencida y destino requiere intervención', async () => {
    const s = await seed();
    const deps = publisher(s.w.fake);
    await enqueue(s.runId);
    await prisma.outboxDelivery.updateMany({ where: { runId: s.runId, targetId: s.targetB }, data: { expiresAt: new Date(Date.now() - 1000) } });
    s.w.fake.failNext('addRun', new TestRailError('server', 'HTTP 503', 503), 50);
    const st = await runOutboxPublisherTick(deps, new Date());
    expect(st.expired).toBe(3);
    expect((await prisma.runTestRailTarget.findUniqueOrThrow({ where: { id: s.targetB } })).syncStatus).toBe('requiere_intervencion');
    // 503 repetido en A: reintenta con backoff y vence a las 24 h sin bucle infinito.
    let now = new Date();
    for (let i = 0; i < 40; i++) {
      now = new Date(now.getTime() + 3600_000);
      await runOutboxPublisherTick(deps, now);
    }
    const a = (await deliveriesOf(s.runId)).find((d) => d.targetId === s.targetA && d.operation === 'testrail.add_run')!;
    expect(a.status).toBe('vencida');
    expect(a.attempts).toBeLessThan(40);
  });

  it('RF-TR-06 corrida preexistente: no crea ni cierra, no cambia su selección; casos ajenos quedan para intervención', async () => {
    const s = await seed({ existingRunCases: [] });
    // Rehacer la corrida preexistente con solo 2 de los 3 casos de la suite A.
    const crs = await prisma.caseResult.findMany({ where: { runTestRailTargetId: s.targetA }, include: { case: true }, orderBy: { case: { trCaseId: 'asc' } } });
    const pre = await s.w.fake.addRun(s.w.projectId, {
      suite_id: s.w.suiteA,
      name: 'Plan existente',
      include_all: false,
      case_ids: crs.slice(0, 2).map((c) => c.case.trCaseId),
    });
    await prisma.runTestRailTarget.update({ where: { id: s.targetA }, data: { trRunId: pre.id } });
    s.w.fake.calls = [];
    const deps = publisher(s.w.fake);
    const r = await enqueue(s.runId);
    expect(r.targets.find((t) => t.targetId === s.targetA)!.deliveries).toBe(2); // resultados + adjunto
    await drain(deps);
    expect(s.w.fake.calls.filter((c) => c.op === 'addRun')).toHaveLength(1); // solo suite B
    expect(s.w.fake.runs.find((x) => x.id === pre.id)!.is_completed).toBe(false);
    expect(s.w.fake.tests.filter((t) => t.run_id === pre.id)).toHaveLength(2);
    const outside = await prisma.caseResult.findUniqueOrThrow({ where: { id: crs[2]!.id } });
    expect(outside.syncStatus).toBe('requiere_intervencion');
    const tA = await prisma.runTestRailTarget.findUniqueOrThrow({ where: { id: s.targetA } });
    expect(tA.syncStatus).toBe('sincronizada');
    expect(tA.lastError).toContain('no pertenecen');
  });

  it('RF-TR-04 sin casos publicables no crea destino externo; helpers de formato y errores', async () => {
    const s = await seed();
    await prisma.caseResult.updateMany({ where: { runId: s.runId }, data: { publishable: false } });
    const r = await enqueue(s.runId);
    expect(r.targets.every((t) => t.syncStatus === 'no_aplica' && t.deliveries === 0)).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: s.runId } })).syncStatus).toBe('no_aplica');
    expect(localDateTime(new Date('2026-11-06T12:30:00Z'), 'America/La_Paz')).toBe('2026-11-06 08:30');
    expect(mapTestRailError(new TestRailError('validation', 'x', 400))).toMatchObject({ kind: 'intervention' });
    expect(mapTestRailError(new TestRailError('network', 'x', null, null, true))).toMatchObject({ kind: 'retry', ambiguous: true });
    expect(() => mapTestRailError(new Error('otro'))).toThrow();
  });
});
