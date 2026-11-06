/**
 * RNF-SEG-03: los módulos de API-A registran exactamente las rutas de `ROUTES` con su guardia; OpenAPI generada las
 * documenta. RF-TR-02: bucle horario de sincronización y registro del publicador en el proceso de control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, ROUTES } from '@katalyst/shared';
import { makeCtx, type TestCtx } from './support/api-a.js';
import { routeGuard } from '../src/lib/auth.js';
import { registerTestRailControl, runScheduledTestRailSync, testrailSyncLoop } from '../src/control/testrail-sync.js';
import { outboxPublisherLoop } from '../src/control/outbox-publisher.js';
import { getOutboxHandler } from '../src/lib/outbox.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import { createLogger } from '../src/logger.js';
import { makeWorld } from './support/testrail-fixture.js';

const MINE = new Set(['auth', 'users', 'audit', 'testrail', 'catalog', 'suites', 'environments', 'integrations', 'health']);
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(() => ctx.close());

describe('inventario de rutas (RNF-SEG-03)', () => {
  it('RNF-SEG-03 todas las rutas de API-A en ROUTES están registradas', () => {
    const mine = ROUTES.filter((r) => MINE.has(r.module));
    expect(mine.length).toBeGreaterThanOrEqual(55);
    for (const r of mine) {
      const url = r.module === 'health' ? r.path : `${API_PREFIX}${r.path}`;
      expect(ctx.app.hasRoute({ method: r.method, url }), `${r.method} ${url}`).toBe(true);
    }
    expect(() => routeGuard('GET', '/no-existe')).toThrow(/no inventariada/);
  });

  it('RNF-SEG-03 rutas no públicas de API-A rechazan anónimos', async () => {
    const mine = ROUTES.filter((r) => MINE.has(r.module) && r.access !== 'public');
    for (const r of mine) {
      const url = `${API_PREFIX}${r.path.replace(/:[a-zA-Z]+/g, '00000000-0000-4000-8000-000000000000')}`;
      const res = await ctx.app.inject({ method: r.method, url, ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }) });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('OpenAPI generada incluye las rutas con esquemas', async () => {
    const spec = ctx.app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/v1/testrail/cases', '/api/v1/auth/login', '/api/v1/suites/{id}']));
  });
});

describe('proceso de control (RF-TR-02, RF-TR-08)', () => {
  it('RF-TR-02 tick horario sincroniza la conexión habilitada y registra handlers TestRail', async () => {
    const w = makeWorld();
    const deps = {
      prisma: ctx.prisma,
      logger: createLogger({ level: 'silent', service: 'test' }),
      config: ctx.config,
      secrets: new MemorySecretProvider(),
      clientFactory: async () => w.fake,
    };
    registerTestRailControl(deps);
    expect(getOutboxHandler('testrail.close_run')).toBeDefined();
    const loop = testrailSyncLoop(deps);
    expect(loop).toMatchObject({ name: 'sync_testrail', intervalMs: ctx.config.TESTRAIL_SYNC_INTERVAL_MS });
    const conn = await ctx.prisma.testRailConnection.findFirst({ orderBy: { createdAt: 'asc' } });
    if (conn) {
      await ctx.prisma.testRailConnection.update({ where: { id: conn.id }, data: { projectExternalId: w.projectId, enabled: true } });
      expect(await runScheduledTestRailSync(deps)).toBe('exitosa');
      await loop.tick({ logger: deps.logger, now: new Date() });
      await ctx.prisma.testRailConnection.update({ where: { id: conn.id }, data: { enabled: false } });
      expect(await runScheduledTestRailSync(deps)).toBeNull();
      await ctx.prisma.testRailConnection.update({ where: { id: conn.id }, data: { enabled: true } });
    }
    const pub = outboxPublisherLoop({ prisma: ctx.prisma, logger: deps.logger, secrets: deps.secrets, operations: [] }, 5000);
    expect(pub.name).toBe('publicador_outbox');
    await pub.tick({ logger: deps.logger, now: new Date() });
  });
});
