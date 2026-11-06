/**
 * Evidencia y tiempo real con PostgreSQL y Redis reales: carga acotada al lease, sanitización bloqueante, cuota,
 * política por ambiente, URL firmada ≤ 5 min y visor de origen separado con ticket de un solo uso; `finalizando`
 * espera artefactos ≤ 60 s; SSE con Last-Event-ID y snapshot; importación DXMon; limpieza diaria; historial.
 * RF-RES-02, RF-RES-03, RF-EJE-02, RF-REN-01, RNF-SEG-02, RNF-SEG-05, RNF-OPT-04.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildReportsApp, REPORT_HTML_CSP } from '../src/main.reports.js';
import { finalizeDueRuns, testHistory, caseHistory } from '../src/services/results.js';
import { runCleanup, dailyCleanupGate } from '../src/control/cleanup.js';
import { partitionShards } from '../src/services/run-admission.js';
import { compileSchedule } from '../src/services/scheduler.js';
import { FsArtifactStore, artifactStorageKey, assertSafeKey, clampTtl, isAllowedContentType } from '../src/adapters/artifact-store/index.js';
import { controlLoops, lazyModule } from '../src/main.control.js';
import { canSee } from '../src/modules/events/routes.js';
import { FakeWorker, createEnv, idemKey, makeApiBCtx, resetDb, seedCatalog, shardsOf, silent, type ApiBCtx, type Seed } from './support/api-b.js';
import { apiTokenFor, serviceTokenFor } from './support/api-a.js';

let ctx: ApiBCtx;
let seed: Seed;
let envId: string;

beforeAll(async () => {
  ctx = await makeApiBCtx();
});
afterAll(async () => ctx.close());

beforeEach(async () => {
  await resetDb(ctx.prisma);
  const qa = await ctx.prisma.panelUser.create({ data: { email: `qa-${randomUUID().slice(0, 6)}@example.test`, name: 'QA', role: 'qa' } });
  ctx.qa = { authorization: (await apiTokenFor(ctx.prisma, qa.id, ['runs.read', 'runs.create', 'runs.cancel', 'artifacts.read', 'schedules.read'])).authorization, userId: qa.id };
  ctx.service = { authorization: (await serviceTokenFor(ctx.prisma)).authorization };
  seed = await seedCatalog(ctx.prisma, ['A', 'D'], [{ key: 'r1', cases: ['A'] }, { key: 'r3', cases: ['D'] }]);
  envId = (
    await createEnv(ctx.prisma, {
      artifactPolicy: {
        enabledKinds: ['reporte', 'captura', 'log', 'dxmon_samples'],
        maxEvidenceBytesPerRun: 1024,
        disabledReasons: { traza: 'Trazas deshabilitadas en este ambiente.' },
      },
    })
  ).env.id;
});

async function startRun(caseKey = 'D') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: { authorization: ctx.qa.authorization, 'idempotency-key': idemKey() },
    payload: { caseIds: [seed.cases[caseKey]!.id], environmentId: envId },
  });
  const run = res.json();
  const [shard] = await shardsOf(ctx.prisma, run.id);
  const w = new FakeWorker(ctx);
  await w.claim(run.id, shard!.id);
  return { run, w, t: w.assignment.tests[0]! };
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

const sanitized = { status: 'sanitizado', reason: null, sanitizerVersion: '1', findingsRemaining: 0 };

describe('artefactos (RF-RES-02, RNF-SEG-05)', () => {
  it('RF-RES-02 carga sanitizada ⇒ URL firmada ≤ 5 min, checksum verificado, acceso autorizado por recurso', async () => {
    const { run, w, t } = await startRun();
    await w.start(t.runResultId);
    const png = Buffer.from('89504e470d0a1a0a-captura', 'utf8');
    const up = await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'captura', contentType: 'image/png', sizeBytes: png.length, checksumSha256: sha(png), sanitization: sanitized });
    expect(up.statusCode).toBe(200);
    const body = up.json();
    expect(body.rejectedReason).toBeNull();
    expect(new Date(body.upload.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    // Antes de cargar: finalizar falla y no es publicable.
    expect((await w.finalize(body.artifactId, { sizeBytes: png.length, checksumSha256: sha(png) })).statusCode).toBe(409);
    const key = (await ctx.prisma.artifact.findUniqueOrThrow({ where: { id: body.artifactId } })).storageKey!;
    expect(key).toBe(artifactStorageKey(run.id, body.artifactId, 'image/png'));
    await ctx.store.putObject(key, png);
    const fin = await w.finalize(body.artifactId, { sizeBytes: png.length, checksumSha256: sha(png) });
    expect(fin.json()).toMatchObject({ sanitizationStatus: 'sanitizado', publishable: true });
    expect((await w.finalize(body.artifactId, { sizeBytes: png.length, checksumSha256: sha(png) })).statusCode).toBe(200);
    const acc = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts/${body.artifactId}`, headers: { authorization: ctx.qa.authorization } });
    expect(acc.json()).toMatchObject({ disposition: 'download' });
    expect(new Date(acc.json().expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(acc.headers['cache-control']).toBe('no-store');
    // Autorización por recurso: el artefacto no pertenece a otra corrida.
    const other = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${randomUUID()}/artifacts/${body.artifactId}`, headers: { authorization: ctx.qa.authorization } });
    expect(other.statusCode).toBe(404);
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts/${body.artifactId}` });
    expect(anon.statusCode).toBe(401);
  });

  it('RNF-SEG-02 evidencia no sanitizable, tipo deshabilitado y cuota agotada se registran sin URL y marcan evidencia incompleta', async () => {
    const { run, w, t } = await startRun();
    await w.start(t.runResultId);
    const b = Buffer.from('{"x":1}');
    const unsafe = await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'reporte', contentType: 'application/json', sizeBytes: b.length, checksumSha256: sha(b), sanitization: { ...sanitized, findingsRemaining: 2 } });
    expect(unsafe.json()).toMatchObject({ upload: null });
    expect(unsafe.json().rejectedReason).toMatch(/sanitizarse/);
    const trace = await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'traza', contentType: 'application/zip', sizeBytes: 10, checksumSha256: sha(Buffer.from('z')), sanitization: sanitized });
    expect(trace.json()).toMatchObject({ upload: null, rejectedReason: 'Trazas deshabilitadas en este ambiente.' });
    const big = Buffer.alloc(2000, 1);
    const quota = await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'log', contentType: 'text/plain', sizeBytes: big.length, checksumSha256: sha(big), sanitization: sanitized });
    expect(quota.json().rejectedReason).toMatch(/Cuota/);
    const badType = await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'captura', contentType: 'text/html', sizeBytes: 5, checksumSha256: sha(b), sanitization: sanitized });
    expect(badType.statusCode).toBe(415);
    const statuses = (await ctx.prisma.artifact.findMany({ where: { runId: run.id } })).map((a) => a.sanitizationStatus).sort();
    expect(statuses).toEqual(['deshabilitado', 'fallido', 'retenido']);
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts`, headers: { authorization: ctx.qa.authorization } });
    expect(list.json().items.every((a: { publishable: boolean }) => !a.publishable)).toBe(true);
    const id = list.json().items[0].id;
    const denied = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts/${id}`, headers: { authorization: ctx.qa.authorization } });
    expect(denied.json().error.code).toBe('ARTIFACT_NOT_PUBLISHABLE');
    await w.result(t.runResultId, 1, 'fallido', { final: true });
    await w.complete();
    const d = (await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}`, headers: { authorization: ctx.qa.authorization } })).json();
    // Evidencia ausente no transforma el resultado fallido.
    expect(d).toMatchObject({ outcome: 'fallido', evidenceIncomplete: true });
  });

  it('RNF-SEG-05 reporte HTML ⇒ ticket de un solo uso en el visor (origen separado, CSP estricta, sin cookies)', async () => {
    const { run, w, t } = await startRun();
    await w.start(t.runResultId);
    const html = Buffer.from('<!doctype html><html><body><script>1</script>reporte</body></html>');
    const up = (await w.upload({ runResultId: null, attemptNo: null, kind: 'reporte', contentType: 'text/html', sizeBytes: html.length, checksumSha256: sha(html), sanitization: sanitized })).json();
    const key = (await ctx.prisma.artifact.findUniqueOrThrow({ where: { id: up.artifactId } })).storageKey!;
    await ctx.store.putObject(key, html);
    await w.finalize(up.artifactId, { sizeBytes: html.length, checksumSha256: sha(html) });
    const acc = (await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${run.id}/artifacts/${up.artifactId}`, headers: { authorization: ctx.qa.authorization } })).json();
    expect(acc.disposition).toBe('viewer');
    expect(acc.url).toMatch(/\/view\/krt_/);
    const ticket = new URL(acc.url).pathname.split('/').pop()!;
    const reports = buildReportsApp(ctx.config, { redis: ctx.redis, store: ctx.store });
    try {
      const v1 = await reports.inject({ method: 'GET', url: `/view/${ticket}`, headers: { cookie: 'katalyst_session=robada' } });
      expect(v1.statusCode).toBe(200);
      expect(v1.body).toContain('reporte');
      expect(v1.headers['content-security-policy']).toBe(REPORT_HTML_CSP);
      expect(v1.headers['content-security-policy']).toContain('sandbox');
      expect(v1.headers['set-cookie']).toBeUndefined();
      const v2 = await reports.inject({ method: 'GET', url: `/view/${ticket}` });
      expect(v2.statusCode).toBe(404); // un solo uso
    } finally {
      await reports.close();
    }
  });

  it('RF-RES-02 almacén fs: URL firmada verificada por el visor (método, vencimiento, checksum)', async () => {
    const store = ctx.store;
    const reports = buildReportsApp({ ...ctx.config, REPORTS_BASE_URL: 'http://reports.example.test' }, { redis: ctx.redis, store });
    try {
      const body = Buffer.from('contenido de log');
      const put = await store.presignPut('runs/x/y.txt', { contentType: 'text/plain', sizeBytes: body.length, checksumSha256: sha(body), expiresInSeconds: 9999 });
      expect(put.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
      const u = new URL(put.url);
      const bad = await reports.inject({ method: 'PUT', url: `${u.pathname}${u.search}`, headers: { 'content-type': 'text/plain' }, payload: Buffer.from('otro contenido!!') });
      expect(bad.statusCode).toBe(400);
      const ok = await reports.inject({ method: 'PUT', url: `${u.pathname}${u.search}`, headers: { 'content-type': 'text/plain' }, payload: body });
      expect(ok.statusCode).toBe(200);
      const tampered = await reports.inject({ method: 'PUT', url: `${u.pathname}${u.search.replace('size=', 'size=1')}`, headers: { 'content-type': 'text/plain' }, payload: body });
      expect(tampered.statusCode).toBe(403);
      const get = await store.presignGet('runs/x/y.txt', { expiresInSeconds: 60, contentType: 'text/plain', downloadName: 'log.txt' });
      const g = new URL(get.url);
      const dl = await reports.inject({ method: 'GET', url: `${g.pathname}${g.search}` });
      expect(dl.body).toBe('contenido de log');
      expect(dl.headers['content-disposition']).toContain('attachment');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(() => assertSafeKey('../etc/passwd')).toThrow();
      expect(clampTtl(10_000)).toBe(300);
      expect(isAllowedContentType('captura', 'image/png; charset=binary')).toBe(true);
    } finally {
      await reports.close();
    }
  });

  it('RF-RES-02 `finalizando` espera artefactos en curso ≤ 60 s y luego cierra con evidencia incompleta', async () => {
    const { run, w, t } = await startRun();
    await w.start(t.runResultId);
    const b = Buffer.from('log');
    await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'log', contentType: 'text/plain', sizeBytes: b.length, checksumSha256: sha(b), sanitization: sanitized });
    await w.result(t.runResultId, 1, 'pasado');
    await w.complete();
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('finalizando');
    expect(await finalizeDueRuns(ctx.prisma, new Date(Date.now() + 10_000), 'http://panel')).toEqual([]);
    expect(await finalizeDueRuns(ctx.prisma, new Date(Date.now() + 61_000), 'http://panel')).toEqual([run.id]);
    const r = await ctx.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ status: 'terminada', outcome: 'pasado', evidenceIncomplete: true });
  });

  it('RF-RES-02 finalizar el último artefacto cierra la corrida en `finalizando` (lease liberado admitido)', async () => {
    const { run, w, t } = await startRun();
    await w.start(t.runResultId);
    const b = Buffer.from('log');
    const up = (await w.upload({ runResultId: t.runResultId, attemptNo: 1, kind: 'log', contentType: 'text/plain', sizeBytes: b.length, checksumSha256: sha(b), sanitization: sanitized })).json();
    await w.result(t.runResultId, 1, 'pasado');
    await w.complete();
    await ctx.store.putObject((await ctx.prisma.artifact.findUniqueOrThrow({ where: { id: up.artifactId } })).storageKey!, b);
    expect((await w.finalize(up.artifactId, { sizeBytes: b.length, checksumSha256: sha(b) })).statusCode).toBe(200);
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('terminada');
  });
});

describe('rendimiento DXMon vía worker (RF-REN-01)', () => {
  it('RF-REN-01 importación con lease: deduplicación por sample_key y cuarentena con conteo', async () => {
    const { run, w } = await startRun();
    const sample = (k: string, extra: Record<string, unknown> = {}) => ({
      sample_key: k,
      schema_version: 1,
      ts: new Date().toISOString(),
      provenance: 'dxmon',
      source: 'probe',
      metric_kind: 'network_request',
      method: 'GET',
      endpoint: '/warehouse/api/warehouse',
      status_code: 200,
      ok: true,
      total_ms: 120,
      timeout: false,
      cache_mode: 'caliente',
      ...extra,
    });
    const file = { schema_version: 1, run_id: run.id, samples: [sample('s1'), sample('s2'), sample('s3', { total_ms: -5 })] };
    const post = (f: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/worker/perf/samples', headers: { authorization: `Bearer ${w.token}` }, payload: { leaseId: w.leaseId, generation: w.generation, samplesFile: f } });
    const r1 = await post(file);
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.fileError).toBeNull();
    expect(b1.accepted).toBe(2);
    expect(b1.quarantined).toHaveLength(1);
    expect(b1.quarantined[0]).toMatchObject({ index: 2, sampleKey: 's3' });
    const r2 = (await post(file)).json();
    expect(r2.accepted).toBe(0);
    expect(await ctx.prisma.perfSample.count({ where: { runId: run.id } })).toBe(2);
    const invalid = await post({ schema_version: 99 });
    expect(invalid.json().fileError).toBeTruthy();
  });
});

describe('SSE (RF-EJE-02, RNF-OPT-04)', () => {
  async function readUntil(res: Response, pred: (text: string) => boolean, ms = 5_000): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const deadline = Date.now() + ms;
    let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
    while (Date.now() < deadline && !pred(text)) {
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
      if (r === null) continue;
      pending = null;
      if (r.done) break;
      text += dec.decode(r.value);
    }
    void reader.cancel().catch(() => undefined);
    return text;
  }

  it('RF-EJE-02 snapshot al conectar, eventos sanitizados con versión, Last-Event-ID repone huecos', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/v1/events/stream`, { headers: { authorization: ctx.qa.authorization }, signal: ac.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const pending = readUntil(res, (t) => t.includes('event: run.created'), 8_000);
      await new Promise((r) => setTimeout(r, 200));
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/runs',
        headers: { authorization: ctx.qa.authorization, 'idempotency-key': idemKey() },
        payload: { caseIds: [seed.cases.D!.id], environmentId: envId },
      });
      const text = await pending;
      ac.abort();
      expect(text).toContain('event: snapshot');
      expect(text).toContain('event: run.created');
      const m = /id: (\d+)\nevent: run\.created\ndata: (.+)\n/.exec(text)!;
      const evt = JSON.parse(m[2]!);
      expect(evt).toMatchObject({ entity: 'run', entityId: created.json().id, version: 0, runId: created.json().id });
      // Reconexión con Last-Event-ID anterior: snapshot + eventos posteriores (shard.updated de la admisión, etc.).
      const ac2 = new AbortController();
      const res2 = await fetch(`${base}/api/v1/runs/${created.json().id}/events`, {
        headers: { authorization: ctx.qa.authorization, 'last-event-id': String(Number(m[1]) - 1) },
        signal: ac2.signal,
      });
      const text2 = await readUntil(res2, (t) => t.includes('event: run.created'), 5_000);
      ac2.abort();
      expect(text2.indexOf('event: snapshot')).toBeLessThan(text2.indexOf('event: run.created'));
      // Sin autenticación ⇒ 401; tokens en query no se aceptan.
      const anon = await fetch(`${base}/api/v1/events/stream?token=x`);
      expect(anon.status).toBe(401);
    } finally {
      await ctx.app.close().catch(() => undefined);
      ctx = await makeApiBCtx();
    }
  }, 30_000);

  it('RNF-SEG-03 autorización por recurso en eventos: grabaciones solo para su dueño o admin', () => {
    const qa = { kind: 'panel_user' as const, id: 'u1', role: 'qa' as const, email: 'a@x', sessionId: 's' };
    const admin = { ...qa, id: 'u2', role: 'admin' as const };
    const evt = (entity: string, data: Record<string, unknown> = {}) => ({
      id: '1', seq: 1, type: 'run.updated' as const, entity: entity as never, entityId: randomUUID(), version: 1,
      occurredAt: new Date().toISOString(), runId: null, environmentId: null, data,
    });
    expect(canSee(qa, evt('run'))).toBe(true);
    expect(canSee(qa, evt('recording_session', { ownerId: 'u9' }))).toBe(false);
    expect(canSee(qa, evt('recording_session', { ownerId: 'u1' }))).toBe(true);
    expect(canSee(admin, evt('recording_session', { ownerId: 'u9' }))).toBe(true);
    expect(canSee({ kind: 'service', id: 's', scopes: ['worker.claim'] }, evt('run'))).toBe(false);
  });
});

describe('limpieza, historial y piezas puras', () => {
  it('RNF-INF-02 limpieza diaria idempotente: retenciones sin tocar corridas activas', async () => {
    const { run: active, w } = await startRun();
    const old = new Date(Date.now() - 400 * 86_400_000);
    const finished = await ctx.prisma.run.create({
      data: {
        trigger: 'manual', environmentId: envId, status: 'terminada', outcome: 'pasado', selectionSnapshot: {},
        manifestHash: 'a'.repeat(64), gitCommit: 'b'.repeat(40), finishedAt: old, createdAt: old,
      },
    });
    await ctx.prisma.idempotencyKey.create({ data: { actorKey: 'x', key: 'k-vieja', method: 'POST', path: '/x', requestHash: 'h', expiresAt: new Date(Date.now() - 1000) } });
    await ctx.prisma.auditLog.create({ data: { actorKind: 'sistema', actorDisplay: 'sistema', action: 'run.create', entity: 'run', createdAt: old } });
    const art = await ctx.prisma.artifact.create({
      data: { runId: active.id, kind: 'log', contentType: 'text/plain', storageKey: `runs/${active.id}/x.txt`, sanitizationStatus: 'sanitizado', uploadedAt: new Date(), expiresAt: new Date(Date.now() - 1000) },
    });
    const s1 = await runCleanup({ prisma: ctx.prisma, logger: silent, store: ctx.store });
    expect(s1).toMatchObject({ idempotencyKeys: expect.any(Number), runs: 1, audit: 1 });
    expect(await ctx.prisma.run.count({ where: { id: finished.id } })).toBe(0);
    expect(await ctx.prisma.run.count({ where: { id: active.id } })).toBe(1);
    // Artefacto vencido de corrida ACTIVA: no se toca.
    expect((await ctx.prisma.artifact.findUniqueOrThrow({ where: { id: art.id } })).storageKey).not.toBeNull();
    const s2 = await runCleanup({ prisma: ctx.prisma, logger: silent, store: ctx.store });
    expect(s2).toMatchObject({ runs: 0, audit: 0, idempotencyKeys: 0 });
    const gate = dailyCleanupGate(8);
    expect(gate(new Date('2026-11-06T08:10:00Z'))).toBe(true);
    expect(gate(new Date('2026-11-06T08:40:00Z'))).toBe(false);
    expect(gate(new Date('2026-11-07T07:10:00Z'))).toBe(false);
    void w;
  });

  it('RF-RES-03 historial por test y por caso con tendencia de éxito y duración', async () => {
    for (const status of ['pasado', 'fallido'] as const) {
      const { w, t } = await startRun();
      await w.start(t.runResultId);
      await w.result(t.runResultId, 1, status, { final: true, durationMs: status === 'pasado' ? 1000 : 3000 });
      await w.complete();
    }
    const h = await testHistory(ctx.prisma, seed.tests.r3!.id, { limit: 1 });
    expect(h.items).toHaveLength(1);
    expect(h.hasNext).toBe(true);
    expect(h.trend).toMatchObject({ successRate: 0.5, avgDurationMs: 2000, observations: 2 });
    expect(h.flaky).toMatchObject({ denominator: 2, isFlaky: false });
    const c = await caseHistory(ctx.prisma, seed.cases.D!.id, { limit: 10 });
    expect(c.trend.observations).toBe(2);
  });

  it('RF-EJE-04 shards disjuntos y control: bucles ≤ 15 s y carga tolerante de módulos', async () => {
    const parts = partitionShards(Array.from({ length: 5 }, (_, i) => ({ runResultId: `r${i}` })), 2);
    expect(parts).toEqual([['r0', 'r2', 'r4'], ['r1', 'r3']]);
    expect(partitionShards([{ runResultId: 'a' }], 4)).toEqual([['a']]);
    expect(compileSchedule({ editor: { mode: 'hora_fija', days: [1], times: ['09:00'] }, timezone: 'America/La_Paz' }, 5).cronExpressions).toEqual(['0 9 * * 1']);
    const loops = controlLoops(ctx.config);
    expect(loops.map((l) => l.name)).toEqual(expect.arrayContaining(['planificador', 'watchdog_leases', 'despacho_shards', 'reconciliador', 'limpieza_diaria', 'publicador_outbox', 'sync_testrail', 'evaluador_umbrales', 'rollup_rendimiento']));
    const missing = lazyModule('inexistente', () => import('./no-existe.js' as string));
    expect(await missing()).toBeNull();
    const fs = new FsArtifactStore({ rootDir: '/tmp/x', publicBaseUrl: 'http://r', signingSecret: '0123456789abcdef0123' });
    const p = await fs.presignGet('runs/a/b.txt', { expiresInSeconds: 60 });
    const q = Object.fromEntries(new URL(p.url).searchParams);
    expect(fs.verify('GET', 'runs/a/b.txt', q)).not.toBeNull();
    expect(fs.verify('PUT', 'runs/a/b.txt', q)).toBeNull();
    expect(fs.verify('GET', 'runs/a/c.txt', q)).toBeNull();
  });
});

describe('proceso de control (main.control.ts)', () => {
  it('RNF-CON-01/RNF-OBS-02 ticks reales: planificador, watchdog, reconciliador, limpieza, módulos externos y HEALTH_FILE', async () => {
    const { mkdtempSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { registerExternalHandlers } = await import('../src/main.control.js');
    const { enforceRunTimeouts } = await import('../src/services/cancellation.js');
    const file = join(mkdtempSync(join(tmpdir(), 'katalyst-ctl-')), 'alive');
    const config = { ...ctx.config, HEALTH_FILE: file, CLEANUP_HOUR_UTC: new Date().getUTCHours() };
    const messages: unknown[] = [];
    const cctx = {
      config,
      logger: silent,
      prisma: ctx.prisma,
      redis: ctx.redis,
      secrets: { get: async () => 'x' },
      publishControl: async (m: unknown) => void messages.push(m),
      store: ctx.store,
      shardQueue: null,
      triggerQueue: null,
    };
    const { run, w } = await startRun();
    await w.start(w.assignment.tests[0]!.runResultId);
    const loops = controlLoops(config, cctx as never);
    for (const name of ['planificador', 'watchdog_leases', 'reconciliador', 'limpieza_diaria', 'despacho_shards', 'health_file']) {
      await loops.find((l) => l.name === name)!.tick({ logger: silent, now: new Date() });
    }
    expect(statSync(file).mtimeMs).toBeGreaterThan(0);
    const reg = await registerExternalHandlers(cctx as never);
    expect(reg.loaded.length + reg.failed.length).toBe(3);
    // Timeout de corrida congelado (20 min) ⇒ interrumpida/timeout_corrida con señal al supervisor.
    const out = await enforceRunTimeouts(
      { prisma: ctx.prisma, logger: silent, publicBaseUrl: 'http://panel', publishControl: async (m) => void messages.push(m) },
      new Date(Date.now() + 21 * 60_000),
    );
    expect(out).toEqual([run.id]);
    expect(await ctx.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'interrumpida', reason: 'timeout_corrida' });
    expect(messages).toContainEqual(expect.objectContaining({ type: 'cancel', runId: run.id, reason: 'timeout_corrida' }));
  });
});
