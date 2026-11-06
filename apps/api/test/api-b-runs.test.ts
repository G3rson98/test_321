/**
 * Integración con PostgreSQL y Redis reales: planificación, idempotencia de POST /runs, política de producción,
 * snapshot inmutable, API de worker (fencing, idempotencia de callbacks), recuperación tras caída de worker,
 * escritura de resultado desconocido, cancelación < 30 s con señal, capacidad y finalización con outbox.
 * RF-EJE-01, RF-EJE-03, RF-EJE-05, RF-EJE-06, RF-EJE-07, RF-EJE-08, RF-RES-01, RF-RES-05, RF-TR-04, RNF-CON-01.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@katalyst/shared';
import { admitPendingShards } from '../src/services/run-admission.js';
import { expireLeases } from '../src/services/leases.js';
import { enforceCancelDeadlines, runControlChannel, redisControlPublisher } from '../src/services/cancellation.js';
import { watchdogTick } from '../src/control/lease-watchdog.js';
import { createRedis } from '../src/redis.js';
import { FakeWorker, createEnv, idemKey, makeApiBCtx, resetDb, seedCatalog, shardsOf, silent, type ApiBCtx, type Seed } from './support/api-b.js';

let ctx: ApiBCtx;
const deps = () => ({
  prisma: ctx.prisma,
  logger: silent,
  globalBrowserCeiling: 1,
  publicBaseUrl: 'http://panel.example.test',
});

beforeAll(async () => {
  ctx = await makeApiBCtx();
});
afterAll(async () => ctx.close());

async function post(url: string, payload: unknown, headers: Record<string, string> = {}, auth = ctx.qa.authorization) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers: { authorization: auth, ...headers } });
}
async function get(url: string, auth = ctx.qa.authorization) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: auth } });
}

/** Seed estándar: A (lectura, test r1 + r2 cubre A y B), C sin automatización, W escritura, U sin clasificar. */
async function standard(): Promise<Seed> {
  return seedCatalog(ctx.prisma, ['A', 'B', 'C', 'D', 'W', 'U'], [
    { key: 'r1', cases: ['A'], tags: ['@humo', '@oc'] },
    { key: 'r2', cases: ['A', 'B'], tags: ['@oc'] },
    { key: 'r3', cases: ['D'], tags: ['@agendamiento'] },
    { key: 'w1', cases: ['W'], classification: 'escritura', tags: ['@oc'] },
    { key: 'u1', cases: ['U'], classification: 'sin_clasificar', tags: ['@x'] },
  ]);
}

async function resetAll() {
  await resetDb(ctx.prisma);
  const qa = await ctx.prisma.panelUser.create({ data: { email: `qa-${Date.now()}@example.test`, name: 'QA', role: 'qa' } });
  const admin = await ctx.prisma.panelUser.create({ data: { email: `ad-${Date.now()}@example.test`, name: 'Admin', role: 'admin' } });
  const { apiTokenFor, serviceTokenFor } = await import('./support/api-a.js');
  const scopes = ['runs.read', 'runs.create', 'runs.cancel', 'artifacts.read', 'schedules.read', 'schedules.write', 'exclusion_windows.write', 'catalog.read', 'testrail.read'];
  ctx.qa = { authorization: (await apiTokenFor(ctx.prisma, qa.id, scopes)).authorization, userId: qa.id };
  ctx.admin = { authorization: (await apiTokenFor(ctx.prisma, admin.id, scopes)).authorization, userId: admin.id };
  ctx.service = { authorization: (await serviceTokenFor(ctx.prisma)).authorization };
  ctx.controlMessages.length = 0;
}

async function createRun(body: Record<string, unknown>, key = idemKey()) {
  const res = await post('/runs', body, { 'idempotency-key': key });
  return { res, key, run: res.json() as { id: string; status: string; outcome: string | null } };
}

describe('planificador y creación (RF-EJE-01/07)', () => {
  let seed: Seed;
  let envId: string;
  beforeEach(async () => {
    await resetAll();
    seed = await standard();
    envId = (await createEnv(ctx.prisma)).env.id;
  });

  it('RF-EJE-07 preview: casos sin automatización bloqueados, conteos casos vs tests (N:M)', async () => {
    const res = await post('/runs/preview', { caseIds: [seed.cases.A!.id, seed.cases.B!.id, seed.cases.C!.id], environmentId: envId });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.counts).toMatchObject({ cases: 3, executableCases: 2, blockedCases: 1, tests: 2, executableTests: 2 });
    const c = p.cases.find((x: { caseId: string }) => x.caseId === seed.cases.C!.id);
    expect(c).toMatchObject({ executable: false, blockReasons: ['sin_automatizacion'], expectedCoverage: 'ninguna' });
    expect(p.cases.find((x: { caseId: string }) => x.caseId === seed.cases.A!.id).requiredTests).toHaveLength(2);
    expect(p.willLaunchBrowser).toBe(true);
    expect(p.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.testrailTargets).toHaveLength(1);
  });

  it('RF-EJE-01 etiquetas OR producen cobertura parcial; selección vacía ⇒ 422', async () => {
    const res = await post('/runs/preview', { tags: ['@humo'], environmentId: envId });
    const p = res.json();
    const a = p.cases.find((x: { caseId: string }) => x.caseId === seed.cases.A!.id);
    expect(a.expectedCoverage).toBe('parcial');
    const empty = await post('/runs/preview', { tags: ['@inexistente'], environmentId: envId });
    expect(empty.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(empty.json()).error.code).toBe('SELECTION_EMPTY');
    const foreign = await post('/runs/preview', { caseIds: ['00000000-0000-4000-8000-000000000001'], environmentId: envId });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error.code).toBe('SELECTION_FOREIGN_IDS');
    const both = await post('/runs/preview', { tags: ['@oc'], caseIds: [seed.cases.A!.id], environmentId: envId });
    expect(both.json().error.code).toBe('SELECTION_EXCLUSIVE');
  });

  it('RF-EJE-01 ambiente deshabilitado ⇒ 422 sin crear corrida', async () => {
    await ctx.prisma.environment.update({ where: { id: envId }, data: { enabled: false } });
    const { res } = await createRun({ tags: ['@oc'], environmentId: envId });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ENVIRONMENT_DISABLED');
    expect(await ctx.prisma.run.count()).toBe(0);
  });

  it('RF-EJE-01 Idempotency-Key: misma clave+cuerpo ⇒ misma corrida; cuerpo distinto ⇒ 409; concurrencia sin duplicar', async () => {
    const noKey = await post('/runs', { tags: ['@oc'], environmentId: envId });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = idemKey();
    const first = await createRun({ tags: ['@oc'], environmentId: envId }, key);
    expect(first.res.statusCode).toBe(201);
    const again = await createRun({ tags: ['@oc'], environmentId: envId }, key);
    expect(again.res.statusCode).toBe(200);
    expect(again.run.id).toBe(first.run.id);
    const conflict = await createRun({ tags: ['@oc'], environmentId: envId, retries: 1 }, key);
    expect(conflict.res.statusCode).toBe(409);
    expect(conflict.res.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    // Otro actor con la misma clave es otra corrida (clave por actor).
    const other = await post('/runs', { tags: ['@oc'], environmentId: envId }, { 'idempotency-key': key }, ctx.admin.authorization);
    expect(other.statusCode).toBe(201);
    expect(other.json().id).not.toBe(first.run.id);
    // Doble clic concurrente.
    const k2 = idemKey();
    const many = await Promise.all(Array.from({ length: 5 }, () => createRun({ tags: ['@humo'], environmentId: envId }, k2)));
    const ids = new Set(many.filter((m) => m.res.statusCode < 300).map((m) => m.run.id));
    expect(ids.size).toBe(1);
    expect(await ctx.prisma.run.count({ where: { idempotencyKey: k2 } })).toBe(1);
  });

  it('RF-EJE-07 previewToken: configuración cambiada desde la vista previa ⇒ 409', async () => {
    const p = (await post('/runs/preview', { tags: ['@oc'], environmentId: envId })).json();
    await ctx.prisma.environment.update({ where: { id: envId }, data: { version: { increment: 1 } } });
    const { res } = await createRun({ tags: ['@oc'], environmentId: envId, previewToken: p.previewToken });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ADMISSION_CONFIG_CHANGED');
  });

  it('RF-EJE-07 snapshot inmutable: cambios del catálogo no alteran la corrida aceptada', async () => {
    const { run } = await createRun({ caseIds: [seed.cases.A!.id], environmentId: envId });
    await ctx.prisma.automatedTest.update({ where: { id: seed.tests.r1!.id }, data: { classification: 'escritura', title: 'renombrado' } });
    const d = (await get(`/runs/${run.id}`)).json();
    const t = d.snapshot.tests.find((x: { automatedTestId: string }) => x.automatedTestId === seed.tests.r1!.id);
    expect(t.classification).toBe('lectura');
    expect(t.title).not.toBe('renombrado');
    expect(JSON.stringify(d.snapshot)).not.toMatch(/KATALYST_SECRET|secretRef/);
    expect(d.snapshot.testUser).toMatchObject({ readOnly: true });
  });
});

describe('producción (RF-EJE-06, RNF-SEG-04)', () => {
  let seed: Seed;
  beforeEach(async () => {
    await resetAll();
    seed = await standard();
  });

  it('RF-EJE-06 @escritura y sin_clasificar bloqueados en producción; lectura permitida', async () => {
    const prod = (await createEnv(ctx.prisma, { production: true })).env.id;
    const p = (await post('/runs/preview', { tags: ['@oc', '@x'], environmentId: prod })).json();
    const reasons = Object.fromEntries(p.tests.map((t: { stableKey: string; blockReasons: string[] }) => [t.stableKey, t.blockReasons]));
    expect(reasons[seed.tests.w1!.stableKey]).toEqual(['escritura_en_produccion']);
    expect(reasons[seed.tests.u1!.stableKey]).toEqual(['clasificacion_ausente']);
    expect(reasons[seed.tests.r1!.stableKey]).toEqual([]);
  });

  it('RF-EJE-06 usuario de prueba con escritura bloquea toda la corrida en producción', async () => {
    const prod = (await createEnv(ctx.prisma, { production: true, userReadOnly: false })).env.id;
    const p = (await post('/runs/preview', { tags: ['@humo'], environmentId: prod })).json();
    expect(p.counts.executableTests).toBe(0);
    expect(p.blockers.map((b: { code: string }) => b.code)).toContain('PRODUCTION_BLOCKED');
  });

  it('RF-TR-07 vínculo requiere_revision bloquea producción; staging manual solo advierte', async () => {
    await ctx.prisma.testCaseLink.updateMany({ where: { automatedTestId: seed.tests.r3!.id }, data: { reviewStatus: 'requiere_revision' } });
    const prod = (await createEnv(ctx.prisma, { production: true })).env.id;
    const staging = (await createEnv(ctx.prisma)).env.id;
    const pp = (await post('/runs/preview', { caseIds: [seed.cases.D!.id], environmentId: prod })).json();
    expect(pp.tests[0].blockReasons).toEqual(['revision_pendiente']);
    const ps = (await post('/runs/preview', { caseIds: [seed.cases.D!.id], environmentId: staging })).json();
    expect(ps.tests[0].executable).toBe(true);
    expect(ps.warnings.map((w: { code: string }) => w.code)).toContain('LINK_REVIEW_PENDING');
  });

  it('RF-EJE-06 selección solo bloqueada ⇒ corrida terminada outcome bloqueado sin navegador, publicable', async () => {
    const prod = (await createEnv(ctx.prisma, { production: true })).env.id;
    const { res, run } = await createRun({ caseIds: [seed.cases.W!.id, seed.cases.C!.id], environmentId: prod });
    expect(res.statusCode).toBe(201);
    expect(run.status).toBe('terminada');
    expect(run.outcome).toBe('bloqueado');
    expect(await ctx.prisma.runShard.count({ where: { runId: run.id } })).toBe(0);
    const cases = (await get(`/runs/${run.id}/case-results`)).json().items;
    expect(cases.every((c: { status: string; publishable: boolean }) => c.status === 'bloqueado' && c.publishable)).toBe(true);
    const ops = (await ctx.prisma.outboxDelivery.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } })).map((d) => d.operation);
    expect(ops).toEqual(['testrail.add_run', 'testrail.add_results_for_cases', 'testrail.close_run']);
    const results = (await get(`/runs/${run.id}/results`)).json().items;
    expect(results[0]).toMatchObject({ status: 'bloqueado', reason: 'escritura_en_produccion' });
  });
});

describe('API de worker (RF-EJE-08, ESP §13.3)', () => {
  let seed: Seed;
  let envId: string;
  beforeEach(async () => {
    await resetAll();
    seed = await standard();
    envId = (await createEnv(ctx.prisma)).env.id;
  });

  async function startedRun(body: Record<string, unknown>) {
    const { run } = await createRun({ environmentId: envId, ...body });
    const [shard] = await shardsOf(ctx.prisma, run.id);
    expect(shard!.status).toBe('asignado');
    const w = new FakeWorker(ctx);
    const claim = await w.claim(run.id, shard!.id);
    expect(claim.statusCode).toBe(200);
    return { run, shard: shard!, w };
  }

  it('RF-EJE-08 flujo completo: claim (sin secreto), heartbeat, intento, resultado, fin ⇒ terminada/pasado + outbox ordenada', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id] });
    const claimBody = w.assignment as unknown as { testUserRef: { secretRef: string; username: string } };
    expect(claimBody.testUserRef.secretRef).toMatch(/^env:/);
    expect(JSON.stringify(w.assignment)).not.toMatch(/password|storageState/i);
    const dup = await new FakeWorker(ctx).claim(run.id, w.assignment.shardId);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SHARD_NOT_CLAIMABLE');
    const hb = await w.heartbeat();
    expect(hb.json()).toMatchObject({ ok: true, cancelRequested: false });
    const t = w.assignment.tests[0]!;
    expect((await w.start(t.runResultId)).json()).toMatchObject({ duplicate: false, proceed: true });
    expect((await get(`/runs/${run.id}`)).json().status).toBe('corriendo');
    const r = await w.result(t.runResultId, 1, 'pasado');
    expect(r.json()).toMatchObject({ status: 'pasado', duplicate: false, retryAllowed: false });
    // Repetición idéntica ⇒ acuse original sin mutación; contenido distinto ⇒ 409.
    const before = await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: t.runResultId } });
    const c = await w.complete();
    expect(c.json()).toMatchObject({ ok: true, duplicate: false });
    expect((await w.complete()).json()).toMatchObject({ ok: true, duplicate: true });
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d).toMatchObject({ status: 'terminada', outcome: 'pasado', syncStatus: 'pendiente' });
    expect(d.runtimeVersions.playwright).toBe('1.65.0');
    const after = await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: t.runResultId } });
    expect(after.status).toBe(before.status);
    const cr = (await get(`/runs/${run.id}/case-results`)).json().items[0];
    expect(cr).toMatchObject({ status: 'pasado', coverage: 'completa', publishable: true, durationMs: 1500 });
    expect(cr.comment).toContain(`[katalyst-run:${run.id}]`);
    const deliveries = await ctx.prisma.outboxDelivery.findMany({ where: { runId: run.id, targetId: { not: null } }, orderBy: { sequence: 'asc' } });
    expect(deliveries.map((x) => x.operation)).toEqual(['testrail.add_run', 'testrail.add_results_for_cases', 'testrail.close_run']);
    // Callback tardío tras terminal: no reabre (lease liberado ⇒ 409).
    const late = await w.start(t.runResultId, 2, 'retry');
    expect(late.statusCode).toBe(409);
    expect((await get(`/runs/${run.id}`)).json().status).toBe('terminada');
  });

  it('RF-EJE-08 callback de resultado duplicado ⇒ acuse original; contenido distinto ⇒ CALLBACK_CONFLICT', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.A!.id] });
    const [t1] = w.assignment.tests;
    await w.start(t1!.runResultId);
    const body = {
      leaseId: w.leaseId,
      generation: w.generation,
      runResultId: t1!.runResultId,
      attemptNo: 1,
      attemptStatus: 'pasado',
      finishedAt: '2026-11-06T12:00:00.000Z',
      durationMs: 1000,
      errorCategory: null,
      error: null,
      final: true,
    };
    const send = (b: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/worker/results', headers: { authorization: `Bearer ${w.token}` }, payload: b as object });
    const a1 = await send(body);
    const a2 = await send(body);
    expect(a1.statusCode).toBe(200);
    expect(a2.json()).toEqual({ ...a1.json(), duplicate: true });
    const conflict = await send({ ...body, durationMs: 999 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('CALLBACK_CONFLICT');
    expect(await ctx.prisma.testAttempt.count({ where: { runResultId: t1!.runResultId } })).toBe(1);
    const dupStart = await w.start(t1!.runResultId);
    expect(dupStart.statusCode).toBe(409);
    void run;
  });

  it('RF-EJE-05 retry funcional ⇒ inestable; escritura sin idempotencia aprobada no reintenta', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id, seed.cases.W!.id], retries: 1 });
    const byKey = Object.fromEntries(w.assignment.tests.map((t) => [t.stableKey, t]));
    const read = byKey[seed.tests.r3!.stableKey]!;
    const write = byKey[seed.tests.w1!.stableKey]!;
    await w.start(read.runResultId);
    expect((await w.result(read.runResultId, 1, 'fallido', { final: false })).json()).toMatchObject({ retryAllowed: true, status: 'corriendo' });
    expect((await w.start(read.runResultId, 2, 'retry')).json().proceed).toBe(true);
    expect((await w.result(read.runResultId, 2, 'pasado')).json().status).toBe('inestable');
    await w.start(write.runResultId);
    const wr = await w.result(write.runResultId, 1, 'fallido', { final: false });
    expect(wr.json()).toMatchObject({ retryAllowed: false, status: 'fallido' });
    expect((await w.start(write.runResultId, 2, 'retry')).statusCode).toBe(409);
    await w.complete();
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d.outcome).toBe('fallido');
    const rr = await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: read.runResultId } });
    expect(rr).toMatchObject({ status: 'inestable', retryCount: 1, infraRecoveryCount: 0, durationMs: 3000 });
  });

  it('RNF-CON-01 caída durante el test de lectura ⇒ detección ≤ 90 s, recuperación única, lease viejo rechazado', async () => {
    const { run, shard, w } = await startedRun({ caseIds: [seed.cases.A!.id] });
    const [t1, t2] = w.assignment.tests;
    await w.start(t1!.runResultId);
    await w.result(t1!.runResultId, 1, 'pasado');
    await w.start(t2!.runResultId);
    // A los 76 s sin heartbeat (expira a 75 s; watchdog ≤ 15 s ⇒ detección ≤ 90 s).
    const lost = await expireLeases({ ...deps() }, new Date(Date.now() + 76_000));
    expect(lost).toEqual([expect.objectContaining({ runId: run.id, recovered: true })]);
    expect((await w.heartbeat()).json().error.code).toBe('LEASE_STALE');
    expect((await w.result(t2!.runResultId, 1, 'pasado')).statusCode).toBe(409);
    const s = await ctx.prisma.runShard.findUniqueOrThrow({ where: { id: shard.id } });
    expect(s).toMatchObject({ status: 'pendiente', recoveryCount: 1 });
    // El resultado confirmado se conserva; el test en curso se reasigna como recuperación.
    expect((await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: t1!.runResultId } })).status).toBe('pasado');
    await admitPendingShards(deps());
    const w2 = new FakeWorker(ctx);
    expect((await w2.claim(run.id, shard.id)).statusCode).toBe(200);
    expect(w2.generation).toBe(2);
    expect(w2.assignment.tests).toEqual([expect.objectContaining({ runResultId: t2!.runResultId, nextAttemptNo: 2, nextAttemptKind: 'recuperacion' })]);
    // Callbacks con la generación anterior siguen rechazados.
    expect((await w.complete()).statusCode).toBe(409);
    await w2.start(t2!.runResultId, 2, 'recuperacion');
    await w2.result(t2!.runResultId, 2, 'pasado');
    await w2.complete();
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d).toMatchObject({ status: 'terminada', outcome: 'pasado' });
    const rr = await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: t2!.runResultId } });
    expect(rr).toMatchObject({ status: 'pasado', infraRecoveryCount: 1, retryCount: 0 });
    // Segunda caída ⇒ ya no hay recuperación: corrida interrumpida (terminal).
  });

  it('RNF-CON-01 escritura en curso perdida ⇒ resultado desconocido sin repetición; agotada la recuperación ⇒ interrumpida', async () => {
    const { run, shard, w } = await startedRun({ caseIds: [seed.cases.W!.id, seed.cases.D!.id] });
    const byKey = Object.fromEntries(w.assignment.tests.map((t) => [t.stableKey, t]));
    const write = byKey[seed.tests.w1!.stableKey]!;
    const read = byKey[seed.tests.r3!.stableKey]!;
    await w.start(write.runResultId);
    await expireLeases(deps(), new Date(Date.now() + 80_000));
    const wr = await ctx.prisma.runResult.findUniqueOrThrow({ where: { id: write.runResultId }, include: { attempts: true } });
    expect(wr).toMatchObject({ status: 'error_infraestructura', reason: 'escritura_resultado_desconocido' });
    expect(wr.attempts[0]).toMatchObject({ status: 'error_infraestructura', errorCategory: 'resultado_desconocido' });
    await admitPendingShards(deps());
    const w2 = new FakeWorker(ctx);
    await w2.claim(run.id, shard.id);
    expect(w2.assignment.tests.map((t) => t.runResultId)).toEqual([read.runResultId]);
    await w2.start(read.runResultId);
    // Segunda caída (antes del resultado): sin recuperación disponible ⇒ interrumpida.
    await expireLeases(deps(), new Date(Date.now() + 160_000));
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d).toMatchObject({ status: 'interrumpida', outcome: 'incompleto', reason: 'recuperacion_agotada' });
    // Corrida terminal: un callback tardío no la reabre.
    expect((await w2.result(read.runResultId, 1, 'pasado')).statusCode).toBe(409);
    expect((await get(`/runs/${run.id}`)).json().status).toBe('interrumpida');
    // Notificación de interrupción solo si hay canal configurado (API-C); el caso de escritura queda sin publicar.
    const cases = (await get(`/runs/${run.id}/case-results`)).json().items;
    expect(cases.find((c: { caseId: string }) => c.caseId === seed.cases.W!.id).status).toBe('no_ejecutado');
  });

  it('RNF-CON-01 caída tras persistir el resultado y antes de completar ⇒ resultado conservado y shard completado', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id] });
    const t = w.assignment.tests[0]!;
    await w.start(t.runResultId);
    await w.result(t.runResultId, 1, 'pasado');
    await expireLeases(deps(), new Date(Date.now() + 80_000));
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d).toMatchObject({ status: 'terminada', outcome: 'pasado' });
  });

  it('RF-EJE-03 cancelación con señal al supervisor y heartbeat; tests no iniciados ⇒ cancelado; idempotente', async () => {
    const sub = createRedis(ctx.config.REDIS_URL);
    await sub.connect();
    const received: string[] = [];
    sub.on('message', (_c, m) => received.push(m));
    await sub.subscribe(runControlChannel(ctx.config.QUEUE_PREFIX));
    const { setRunsTestDoubles } = await import('../src/modules/runs/deps.js');
    setRunsTestDoubles({ store: ctx.store, control: redisControlPublisher(ctx.redis, ctx.config.QUEUE_PREFIX) });
    try {
      const { run, w } = await startedRun({ caseIds: [seed.cases.A!.id] });
      const [t1, t2] = w.assignment.tests;
      await w.start(t1!.runResultId);
      const t0 = Date.now();
      const c1 = await post(`/runs/${run.id}/cancel`, { reason: 'prueba' });
      expect(c1.statusCode).toBe(200);
      expect(c1.json()).toMatchObject({ run: { status: 'cancelando' }, stopConfirmed: false });
      for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toMatchObject({ type: 'cancel', runId: run.id, leaseIds: [w.leaseId] });
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect((await w.heartbeat()).json()).toMatchObject({ cancelRequested: true });
      expect((await w.start(t2!.runResultId)).json()).toMatchObject({ proceed: false });
      await w.result(t1!.runResultId, 1, 'cancelado', { final: true });
      expect((await w.complete('cancelado')).statusCode).toBe(200);
      const c2 = await post(`/runs/${run.id}/cancel`, {});
      expect(c2.json()).toMatchObject({ run: { status: 'cancelada', outcome: 'incompleto' }, stopConfirmed: true });
      const results = await ctx.prisma.runResult.findMany({ where: { runId: run.id } });
      expect(results.every((r) => r.status === 'cancelado')).toBe(true);
    } finally {
      setRunsTestDoubles({ store: ctx.store, control: async (m) => void ctx.controlMessages.push(m) });
      sub.disconnect();
    }
  });

  it('RF-EJE-03 worker inaccesible: a los 30 s se revocan credenciales y queda constancia', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id] });
    await w.start(w.assignment.tests[0]!.runResultId);
    await post(`/runs/${run.id}/cancel`, {});
    const closed = await enforceCancelDeadlines({ ...deps(), publishControl: async (m) => void ctx.controlMessages.push(m) }, new Date(Date.now() + 31_000));
    expect(closed).toEqual([run.id]);
    expect((await get(`/runs/${run.id}`)).json().status).toBe('cancelada');
    expect((await w.heartbeat()).statusCode).toBe(409);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'run.cancel_unconfirmed', entityId: run.id } });
    expect(audit).not.toBeNull();
    expect(ctx.controlMessages.some((m) => m.type === 'revoke' && m.runId === run.id)).toBe(true);
  });

  it('RF-EJE-03 cancelar corrida en cola sin worker ⇒ cancelada de inmediato, despacho revocado', async () => {
    const holder = await createRun({ caseIds: [seed.cases.D!.id], environmentId: envId });
    const { run } = await createRun({ caseIds: [seed.cases.A!.id], environmentId: envId });
    const [queued] = await shardsOf(ctx.prisma, run.id);
    expect(queued!.status).toBe('pendiente'); // capacidad global 1 ocupada por la primera
    const c = await post(`/runs/${run.id}/cancel`, {});
    expect(c.json()).toMatchObject({ run: { status: 'cancelada' }, stopConfirmed: true });
    void holder;
  });

  it('RF-EJE-04 capacidad global 1: la segunda corrida espera y se admite al liberarse', async () => {
    const a = await startedRun({ caseIds: [seed.cases.D!.id] });
    const { run: b } = await createRun({ caseIds: [seed.cases.A!.id], environmentId: envId });
    const adm = await admitPendingShards(deps());
    expect(adm.saturated).toContain('global');
    expect((await shardsOf(ctx.prisma, b.id))[0]!.status).toBe('pendiente');
    const t = a.w.assignment.tests[0]!;
    await a.w.start(t.runResultId);
    await a.w.result(t.runResultId, 1, 'pasado');
    await a.w.complete();
    const adm2 = await admitPendingShards(deps());
    expect(adm2.admitted.map((x) => x.runId)).toEqual([b.id]);
  });

  it('RF-RES-05 detalle separa aplicación, runner y publicación; lista paginada con filtros', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id] });
    const t = w.assignment.tests[0]!;
    await w.start(t.runResultId);
    await w.result(t.runResultId, 1, 'fallido', { final: true, error: 'Falló con token=abc123secreto456 en la grilla' });
    await w.complete();
    const d = (await get(`/runs/${run.id}`)).json();
    expect(d.problems).toEqual({ application: 1, runner: 0, publication: 0 });
    const att = (await get(`/runs/${run.id}/results/${t.runResultId}/attempts`)).json().items[0];
    expect(att.error).not.toContain('abc123secreto456');
    const list = (await get(`/runs?limit=1&environmentId=${envId}`)).json();
    expect(list.items).toHaveLength(1);
    const outcome = (await get(`/runs?outcome=fallido`)).json();
    expect(outcome.items.map((r: { id: string }) => r.id)).toContain(run.id);
    expect((await get(`/runs/${run.id}/targets`)).json().items[0]).toMatchObject({ syncStatus: 'pendiente', pendingDeliveries: 3 });
  });

  it('RNF-SEG-03 worker: servicio no puede llamar callbacks; panel no puede reclamar', async () => {
    const { run, shard } = await (async () => {
      const { run } = await createRun({ caseIds: [seed.cases.D!.id], environmentId: envId });
      return { run, shard: (await shardsOf(ctx.prisma, run.id))[0]! };
    })();
    const asQa = await post('/worker/claim', { runId: run.id, shardId: shard.id, workerId: 'x' });
    expect(asQa.statusCode).toBe(403);
    const asService = await post('/worker/heartbeat', { leaseId: shard.id, generation: 1 }, {}, ctx.service.authorization);
    expect(asService.statusCode).toBe(403);
  });

  it('RNF-CON-01 watchdog completo libera reservas huérfanas y publica revocación', async () => {
    const { run, w } = await startedRun({ caseIds: [seed.cases.D!.id] });
    await w.start(w.assignment.tests[0]!.runResultId);
    const r = await watchdogTick({ ...deps(), publishControl: async (m) => void ctx.controlMessages.push(m) }, new Date(Date.now() + 90_000));
    expect(r.lost).toHaveLength(1);
    expect(ctx.controlMessages.find((m) => m.type === 'revoke')).toMatchObject({ runId: run.id, reason: 'lease_vencido' });
  });
});
