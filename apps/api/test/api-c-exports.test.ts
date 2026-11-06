/**
 * Exportaciones (RF-RES-04, ESP §17.3/§17.4): mismos permisos (alcance), página vs conjunto completo explícito,
 * neutralización de fórmulas CSV, PDF generado en servidor, trabajo diferido con archivo privado, URL firmada y
 * vencimiento.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { KatalystError } from '@katalyst/shared';
import { loadConfig } from '../src/config.js';
import type { Principal } from '../src/lib/auth.js';
import { FsArtifactStore } from '../src/adapters/artifact-store/fs.js';
import { createExport, downloadExport, getExport, processExportJob, purgeExpiredExports } from '../src/modules/exports/service.js';
import { createEnvironment, createRun } from './support/api-c.js';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
afterAll(() => prisma.$disconnect());
const root = mkdtempSync(join(tmpdir(), 'katalyst-exports-'));
const store = new FsArtifactStore({ rootDir: root, publicBaseUrl: 'http://localhost:3001', signingSecret: 's'.repeat(64) });
const deps = { config: loadConfig(process.env), store };

async function principal(role: 'qa' | 'admin'): Promise<Principal & { kind: 'panel_user' }> {
  const u = await prisma.panelUser.create({ data: { email: `${role}-${crypto.randomUUID().slice(0, 8)}@example.test`, name: role, role } });
  return { kind: 'panel_user', id: u.id, role, email: u.email, sessionId: crypto.randomUUID() };
}
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as KatalystError;
  }
  throw new Error('se esperaba error');
};
const fileOf = async (id: string) => {
  const j = await prisma.exportJob.findUniqueOrThrow({ where: { id } });
  return readFileSync(join(root, j.storageKey!));
};

describe('exportaciones CSV/PDF (RF-RES-04)', () => {
  it('RF-RES-04 página explícita con fórmulas neutralizadas; mismos filtros del listado', async () => {
    const qa = await principal('qa');
    const env = await createEnvironment(prisma, { name: `=HYPERLINK("http://x")-${crypto.randomUUID().slice(0, 4)}` });
    for (let i = 0; i < 3; i++) await createRun(prisma, env.id, { outcome: i === 0 ? 'fallido' : 'pasado' });
    const r = await createExport(prisma, deps, qa, { format: 'csv', scope: 'runs', filters: { environmentId: env.id }, extent: 'pagina', limit: 2 });
    expect(r.deferred).toBe(false);
    expect(r.job).toMatchObject({ status: 'listo', rowCount: 2, extent: 'pagina' });
    const csv = (await fileOf(r.job.id)).toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    const filtered = await createExport(prisma, deps, qa, {
      format: 'csv',
      scope: 'runs',
      filters: { environmentId: env.id, outcome: 'fallido' },
      extent: 'pagina',
    });
    expect(filtered.job.rowCount).toBe(1);
    expect((await err(createExport(prisma, deps, qa, { format: 'csv', scope: 'runs', filters: { outcome: 'inventado' }, extent: 'pagina' }))).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('RF-RES-04 conjunto completo como trabajo diferido; PDF válido; URL firmada ≤ 5 min y vencimiento', async () => {
    const qa = await principal('qa');
    const env = await createEnvironment(prisma);
    for (let i = 0; i < 5; i++) await createRun(prisma, env.id);
    const r = await createExport(prisma, deps, qa, { format: 'pdf', scope: 'runs', filters: { environmentId: env.id }, extent: 'completo' });
    expect(r.deferred).toBe(true);
    const job = await processExportJob(prisma, deps, r.job.id);
    expect(job.status === 'listo' || job.status === 'en_proceso').toBe(true);
    // Esperar al procesamiento en segundo plano si lo tomó primero.
    for (let i = 0; i < 50 && (await getExport(prisma, qa, r.job.id)).status !== 'listo'; i++) await new Promise((res) => setTimeout(res, 50));
    const done = await getExport(prisma, qa, r.job.id);
    expect(done).toMatchObject({ status: 'listo', rowCount: 5 });
    expect((await fileOf(r.job.id)).subarray(0, 5).toString()).toBe('%PDF-');
    const dl = await downloadExport(prisma, deps, qa, r.job.id);
    expect(new Date(dl.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    // Otro usuario no la ve.
    expect((await err(getExport(prisma, await principal('qa'), r.job.id))).code).toBe('NOT_FOUND');
    // Vencida → archivo eliminado y no descargable.
    const purged = await purgeExpiredExports(prisma, new Date(Date.now() + 25 * 3_600_000), deps);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await getExport(prisma, qa, r.job.id)).status).toBe('vencido');
    expect((await err(downloadExport(prisma, deps, qa, r.job.id))).code).toBe('NOT_FOUND');
  });

  it('RF-RES-04 mismos permisos: qa no exporta auditoría (admin sí); resultados por corrida requieren runId', async () => {
    const qa = await principal('qa');
    const admin = await principal('admin');
    expect((await err(createExport(prisma, deps, qa, { format: 'csv', scope: 'audit_log', filters: {}, extent: 'pagina' }))).code).toBe('FORBIDDEN');
    const ok = await createExport(prisma, deps, admin, { format: 'csv', scope: 'audit_log', filters: {}, extent: 'pagina', limit: 5 });
    expect(ok.job.status).toBe('listo');
    expect((await err(createExport(prisma, deps, qa, { format: 'csv', scope: 'run_results', filters: {}, extent: 'pagina' }))).code).toBe(
      'VALIDATION_FAILED',
    );
    const env = await createEnvironment(prisma);
    const run = await createRun(prisma, env.id);
    const rr = await createExport(prisma, deps, qa, { format: 'csv', scope: 'run_results', filters: {}, extent: 'completo', runId: run.id });
    expect(rr.deferred).toBe(true);
  });
});
