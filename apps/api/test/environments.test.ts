/**
 * Ambientes, usuarios de prueba y parámetros administrativos (RF-AMB-01, RF-AMB-02, ESP §13.3, §13.7, RNF-SEG-01/03):
 * SSRF en URLs, nunca secretos (solo referencias, solo admin), producción solo con usuarios de lectura y sin
 * trazas/video, nombre único, versión optimista, auditoría y matriz de roles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorMatrix, loginAs, makeCtx, type TestCtx } from './support/api-a.js';
import { getRuntimeSettings, validateAllowedHosts, validateTargetUrl } from '../src/modules/environments/service.js';

let ctx: TestCtx;
let admin: Record<string, string>;
beforeAll(async () => {
  ctx = await makeCtx({ ALLOWED_TARGET_HOSTS: '*.example.test,localhost', SSRF_PRIVATE_ALLOWED_HOSTS: 'priv.example.test' });
  admin = (await loginAs(ctx, 'admin')).headers;
});
afterAll(() => ctx.close());

const envBody = (over: Record<string, unknown> = {}) => ({
  name: `staging-${randomUUID().slice(0, 8)}`,
  appUrl: 'https://app.example.test',
  apiUrl: 'https://api.example.test',
  isProduction: false,
  ...over,
});

describe('ambientes (RF-AMB-01)', () => {
  it('RF-AMB-01 crear/leer/actualizar con política de evidencia por defecto, auditado; nombre único', async () => {
    const body = envBody({ allowedHosts: ['cdn.example.test'] });
    const c = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: body });
    expect(c.statusCode).toBe(201);
    const env = c.json();
    expect(env).toMatchObject({ name: body.name, isProduction: false, maxConcurrency: 1, enabled: true, recordingAllowed: false, version: 0 });
    expect(env.artifactPolicy.enabledKinds).toEqual(['reporte', 'log']);
    expect(env.artifactPolicy.disabledReasons.captura).toMatch(/canarios/);
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: { ...body, name: body.name.toUpperCase() } });
    expect(dup.statusCode).toBe(409);
    const up = await ctx.app.inject({ method: 'PUT', url: `/api/v1/environments/${env.id}`, headers: admin, payload: { maxConcurrency: 2, recordingAllowed: true, version: 0 } });
    expect(up.json()).toMatchObject({ maxConcurrency: 2, recordingAllowed: true, version: 1 });
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/v1/environments/${env.id}`, headers: admin, payload: { maxConcurrency: 3, version: 0 } });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const dis = await ctx.app.inject({ method: 'PUT', url: `/api/v1/environments/${env.id}`, headers: admin, payload: { enabled: false, version: 1 } });
    expect(dis.json()).toMatchObject({ enabled: false });
    expect(dis.json().disabledAt).not.toBeNull();
    const g = await ctx.app.inject({ method: 'GET', url: `/api/v1/environments/${env.id}`, headers: admin });
    expect(g.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/environments/${randomUUID()}`, headers: admin })).statusCode).toBe(404);
    const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: env.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['environment.create', 'environment.update', 'environment.update']);
  });

  it('RNF-SEG-03 SSRF: metadatos, loopback no permitido, host fuera de allowlist y patrón inválido → 422', async () => {
    for (const appUrl of ['https://169.254.169.254/', 'https://10.0.0.1/', 'https://evil.example.com/', 'ftp://app.example.test/']) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: envBody({ appUrl }) });
      expect(r.statusCode, appUrl).toBe(422);
    }
    const hosts = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: envBody({ allowedHosts: ['otro.example.com'] }) });
    expect(hosts.json().error.code).toBe('HOST_NOT_ALLOWED');
    const pattern = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: envBody({ allowedHosts: ['bad host'] }) });
    expect(pattern.json().error.code).toBe('HOST_NOT_ALLOWED');
    const lookup = async () => [{ address: '10.1.1.1', family: 4 }];
    const policy = { allowedHosts: ['*.example.test'], privateAllowedHosts: ['priv.example.test'] };
    await expect(validateTargetUrl('https://priv.example.test', policy, lookup)).resolves.toBeUndefined();
    await expect(validateTargetUrl('https://pub.example.test', policy, lookup)).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    await expect(validateTargetUrl('https://nx.example.test', policy, async () => { throw new Error('ENOTFOUND'); })).resolves.toBeUndefined();
    expect(validateAllowedHosts(['*.a.example.test', 'B.example.test'], policy)).toEqual(['*.a.example.test', 'b.example.test']);
  });

  it('RNF-SEG-04 producción: sin grabación, sin trazas/video, usuarios solo lectura', async () => {
    const p = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: envBody({ isProduction: true, recordingAllowed: true }) });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ isProduction: true, recordingAllowed: false });
    expect(p.json().artifactPolicy.disabledReasons.traza).toMatch(/producción/);
    const trace = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/environments',
      headers: admin,
      payload: envBody({ isProduction: true, artifactPolicy: { enabledKinds: ['reporte', 'traza'] } }),
    });
    expect(trace.statusCode).toBe(422);
    const writeUser = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${p.json().id}/users`,
      headers: admin,
      payload: { label: 'w', username: 'w@example.test', secretRef: 'env:KATALYST_SECRET__W', readOnly: false },
    });
    expect(writeUser.json().error.code).toBe('PRODUCTION_BLOCKED');
  });

  it('RNF-SEG-03 matriz: listado resumido para qa sin URLs; administración solo admin', async () => {
    const m = await actorMatrix(ctx);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/environments', headers: m.qa });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    if (item) expect(item).not.toHaveProperty('appUrl');
    const adminList = await ctx.app.inject({ method: 'GET', url: '/api/v1/environments?includeDisabled=true', headers: admin });
    if (adminList.json().items[0]) expect(adminList.json().items[0]).toHaveProperty('appUrl');
    for (const [actor, status] of Object.entries({ qa: 403, dev: 403, servicio: 403, anonimo: 401 })) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: m[actor as keyof typeof m], payload: envBody() });
      expect(r.statusCode, actor).toBe(status);
      const s = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings/runtime', headers: m[actor as keyof typeof m] });
      expect(s.statusCode, actor).toBe(status);
    }
  });
});

describe('usuarios de prueba (RF-AMB-02)', () => {
  it('RF-AMB-02 registra referencia de secreto (nunca el valor), etiqueta única, actualiza y deshabilita', async () => {
    const env = (await ctx.app.inject({ method: 'POST', url: '/api/v1/environments', headers: admin, payload: envBody() })).json();
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${env.id}/users`,
      headers: admin,
      payload: { label: 'qa', username: 'qa@example.test', secretRef: 'contraseña-en-claro', readOnly: true },
    });
    expect(bad.statusCode).toBe(422);
    const notPrefixed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${env.id}/users`,
      headers: admin,
      payload: { label: 'qa', username: 'qa@example.test', secretRef: 'env:DATABASE_URL', readOnly: true },
    });
    expect(notPrefixed.json().error.code).toBe('SECRET_REF_INVALID');
    const c = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${env.id}/users`,
      headers: admin,
      payload: { label: 'qa', username: 'qa@example.test', secretRef: 'ssm:/katalyst/internal/deltax/qa', readOnly: true },
    });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ secretRef: 'ssm:/katalyst/internal/deltax/qa', readOnly: true, enabled: true });
    const dup = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/environments/${env.id}/users`,
      headers: admin,
      payload: { label: 'qa', username: 'x@example.test', secretRef: 'env:KATALYST_SECRET__X', readOnly: true },
    });
    expect(dup.statusCode).toBe(409);
    const up = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/environments/${env.id}/users/${c.json().id}`,
      headers: admin,
      payload: { secretRef: 'env:KATALYST_SECRET__QA_ROTADO', enabled: false, version: 0 },
    });
    expect(up.json()).toMatchObject({ secretRef: 'env:KATALYST_SECRET__QA_ROTADO', enabled: false, version: 1 });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/environments/${env.id}/users?includeDisabled=true`, headers: admin });
    expect(list.json().items).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/environments/${env.id}/users`, headers: admin })).json().items).toHaveLength(0);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: c.json().id, action: 'test_user.update' } });
    expect(audit.diff).toMatchObject({ secretRef: { from: 'ssm:/katalyst/internal/deltax/qa', to: 'env:KATALYST_SECRET__QA_ROTADO' } });
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/v1/environments/${env.id}/users/${randomUUID()}`, headers: admin, payload: { version: 0 } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/environments/${randomUUID()}/users`, headers: admin })).statusCode).toBe(404);
  });
});

describe('parámetros administrativos (ESP §13.3)', () => {
  it('RF-EJE-04 defaults de timeouts §13.3, actualización auditada con versión', async () => {
    const before = await getRuntimeSettings(ctx.prisma);
    const g = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings/runtime', headers: admin });
    expect(g.json()).toMatchObject({ version: before.version });
    if (before.version === 0) {
      expect(g.json().timeouts).toMatchObject({ testMs: 120_000, setupMs: 120_000, functionalRunMs: 1_200_000, perfRunMs: 240_000 });
    }
    const body = { ...g.json(), timeouts: { ...g.json().timeouts, testMs: 90_000 } };
    const up = await ctx.app.inject({ method: 'PUT', url: '/api/v1/settings/runtime', headers: admin, payload: body });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ version: before.version + 1, timeouts: { testMs: 90_000 } });
    const stale = await ctx.app.inject({ method: 'PUT', url: '/api/v1/settings/runtime', headers: admin, payload: body });
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/v1/settings/runtime', headers: admin, payload: { ...body, timeouts: { ...body.timeouts, finalizingMs: 120_000 } } });
    expect(bad.statusCode).toBe(422);
    const restored = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/runtime',
      headers: admin,
      payload: { ...(up.json() as Record<string, unknown>), timeouts: { ...(up.json().timeouts as Record<string, unknown>), testMs: 120_000 } },
    });
    expect(restored.statusCode).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'runtime_setting.update', createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThanOrEqual(2);
  });
});
