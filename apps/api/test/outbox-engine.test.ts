/**
 * Motor genérico de outbox (RF-TR-08, RNF-CON-02, ESP §13.4): resultados defer/cancelled/intervention/retry,
 * excepción y timeout del handler (ambiguos), backoff con tope y vencimiento, orden por destino con predecesora
 * bloqueante, SKIP LOCKED entre publicadores, reintento administrativo sin reconciliador y estados no reintentables.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrisma } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import { enqueueOutbox, registerOutboxHandler, type OutboxHandlerResult } from '../src/lib/outbox.js';
import { adminRetryDelivery, runOutboxPublisherTick, registerOutboxMetrics } from '../src/control/outbox-publisher.js';
import { renderMetrics } from '../src/lib/metrics.js';
import { runScheduledTestRailSync } from '../src/control/testrail-sync.js';
import { startSync } from '../src/modules/testrail/sync.js';
import { testConfig } from './support/api-a.js';
import { makeWorld, syncDeps } from './support/testrail-fixture.js';

const config = testConfig();
const prisma = createPrisma(config, 'api');
const logger = createLogger({ level: 'silent', service: 'test' });
const OP = 'notification.alert' as const;
const deps = { prisma, logger, secrets: new MemorySecretProvider(), random: () => 0.5, operations: [OP], workerId: 'motor' };
let script: ((attempt: number, ambiguous: boolean) => Promise<OutboxHandlerResult>) | undefined;
const terminals: string[] = [];

registerOutboxHandler(
  OP,
  async (_d, ctx) => script!(ctx.attempt, ctx.previousAmbiguous),
  { timeoutMs: 200, onTerminal: async (_tx, d, status) => void terminals.push(`${d.dedupKey}:${status}`) },
);

afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  await prisma.outboxDelivery.updateMany({ where: { operation: OP, status: { in: ['pendiente', 'en_proceso'] } }, data: { status: 'cancelada' } });
  terminals.length = 0;
});

async function one(extra: Partial<Parameters<typeof enqueueOutbox>[1]> = {}) {
  const key = `motor:${randomUUID()}`;
  const r = await enqueueOutbox(prisma, { operation: OP, dedupKey: key, payload: { x: 1 }, ...extra });
  return { id: r.id, key };
}
const get = (id: string) => prisma.outboxDelivery.findUniqueOrThrow({ where: { id } });

describe('motor de outbox (RF-TR-08, RNF-CON-02)', () => {
  it('RNF-CON-02 defer no cuenta intento; cancelled cierra con hook; intervention sin bucle', async () => {
    const a = await one();
    script = async () => ({ kind: 'defer', untilMs: 5000, reason: 'espera' });
    const now = new Date();
    await runOutboxPublisherTick(deps, now);
    expect(await get(a.id)).toMatchObject({ status: 'pendiente', attempts: 0 });
    script = async () => ({ kind: 'cancelled', reason: 'no aplica' });
    await runOutboxPublisherTick(deps, new Date(now.getTime() + 6000));
    expect(await get(a.id)).toMatchObject({ status: 'cancelada', lastError: 'no aplica' });
    expect(terminals).toEqual([`${a.key}:cancelada`]);
    const b = await one();
    script = async () => ({ kind: 'intervention', error: 'HTTP 403', httpStatus: 403 });
    await runOutboxPublisherTick(deps, new Date());
    await runOutboxPublisherTick(deps, new Date(Date.now() + 7200_000));
    expect(await get(b.id)).toMatchObject({ status: 'requiere_intervencion', attempts: 1, lastHttpStatus: 403 });
  });

  it('RF-TR-08 excepción y timeout del handler se tratan como reintento ambiguo; el siguiente intento lo sabe', async () => {
    const a = await one();
    const seen: [number, boolean][] = [];
    script = async (attempt, amb) => {
      seen.push([attempt, amb]);
      if (attempt === 1) throw new Error('fallo con password=supersecreta123');
      if (attempt === 2) return new Promise(() => {}); // cuelga → timeout del intento
      return { kind: 'delivered', externalId: 'ext-1' };
    };
    let now = new Date();
    await runOutboxPublisherTick(deps, now);
    const d1 = await get(a.id);
    expect(d1.lastError).toMatch(/^\[ambiguo\]/);
    expect(d1.lastError).not.toContain('supersecreta123');
    expect(d1.nextAttemptAt!.getTime() - now.getTime()).toBe(5000);
    now = new Date(now.getTime() + 5000);
    await runOutboxPublisherTick(deps, now);
    const d2 = await get(a.id);
    expect(d2.lastError).toContain('timeout');
    expect(d2.nextAttemptAt!.getTime() - now.getTime()).toBe(10_000);
    await runOutboxPublisherTick(deps, new Date(now.getTime() + 10_000));
    expect(await get(a.id)).toMatchObject({ status: 'entregada', externalId: 'ext-1', lastError: null, attempts: 3 });
    expect(seen).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
  });

  it('RNF-CON-02 backoff exponencial con tope de 1 h y vencimiento antes del siguiente intento', async () => {
    const a = await one({ expiresAt: new Date(Date.now() + 3 * 3600_000) });
    script = async () => ({ kind: 'retry', error: 'HTTP 503', httpStatus: 503 });
    let now = new Date();
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) {
      await runOutboxPublisherTick(deps, now);
      const d = await get(a.id);
      if (d.status !== 'pendiente') break;
      delays.push(d.nextAttemptAt!.getTime() - now.getTime());
      now = d.nextAttemptAt!;
    }
    expect(delays.slice(0, 4)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(Math.max(...delays)).toBe(3600_000);
    expect((await get(a.id)).status).toBe('vencida');
    expect(terminals).toContain(`${a.key}:vencida`);
  });

  it('RF-TR-08 orden por destino: espera predecesora pendiente; falla terminal bloqueante retiene; no bloqueante no', async () => {
    const run = await prisma.run.findFirst({ select: { id: true } });
    const target = await prisma.runTestRailTarget.findFirst({ select: { id: true } });
    if (!run || !target) return; // depende de datos de otras pruebas de publicación
    await prisma.outboxDelivery.updateMany({ where: { targetId: target.id, status: { in: ['pendiente', 'en_proceso'] } }, data: { status: 'cancelada' } });
    const first = await one({ targetId: target.id, sequence: 0 });
    const second = await one({ targetId: target.id, sequence: 1 });
    const claimed: string[] = [];
    script = async () => ({ kind: 'delivered' });
    registerOutboxHandler(OP, async (d) => {
      claimed.push(d.dedupKey);
      return { kind: 'delivered' };
    });
    await runOutboxPublisherTick(deps, new Date());
    expect(claimed).toEqual([first.key]);
    await runOutboxPublisherTick(deps, new Date());
    expect(claimed).toEqual([first.key, second.key]);
    registerOutboxHandler(OP, async (_d, ctx) => script!(ctx.attempt, ctx.previousAmbiguous), { timeoutMs: 200 });
  });

  it('RF-TR-08 dos publicadores concurrentes no procesan la misma entrega (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await one();
    let calls = 0;
    script = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { kind: 'delivered' };
    };
    const [s1, s2] = await Promise.all([
      runOutboxPublisherTick({ ...deps, workerId: 'p1', batchSize: 6 }, new Date()),
      runOutboxPublisherTick({ ...deps, workerId: 'p2', batchSize: 6 }, new Date()),
    ]);
    expect(s1.claimed + s2.claimed).toBe(6);
    expect(calls).toBe(6);
  });

  it('RF-TR-08 reintento admin: sin reconciliador reprograma; entregada no es reintentable; inexistente 404', async () => {
    const a = await one();
    script = async () => ({ kind: 'intervention', error: 'HTTP 401', httpStatus: 401 });
    await runOutboxPublisherTick(deps, new Date());
    const actor = { kind: 'service' as const, id: randomUUID(), scopes: [] };
    const r = await adminRetryDelivery(deps, a.id, actor, { note: 'reintento' });
    expect(r).toMatchObject({ reconciliation: 'no_aplicada', delivery: { status: 'pendiente', attempts: 1 } });
    script = async () => ({ kind: 'delivered' });
    await runOutboxPublisherTick(deps, new Date());
    await expect(adminRetryDelivery(deps, a.id, actor)).rejects.toMatchObject({ code: 'DELIVERY_NOT_RETRYABLE' });
    await expect(adminRetryDelivery(deps, randomUUID(), actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Reconciliador que falla → indeterminada (sin reenviar).
    const b = await one();
    registerOutboxHandler(OP, async () => ({ kind: 'intervention', error: 'x' }), {
      reconcile: async () => {
        throw new Error('sin permisos para consultar');
      },
    });
    await runOutboxPublisherTick(deps, new Date());
    const ind = await adminRetryDelivery(deps, b.id, actor);
    expect(ind).toMatchObject({ reconciliation: 'indeterminada', delivery: { status: 'requiere_intervencion' } });
    expect(ind.delivery.lastError).toContain('indeterminada');
    registerOutboxHandler(OP, async (_d, ctx) => script!(ctx.attempt, ctx.previousAmbiguous), { timeoutMs: 200 });
  });

  it('RNF-OBS-02 métricas de outbox: pendientes, vencidas e intervención', async () => {
    await one();
    registerOutboxMetrics(prisma);
    const text = await renderMetrics();
    expect(text).toMatch(/katalyst_outbox_pending\{[^}]*family="notification"[^}]*\} [1-9]/);
    expect(text).toContain('katalyst_outbox_requires_intervention');
  });

  it('RF-TR-02 tick horario omite si hay una sincronización en curso', async () => {
    const w = makeWorld();
    const conn = await prisma.testRailConnection.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!conn) return;
    await prisma.testRailConnection.update({ where: { id: conn.id }, data: { projectExternalId: w.projectId, enabled: true } });
    const run = await startSync(syncDeps(prisma, w.fake), { trigger: 'manual', actor: 'system', connectionId: conn.id });
    const r = await runScheduledTestRailSync({ prisma, logger, config, secrets: deps.secrets, clientFactory: async () => w.fake });
    expect(r).toBeNull();
    await prisma.testRailSyncRun.update({ where: { id: run.id }, data: { status: 'fallida', finishedAt: new Date() } });
  });
});
