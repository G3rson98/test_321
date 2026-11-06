/**
 * Aceptación RNF-OPT-05 / ESP §17.5 (D-053): `GET /schedules` obtiene la última ocurrencia de TODAS las
 * programaciones de la página en una sola consulta (antes: una consulta por fila, N+1 detectado con
 * scripts/load/explain-queries.ts). Verifica que el resultado en lote coincide con la consulta individual.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastOccurrencesFor } from '../../src/services/scheduler.js';
import { createEnv, makeApiBCtx, type ApiBCtx } from '../support/api-b.js';

let ctx: ApiBCtx;
const ids: string[] = [];

beforeAll(async () => {
  ctx = await makeApiBCtx();
  const { env } = await createEnv(ctx.prisma);
  for (let i = 0; i < 5; i++) {
    const s = await ctx.prisma.schedule.create({
      data: {
        name: `Lote ${i}`,
        selector: { kind: 'cases', caseIds: [randomUUID()] },
        environmentId: env.id,
        cronExpressions: ['0 3 * * 1-5'],
        notify: { onFailure: true, onInterruption: true, channels: [] },
      },
    });
    ids.push(s.id);
    // i ocurrencias por programación (la 0 queda sin ocurrencias): la última es la de mayor scheduledFor.
    for (let k = 0; k < i; k++) {
      await ctx.prisma.scheduleOccurrence.create({
        data: { scheduleId: s.id, scheduleRevision: 1, timezone: 'America/La_Paz', scheduledFor: new Date(Date.UTC(2026, 10, 1 + k, 7)), status: k % 2 ? 'omitida' : 'admitida', ...(k % 2 ? { reason: 'solapamiento' } : {}) },
      });
    }
  }
});

afterAll(async () => {
  await ctx?.close();
});

describe('GET /schedules sin N+1 (última ocurrencia en lote)', () => {
  it('lastOccurrencesFor devuelve la última ocurrencia por programación en una consulta', async () => {
    const m = await lastOccurrencesFor(ctx.prisma, ids);
    expect(m.has(ids[0]!)).toBe(false);
    for (let i = 1; i < 5; i++) {
      const single = await ctx.prisma.scheduleOccurrence.findFirst({ where: { scheduleId: ids[i] }, orderBy: { scheduledFor: 'desc' } });
      const got = m.get(ids[i]!)!;
      expect(got.scheduledFor.toISOString()).toBe(single!.scheduledFor.toISOString());
      expect(got.status).toBe(single!.status);
      expect(got.reason).toBe(single!.reason);
      expect(got.runId).toBe(single!.runId);
    }
    expect((await lastOccurrencesFor(ctx.prisma, [])).size).toBe(0);
  });

  it('el listado HTTP expone la misma lastOccurrence que el detalle', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/schedules?limit=100', headers: { authorization: ctx.qa.authorization } });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { id: string; lastOccurrence: unknown }[] }).items;
    expect(items).toHaveLength(5);
    for (const it of items) {
      const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/schedules/${it.id}`, headers: { authorization: ctx.qa.authorization } });
      expect(detail.statusCode).toBe(200);
      expect(it.lastOccurrence).toEqual((detail.json() as { lastOccurrence: unknown }).lastOccurrence);
    }
    expect(items.find((i) => i.id === ids[0])!.lastOccurrence).toBeNull();
  });
});
