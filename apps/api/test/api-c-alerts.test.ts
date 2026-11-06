/**
 * Umbrales, alertas y notificaciones (ESP §13.8, §14 "Monitoreo"): estrictamente mayor, muestra insuficiente,
 * series separadas, una alerta por hora también tras reinicio (simulado con evaluaciones independientes), mutex
 * con evaluadores concurrentes, recuperación sin notificación, outbox con reintentos sin alertas nuevas, entrega
 * ambigua, notificación de corrida fallida/interrumpida. RF-REN-03, RF-NOT-01, RF-NOT-02, RF-NOT-03.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type OutboxDelivery } from '@prisma/client';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import type { OutboxCtx } from '../src/lib/outbox.js';
import { evaluatePerfThresholds } from '../src/control/perf-evaluator.js';
import { createFakeNotifiers } from '../src/adapters/notifier/index.js';
import { alertHandler, enqueueRunFinishedNotification, runFinishedHandler } from '../src/modules/notifications/dispatch.js';
import { getPreferences, updatePreferences } from '../src/modules/notifications/preferences.js';
import { createThreshold } from '../src/modules/perf/thresholds.js';
import type { Principal } from '../src/lib/auth.js';
import { createEnvironment, createRun } from './support/api-c.js';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
const config = loadConfig({ ...process.env, PUBLIC_BASE_URL: 'https://katalyst.example.test' });
const secrets = new MemorySecretProvider({
  'env:KATALYST_SECRET__SLACK_TEST': 'https://hooks.slack.com/services/T000/B000/XXXXSYNTHETIC',
  'env:KATALYST_SECRET__SMTP_TEST': 'usuario:clave-sintetica',
});
afterAll(() => prisma.$disconnect());

const T0 = new Date(Date.now() - 5 * 60_000);
const MIN = 60_000;

async function admin(): Promise<Principal & { kind: 'panel_user' }> {
  const u = await prisma.panelUser.create({ data: { email: `a-${crypto.randomUUID().slice(0, 8)}@example.test`, name: 'Admin', role: 'admin' } });
  return { kind: 'panel_user', id: u.id, role: 'admin', email: u.email, sessionId: crypto.randomUUID() };
}

async function resetChannels(kinds: ('slack' | 'correo')[] = ['slack']) {
  await prisma.notificationChannel.deleteMany();
  for (const k of kinds) {
    await prisma.notificationChannel.create({
      data:
        k === 'slack'
          ? { kind: 'slack', enabled: true, secretRef: 'env:KATALYST_SECRET__SLACK_TEST', recipients: [] }
          : {
              kind: 'correo',
              enabled: true,
              secretRef: 'env:KATALYST_SECRET__SMTP_TEST',
              recipients: ['equipo-qa@example.test'],
              smtp: { host: 'smtp.example.test', port: 587, from: 'katalyst@example.test', secure: true },
            },
    });
  }
}

async function seedSamples(envId: string, values: number[], at: Date, opts: { cacheMode?: 'fria' | 'caliente'; timeouts?: number } = {}) {
  const run = await createRun(prisma, envId);
  await prisma.perfSample.createMany({
    data: [
      ...values.map((ms, i) => ({
        runId: run.id,
        environmentId: envId,
        sampleKey: `v${i}`,
        schemaVersion: 1,
        ts: new Date(at.getTime() - (i + 1) * 1000),
        provenance: 'playwright' as const,
        source: 'app' as const,
        metricKind: 'network_request' as const,
        endpointKey: 'GET /warehouse/api/warehouse/list/scheduling',
        statusCode: 200,
        ok: true,
        totalMs: ms,
        over29s: ms > 29_000,
        cacheMode: opts.cacheMode ?? 'caliente',
        workerProfile: 'linux-2cpu',
      })),
      ...Array.from({ length: opts.timeouts ?? 0 }, (_, i) => ({
        runId: run.id,
        environmentId: envId,
        sampleKey: `t${i}`,
        schemaVersion: 1,
        ts: new Date(at.getTime() - (i + 1) * 1500),
        provenance: 'playwright' as const,
        source: 'app' as const,
        metricKind: 'network_request' as const,
        endpointKey: 'GET /warehouse/api/warehouse/list/scheduling',
        timeout: true,
        censored: true,
        censoredAtMs: 20_000,
        timeoutLimitMs: 20_000,
        cacheMode: opts.cacheMode ?? 'caliente',
        workerProfile: 'linux-2cpu',
      })),
    ],
  });
}

async function threshold(envId: string, over: Partial<{ metric: 'p95' | 'max' | 'error_rate' | 'timeout_rate'; limit: number; windowMin: number; minSamples: number; cacheMode: 'fria' | 'caliente' }> = {}) {
  const metric = over.metric ?? 'p95';
  return createThreshold(prisma, await admin(), {
    environmentId: envId,
    seriesSelector: {
      endpointKey: 'GET /warehouse/api/warehouse/list/scheduling',
      provenance: 'playwright',
      source: 'app',
      metricKind: 'network_request',
      cacheMode: over.cacheMode ?? 'caliente',
      workerProfile: 'linux-2cpu',
    },
    metric,
    limit: over.limit ?? 10_000,
    windowMin: over.windowMin ?? 60,
    minSamples: over.minSamples ?? 20,
    enabled: true,
    label: 'Agendamientos lista p95',
  });
}

async function deliveriesFor(thresholdId: string): Promise<OutboxDelivery[]> {
  return prisma.outboxDelivery.findMany({ where: { alert: { thresholdId } }, orderBy: { createdAt: 'asc' } });
}

function outboxCtx(delivery: OutboxDelivery): OutboxCtx {
  return {
    prisma,
    logger: createLogger({ level: 'silent', service: 'test' }),
    secrets,
    now: new Date(),
    attempt: delivery.attempts + 1,
    previousAmbiguous: false,
    signal: new AbortController().signal,
  };
}

async function onlyThresholds(ids: string[]) {
  // Aísla el evaluador: deshabilita umbrales de otras pruebas.
  await prisma.perfThreshold.updateMany({ where: { id: { notIn: ids } }, data: { enabled: false } });
}

beforeEach(async () => {
  await resetChannels(['slack']);
});

describe('evaluador de umbrales (RF-REN-03, RF-NOT-02, ESP §13.8)', () => {
  it('RF-NOT-02 umbral superado envía UNA alerta por hora, también tras reinicio; mutex con evaluadores concurrentes', async () => {
    const env = await createEnvironment(prisma);
    const t = await threshold(env.id, { windowMin: 180 });
    await onlyThresholds([t.id]);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 12_000), T0);
    // Dos evaluadores concurrentes (dos réplicas) en el mismo instante → un solo envío.
    const [a, b] = await Promise.all([
      evaluatePerfThresholds({ prisma, config, now: T0 }),
      evaluatePerfThresholds({ prisma, config, now: T0 }),
    ]);
    expect(a.exceeded + b.exceeded).toBe(2);
    expect(a.enqueued + b.enqueued).toBe(1);
    expect(await deliveriesFor(t.id)).toHaveLength(1);
    // "Reinicio": nuevo ciclo independiente 10 y 59 min después → suprimido (estado en BD).
    await evaluatePerfThresholds({ prisma, config, now: new Date(T0.getTime() + 10 * MIN) });
    await evaluatePerfThresholds({ prisma, config, now: new Date(T0.getTime() + 59 * MIN) });
    expect(await deliveriesFor(t.id)).toHaveLength(1);
    // 60 min después del último envío (ventana móvil) → segundo envío.
    await evaluatePerfThresholds({ prisma, config, now: new Date(T0.getTime() + 60 * MIN) });
    const ds = await deliveriesFor(t.id);
    expect(ds).toHaveLength(2);
    const alert = await prisma.alert.findFirstOrThrow({ where: { thresholdId: t.id } });
    expect(alert).toMatchObject({ status: 'activa', sendCount: 2, channel: 'slack', kind: 'umbral_rendimiento' });
    expect(alert.fingerprint).toContain(t.id);
    expect((alert.payload as { value: number }).value).toBe(12_000);
  });

  it('RF-REN-03 estrictamente mayor: p95 igual al límite no dispara; muestra insuficiente no dispara', async () => {
    const env = await createEnvironment(prisma);
    const equal = await threshold(env.id, { limit: 12_000 });
    const env2 = await createEnvironment(prisma);
    const insufficient = await threshold(env2.id, { limit: 100 });
    await onlyThresholds([equal.id, insufficient.id]);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 12_000), T0);
    await seedSamples(env2.id, Array.from({ length: 19 }, () => 50_000), T0);
    const r = await evaluatePerfThresholds({ prisma, config, now: T0 });
    expect(r.exceeded).toBe(0);
    expect(await prisma.alert.count({ where: { thresholdId: { in: [equal.id, insufficient.id] } } })).toBe(0);
    const t2 = await prisma.perfThreshold.findUniqueOrThrow({ where: { id: insufficient.id } });
    expect(t2.lastState).toBe('insuficiente');
    expect(t2.lastN).toBe(19);
    expect((await prisma.perfThreshold.findUniqueOrThrow({ where: { id: equal.id } })).lastState).toBe('normal');
  });

  it('RF-REN-03 serie separada por caché: muestras frías no disparan el umbral de la serie caliente; timeout_rate con censuradas', async () => {
    const env = await createEnvironment(prisma);
    const hot = await threshold(env.id, { cacheMode: 'caliente' });
    const rate = await threshold(env.id, { metric: 'timeout_rate', limit: 0.1, cacheMode: 'fria' });
    await onlyThresholds([hot.id, rate.id]);
    // Frías lentas + 5 timeouts: 25 válidas iniciadas, timeout_rate = 5/25 = 0,2 > 0,1.
    await seedSamples(env.id, Array.from({ length: 20 }, () => 25_000), T0, { cacheMode: 'fria', timeouts: 5 });
    await seedSamples(env.id, Array.from({ length: 25 }, () => 100), T0, { cacheMode: 'caliente' });
    await evaluatePerfThresholds({ prisma, config, now: T0 });
    expect((await prisma.perfThreshold.findUniqueOrThrow({ where: { id: hot.id } })).lastState).toBe('normal');
    const r = await prisma.perfThreshold.findUniqueOrThrow({ where: { id: rate.id } });
    expect(r.lastState).toBe('superado');
    expect(r.lastValue).toBeCloseTo(0.2, 10);
  });

  it('RF-NOT-02 recuperación registrada sin notificación adicional', async () => {
    const env = await createEnvironment(prisma);
    const t = await threshold(env.id, { windowMin: 10 });
    await onlyThresholds([t.id]);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 15_000), T0);
    await evaluatePerfThresholds({ prisma, config, now: T0 });
    const later = new Date(T0.getTime() + 15 * MIN);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 200), later);
    const r = await evaluatePerfThresholds({ prisma, config, now: later });
    expect(r.recovered).toBe(1);
    const alert = await prisma.alert.findFirstOrThrow({ where: { thresholdId: t.id } });
    expect(alert.status).toBe('recuperada');
    expect(alert.recoveredAt).not.toBeNull();
    expect(await deliveriesFor(t.id)).toHaveLength(1);
  });

  it('RF-NOT-02 sin canal configurado la alerta queda registrada para el panel sin envío', async () => {
    await prisma.notificationChannel.deleteMany();
    const env = await createEnvironment(prisma);
    const t = await threshold(env.id);
    await onlyThresholds([t.id]);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 15_000), T0);
    const r = await evaluatePerfThresholds({ prisma, config, now: T0 });
    expect(r.enqueued).toBe(0);
    const alert = await prisma.alert.findFirstOrThrow({ where: { thresholdId: t.id } });
    expect(alert.channel).toBeNull();
    expect(alert.status).toBe('activa');
  });
});

describe('handlers de outbox (RF-NOT-01, RF-NOT-02, ESP §13.8)', () => {
  it('RF-NOT-02 envío por el canal, reintento sin alerta nueva, entrega ambigua registrada, falla permanente a intervención', async () => {
    const env = await createEnvironment(prisma);
    const t = await threshold(env.id);
    await onlyThresholds([t.id]);
    await seedSamples(env.id, Array.from({ length: 25 }, () => 15_000), T0);
    await evaluatePerfThresholds({ prisma, config, now: T0 });
    const [d] = await deliveriesFor(t.id);
    const fakes = createFakeNotifiers();
    const handler = alertHandler({ config, notifiers: () => fakes });
    fakes.slack.enqueueResult(
      { outcome: 'reintentable', message: 'El webhook respondió 503', httpStatus: 503 },
      { outcome: 'ambigua', message: 'Entrega ambigua' },
      { outcome: 'permanente', message: 'El webhook rechazó el mensaje (404)', httpStatus: 404 },
    );
    expect(await handler(d!, outboxCtx(d!))).toMatchObject({ kind: 'retry', httpStatus: 503 });
    expect(await handler(d!, outboxCtx(d!))).toMatchObject({ kind: 'delivered', note: 'entrega_ambigua' });
    expect(await handler(d!, outboxCtx(d!))).toMatchObject({ kind: 'intervention' });
    expect(await prisma.alert.count({ where: { thresholdId: t.id } })).toBe(1);
    const alert = await prisma.alert.findFirstOrThrow({ where: { thresholdId: t.id } });
    expect((alert.payload as { deliveryAmbiguous?: boolean }).deliveryAmbiguous).toBe(true);
    const sent = fakes.slack.sent[0]!;
    expect(sent.hasSecret).toBe(true);
    expect(sent.message.subject).toContain('Umbral superado');
    expect(sent.message.link).toMatch(/^https:\/\/katalyst\.example\.test\/rendimiento\?/);
    expect(JSON.stringify(sent.message)).not.toContain('hooks.slack.com');
  });

  it('RF-NOT-01 corrida con fallas: una notificación por canal (idempotente) con resumen y enlace autenticado; correo a suscriptores (RF-NOT-03)', async () => {
    await resetChannels(['slack', 'correo']);
    const env = await createEnvironment(prisma);
    const a = await admin();
    const user = await prisma.panelUser.create({ data: { email: `qa-${crypto.randomUUID().slice(0, 6)}@example.test`, name: 'QA', role: 'qa' } });
    const qa: Principal = { kind: 'panel_user', id: user.id, role: 'qa', email: user.email, sessionId: crypto.randomUUID() };
    const run = await createRun(prisma, env.id, { status: 'terminada', outcome: 'fallido', createdById: user.id });
    await updatePreferences(prisma, qa, user.id, {
      channels: ['correo'],
      events: ['corrida_con_fallas'],
      scheduleIds: [],
      allSchedules: false,
      thresholdIds: [],
      allThresholds: false,
    });
    expect((await getPreferences(prisma, user.id)).events).toEqual(['corrida_con_fallas']);
    const r1 = await prisma.$transaction((tx) => enqueueRunFinishedNotification(tx, run.id, config));
    const r2 = await prisma.$transaction((tx) => enqueueRunFinishedNotification(tx, run.id, config));
    expect(r1).toEqual({ enqueued: 2, event: 'corrida_con_fallas' });
    expect(r2.enqueued).toBe(0);
    const ds = await prisma.outboxDelivery.findMany({ where: { runId: run.id, operation: 'notification.run_finished' } });
    expect(ds).toHaveLength(2);
    const fakes = createFakeNotifiers();
    const handler = runFinishedHandler({ config, notifiers: () => fakes });
    for (const d of ds) expect(await handler(d, outboxCtx(d))).toMatchObject({ kind: 'delivered' });
    const mail = fakes.correo.sent[0]!;
    expect(mail.recipients.sort()).toEqual(['equipo-qa@example.test', user.email.toLowerCase()].sort());
    expect(mail.message.link).toBe(`https://katalyst.example.test/ejecuciones/${run.id}`);
    expect(mail.message.subject).toContain('Ejecución con fallas');
    expect(fakes.slack.sent).toHaveLength(1);
    void a;
  });

  it('RF-NOT-01 interrumpida notifica; pasada no; programación con onFailure=false no notifica fallas', async () => {
    const env = await createEnvironment(prisma);
    const interrupted = await createRun(prisma, env.id, { status: 'interrumpida', outcome: 'incompleto' });
    const ok = await createRun(prisma, env.id, { status: 'terminada', outcome: 'pasado' });
    expect((await prisma.$transaction((tx) => enqueueRunFinishedNotification(tx, interrupted.id, config))).event).toBe('corrida_interrumpida');
    expect(await prisma.$transaction((tx) => enqueueRunFinishedNotification(tx, ok.id, config))).toEqual({ enqueued: 0, event: null });
    const schedule = await prisma.schedule.create({
      data: {
        name: 'Humo diario',
        selector: { tags: ['@humo'] },
        environmentId: env.id,
        cronExpressions: ['0 8 * * 1-5'],
        notify: { onFailure: false, onInterruption: true, channels: [] },
      },
    });
    const failed = await createRun(prisma, env.id, { status: 'terminada', outcome: 'fallido', scheduleId: schedule.id, trigger: 'programada' });
    expect((await prisma.$transaction((tx) => enqueueRunFinishedNotification(tx, failed.id, config))).enqueued).toBe(0);
  });
});
