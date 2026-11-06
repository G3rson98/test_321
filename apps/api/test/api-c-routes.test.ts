/**
 * Rutas HTTP de API-C con la app completa (auth real, BD/Redis reales): matriz de roles, contratos del flujo de
 * dispositivo y grabación para RECORDER, validación de umbrales y exportaciones. RNF-SEG-03, RF-GRB-01, RF-GRB-02,
 * RF-REN-02, RF-REN-03, RF-NOT-01, RF-RES-04.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@katalyst/shared';
import { apiTokenFor, loginAs, makeCtx, type TestCtx } from './support/api-a.js';
import { createCase, createEnvironment } from './support/api-c.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeCtx({ PUBLIC_BASE_URL: 'http://localhost:5173' });
});
afterAll(async () => {
  await ctx?.close();
});
const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;
const api = (p: string) => `/api/v1${p}`;

describe('rendimiento y umbrales por HTTP (RF-REN-02, RF-REN-03)', () => {
  it('RF-REN-03 qa lee /perf pero no crea umbrales; dev crea; min_samples bajo el piso → 422 THRESHOLD_MIN_SAMPLES', async () => {
    const env = await createEnvironment(ctx.prisma);
    const qa = await loginAs(ctx, 'qa');
    const dev = await loginAs(ctx, 'dev');
    const perf = await ctx.app.inject({
      method: 'GET',
      url: api(`/perf?environmentId=${env.id}&from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date().toISOString()}&by=hour`),
      headers: qa.headers,
    });
    expect(perf.statusCode).toBe(200);
    expect(perf.json()).toMatchObject({ granularity: 'hour', series: [], lastSampleAt: null });
    const body = {
      environmentId: env.id,
      seriesSelector: {
        endpointKey: 'GET /warehouse/api/warehouse/list/scheduling',
        provenance: 'playwright',
        source: 'app',
        metricKind: 'network_request',
        cacheMode: 'caliente',
        workerProfile: null,
      },
      metric: 'p95',
      limit: 10_000,
      windowMin: 60,
      minSamples: 20,
    };
    const forbidden = await ctx.app.inject({ method: 'POST', url: api('/perf/thresholds'), headers: qa.headers, payload: body });
    expect(forbidden.statusCode).toBe(403);
    const low = await ctx.app.inject({ method: 'POST', url: api('/perf/thresholds'), headers: dev.headers, payload: { ...body, minSamples: 5 } });
    expect(low.statusCode).toBe(422);
    expect(code(low.body)).toBe('THRESHOLD_MIN_SAMPLES');
    const ok = await ctx.app.inject({ method: 'POST', url: api('/perf/thresholds'), headers: dev.headers, payload: body });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ unit: 'ms', metric: 'p95', minSamples: 20, version: 0 });
    const put = await ctx.app.inject({ method: 'PUT', url: api(`/perf/thresholds/${ok.json().id}`), headers: dev.headers, payload: { ...body, limit: 8000, version: 0 } });
    expect(put.json()).toMatchObject({ limit: 8000, version: 1 });
    const stale = await ctx.app.inject({ method: 'PUT', url: api(`/perf/thresholds/${ok.json().id}`), headers: dev.headers, payload: { ...body, version: 0 } });
    expect(code(stale.body)).toBe('VERSION_CONFLICT');
    const mark = await ctx.app.inject({
      method: 'POST',
      url: api('/events'),
      headers: dev.headers,
      payload: { ts: new Date().toISOString(), label: 'Despliegue', environmentId: env.id, frontendVersion: '2.0.0', backendVersion: '1.9.0' },
    });
    expect(mark.statusCode).toBe(201);
  });
});

describe('flujo de dispositivo y grabación por HTTP (contrato RECORDER)', () => {
  it('RF-GRB-01 authorize → aprobación con sesión del panel → token → grabación con credencial de dispositivo', async () => {
    const qa = await loginAs(ctx, 'qa');
    const start = await ctx.app.inject({
      method: 'POST',
      url: api('/devices/authorize'),
      payload: { clientName: 'Katalyst Recorder', clientVersion: '0.1.0', platform: 'windows' },
    });
    expect(start.statusCode).toBe(200);
    const { deviceCode, userCode } = start.json();
    const pending = await ctx.app.inject({ method: 'POST', url: api('/devices/token'), payload: { deviceCode } });
    expect(code(pending.body)).toBe('DEVICE_AUTHORIZATION_PENDING');
    // Un token API (no sesión) no puede aprobar.
    const tok = await apiTokenFor(ctx.prisma, qa.userId, ['devices.approve']);
    const byToken = await ctx.app.inject({ method: 'POST', url: api('/devices/approve'), headers: { authorization: tok.authorization }, payload: { userCode } });
    expect(byToken.statusCode).toBe(403);
    const view = await ctx.app.inject({ method: 'GET', url: api(`/devices/authorizations/${userCode}`), headers: qa.headers });
    expect(view.json()).toMatchObject({ status: 'pendiente', clientName: 'Katalyst Recorder' });
    const approve = await ctx.app.inject({ method: 'POST', url: api('/devices/approve'), headers: qa.headers, payload: { userCode } });
    expect(approve.statusCode).toBe(200);
    await ctx.prisma.deviceAuthorization.update({ where: { userCode }, data: { lastPolledAt: new Date(Date.now() - 10_000) } });
    const token = await ctx.app.inject({ method: 'POST', url: api('/devices/token'), payload: { deviceCode } });
    expect(token.statusCode).toBe(200);
    const device = { authorization: `Bearer ${token.json().accessToken}` };
    // El asistente crea/consulta grabaciones pero no accede a otras áreas.
    expect((await ctx.app.inject({ method: 'GET', url: api('/perf/thresholds'), headers: device })).statusCode).toBe(403);
    const c = await createCase(ctx.prisma);
    const env = await createEnvironment(ctx.prisma);
    const created = await ctx.app.inject({ method: 'POST', url: api('/recordings'), headers: device, payload: { caseId: c.id, environmentId: env.id, tags: ['@oc'] } });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec.assistantLink).toBe(`katalyst://grabar?session=${rec.recording.id}`);
    expect(rec.recording.deviceId).toBe(token.json().deviceId);
    const detail = await ctx.app.inject({ method: 'GET', url: api(`/recordings/${rec.recording.id}`), headers: device });
    expect(detail.json().environment).toMatchObject({ id: env.id, isProduction: false, recordingAllowed: true, enabled: true });
    const st = await ctx.app.inject({ method: 'POST', url: api(`/recordings/${rec.recording.id}/status`), headers: device, payload: { status: 'grabando' } });
    expect(st.json().status).toBe('grabando');
    const hb = await ctx.app.inject({ method: 'POST', url: api('/devices/heartbeat'), headers: device, payload: { clientVersion: '0.1.0', activeRecordingId: rec.recording.id } });
    expect(hb.statusCode).toBe(200);
    const status = await ctx.app.inject({ method: 'GET', url: api('/devices/status'), headers: qa.headers });
    expect(status.json()).toMatchObject({ linked: true, online: true });
    // El asistente se desvincula a sí mismo.
    const del = await ctx.app.inject({ method: 'DELETE', url: api(`/devices/${token.json().deviceId}`), headers: device });
    expect(del.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: api(`/recordings/${rec.recording.id}`), headers: device })).statusCode).toBe(401);
  });
});

describe('OpenAPI (ESP §9: flujo de dispositivo documentado antes de 2C)', () => {
  it('RF-GRB-01 OpenAPI documenta inicio, aprobación autenticada y consulta limitada por código', async () => {
    const doc = (ctx.app as unknown as { swagger(): { paths: Record<string, Record<string, { summary?: string }>> } }).swagger();
    for (const p of ['/api/v1/devices/authorize', '/api/v1/devices/token', '/api/v1/devices/approve', '/api/v1/devices/authorizations/{userCode}']) {
      expect(doc.paths[p], p).toBeDefined();
    }
    expect(doc.paths['/api/v1/devices/token']!.post!.summary).toMatch(/polling limitado/);
    expect(doc.paths['/api/v1/recordings/{id}/complete']).toBeDefined();
  });
});

describe('notificaciones y exportaciones por HTTP (RF-NOT-01, RF-RES-04)', () => {
  it('RF-NOT-01 solo admin configura canales; referencias env: sin prefijo KATALYST_SECRET__ se rechazan', async () => {
    const qa = await loginAs(ctx, 'qa');
    const admin = await loginAs(ctx, 'admin');
    expect((await ctx.app.inject({ method: 'GET', url: api('/notifications/channels'), headers: qa.headers })).statusCode).toBe(403);
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: api('/notifications/channels/slack'),
      headers: admin.headers,
      payload: { enabled: true, secretRef: 'env:DATABASE_URL' },
    });
    expect(code(bad.body)).toBe('SECRET_REF_INVALID');
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: api('/notifications/channels/slack'),
      headers: admin.headers,
      payload: { enabled: true, secretRef: 'env:KATALYST_SECRET__SLACK_WEBHOOK' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ kind: 'slack', enabled: true, secretRef: 'env:KATALYST_SECRET__SLACK_WEBHOOK' });
    const prefs = await ctx.app.inject({ method: 'GET', url: api('/notifications/preferences'), headers: qa.headers });
    expect(prefs.json()).toMatchObject({ userId: qa.userId, channels: [] });
  });

  it('RF-RES-04 qa no exporta auditoría (403); página → 201 listo', async () => {
    const qa = await loginAs(ctx, 'qa');
    const audit = await ctx.app.inject({ method: 'POST', url: api('/exports'), headers: qa.headers, payload: { format: 'csv', scope: 'audit_log', extent: 'pagina' } });
    expect(audit.statusCode).toBe(403);
    const runs = await ctx.app.inject({ method: 'POST', url: api('/exports'), headers: qa.headers, payload: { format: 'csv', scope: 'runs', extent: 'pagina', limit: 5 } });
    expect(runs.statusCode).toBe(201);
    expect(runs.json().status).toBe('listo');
  });
});
