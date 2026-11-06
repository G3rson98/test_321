/**
 * Verificación extremo a extremo del stack LOCAL (scripts/dev-stack.sh + scripts/seed-dev.ts) solo por HTTP:
 * login → sync TestRail (falso) → refresh de catálogo (catalog-listing en el supervisor) → preview → corrida manual
 * con Chromium real contra la fixture local → resultados/evidencia persistidos → publicación al TestRail falso
 * (add_run → add_results_for_cases → add_attachment_to_result → close_run) → cancelación (< 30 s) → programación
 * (próximas 5 y una ocurrencia real disparada por el planificador).
 * Uso: node scripts/e2e-local.ts < archivo-con-clave-admin   [E2E_SKIP_SCHEDULE_FIRE=1 para omitir la espera de la
 * ocurrencia programada]. Imprime un JSON con las mediciones (sin secretos) y sale ≠ 0 si una verificación falla.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { KatalystClient, readEnvFile, readStdin, stackDir, waitFor } from './lib/katalyst-client.ts';

const STACK = stackDir();
const stackEnv = readEnvFile(path.join(STACK, 'stack.env'));
const API = process.env.KATALYST_DEV_API_URL ?? stackEnv.KATALYST_DEV_API_URL ?? 'http://127.0.0.1:3000';
const TR = stackEnv.FAKE_TESTRAIL_URL ?? 'http://127.0.0.1:4010';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@katalyst.example.test';
const ENV_NAME = process.env.SEED_ENV_NAME ?? 'staging-local';
const TERMINAL = new Set(['terminada', 'cancelada', 'interrumpida']);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), api: API };
const failures: string[] = [];
const log = (m: string) => process.stderr.write(`[e2e] ${m}\n`);
function check(cond: unknown, what: string): void {
  if (cond) log(`OK  ${what}`);
  else {
    log(`FALLA ${what}`);
    failures.push(what);
  }
}

async function trState(): Promise<any> {
  return (await fetch(`${TR}/_fake/state`)).json();
}

async function main(): Promise<void> {
  const password = await readStdin();
  const c = new KatalystClient(API);
  const t0 = Date.now();
  const me = await c.login(ADMIN_EMAIL, password);
  check(me.user?.role === 'admin', 'login admin por cookie de sesión + CSRF');
  const health = await (await fetch(`${API}/readyz`)).json();
  check(health.status === 'ready', '/readyz (BD + Redis)');

  // 1) Sincronización TestRail
  const sync = await c.ok('POST', '/testrail/sync', {}, [202]);
  const syncDone = await waitFor(async () => {
    const r = await c.ok('GET', `/testrail/sync-runs/${sync.id}`);
    return r.status === 'en_curso' ? null : r;
  }, 120_000, 'sync TestRail');
  const counts = syncDone.counts ?? syncDone.stats;
  report.sync = { status: syncDone.status, counts };
  check(syncDone.status === 'exitosa', `sync TestRail exitosa (${JSON.stringify(counts)})`);

  // 2) Refresco del catálogo: la API encola catalog-listing; el supervisor hace checkout + `playwright --list`.
  const tRef = Date.now();
  const rev = await c.ok('POST', '/tests/refresh', {}, [202]);
  const revDone = await waitFor(async () => {
    const r = await c.ok('GET', `/catalog/revisions/${rev.id}`);
    return r.status === 'en_curso' ? null : r;
  }, 240_000, 'revisión de catálogo');
  report.catalog = { status: revDone.status, gitCommit: revDone.gitCommit, testCount: revDone.testCount, ms: Date.now() - tRef };
  check(revDone.status === 'completa', `refresh de catálogo completa (${revDone.testCount} tests, ${Date.now() - tRef} ms)`);

  const envs = await c.all('/environments');
  const env = envs.find((e: any) => e.name === ENV_NAME);
  if (!env) throw new Error(`ambiente ${ENV_NAME} no existe: ejecuta scripts/seed-dev.ts`);
  const cases = await c.all('/testrail/cases?includeArchived=false');
  const byTr = (n: number) => cases.find((x: any) => x.trCaseId === n);
  report.casesInApi = cases.length;
  const sel = [900006, 900007, 900004].map((n) => byTr(n)?.id);
  check(sel.every(Boolean), 'casos C900006/C900007/C900004 sincronizados');

  // 3) Vista previa
  const runBody = { caseIds: sel, environmentId: env.id, retries: 1, testrail: { mode: 'nueva' } };
  const preview = await c.ok('POST', '/runs/preview', runBody, [200]);
  report.preview = { counts: preview.counts, blockers: preview.blockers, gitCommit: preview.gitCommit };
  check(preview.counts.executableTests === 3 && preview.blockers.length === 0, `preview: ${JSON.stringify(preview.counts)}`);

  // 4) Corrida manual (idempotente) → Chromium real contra la fixture local
  const key = `e2e-${randomUUID()}`;
  const tRun = Date.now();
  const created = await c.request('POST', '/runs', { ...runBody, previewToken: preview.previewToken }, { 'idempotency-key': key });
  check(created.status === 201, `POST /runs → 201 (${created.status})`);
  const runId = created.body.id;
  const again = await c.request('POST', '/runs', { ...runBody, previewToken: preview.previewToken }, { 'idempotency-key': key });
  check(again.status === 200 && again.body.id === runId, 'POST /runs repetido con la misma Idempotency-Key → 200 misma corrida');
  const statuses: string[] = [];
  const run = await waitFor(async () => {
    const r = await c.ok('GET', `/runs/${runId}`);
    if (statuses.at(-1) !== r.status) statuses.push(r.status);
    return TERMINAL.has(r.status) ? r : null;
  }, 480_000, 'corrida terminal', 1000);
  const results = await c.all(`/runs/${runId}/results`);
  const resultSummary = results.map((r: any) => ({ title: r.title.slice(0, 60), status: r.status, reason: r.reason, retryCount: r.retryCount, artifacts: r.artifactCount }));
  const attempts: any[] = [];
  for (const r of results) {
    const a = await c.ok('GET', `/runs/${runId}/results/${r.id}/attempts`);
    attempts.push(...(a.items ?? a).map((x: any) => ({ test: r.title.slice(0, 5), kind: x.kind, status: x.status, errorCategory: x.errorCategory })));
  }
  const artifacts = await c.all(`/runs/${runId}/artifacts`);
  report.manualRun = {
    runId,
    statuses,
    final: { status: run.status, outcome: run.outcome, syncStatus: run.syncStatus },
    seconds: Math.round((Date.now() - tRun) / 1000),
    results: resultSummary,
    attempts,
    artifacts: artifacts.map((a: any) => ({ kind: a.kind, contentType: a.contentType, sizeBytes: a.sizeBytes, status: a.status ?? a.sanitizationStatus })),
  };
  check(run.status === 'terminada', `corrida manual terminada (outcome ${run.outcome}, ${Math.round((Date.now() - tRun) / 1000)} s)`);
  const st = (n: string) => results.find((r: any) => r.title.startsWith(n))?.status;
  check(st('C900006') === 'pasado', `C900006 pasado (${st('C900006')})`);
  check(st('C900007') === 'fallido', `C900007 fallido (${st('C900007')})`);
  check(Boolean(st('C900004')), `C900004 con resultado persistido (${st('C900004')})`);
  check(artifacts.length > 0, `${artifacts.length} artefactos registrados`);
  const blocked = artifacts.filter((a: any) => (a.status ?? a.sanitizationStatus) !== 'sanitizado');
  check(blocked.length === 0, `toda la evidencia quedó sanitizada (${blocked.length} bloqueados)`);
  const html = artifacts.find((a: any) => a.contentType === 'text/html' && (a.status ?? a.sanitizationStatus) === 'sanitizado');
  check(Boolean(html), 'reporte HTML sanitizado disponible');
  if (html) {
    const link = await c.ok('GET', `/runs/${runId}/artifacts/${html.id}`);
    const res = await fetch(link.url, { redirect: 'manual' });
    report.reportViewer = { disposition: link.disposition, status: res.status, expiresAt: link.expiresAt };
    check(res.status === 200 || res.status === 302 || res.status === 303, `visor de reportes sirve el HTML firmado (HTTP ${res.status})`);
    const reuse = await fetch(link.url, { redirect: 'manual' });
    report.reportViewer = { ...(report.reportViewer as object), reuseStatus: reuse.status };
  }

  // 5) Publicación TestRail (outbox → add_run → add_results_for_cases → adjuntos → close_run)
  const synced = await waitFor(async () => {
    const r = await c.ok('GET', `/runs/${runId}`);
    return r.syncStatus === 'sincronizada' || r.syncStatus === 'requiere_intervencion' ? r : null;
  }, 180_000, 'publicación TestRail', 1000);
  const targets = await c.ok('GET', `/runs/${runId}/targets`);
  const tr = await trState();
  const trRun = tr.runs.at(-1);
  const trTests = tr.tests.filter((t: any) => t.run_id === trRun?.id);
  const trResults = tr.results.filter((r: any) => trTests.some((t: any) => t.id === r.test_id));
  const trAtt = tr.attachments.filter((a: any) => trResults.some((r: any) => r.id === a.result_id));
  report.testrail = {
    syncStatus: synced.syncStatus,
    targets: (targets.items ?? targets).map((t: any) => ({ trRunId: t.trRunId, syncStatus: t.syncStatus, mode: t.mode })),
    fake: { runId: trRun?.id, name: trRun?.name, isCompleted: trRun?.is_completed, tests: trTests.length, results: trResults.map((r: any) => r.status_id), attachments: trAtt.map((a: any) => ({ name: a.name, size: a.size })) },
  };
  check(synced.syncStatus === 'sincronizada', `publicación TestRail sincronizada (${synced.syncStatus})`);
  check(trRun?.is_completed === true && trResults.length >= 3, `TestRail falso: run ${trRun?.id} cerrada con ${trResults.length} resultados y ${trAtt.length} adjuntos`);

  // 6) Cancelación
  const c8 = byTr(900008)?.id;
  const cancelRun = await c.ok('POST', '/runs', { caseIds: [c8], environmentId: env.id, retries: 0, testrail: { mode: 'ninguno' } }, [201], { 'idempotency-key': `e2e-${randomUUID()}` });
  await waitFor(async () => {
    const rs = await c.all(`/runs/${cancelRun.id}/results`);
    return rs.some((r: any) => r.status === 'corriendo') ? true : null;
  }, 180_000, 'C900008 corriendo', 500);
  await new Promise((r) => setTimeout(r, 3000));
  const tc = Date.now();
  const cancel = await c.ok('POST', `/runs/${cancelRun.id}/cancel`, { reason: 'ensayo e2e local' }, [200]);
  const cancelled = await waitFor(async () => {
    const r = await c.ok('GET', `/runs/${cancelRun.id}`);
    return TERMINAL.has(r.status) ? r : null;
  }, 60_000, 'corrida cancelada', 250);
  const cancelMs = Date.now() - tc;
  report.cancel = { runId: cancelRun.id, stopConfirmed: cancel.stopConfirmed, final: cancelled.status, ms: cancelMs };
  check(cancelled.status === 'cancelada' && cancelMs < 30_000, `cancelación → ${cancelled.status} en ${cancelMs} ms (< 30 s)`);

  // 7) Programación: próximas 5 + ocurrencia real
  const sched = await c.ok(
    'POST',
    '/schedules',
    { name: `e2e hora fija ${Date.now()}`, caseIds: [byTr(900006)?.id], environmentId: env.id, timezone: 'America/La_Paz', editor: { mode: 'hora_fija', days: [1, 2, 3, 4, 5], times: ['03:00', '15:30'] } },
    [201],
  );
  const next = await c.ok('GET', `/schedules/${sched.id}/next?count=5`);
  report.schedule = { id: sched.id, cron: sched.cronExpressions, next: next.occurrences.map((o: any) => o.local) };
  check(next.occurrences.length === 5, `próximas 5 ocurrencias: ${next.occurrences.map((o: any) => o.local).join(' | ')}`);
  await c.ok('POST', `/schedules/${sched.id}/pause`, {}, [200]);

  if (!process.env.E2E_SKIP_SCHEDULE_FIRE) {
    // Hora fija = ahora + 2 min en America/La_Paz (el intervalo mínimo del editor es 5 min).
    const at = new Date(Date.now() + 120_000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/La_Paz', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
    const every = await c.ok(
      'POST',
      '/schedules',
      { name: `e2e disparo ${Date.now()}`, caseIds: [byTr(900006)?.id], environmentId: env.id, timezone: 'America/La_Paz', retries: 0, editor: { mode: 'hora_fija', days: [day], times: [`${parts.hour}:${parts.minute}`] } },
      [201],
    );
    const tf = Date.now();
    const fired = await waitFor(async () => {
      const page = await c.ok('GET', `/runs?scheduleId=${every.id}&limit=5`);
      return page.items.length ? page.items[0] : null;
    }, 240_000, 'corrida disparada por la programación', 2000);
    await c.ok('POST', `/schedules/${every.id}/pause`, {}, [200]);
    const firedDone = await waitFor(async () => {
      const r = await c.ok('GET', `/runs/${fired.id}`);
      return TERMINAL.has(r.status) ? r : null;
    }, 300_000, 'corrida programada terminal', 1000);
    const occ = await c.ok('GET', `/schedules/${every.id}/occurrences?limit=5`);
    report.scheduleFired = { scheduleId: every.id, runId: fired.id, trigger: fired.trigger, secondsToRun: Math.round((Date.now() - tf) / 1000), final: { status: firedDone.status, outcome: firedDone.outcome }, occurrences: (occ.items ?? []).map((o: any) => o.status) };
    check(fired.trigger === 'programada' && firedDone.status === 'terminada', `ocurrencia programada → corrida ${firedDone.status}/${firedDone.outcome}`);
  }

  const audit = await c.ok('GET', '/audit-log?limit=100');
  report.audit = [...new Set(audit.items.map((a: any) => a.action))];
  report.totalSeconds = Math.round((Date.now() - t0) / 1000);
  report.failures = failures;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) process.exit(2);
}

main().catch((e: unknown) => {
  process.stderr.write(`[e2e] ERROR: ${(e as Error).message}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, error: (e as Error).message, failures }, null, 2)}\n`);
  process.exit(1);
});
