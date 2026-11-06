/* eslint-disable @typescript-eslint/no-explicit-any -- script de aceptación: respuestas JSON sin tipar */
/**
 * Datos de carga para el ensayo RNF-REN-01 / ESP §17.5: 5.000 casos TestRail + 5.000 tests automatizados vinculados
 * (1:1) + historial razonable (corridas terminadas con resultados por test y por caso, intentos), programaciones
 * pausadas y bitácora de auditoría. Idempotente por suite de carga (externalId 9000): si ya existe, no duplica.
 *
 * Uso: DATABASE_URL=postgresql://…/katalyst_accept node scripts/load/seed-5000.ts [--cases 5000] [--runs 300]
 *        [--results-per-run 25] [--schedules 120] [--audit 20000] [--env staging-local]
 * Requiere un ambiente existente (scripts/seed-dev.ts) y una conexión TestRail (se reutiliza la primera).
 * Las programaciones se crean DESHABILITADAS/pausadas: el planificador no dispara corridas durante el ensayo.
 */
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const req = createRequire(path.join(ROOT, 'apps/api/package.json'));
const { PrismaClient } = req('@prisma/client') as { PrismaClient: new (o?: object) => any };

const argv = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const str = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1]) : def;
};
const N_CASES = num('cases', 5000);
const N_RUNS = num('runs', 300);
const PER_RUN = num('results-per-run', 25);
const N_SCHED = num('schedules', 120);
const N_AUDIT = num('audit', 20000);
const ENV_NAME = str('env', 'staging-local');
const SUITE_EXT = 9000;
const SECTION_BASE = 90_000;
const CASE_BASE = 5_000_000;

const AREAS = ['Órdenes de carga', 'Agendamientos', 'Instalaciones', 'Despachos', 'Facturación', 'Transportistas', 'Inventario', 'Reportes', 'Usuarios', 'Notificaciones'];
const VERBS = ['Abrir', 'Filtrar', 'Exportar', 'Ordenar', 'Buscar', 'Paginar', 'Ver detalle de', 'Validar totales de', 'Alternar vista de', 'Revisar estado de'];
const RESULT_STATUSES = ['pasado', 'pasado', 'pasado', 'pasado', 'pasado', 'pasado', 'fallido', 'inestable', 'bloqueado', 'omitido'];
const log = (m: string) => process.stderr.write(`[seed-5000] ${m}\n`);
const pick = <T>(a: readonly T[], i: number): T => a[i % a.length]!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL (p. ej. …/katalyst_accept)');
  const prisma = new PrismaClient();
  const t0 = Date.now();
  try {
    const env = await prisma.environment.findFirst({ where: { name: ENV_NAME } });
    if (!env) throw new Error(`No existe el ambiente ${ENV_NAME}: ejecuta scripts/seed-dev.ts`);
    const conn = await prisma.testRailConnection.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!conn) throw new Error('No hay conexión TestRail: ejecuta scripts/seed-dev.ts');
    const admin = await prisma.panelUser.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' } });
    const existing = await prisma.testRailSuite.findFirst({ where: { connectionId: conn.id, externalId: SUITE_EXT } });
    if (existing) {
      log(`la suite de carga ya existe (${existing.id}); no se duplica`);
      return;
    }
    const project =
      (await prisma.testRailProject.findFirst({ where: { connectionId: conn.id } })) ??
      (await prisma.testRailProject.create({ data: { connectionId: conn.id, externalId: 1, name: 'Proyecto de carga' } }));
    const suite = await prisma.testRailSuite.create({ data: { connectionId: conn.id, projectId: project.id, externalId: SUITE_EXT, name: 'Carga RNF-REN-01 (5.000 casos)' } });

    // Secciones: 10 áreas × 5 subsecciones (árbol de 2 niveles para includeDescendants).
    const sections: { id: string; area: number }[] = [];
    for (let a = 0; a < AREAS.length; a++) {
      const parent = await prisma.testRailSection.create({ data: { connectionId: conn.id, trSectionId: SECTION_BASE + a * 10, suiteId: suite.id, name: AREAS[a], depth: 0, displayOrder: a } });
      sections.push({ id: parent.id, area: a });
      for (let s = 1; s <= 4; s++) {
        const child = await prisma.testRailSection.create({
          data: { connectionId: conn.id, trSectionId: SECTION_BASE + a * 10 + s, suiteId: suite.id, name: `${AREAS[a]} · grupo ${s}`, parentId: parent.id, depth: 1, displayOrder: s },
        });
        sections.push({ id: child.id, area: a });
      }
    }

    // Catálogo: una revisión "completa" que agrupa los tests de carga.
    // Se reutiliza la última revisión `completa` (crear una nueva sin manifiesto real la volvería la vigente y la
    // admisión de corridas respondería MANIFEST_INVALID). Sin revisión previa se crea una marcada como antigua.
    const rev =
      (await prisma.catalogRevision.findFirst({ where: { status: 'completa' }, orderBy: { startedAt: 'desc' } })) ??
      (await prisma.catalogRevision.create({
        data: { status: 'completa', gitCommit: sha('carga').slice(0, 40), manifestHash: sha('manifest-carga'), manifest: { schemaVersion: 1, tests: [] }, testCount: 0, startedAt: new Date(0), finishedAt: new Date(0) },
      }));
    const gitCommit = rev.gitCommit;
    const manifestHash = rev.manifestHash;

    const now = Date.now();
    const cases: any[] = [];
    const tests: any[] = [];
    const links: any[] = [];
    for (let i = 0; i < N_CASES; i++) {
      const sec = sections[i % sections.length]!;
      const trCaseId = CASE_BASE + i;
      const title = `${pick(VERBS, Math.floor(i / sections.length))} ${AREAS[sec.area]} ${String(i + 1).padStart(4, '0')}`;
      const caseId = randomUUID();
      const testId = randomUUID();
      cases.push({
        id: caseId,
        connectionId: conn.id,
        trCaseId,
        sectionId: sec.id,
        suiteId: suite.id,
        title,
        steps: [{ content: 'Abrir la pantalla', expected: 'Se muestra sin errores' }],
        priority: pick(['Low', 'Medium', 'High'], i),
        type: pick(['Functional', 'Smoke & Sanity'], i),
        contentHash: sha(`${trCaseId}:${title}`),
        syncedAt: new Date(now - (i % 48) * 3_600_000),
      });
      const area = AREAS[sec.area]!.normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase();
      tests.push({
        id: testId,
        stableKey: randomUUID(),
        filePath: `tests/carga/${area}/caso-${i + 1}.spec.ts`,
        title: `C${trCaseId} ${title} @carga @${area}`,
        tags: ['@carga', `@${area}`, ...(i % 7 === 0 ? ['@humo'] : [])],
        classification: i % 20 === 0 ? 'escritura' : 'lectura',
        status: 'aprobado',
        parameterKeys: ['default'],
        writeIdempotencyApproved: i % 20 === 0,
        owner: 'qa-automation',
        flakyScore: i % 13 === 0 ? 0.35 : i % 5 === 0 ? 0.02 : null,
        manifestCommit: gitCommit,
        catalogRevisionId: rev.id,
      });
      links.push({ automatedTestId: testId, caseId, reviewStatus: i % 50 === 0 ? 'requiere_revision' : 'vigente', reviewedCaseRevision: 1 });
    }
    await chunked(cases, 1000, (c) => prisma.testRailCase.createMany({ data: c }));
    await chunked(tests, 1000, (c) => prisma.automatedTest.createMany({ data: c }));
    await chunked(links, 1000, (c) => prisma.testCaseLink.createMany({ data: c }));
    log(`${cases.length} casos, ${tests.length} tests y ${links.length} vínculos creados (${Date.now() - t0} ms)`);

    // Historial: corridas terminadas en los últimos 30 días.
    const template = await prisma.run.findFirst({ where: { trigger: 'manual', NOT: { selectionSnapshot: { equals: {} } } }, orderBy: { createdAt: 'asc' }, select: { selectionSnapshot: true } });
    const templateSnapshot = template?.selectionSnapshot ?? null;
    const runs: any[] = [];
    const results: any[] = [];
    const attempts: any[] = [];
    const caseResults: any[] = [];
    for (let r = 0; r < N_RUNS; r++) {
      const runId = randomUUID();
      const started = new Date(now - (N_RUNS - r) * (30 * 86_400_000) / N_RUNS);
      const finished = new Date(started.getTime() + 180_000 + (r % 10) * 20_000);
      let failed = 0;
      const idxs = Array.from({ length: PER_RUN }, (_, k) => (r * 37 + k * 197) % N_CASES);
      for (const [k, idx] of idxs.entries()) {
        const status = pick(RESULT_STATUSES, r + k * 3);
        if (status === 'fallido') failed++;
        const resId = randomUUID();
        results.push({ id: resId, runId, automatedTestId: tests[idx].id, status, durationMs: 5000 + ((r + k) % 40) * 1000, retryCount: status === 'inestable' ? 1 : 0, createdAt: started, updatedAt: finished });
        if (status !== 'omitido' && status !== 'bloqueado') {
          attempts.push({ runResultId: resId, attemptNo: 1, kind: 'inicial', status: status === 'pasado' ? 'pasado' : 'fallido', startedAt: started, finishedAt: finished, durationMs: 5000, errorCategory: status === 'pasado' ? null : 'asercion', error: status === 'pasado' ? null : 'expect(locator).toBeVisible() falló (sintético)' });
          if (status === 'inestable') attempts.push({ runResultId: resId, attemptNo: 2, kind: 'retry', status: 'pasado', startedAt: started, finishedAt: finished, durationMs: 5200 });
        }
        caseResults.push({ runId, caseId: cases[idx].id, caseRevision: 1, status: status === 'omitido' ? 'no_ejecutado' : status, coverage: 'completa', durationMs: 5000, publishable: status !== 'omitido', createdAt: finished });
      }
      runs.push({
        id: runId,
        trigger: r % 3 === 0 ? 'programada' : 'manual',
        environmentId: env.id,
        status: 'terminada',
        outcome: failed > 0 ? 'fallido' : 'pasado',
        syncStatus: r % 4 === 0 ? 'no_aplica' : 'sincronizada',
        // Forma real del snapshot (copiada de una corrida existente) para que el detalle de la corrida sea válido.
        selectionSnapshot: templateSnapshot ?? { kind: 'funcional', cases: [], tests: [], caseIds: idxs.map((i) => cases[i].id) },
        retries: 1,
        catalogRevisionId: rev.id,
        manifestHash,
        queuedAt: started,
        startedAt: started,
        finishedAt: finished,
        gitCommit,
        createdById: admin?.id ?? null,
        createdAt: started,
        updatedAt: finished,
      });
    }
    await chunked(runs, 500, (c) => prisma.run.createMany({ data: c }));
    await chunked(results, 2000, (c) => prisma.runResult.createMany({ data: c }));
    await chunked(attempts, 2000, (c) => prisma.testAttempt.createMany({ data: c }));
    await chunked(caseResults, 2000, (c) => prisma.caseResult.createMany({ data: c }));
    log(`${runs.length} corridas, ${results.length} resultados, ${attempts.length} intentos, ${caseResults.length} resultados por caso`);

    const schedules: any[] = [];
    for (let s = 0; s < N_SCHED; s++) {
      const caseIds = [cases[(s * 41) % N_CASES].id, cases[(s * 41 + 1) % N_CASES].id];
      schedules.push({
        name: `Carga ${pick(AREAS, s)} ${String(s + 1).padStart(3, '0')}`,
        selector: { kind: 'cases', caseIds },
        environmentId: env.id,
        cronExpressions: [`${s % 60} ${3 + (s % 4)} * * 1-5`],
        notify: { onFailure: true, onInterruption: true, channels: [] },
        timezone: 'America/La_Paz',
        enabled: false,
        pausedAt: new Date(),
        createdById: admin?.id ?? null,
      });
    }
    await chunked(schedules, 500, (c) => prisma.schedule.createMany({ data: c }));

    const audit: any[] = [];
    const ACTIONS = ['run.create', 'run.cancel', 'schedule.update', 'environment.update', 'testrail.sync', 'auth.login', 'catalog.refresh'];
    for (let a = 0; a < N_AUDIT; a++) {
      audit.push({
        actorKind: a % 5 === 0 ? 'sistema' : 'panel_user',
        actorId: a % 5 === 0 ? null : (admin?.id ?? null),
        actorDisplay: a % 5 === 0 ? 'sistema' : 'Administrador local',
        action: pick(ACTIONS, a),
        entity: pick(['run', 'schedule', 'environment', 'testrail_sync_run', 'panel_session', 'catalog_revision'], a),
        entityId: runs[a % runs.length]?.id ?? null,
        diff: { carga: true, n: a },
        createdAt: new Date(now - (N_AUDIT - a) * 120_000),
      });
    }
    await chunked(audit, 5000, (c) => prisma.auditLog.createMany({ data: c }));
    await prisma.$executeRawUnsafe('ANALYZE');
    log(`${schedules.length} programaciones (pausadas) y ${audit.length} registros de auditoría; total ${Date.now() - t0} ms`);
    process.stdout.write(`${JSON.stringify({ suiteId: suite.id, cases: cases.length, tests: tests.length, runs: runs.length, results: results.length, attempts: attempts.length, caseResults: caseResults.length, schedules: schedules.length, audit: audit.length, ms: Date.now() - t0 })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[seed-5000] ERROR: ${(e as Error).message}\n`);
  process.exit(1);
});
