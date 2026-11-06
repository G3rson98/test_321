/**
 * Programación con reloj inyectable, PostgreSQL y Redis reales: 21 ocurrencias L-V 08–18 c/30 en un día simulado,
 * DST, solapamiento, saturación ⇒ sin_capacidad, pausa sin catch-up, huecos tras caída ⇒ omitidas sin ráfaga,
 * ventanas de exclusión, CRUD con revisiones y disparadores BullMQ reconciliados desde PostgreSQL.
 * RF-PRG-01, RF-PRG-02, RF-PRG-03, RF-PRG-04, RF-PRG-05, RNF-REN-02.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import type { Principal } from '../src/lib/auth.js';
import { createSchedule, materializeDueOccurrences, setSchedulePaused } from '../src/services/scheduler.js';
import { schedulerTick } from '../src/control/scheduler-loop.js';
import { createRunFromPlan } from '../src/services/run-admission.js';
import { resolvePlan } from '../src/services/run-planner.js';
import { createTriggerQueue, syncScheduleTriggers } from '../src/control/reconciler.js';
import { bullConnectionFromUrl, createShardQueue, dispatchPendingDeliveries, redispatchStaleShards } from '../src/control/dispatcher.js';
import { runInTransaction } from '../src/lib/events-publish.js';
import { FakeWorker, createEnv, makeApiBCtx, resetDb, seedCatalog, silent, type ApiBCtx, type Seed } from './support/api-b.js';
import { apiTokenFor, serviceTokenFor } from './support/api-a.js';

let ctx: ApiBCtx;
let seed: Seed;
let envId: string;
let actor: Principal;

const deps = () => ({
  prisma: ctx.prisma,
  logger: silent,
  publicBaseUrl: 'http://panel.example.test',
  globalBrowserCeiling: 1,
});

beforeAll(async () => {
  ctx = await makeApiBCtx();
});
afterAll(async () => ctx.close());

beforeEach(async () => {
  await resetDb(ctx.prisma);
  const qa = await ctx.prisma.panelUser.create({ data: { email: `qa-${Date.now()}@example.test`, name: 'QA Programadora', role: 'qa' } });
  ctx.qa = {
    authorization: (await apiTokenFor(ctx.prisma, qa.id, ['schedules.read', 'schedules.write', 'runs.read', 'runs.create', 'exclusion_windows.write'])).authorization,
    userId: qa.id,
  };
  ctx.service = { authorization: (await serviceTokenFor(ctx.prisma)).authorization };
  actor = { kind: 'panel_user', id: qa.id, role: 'qa', email: qa.email, sessionId: 'test' };
  seed = await seedCatalog(ctx.prisma, ['A', 'C', 'D'], [{ key: 'r1', cases: ['A'], tags: ['@humo'] }, { key: 'r3', cases: ['D'], tags: ['@ag'] }]);
  envId = (await createEnv(ctx.prisma)).env.id;
});

const LV_8_18_30 = { mode: 'intervalo' as const, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', everyMinutes: 30 };

async function schedule(body: Record<string, unknown>, now: Date) {
  return createSchedule(
    deps(),
    {
      name: 'Programación de prueba',
      environmentId: envId,
      timezone: 'America/La_Paz',
      retries: 0,
      enabled: true,
      notify: { onFailure: true, onInterruption: true, channels: [] },
      ...body,
    } as never,
    actor,
    now,
  );
}

async function tickEvery(from: Date, to: Date, stepMs: number, fn: (now: Date) => Promise<unknown>) {
  for (let t = from.getTime(); t <= to.getTime(); t += stepMs) await fn(new Date(t));
}

describe('materialización de ocurrencias (RF-PRG-01/04, ESP §13.5)', () => {
  it('RF-PRG-01 L-V 08:00–18:00 c/30 ⇒ 21 ocurrencias admitidas en un día simulado sin intervención', async () => {
    // Lunes 2026-11-09, America/La_Paz (UTC−4): 08:00 local = 12:00Z.
    const s = await schedule({ caseIds: [seed.cases.C!.id], editor: LV_8_18_30 }, new Date('2026-11-09T11:00:00Z'));
    expect(s.cronExpressions).toEqual(['0,30 8-17 * * 1-5', '0 18 * * 1-5']);
    await tickEvery(new Date('2026-11-09T11:59:50Z'), new Date('2026-11-09T22:01:00Z'), 15_000, (now) => schedulerTick(deps(), now));
    const occ = await ctx.prisma.scheduleOccurrence.findMany({ where: { scheduleId: s.id }, orderBy: { scheduledFor: 'asc' } });
    expect(occ).toHaveLength(21);
    expect(occ.every((o) => o.status === 'admitida' && o.runId)).toBe(true);
    expect(occ[0]!.scheduledFor.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(occ.at(-1)!.scheduledFor.toISOString()).toBe('2026-11-09T22:00:00.000Z');
    expect(occ.every((o) => o.timezone === 'America/La_Paz' && o.scheduleRevision === 1)).toBe(true);
    const runs = await ctx.prisma.run.findMany({ where: { scheduleId: s.id } });
    expect(runs).toHaveLength(21);
    expect(runs.every((r) => r.trigger === 'programada' && r.status === 'terminada' && r.outcome === 'bloqueado')).toBe(true);
    // Retraso de registro ≤ 60 s (RNF-REN-02): tick cada 15 s.
    expect(occ.every((o) => o.createdAt.getTime() > 0)).toBe(true);
  }, 120_000);

  it('RF-PRG-01 DST: hora inexistente se omite y la repetida corre solo una vez (misma política que la vista previa)', async () => {
    const s = await schedule({ caseIds: [seed.cases.C!.id], cronExpressions: ['30 1 * * *', '30 2 * * *'], timezone: 'America/New_York' }, new Date('2027-03-13T00:00:00Z'));
    // 14-mar-2027: 02:30 no existe (salto 02:00→03:00). Ticks cada 15 s alrededor de los instantes UTC.
    for (const day of ['2027-03-13', '2027-03-14', '2027-03-15']) {
      await tickEvery(new Date(`${day}T05:20:00Z`), new Date(`${day}T07:40:00Z`), 15_000, (now) => materializeDueOccurrences(deps(), now));
    }
    const spring = (await ctx.prisma.scheduleOccurrence.findMany({ where: { scheduleId: s.id }, orderBy: { scheduledFor: 'asc' } })).map((o) => o.scheduledFor.toISOString());
    expect(spring).toEqual([
      '2027-03-13T06:30:00.000Z', // 01:30 EST
      '2027-03-13T07:30:00.000Z', // 02:30 EST
      '2027-03-14T06:30:00.000Z', // 01:30 EST (02:30 no existe)
      '2027-03-15T05:30:00.000Z', // 01:30 EDT
      '2027-03-15T06:30:00.000Z', // 02:30 EDT
    ]);
  }, 120_000);

  it('RF-PRG-01 DST: hora repetida (fin de horario de verano) solo en su primera ocurrencia', async () => {
    const s = await schedule({ caseIds: [seed.cases.C!.id], cronExpressions: ['30 1 * * *'], timezone: 'America/New_York' }, new Date('2026-11-01T00:00:00Z'));
    await tickEvery(new Date('2026-11-01T05:20:00Z'), new Date('2026-11-01T06:40:00Z'), 15_000, (now) => materializeDueOccurrences(deps(), now));
    const occ = await ctx.prisma.scheduleOccurrence.findMany({ where: { scheduleId: s.id } });
    expect(occ.map((o) => o.scheduledFor.toISOString())).toEqual(['2026-11-01T05:30:00.000Z']);
  }, 60_000);

  it('RF-PRG-04 solapamiento: corrida activa ⇒ siguiente ocurrencia omitida/solapamiento sin acumular', async () => {
    const t0 = new Date('2026-11-09T12:00:00Z');
    const s = await schedule({ caseIds: [seed.cases.D!.id], cronExpressions: ['*/5 * * * *'] }, new Date(t0.getTime() - 60_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 5_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 5 * 60_000 + 5_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 10 * 60_000 + 5_000));
    const occ = await ctx.prisma.scheduleOccurrence.findMany({ where: { scheduleId: s.id }, orderBy: { scheduledFor: 'asc' } });
    expect(occ.map((o) => [o.status, o.reason])).toEqual([
      ['admitida', null],
      ['omitida', 'solapamiento'],
      ['omitida', 'solapamiento'],
    ]);
    expect(await ctx.prisma.run.count({ where: { scheduleId: s.id } })).toBe(1);
  });

  it('RF-PRG-04 saturación: sin capacidad espera ≤ 60 s y luego omitida/sin_capacidad sin destino externo', async () => {
    // Ocupa la única capacidad global con una corrida manual.
    const plan = await resolvePlan(ctx.prisma, {
      selection: { kind: 'cases', caseIds: [seed.cases.A!.id] },
      environmentId: envId,
      retries: 0,
      excludeFlaky: false,
      testrail: { mode: 'nueva' },
      trigger: 'manual',
    });
    const holder = await runInTransaction(ctx.prisma, (tx) => createRunFromPlan(tx, deps(), plan, { trigger: 'manual', actor }, new Date()));
    const t0 = new Date('2026-11-09T12:00:00Z');
    await schedulerTick(deps(), new Date(t0.getTime() - 1000)); // admite la corrida manual
    const s = await schedule({ caseIds: [seed.cases.D!.id], cronExpressions: ['0 * * * *'] }, new Date(t0.getTime() - 60_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 2_000));
    let occ = await ctx.prisma.scheduleOccurrence.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(occ.status).toBe('admitida');
    const queued = await ctx.prisma.run.findUniqueOrThrow({ where: { id: occ.runId! } });
    expect(queued.status).toBe('en_cola');
    await schedulerTick(deps(), new Date(t0.getTime() + 30_000));
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('en_cola');
    await schedulerTick(deps(), new Date(t0.getTime() + 61_000));
    const omitted = await ctx.prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
    expect(omitted).toMatchObject({ status: 'omitida', outcome: 'incompleto', reason: 'sin_capacidad', syncStatus: 'no_aplica' });
    occ = await ctx.prisma.scheduleOccurrence.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(occ).toMatchObject({ status: 'omitida', reason: 'sin_capacidad' });
    expect(await ctx.prisma.outboxDelivery.count({ where: { runId: queued.id, operation: { startsWith: 'testrail.' } } })).toBe(0);
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: holder } })).status).not.toBe('omitida');
  });

  it('RF-PRG-03 pausar cancela corridas no iniciadas con motivo; reanudar sin catch-up', async () => {
    const t0 = new Date('2026-11-09T12:00:00Z');
    const s = await schedule({ caseIds: [seed.cases.D!.id], cronExpressions: ['*/10 * * * *'] }, new Date(t0.getTime() - 60_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 1_000));
    const first = await ctx.prisma.scheduleOccurrence.findFirstOrThrow({ where: { scheduleId: s.id } });
    await setSchedulePaused(deps(), s.id, true, actor, new Date(t0.getTime() + 2 * 60_000));
    const cancelled = await ctx.prisma.run.findUniqueOrThrow({ where: { id: first.runId! } });
    expect(cancelled).toMatchObject({ status: 'cancelada', reason: 'cancelado_por_programacion' });
    // Durante la pausa no se registran ocurrencias.
    await tickEvery(new Date(t0.getTime() + 5 * 60_000), new Date(t0.getTime() + 45 * 60_000), 60_000, (now) => schedulerTick(deps(), now));
    expect(await ctx.prisma.scheduleOccurrence.count({ where: { scheduleId: s.id } })).toBe(1);
    await setSchedulePaused(deps(), s.id, false, actor, new Date(t0.getTime() + 45 * 60_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 45 * 60_000 + 1_000));
    expect(await ctx.prisma.scheduleOccurrence.count({ where: { scheduleId: s.id } })).toBe(1); // sin catch-up
    await schedulerTick(deps(), new Date(t0.getTime() + 50 * 60_000 + 1_000));
    const occ = await ctx.prisma.scheduleOccurrence.findMany({ where: { scheduleId: s.id }, orderBy: { scheduledFor: 'asc' } });
    expect(occ.map((o) => o.scheduledFor.toISOString())).toEqual(['2026-11-09T12:00:00.000Z', '2026-11-09T12:50:00.000Z']);
    expect(occ[1]!.scheduleRevision).toBe(3);
    const revs = await ctx.prisma.scheduleRevision.findMany({ where: { scheduleId: s.id }, orderBy: { revision: 'asc' } });
    expect(revs.map((r) => [r.revision, r.action, r.changedById])).toEqual([
      [1, 'create', actor.id],
      [2, 'pause', actor.id],
      [3, 'resume', actor.id],
    ]);
  });

  it('RF-PRG-04 huecos tras caída ⇒ ocurrencias omitidas (caida_servicio) por lotes, sin ráfaga', async () => {
    const t0 = new Date('2026-11-09T12:00:00Z');
    const s = await schedule({ caseIds: [seed.cases.C!.id], cronExpressions: ['0,30 * * * *'] }, new Date(t0.getTime() - 60_000));
    // El servicio vuelve 3 h 5 min después.
    const st = await materializeDueOccurrences(deps(), new Date(t0.getTime() + 3 * 3_600_000 + 5 * 60_000));
    expect(st.omitted.caida_servicio).toBe(7);
    expect(st.admitted).toBe(0);
    expect(await ctx.prisma.run.count({ where: { scheduleId: s.id } })).toBe(0);
    const cursor = await ctx.prisma.reconciliationCursor.findUniqueOrThrow({ where: { scheduleId: s.id } });
    expect(cursor.reconciledUntil.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    // Idempotente: repetir no duplica.
    await materializeDueOccurrences(deps(), new Date(t0.getTime() + 3 * 3_600_000 + 6 * 60_000));
    expect(await ctx.prisma.scheduleOccurrence.count({ where: { scheduleId: s.id } })).toBe(7);
  });

  it('RF-PRG-05 ventana de exclusión ⇒ omitida/ventana_exclusion', async () => {
    const t0 = new Date('2026-11-09T12:00:00Z');
    const s = await schedule({ caseIds: [seed.cases.C!.id], cronExpressions: ['0 * * * *'] }, new Date(t0.getTime() - 60_000));
    await ctx.prisma.exclusionWindow.create({
      data: { environmentId: envId, startsAt: new Date(t0.getTime() - 60_000), endsAt: new Date(t0.getTime() + 60_000), reason: 'despliegue' },
    });
    await materializeDueOccurrences(deps(), new Date(t0.getTime() + 5_000));
    const occ = await ctx.prisma.scheduleOccurrence.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(occ).toMatchObject({ status: 'omitida', reason: 'ventana_exclusion', runId: null });
  });

  it('RF-PRG-01 programación bloquea vínculos con revisión pendiente (no se ejecutan)', async () => {
    await ctx.prisma.testCaseLink.updateMany({ where: { automatedTestId: seed.tests.r3!.id }, data: { reviewStatus: 'requiere_revision' } });
    const t0 = new Date('2026-11-09T12:00:00Z');
    const s = await schedule({ caseIds: [seed.cases.D!.id], cronExpressions: ['0 * * * *'] }, new Date(t0.getTime() - 60_000));
    await schedulerTick(deps(), new Date(t0.getTime() + 2_000));
    const run = await ctx.prisma.run.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(run).toMatchObject({ status: 'terminada', outcome: 'bloqueado' });
    const rr = await ctx.prisma.runResult.findFirstOrThrow({ where: { runId: run.id } });
    expect(rr).toMatchObject({ status: 'bloqueado', reason: 'revision_pendiente' });
  });
});

describe('rutas de programaciones (RF-PRG-01/02/03)', () => {
  const H = () => ({ authorization: ctx.qa.authorization });
  const body = () => ({ name: 'Humo diario', caseIds: [seed.cases.A!.id], environmentId: envId, editor: LV_8_18_30 });

  it('RF-PRG-02 CRUD, próximas 5, revisiones con autor, duplicar y borrado lógico', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/schedules', headers: H(), payload: body() });
    expect(created.statusCode).toBe(201);
    const s = created.json();
    expect(s).toMatchObject({ revision: 1, timezone: 'America/La_Paz', cronExpressions: ['0,30 8-17 * * 1-5', '0 18 * * 1-5'] });
    expect(s.description).toContain('cada 30 min');
    const next = await ctx.app.inject({ method: 'GET', url: `/api/v1/schedules/${s.id}/next?count=5&after=2026-11-09T11:00:00Z`, headers: H() });
    expect(next.json().occurrences.map((o: { local: string }) => o.local)).toEqual([
      '2026-11-09T08:00',
      '2026-11-09T08:30',
      '2026-11-09T09:00',
      '2026-11-09T09:30',
      '2026-11-09T10:00',
    ]);
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/v1/schedules/${s.id}`, headers: H(), payload: { ...body(), revision: 7 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const upd = await ctx.app.inject({ method: 'PUT', url: `/api/v1/schedules/${s.id}`, headers: H(), payload: { ...body(), name: 'Humo', revision: 1 } });
    expect(upd.json()).toMatchObject({ revision: 2, name: 'Humo' });
    const revs = (await ctx.app.inject({ method: 'GET', url: `/api/v1/schedules/${s.id}/revisions`, headers: H() })).json();
    expect(revs.items.map((r: { revision: number; action: string; changedBy: { id: string } }) => [r.revision, r.action, r.changedBy.id])).toEqual([
      [2, 'update', ctx.qa.userId],
      [1, 'create', ctx.qa.userId],
    ]);
    expect(revs.items[0].diff.name).toEqual({ from: 'Humo diario', to: 'Humo' });
    const paused = await ctx.app.inject({ method: 'POST', url: `/api/v1/schedules/${s.id}/pause`, headers: H() });
    expect(paused.json()).toMatchObject({ enabled: false, revision: 3, nextOccurrence: null });
    const dup = await ctx.app.inject({ method: 'POST', url: `/api/v1/schedules/${s.id}/duplicate`, headers: H(), payload: {} });
    expect(dup.statusCode).toBe(201);
    expect(dup.json()).toMatchObject({ name: 'Humo (copia)', enabled: false, revision: 1 });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/v1/schedules?limit=1', headers: H() })).json();
    expect(list.items).toHaveLength(1);
    expect(list.hasNext).toBe(true);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/schedules/${s.id}`, headers: H() });
    expect(del.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/schedules/${s.id}`, headers: H() })).statusCode).toBe(404);
    expect(await ctx.prisma.schedule.count({ where: { id: s.id } })).toBe(1); // borrado lógico
    const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: s.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['schedule.create', 'schedule.update', 'schedule.pause', 'schedule.delete']);
  });

  it('RF-PRG-01 validaciones 422: cron inválido, intervalo < 5 min, rango que cruza medianoche, selección vacía', async () => {
    const bad = async (p: Record<string, unknown>) =>
      (await ctx.app.inject({ method: 'POST', url: '/api/v1/schedules', headers: H(), payload: { name: 'x', environmentId: envId, caseIds: [seed.cases.A!.id], ...p } })).json().error.code;
    expect(await bad({ cronExpressions: ['61 * * * *'] })).toBe('CRON_INVALID');
    expect(await bad({ cronExpressions: ['*/2 * * * *'] })).toBe('CRON_INTERVAL_TOO_SHORT');
    expect(await bad({ editor: { mode: 'intervalo', days: [1], start: '22:00', end: '02:00', everyMinutes: 30 } })).toBe('SCHEDULE_RANGE_CROSSES_MIDNIGHT');
    expect(await bad({ cronExpressions: ['0 8 * * *'], timezone: 'Mars/Olympus' })).toBe('TIMEZONE_INVALID');
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: H(),
      payload: { name: 'x', environmentId: envId, tags: ['@nada'], cronExpressions: ['0 8 * * *'] },
    });
    expect(empty.json().error.code).toBe('SELECTION_EMPTY');
    const preview = await ctx.app.inject({ method: 'POST', url: '/api/v1/schedules/preview', headers: H(), payload: { editor: LV_8_18_30, count: 3 } });
    expect(preview.json().occurrences).toHaveLength(3);
  });

  it('RF-PRG-05 ventanas de exclusión: crear, listar activas y borrar (auditado)', async () => {
    const dev = await ctx.prisma.panelUser.create({ data: { email: `dev-${Date.now()}@example.test`, name: 'Dev', role: 'dev' } });
    const auth = (await apiTokenFor(ctx.prisma, dev.id, ['schedules.read', 'exclusion_windows.write'])).authorization;
    const w = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/exclusion-windows',
      headers: { authorization: auth },
      payload: { environmentId: envId, startsAt: '2026-11-09T12:00:00Z', endsAt: '2026-11-09T13:00:00Z', reason: 'Despliegue' },
    });
    expect(w.statusCode).toBe(201);
    const active = await ctx.app.inject({ method: 'GET', url: '/api/v1/exclusion-windows?activeAt=2026-11-09T12:30:00Z', headers: { authorization: auth } });
    expect(active.json().items).toHaveLength(1);
    const qaCreate = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/exclusion-windows',
      headers: H(),
      payload: { startsAt: '2026-11-09T12:00:00Z', endsAt: '2026-11-09T13:00:00Z', reason: 'x' },
    });
    expect(qaCreate.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/exclusion-windows/${w.json().id}`, headers: { authorization: auth } })).statusCode).toBe(200);
  });
});

describe('BullMQ y reconciliación con Redis real (RNF-CON-04, ESP §13.5)', () => {
  it('RF-PRG-01 Job Schedulers sincronizados desde PostgreSQL (alta, pausa, Redis vaciado)', async () => {
    const prefix = `${ctx.config.QUEUE_PREFIX}-sched`;
    const q = createTriggerQueue(bullConnectionFromUrl(ctx.config.REDIS_URL), prefix);
    try {
      await q.obliterate({ force: true });
      const s = await schedule({ caseIds: [seed.cases.C!.id], editor: LV_8_18_30 }, new Date());
      expect(await syncScheduleTriggers(ctx.prisma, q)).toEqual({ upserted: 2, removed: 0 });
      const js = await q.getJobSchedulers(0, -1);
      expect(js.map((j) => j.pattern).sort()).toEqual(['0 18 * * 1-5', '0,30 8-17 * * 1-5']);
      expect(js.every((j) => j.tz === 'America/La_Paz')).toBe(true);
      expect(await syncScheduleTriggers(ctx.prisma, q)).toEqual({ upserted: 0, removed: 0 });
      // Redis vaciado: el reconciliador los reconstruye desde la BD.
      await q.obliterate({ force: true });
      expect((await syncScheduleTriggers(ctx.prisma, q)).upserted).toBe(2);
      await setSchedulePaused(deps(), s.id, true, actor);
      expect(await syncScheduleTriggers(ctx.prisma, q)).toEqual({ upserted: 0, removed: 2 });
    } finally {
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
  });

  it('RNF-CON-04 despacho: trabajo perdido en Redis se reconstruye desde la BD; el supervisor reclama una sola vez', async () => {
    const prefix = `${ctx.config.QUEUE_PREFIX}-shards`;
    const q = createShardQueue(bullConnectionFromUrl(ctx.config.REDIS_URL), prefix);
    try {
      await q.obliterate({ force: true });
      const plan = await resolvePlan(ctx.prisma, {
        selection: { kind: 'cases', caseIds: [seed.cases.D!.id] },
        environmentId: envId,
        retries: 0,
        excludeFlaky: false,
        testrail: { mode: 'nueva' },
        trigger: 'manual',
      });
      const runId = await runInTransaction(ctx.prisma, (tx) => createRunFromPlan(tx, deps(), plan, { trigger: 'manual', actor }, new Date()));
      await schedulerTick(deps(), new Date());
      expect((await dispatchPendingDeliveries(ctx.prisma, q)).delivered).toBe(1);
      const waiting = await q.getJobs(['waiting']);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]!.data).toEqual({ runId, shardId: waiting[0]!.data.shardId });
      expect(Object.keys(waiting[0]!.data).sort()).toEqual(['runId', 'shardId']);
      // Reinicio de Redis sin persistencia: se pierde el trabajo.
      await q.obliterate({ force: true });
      const r = await redispatchStaleShards(ctx.prisma, new Date(Date.now() + 61_000));
      expect(r.redispatched).toBe(1);
      expect((await dispatchPendingDeliveries(ctx.prisma, q, new Date(Date.now() + 61_000))).delivered).toBe(1);
      const again = await q.getJobs(['waiting']);
      expect(again).toHaveLength(1);
      // Dos entregas del mismo shard (al menos una vez) ⇒ un solo lease.
      const w1 = new FakeWorker(ctx);
      const w2 = new FakeWorker(ctx);
      expect((await w1.claim(runId, again[0]!.data.shardId)).statusCode).toBe(200);
      expect((await w2.claim(runId, again[0]!.data.shardId)).statusCode).toBe(409);
    } finally {
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
  });

  it('RNF-CON-04 reinicio de la API: la idempotencia y el estado viven en PostgreSQL', async () => {
    const { makeCtx } = await import('./support/api-a.js');
    const key = `restart-${Date.now()}`;
    const payload = { caseIds: [seed.cases.C!.id], environmentId: envId };
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/v1/runs', headers: { authorization: ctx.qa.authorization, 'idempotency-key': key }, payload });
    expect(r1.statusCode).toBe(201);
    const other = await makeCtx({ QUEUE_PREFIX: ctx.config.QUEUE_PREFIX });
    try {
      const r2 = await other.app.inject({ method: 'POST', url: '/api/v1/runs', headers: { authorization: ctx.qa.authorization, 'idempotency-key': key }, payload });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().id).toBe(r1.json().id);
    } finally {
      await other.close();
    }
  });
});

void Queue;
