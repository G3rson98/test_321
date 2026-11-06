/**
 * Datos sintéticos para MSW (solo desarrollo/pruebas). Tipados con los DTO de @katalyst/shared.
 * 5.000 casos generados para probar paginación por cursor (ESP §17.5). PRNG con semilla: datos reproducibles.
 * Credenciales de demo: ver mocks/fixtures.ts (valores de prueba de esta app, nunca reales).
 */
import type {
  Alert,
  AuditEntry,
  AutomatedTest,
  CaseResult,
  Delivery,
  Environment,
  NotificationChannel,
  PanelUser,
  RunDetail,
  RunResult,
  Schedule,
  Section,
  Suite,
  SyncRun,
  TestAttempt,
  TestRailConnection,
  TestUser,
  CaseDetail,
  Artifact,
  ApiToken,
  Device,
  RecordingSession,
  PerfThreshold,
  EventMark,
  NotificationPreferences,
} from '@/lib/api/types';
import type { RunOutcome, RunResultStatus, RunStatus } from '@katalyst/shared/enums';
import { buildCronExpressions } from '@katalyst/shared/schedule';
import { DEMO_USERS } from '../fixtures';

// ---------------------------------------------------------------------------
// PRNG y utilidades
// ---------------------------------------------------------------------------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261106);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

export function uuid(r: () => number = rng): string {
  const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  h[12] = '4';
  h[16] = ['8', '9', 'a', 'b'][Math.floor(r() * 4)]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const sha = (r: () => number = rng) => Array.from({ length: 40 }, () => Math.floor(r() * 16).toString(16)).join('');
const sha256 = () => Array.from({ length: 64 }, () => Math.floor(rng() * 16).toString(16)).join('');
const iso = (ms: number) => new Date(ms).toISOString();

export const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Usuarios y sesión
// ---------------------------------------------------------------------------
export const users: PanelUser[] = DEMO_USERS.map((u) => ({
  id: uuid(),
  email: u.email,
  name: u.name,
  role: u.role,
  hasLocalPassword: true,
  authSubject: null,
  disabledAt: null,
  lastLoginAt: iso(NOW - 2 * HOUR),
  createdAt: iso(NOW - 90 * DAY),
  updatedAt: iso(NOW - 10 * DAY),
  version: 1,
}));
export const userByEmail = (email: string) => users.find((u) => u.email === email.toLowerCase());
export const schedulerActor = { id: null, kind: 'sistema' as const, displayName: 'Programador' };
const actorOf = (u: PanelUser) => ({ id: u.id, kind: 'panel_user' as const, displayName: u.name });

// ---------------------------------------------------------------------------
// Ambientes y usuarios de prueba
// ---------------------------------------------------------------------------
const basePolicy = {
  enabledKinds: ['reporte', 'traza', 'video', 'captura', 'log'] as Environment['artifactPolicy']['enabledKinds'],
  screenshotsOnFailureOnly: true,
  videoOnFailureOnly: true,
  traceOnFailureOnly: true,
  maxEvidenceBytesPerRun: 250 * 1024 * 1024,
  maxTempBytesPerRun: 1024 * 1024 * 1024,
  retentionDays: 30,
  disabledReasons: {},
};
export const environments: Environment[] = [
  {
    id: uuid(),
    name: 'Staging',
    isProduction: false,
    enabled: true,
    recordingAllowed: true,
    appUrl: 'https://staging.deltax.la',
    apiUrl: 'https://staging-api.deltax.la',
    maxConcurrency: 4,
    artifactPolicy: basePolicy,
    allowedHosts: ['staging.deltax.la', 'staging-api.deltax.la'],
    createdAt: iso(NOW - 120 * DAY),
    updatedAt: iso(NOW - 20 * DAY),
    disabledAt: null,
    version: 3,
  },
  {
    id: uuid(),
    name: 'Producción',
    isProduction: true,
    enabled: true,
    recordingAllowed: false,
    appUrl: 'https://cbc.deltax.la',
    apiUrl: 'https://fmsapi.deltax.la',
    maxConcurrency: 1,
    artifactPolicy: {
      ...basePolicy,
      enabledKinds: ['reporte', 'log'],
      disabledReasons: {
        traza: 'Deshabilitada en producción por defecto (ESP §13.7).',
        video: 'Deshabilitado en producción por defecto (ESP §13.7).',
        captura: 'Requiere política de enmascaramiento probada con canarios.',
      },
    },
    allowedHosts: ['cbc.deltax.la', 'fmsapi.deltax.la'],
    createdAt: iso(NOW - 120 * DAY),
    updatedAt: iso(NOW - 30 * DAY),
    disabledAt: null,
    version: 2,
  },
];
export const STAGING = environments[0]!;
export const PROD = environments[1]!;
export const envSummary = (e: Environment) => ({
  id: e.id,
  name: e.name,
  isProduction: e.isProduction,
  enabled: e.enabled,
  recordingAllowed: e.recordingAllowed,
});

export const testUsers: TestUser[] = [
  ['qa.shipper1', STAGING, false],
  ['qa.shipper2', STAGING, false],
  ['qa.readonly', PROD, true],
].map(([username, env, ro]) => ({
  id: uuid(),
  environmentId: (env as Environment).id,
  label: String(username),
  username: String(username),
  secretRef: `ssm:/katalyst/${(env as Environment).name === 'Staging' ? 'staging' : 'prod'}/${String(username)}`,
  readOnly: Boolean(ro),
  allowsConcurrency: false,
  enabled: true,
  createdAt: iso(NOW - 60 * DAY),
  updatedAt: iso(NOW - 2 * DAY),
  version: 1,
}));

// ---------------------------------------------------------------------------
// TestRail: secciones, casos (5.000), tests
// ---------------------------------------------------------------------------
const TR_SUITE_ID = uuid();
const topNames = ['Arranque', 'Órdenes de carga', 'Instalaciones', 'Agendamientos'] as const;
export const sections: Section[] = [];
const subNames = ['Listados', 'Formularios', 'Reportes'];
for (const [i, name] of topNames.entries()) {
  const top: Section = { id: uuid(), suiteId: TR_SUITE_ID, externalId: 100 + i, name, parentId: null, depth: 0, archivedAt: null };
  sections.push(top);
  for (const [j, sub] of subNames.entries()) {
    sections.push({ id: uuid(), suiteId: TR_SUITE_ID, externalId: 200 + i * 10 + j, name: `${name} · ${sub}`, parentId: top.id, depth: 1, archivedAt: null });
  }
}
const topByName = (n: string) => sections.find((s) => s.name === n && s.depth === 0)!;

/** Caso interno del mock: los campos extra (etiquetas, flaky…) NO salen en las respuestas (los quita `reply`). */
export interface MockCase extends CaseDetail {
  tags: string[];
  testIds: string[];
  sectionName: string | null;
  classification: AutomatedTest['classification'] | null;
  flaky: AutomatedTest['flaky'] | null;
}
export const cases: MockCase[] = [];
export const tests: AutomatedTest[] = [];
const MAIN_COMMIT = 'a3f9c21' + sha().slice(7);

const STEPS_C1501 = [
  { content: 'Ingresar a /schedulings con usuario shipper', expected: 'Se muestra la vista Agendamientos' },
  { content: 'Seleccionar la pestaña Lista', expected: 'La grilla carga en menos de 60 s' },
  { content: "Filtrar por estado 'Confirmado'", expected: 'Solo se muestran agendamientos confirmados' },
];

interface SeedCase {
  n: number;
  title: string;
  section: string;
  priority: string;
  tags: string[];
  automated: boolean;
  classification?: 'lectura' | 'escritura' | 'sin_clasificar';
  review?: boolean;
  flaky?: boolean;
}
const FIXED: SeedCase[] = [
  { n: 1201, title: 'Login con usuario shipper válido', section: 'Arranque', priority: 'Alta', tags: ['@arranque', '@humo'], automated: true, classification: 'lectura' },
  { n: 1202, title: 'Carga de Informe operativo < 10 s', section: 'Arranque', priority: 'Alta', tags: ['@arranque', '@rendimiento'], automated: true, classification: 'lectura', flaky: true },
  { n: 1310, title: 'Filtrar órdenes de carga · Abastecimiento', section: 'Órdenes de carga', priority: 'Media', tags: ['@oc', '@humo'], automated: true, classification: 'lectura' },
  { n: 1311, title: 'Filtrar órdenes de carga · Directa', section: 'Órdenes de carga', priority: 'Media', tags: ['@oc'], automated: true, classification: 'lectura' },
  { n: 1312, title: 'Crear orden de carga · Distribuidores', section: 'Órdenes de carga', priority: 'Alta', tags: ['@oc', '@escritura'], automated: true, classification: 'escritura', review: true },
  { n: 1420, title: 'Listar instalaciones en Configuración', section: 'Instalaciones', priority: 'Baja', tags: ['@humo'], automated: true, classification: 'lectura' },
  { n: 1501, title: 'Agendamientos · vista lista carga < 60 s', section: 'Agendamientos', priority: 'Alta', tags: ['@agendamiento', '@rendimiento'], automated: true, classification: 'lectura' },
  { n: 1502, title: 'Agendamientos · vista calendario', section: 'Agendamientos', priority: 'Media', tags: ['@agendamiento'], automated: false },
  { n: 1503, title: 'Cambiar estado de agendamiento', section: 'Agendamientos', priority: 'Alta', tags: ['@agendamiento'], automated: false },
];
const VERBS = ['Listar', 'Filtrar', 'Exportar', 'Editar', 'Validar', 'Buscar', 'Ordenar', 'Paginar', 'Abrir detalle de', 'Crear'];
const OBJECTS = ['órdenes de carga', 'instalaciones', 'agendamientos', 'transportistas', 'productos', 'reportes', 'usuarios', 'conductores', 'muelles', 'turnos'];
const TAG_FOR: Record<string, string> = { Arranque: '@arranque', 'Órdenes de carga': '@oc', Instalaciones: '@instalacion', Agendamientos: '@agendamiento' };
export const KNOWN_TAGS = ['@humo', '@oc', '@agendamiento', '@arranque', '@rendimiento', '@instalacion', '@escritura'];

function addCase(sc: SeedCase, sectionId: string, sectionName: string) {
  const id = uuid();
  const testIds: string[] = [];
  if (sc.automated) {
    const testId = uuid();
    testIds.push(testId);
    const classification = sc.classification ?? 'lectura';
    tests.push({
      id: testId,
      stableKey: uuid(),
      filePath: `tests/${(TAG_FOR[sc.section] ?? '@general').slice(1)}.spec.ts`,
      title: `C${sc.n} ${sc.title}`,
      tags: sc.tags,
      classification,
      status: 'aprobado',
      parameterKeys: ['default'],
      writeIdempotencyApproved: false,
      owner: 'Carlos Méndez',
      manifestCommit: MAIN_COMMIT,
      flaky: { score: sc.flaky ? 0.2 : 0, numerator: sc.flaky ? 4 : 0, denominator: 20, isFlaky: !!sc.flaky, environmentId: STAGING.id },
      caseLinks: [],
      lastResult: null,
      updatedAt: iso(NOW - 5 * DAY),
    });
  }
  const revision = sc.review ? 3 : 1 + Math.floor(rng() * 3);
  const c: MockCase = {
    id,
    trCaseId: sc.n,
    ref: `C${sc.n}`,
    sectionId,
    suiteId: TR_SUITE_ID,
    title: sc.title,
    priority: sc.priority,
    type: 'Funcional',
    refs: null,
    revision,
    archivedAt: null,
    syncedAt: iso(NOW - 3 * HOUR),
    automated: sc.automated,
    automatedTestCount: testIds.length,
    linksRequiringReview: sc.review ? 1 : 0,
    lastResult: null,
    steps: sc.n === 1501 || FIXED.some((f) => f.n === sc.n) ? STEPS_C1501 : [{ content: `${sc.title}`, expected: 'El sistema responde sin errores' }],
    expected: null,
    contentHash: sha256(),
    customFields: {},
    links: [],
    revisions: Array.from({ length: revision }, (_, i) => ({ revision: i + 1, contentHash: sha256(), createdAt: iso(NOW - (revision - i) * 15 * DAY) })),
    tags: sc.tags,
    testIds,
    sectionName,
    classification: sc.automated ? (sc.classification ?? 'lectura') : null,
    flaky: null,
  };
  for (const tid of testIds) {
    const t = tests.find((x) => x.id === tid)!;
    t.caseLinks.push({
      caseId: id,
      ref: c.ref,
      title: c.title,
      reviewStatus: sc.review ? 'requiere_revision' : 'vigente',
      reviewedCaseRevision: sc.review ? revision - 1 : revision,
      currentCaseRevision: revision,
      reviewedBy: null,
      reviewedAt: iso(NOW - 20 * DAY),
    });
    c.links.push({ automatedTestId: tid, stableKey: t.stableKey, title: t.title, reviewStatus: sc.review ? 'requiere_revision' : 'vigente', reviewedCaseRevision: sc.review ? revision - 1 : revision });
    c.flaky = t.flaky;
  }
  cases.push(c);
}

for (const sc of FIXED) {
  const top = topByName(sc.section);
  addCase(sc, top.id, top.name);
}
for (let i = 0; cases.length < 5000; i++) {
  const n = 2000 + i;
  const sec = sections[1 + Math.floor(rng() * (sections.length - 1))]!;
  const top = sec.parentId ? sections.find((s) => s.id === sec.parentId)! : sec;
  const automated = rng() < 0.62;
  const tags = [TAG_FOR[top.name] ?? '@general'];
  if (rng() < 0.12) tags.push('@humo');
  if (rng() < 0.06) tags.push('@rendimiento');
  const classification = automated ? (rng() < 0.85 ? 'lectura' : rng() < 0.7 ? 'escritura' : 'sin_clasificar') : undefined;
  if (classification === 'escritura') tags.push('@escritura');
  addCase(
    {
      n,
      title: `${pick(VERBS)} ${pick(OBJECTS)} · escenario ${i + 1}`,
      section: top.name,
      priority: pick(['Alta', 'Media', 'Baja']),
      tags,
      automated,
      ...(classification ? { classification } : {}),
      review: automated && rng() < 0.02,
      flaky: automated && rng() < 0.03,
    },
    sec.id,
    sec.name,
  );
}
export const caseById = (id: string) => cases.find((c) => c.id === id);
export const caseByRef = (ref: string) => cases.find((c) => c.ref === ref);
export const testById = (id: string) => tests.find((t) => t.id === id);

export const TEST_SOURCE = `test('C1501 Agendamientos lista carga < 60 s', {
  tag: ['@agendamiento', '@rendimiento'],
  annotation: { type: 'clasificacion', description: 'lectura' },
}, async ({ page }) => {
  await page.goto('/schedulings');
  await page.getByRole('tab', { name: 'Lista' }).click();
  await expect(page.getByRole('grid')).toBeVisible({ timeout: 60_000 });
});`;
export const MAIN_COMMIT_SHA = MAIN_COMMIT;

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------
function suite(name: string, description: string, tags: string[]): Suite {
  const resolvedCases = cases.filter((c) => c.tags.some((t) => tags.includes(t)) && c.trCaseId < 2000);
  return {
    id: uuid(),
    name,
    description,
    selector: { tags, excludeFlaky: false },
    createdBy: users[0]!.id,
    createdAt: iso(NOW - 40 * DAY),
    updatedAt: iso(NOW - 3 * DAY),
    deletedAt: null,
    version: 1,
    resolved: { cases: resolvedCases.length + (name === 'Humo diario' ? 1 : 0), tests: resolvedCases.filter((c) => c.automated).length },
  };
}
export const suites: Suite[] = [
  suite('Humo diario', 'Verificación rápida de pantallas principales', ['@humo']),
  suite('Regresión OC', 'Órdenes de carga en las tres pestañas', ['@oc']),
  suite('Rendimiento DXMon', 'Ciclos de medición de tiempos y tamaños', ['@rendimiento']),
];
export const suiteById = (id: string) => suites.find((s) => s.id === id);

/** Casos que resuelve un selector de suite / etiquetas (secciones incluyen descendientes). */
export function resolveSelector(sel: { caseIds?: string[]; tags?: string[]; sectionIds?: string[] }): MockCase[] {
  const out = new Map<string, MockCase>();
  if (sel.caseIds) for (const id of sel.caseIds) {
    const c = caseById(id);
    if (c) out.set(c.id, c);
  }
  if (sel.tags) for (const c of cases) if (c.tags.some((t) => sel.tags!.includes(t)) && c.trCaseId < 2000) out.set(c.id, c);
  if (sel.sectionIds) {
    const all = new Set(sel.sectionIds);
    for (const s of sections) if (s.parentId && all.has(s.parentId)) all.add(s.id);
    for (const c of cases) if (all.has(c.sectionId)) out.set(c.id, c);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Corridas, resultados, intentos, artefactos
// ---------------------------------------------------------------------------
/** Resultado interno: `lastError` alimenta el error del intento (la API lo expone en `TestAttempt.error`). */
export type MockRunResult = RunResult & { caseRefs: string[]; lastError: string | null };
export interface MockRun extends RunDetail {
  selectionLabel?: string | null;
  results: MockRunResult[];
  attempts: TestAttempt[];
  caseResults: CaseResult[];
  artifacts: Artifact[];
}
export const runs: MockRun[] = [];

const ERRORS = [
  'TimeoutError: loadingOrder/filter no respondió en 20 000 ms',
  "expect(locator).toBeVisible() falló: getByRole('grid') no apareció",
  'Error: la respuesta de warehouse/list/scheduling fue HTTP 504',
];

function counts(results: RunResult[]) {
  const c = { total: results.length, pendiente: 0, corriendo: 0, pasado: 0, inestable: 0, fallido: 0, bloqueado: 0, omitido: 0, cancelado: 0, error_infraestructura: 0 };
  for (const r of results) c[r.status] += 1;
  return c;
}
export function recomputeRun(run: MockRun): void {
  run.counts = counts(run.results);
  const cc = { total: run.caseResults.length, pasado: 0, inestable: 0, fallido: 0, bloqueado: 0, no_ejecutado: 0, pendiente: 0 };
  for (const cr of run.caseResults) cc[cr.status] += 1;
  run.caseCounts = cc;
}

export function makeRun(opts: {
  caseList: MockCase[];
  env: Environment;
  trigger: 'manual' | 'programada' | 'api';
  by: PanelUser | null;
  at: number;
  suite?: Suite | null;
  scheduleId?: string | null;
  scheduleName?: string | null;
  retries?: number;
  status?: RunStatus;
  plan?: RunResultStatus[];
  selectionLabel?: string | null;
}): MockRun {
  const id = uuid();
  const runTests = opts.caseList.flatMap((c) => c.testIds.map((tid) => ({ c, t: testById(tid)! })));
  const statuses = opts.plan ?? runTests.map(() => (rng() < 0.82 ? 'pasado' : rng() < 0.5 ? 'fallido' : 'inestable'));
  const results: MockRunResult[] = runTests.map(({ c, t }, i) => {
    const status = statuses[i] ?? 'pasado';
    const blocked = opts.env.isProduction && t.classification !== 'lectura';
    const st: RunResultStatus = blocked ? 'bloqueado' : status;
    const dur = st === 'pendiente' || st === 'corriendo' || st === 'bloqueado' ? null : Math.round(8000 + rng() * 25000);
    return {
      id: uuid(),
      runId: id,
      automatedTestId: t.id,
      stableKey: t.stableKey,
      title: c.title,
      filePath: t.filePath,
      parameterKey: 'default',
      classification: t.classification,
      status: st,
      reason: blocked ? 'escritura_en_produccion' : null,
      reasonText: blocked ? 'Clasificación escritura: bloqueado en producción' : null,
      durationMs: dur,
      retryCount: st === 'fallido' || st === 'inestable' ? 1 : 0,
      infraRecoveryCount: 0,
      caseIds: [c.id],
      artifactCount: st === 'fallido' ? 4 : 1,
      evidenceIncomplete: false,
      updatedAt: iso(opts.at + (i + 1) * 20_000),
      version: 3,
      caseRefs: [c.ref],
      lastError: st === 'fallido' ? pick(ERRORS) : null,
    };
  });
  // Casos sin automatización: quedan bloqueados en el plan (ESP §13.1).
  const caseResults: CaseResult[] = opts.caseList.map((c) => {
    const rs = results.filter((r) => r.caseIds.includes(c.id));
    const status: CaseResult['status'] =
      rs.length === 0
        ? 'bloqueado'
        : rs.some((r) => r.status === 'fallido')
          ? 'fallido'
          : rs.some((r) => r.status === 'pendiente' || r.status === 'corriendo')
            ? 'pendiente'
            : rs.some((r) => r.status === 'bloqueado')
              ? 'bloqueado'
              : rs.some((r) => r.status === 'inestable')
                ? 'inestable'
                : 'pasado';
    return {
      id: uuid(),
      runId: id,
      caseId: c.id,
      ref: c.ref,
      title: c.title,
      caseRevision: c.revision,
      status,
      coverage: rs.length === 0 ? 'ninguna' : 'completa',
      contributingResults: rs.map((r) => ({ runResultId: r.id, stableKey: r.stableKey, parameterKey: r.parameterKey, status: r.status })),
      durationMs: rs.reduce((a, r) => a + (r.durationMs ?? 0), 0) || null,
      comment: rs.length === 0 ? 'Sin automatización: se publica como Blocked' : null,
      trResultId: null,
      publishable: status !== 'pendiente',
      syncStatus: 'pendiente',
    };
  });
  const attempts: TestAttempt[] = results.flatMap((r) => {
    if (r.status === 'pendiente' || r.status === 'bloqueado') return [];
    const n = r.retryCount + 1;
    return Array.from({ length: n }, (_, k) => ({
      id: uuid(),
      runResultId: r.id,
      attemptNo: k + 1,
      kind: k === 0 ? ('inicial' as const) : ('retry' as const),
      status:
        r.status === 'corriendo' && k === n - 1
          ? ('corriendo' as const)
          : r.status === 'inestable'
            ? k === n - 1
              ? ('pasado' as const)
              : ('fallido' as const)
            : r.status === 'fallido'
              ? ('fallido' as const)
              : ('pasado' as const),
      startedAt: iso(opts.at + k * 15_000),
      finishedAt: r.status === 'corriendo' && k === n - 1 ? null : iso(opts.at + (k + 1) * 15_000),
      durationMs: r.status === 'corriendo' && k === n - 1 ? null : Math.round((r.durationMs ?? 15000) / n),
      errorCategory: r.status === 'fallido' || (r.status === 'inestable' && k < n - 1) ? ('timeout_aplicacion' as const) : null,
      error: r.status === 'fallido' || (r.status === 'inestable' && k < n - 1) ? r.lastError ?? ERRORS[0]! : null,
      workerLeaseId: null,
    }));
  });
  const artifacts: Artifact[] = results.flatMap((r) => {
    if (r.status !== 'fallido') return [];
    const kinds = ['video', 'traza', 'captura', 'reporte'] as const;
    return kinds.map((kind) => {
      const allowed = opts.env.artifactPolicy.enabledKinds.includes(kind);
      return {
        id: uuid(),
        runId: id,
        runResultId: r.id,
        testAttemptId: null,
        kind,
        contentType: kind === 'video' ? 'video/webm' : kind === 'captura' ? 'image/png' : kind === 'traza' ? 'application/zip' : 'text/html',
        sizeBytes: allowed ? Math.round(50_000 + rng() * 2_000_000) : null,
        checksum: allowed ? sha256() : null,
        sanitizationStatus: allowed ? ('sanitizado' as const) : ('deshabilitado' as const),
        sanitizationReason: allowed ? null : (opts.env.artifactPolicy.disabledReasons[kind] ?? 'Deshabilitada por la política del ambiente'),
        publishable: allowed,
        expiresAt: iso(NOW + 30 * DAY),
        createdAt: iso(opts.at + 60_000),
      };
    });
  });

  const status = opts.status ?? 'terminada';
  const terminal = status === 'terminada' || status === 'cancelada' || status === 'interrumpida' || status === 'omitida';
  const anyFail = results.some((r) => r.status === 'fallido');
  const anyBlocked = caseResults.some((c) => c.status === 'bloqueado');
  const anyFlaky = results.some((r) => r.status === 'inestable');
  const outcome: RunOutcome | null =
    status === 'terminada' ? (anyFail ? 'fallido' : anyBlocked ? 'bloqueado' : anyFlaky ? 'inestable' : 'pasado') : terminal ? 'incompleto' : null;
  const durationMs = terminal ? results.reduce((a, r) => a + (r.durationMs ?? 0), 0) / Math.max(1, Math.min(opts.env.maxConcurrency, 2)) + 20_000 : null;
  const actor = opts.by ? actorOf(opts.by) : schedulerActor;
  const run: MockRun = {
    id,
    trigger: opts.trigger,
    status,
    outcome,
    syncStatus: terminal ? (status === 'terminada' ? 'sincronizada' : 'no_aplica') : 'pendiente',
    reason: status === 'cancelada' ? 'cancelado_por_usuario' : null,
    environment: envSummary(opts.env),
    suiteId: opts.suite?.id ?? null,
    suiteName: opts.suite?.name ?? null,
    scheduleId: opts.scheduleId ?? null,
    scheduleName: opts.scheduleName ?? null,
    counts: counts(results),
    caseCounts: { total: 0, pasado: 0, inestable: 0, fallido: 0, bloqueado: 0, no_ejecutado: 0, pendiente: 0 },
    scheduledFor: opts.trigger === 'programada' ? iso(opts.at) : null,
    queuedAt: iso(opts.at),
    startedAt: iso(opts.at + 5_000),
    finishedAt: terminal ? iso(opts.at + (durationMs ?? 0)) : null,
    cancelRequestedAt: status === 'cancelada' ? iso(opts.at + 30_000) : null,
    durationMs: durationMs !== null ? Math.round(durationMs) : null,
    gitCommit: MAIN_COMMIT,
    createdBy: actor,
    createdAt: iso(opts.at),
    version: 10,
    snapshot: {
      schemaVersion: 1,
      selection: opts.suite ? { kind: 'suite', suiteId: opts.suite.id } : { kind: 'cases', caseIds: opts.caseList.map((c) => c.id).slice(0, 500) },
      suite: opts.suite ? { id: opts.suite.id, name: opts.suite.name, selector: opts.suite.selector } : null,
      scheduleId: opts.scheduleId ?? null,
      scheduleRevision: opts.scheduleId ? 1 : null,
      catalogRevisionId: uuid(),
      gitCommit: MAIN_COMMIT,
      manifestHash: sha256(),
      environment: { id: opts.env.id, name: opts.env.name, appUrl: opts.env.appUrl, apiUrl: opts.env.apiUrl, isProduction: opts.env.isProduction },
      testUser: { testUserId: testUsers.find((u) => u.environmentId === opts.env.id)!.id, label: testUsers.find((u) => u.environmentId === opts.env.id)!.label, readOnly: opts.env.isProduction },
      retries: opts.retries ?? 1,
      excludeFlaky: true,
      timeouts: { testMs: 120_000, setupMs: 120_000, runMs: 20 * MIN, finalizingMs: 60_000 },
      artifactPolicy: opts.env.artifactPolicy,
      testrail: { mode: 'nueva' },
      cases: [],
      tests: [],
      kind: opts.suite?.name === 'Rendimiento DXMon' ? 'rendimiento' : 'funcional',
    },
    runtimeVersions: { node: '24.22.2', playwright: '1.65.0', chromium: '141.0', runner: '0.1.0' },
    shards: [],
    targets: [
      {
        id: uuid(),
        testrailSuiteId: TR_SUITE_ID,
        suiteName: 'Master',
        trRunId: 3300 + Math.floor(rng() * 100),
        syncStatus: terminal ? (status === 'terminada' ? 'sincronizada' : 'no_aplica') : 'pendiente',
        closeExistingRun: false,
        pendingDeliveries: terminal ? 0 : 1,
        lastError: null,
        url: 'https://deltax.testrail.io/index.php?/runs/view/3392',
      },
    ],
    problems: { application: results.filter((r) => r.status === 'fallido').length, runner: 0, publication: 0 },
    evidenceIncomplete: false,
    selectionLabel: opts.selectionLabel ?? (opts.suite ? null : opts.caseList.map((c) => c.ref).slice(0, 3).join(', ')),
    results,
    attempts,
    caseResults,
    artifacts,
  };
  recomputeRun(run);
  return run;
}

const humo = suites[0]!;
const regOC = suites[1]!;
const perfSuite = suites[2]!;
const fixedCases = (refs: number[]) => refs.map((n) => caseByRef(`C${n}`)!).filter(Boolean);
const [ana, carlos, kevin, luis] = users as [PanelUser, PanelUser, PanelUser, PanelUser];

// Historial de 30 días (para "Éxito 7 días", historial por caso y listas paginadas).
for (let d = 30; d >= 1; d--) {
  const at = NOW - d * DAY;
  runs.push(makeRun({ caseList: fixedCases([1201, 1310, 1420, 1502]), env: PROD, trigger: 'programada', by: null, at: at + 8 * HOUR, suite: humo, scheduleName: 'Humo mañana' }));
  if (d % 2 === 0)
    runs.push(makeRun({ caseList: fixedCases([1310, 1311, 1312]), env: STAGING, trigger: 'programada', by: null, at: at + 22 * HOUR, suite: regOC, scheduleName: 'Regresión nocturna OC' }));
}
// Las 6 de la captura 10 (más recientes primero al ordenar).
runs.push(makeRun({ caseList: fixedCases([1310, 1311, 1312]), env: STAGING, trigger: 'manual', by: ana, at: NOW - 26 * HOUR, status: 'cancelada', plan: ['pasado', 'cancelado', 'cancelado'], selectionLabel: '@oc' }));
runs.push(makeRun({ caseList: fixedCases([1201, 1310, 1420, 1502]), env: PROD, trigger: 'programada', by: null, at: NOW - 14 * HOUR, suite: humo, scheduleName: 'Humo mañana', plan: ['pasado', 'pasado', 'pasado'] }));
runs.push(makeRun({ caseList: fixedCases([1501, 1502]), env: STAGING, trigger: 'manual', by: luis, at: NOW - 6 * HOUR, plan: ['fallido'], retries: 1 }));
runs.push(makeRun({ caseList: fixedCases([1202, 1501]), env: PROD, trigger: 'programada', by: null, at: NOW - 3.5 * HOUR, suite: perfSuite, scheduleName: 'Rendimiento horario laboral', plan: ['inestable', 'pasado'] }));
runs.push(makeRun({ caseList: fixedCases([1201, 1310, 1311, 1420]), env: STAGING, trigger: 'manual', by: ana, at: NOW - 3 * HOUR, suite: regOC, plan: ['pasado', 'pasado', 'fallido', 'pasado'], retries: 1 }));
// En curso (captura 14).
export const LIVE_RUN = makeRun({
  caseList: fixedCases([1201, 1310, 1311, 1420]),
  env: PROD,
  trigger: 'programada',
  by: null,
  at: NOW - 70_000,
  suite: humo,
  scheduleName: 'Humo mañana',
  status: 'corriendo',
  plan: ['pasado', 'pasado', 'fallido', 'corriendo'],
  retries: 1,
});
runs.push(LIVE_RUN);
for (const u of [carlos, kevin]) void u;
export const runById = (id: string) => runs.find((r) => r.id === id);

// Último resultado por caso (catálogo).
for (const r of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  for (const rr of r.results) {
    for (const cid of rr.caseIds) {
      const c = caseById(cid);
      if (c && !['pendiente', 'corriendo', 'cancelado'].includes(rr.status)) c.lastResult = { status: rr.status, runId: r.id, finishedAt: r.finishedAt };
    }
  }
}
for (const c of cases) {
  if (!c.lastResult && c.automated && c.trCaseId >= 2000 && rng() < 0.7) {
    c.lastResult = { status: rng() < 0.85 ? 'pasado' : rng() < 0.6 ? 'fallido' : 'inestable', runId: runs[0]!.id, finishedAt: iso(NOW - Math.floor(rng() * 10) * DAY) };
  }
}

// ---------------------------------------------------------------------------
// Programaciones
// ---------------------------------------------------------------------------
function schedule(name: string, sel: Schedule['selector'], env: Environment, editor: NonNullable<Schedule['editor']>, enabled: boolean, _targetLabel: string): Schedule {
  const built = buildCronExpressions(editor);
  return {
    id: uuid(),
    name,
    suiteId: sel.kind === 'suite' ? sel.suiteId : null,
    selector: sel,
    environmentId: env.id,
    cronExpressions: built.cronExpressions,
    editor,
    description: built.description,
    timezone: 'America/La_Paz',
    windowStart: built.windowStart,
    windowEnd: built.windowEnd,
    enabled,
    pausedAt: enabled ? null : iso(NOW - DAY),
    retries: 0,
    notify: { onFailure: true, onInterruption: true, channels: ['slack'] },
    revision: enabled ? 2 : 3,
    createdBy: actorOf(ana),
    createdAt: iso(NOW - 30 * DAY),
    updatedAt: iso(NOW - DAY),
    deletedAt: null,
    nextOccurrence: null,
    lastOccurrence: null,
    version: 1,
  };
}
export const schedules: Schedule[] = [
  schedule('Humo mañana', { kind: 'suite', suiteId: humo.id }, PROD, { mode: 'hora_fija', days: [1, 2, 3, 4, 5], times: ['08:00'] }, true, 'Humo diario'),
  schedule('Rendimiento horario laboral', { kind: 'suite', suiteId: perfSuite.id }, PROD, { mode: 'intervalo', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', everyMinutes: 30 }, true, 'Rendimiento DXMon'),
  schedule('Regresión nocturna OC', { kind: 'suite', suiteId: regOC.id }, STAGING, { mode: 'hora_fija', days: [0, 1, 2, 3, 4, 5, 6], times: ['22:00'] }, true, 'Regresión OC'),
  schedule('Agendamientos fin de semana', { kind: 'tags', tags: ['@agendamiento'] }, STAGING, { mode: 'hora_fija', days: [6], times: ['10:00'] }, false, '@agendamiento'),
];
export const scheduleById = (id: string) => schedules.find((s) => s.id === id);

// ---------------------------------------------------------------------------
// TestRail: conexión, sincronizaciones, entregas
// ---------------------------------------------------------------------------
export const connection: TestRailConnection = {
  id: uuid(),
  baseUrl: 'https://deltax.testrail.io',
  username: 'qa-runner@deltax.la',
  secretRef: 'ssm:/katalyst/testrail/api-key',
  projectExternalId: 7,
  suiteExternalIds: [12],
  enabled: true,
  lastSyncAt: iso(NOW - 3 * HOUR),
  lastSyncStatus: 'exitosa',
  version: 4,
  updatedAt: iso(NOW - 10 * DAY),
};
export const syncRuns: SyncRun[] = Array.from({ length: 12 }, (_, i) => ({
  id: uuid(),
  connectionId: connection.id,
  status: 'exitosa' as const,
  trigger: i === 0 ? ('manual' as const) : ('programada' as const),
  startedAt: iso(NOW - (3 + i) * HOUR - 2 * MIN),
  finishedAt: iso(NOW - (3 + i) * HOUR),
  stats: {
    projects: 1,
    suites: 1,
    sections: sections.length,
    casesSeen: 412,
    casesCreated: 0,
    casesUpdated: i === 0 ? 3 : 0,
    casesNewRevision: i === 0 ? 3 : 0,
    casesArchived: 0,
    linksRequiringReview: i === 0 ? 1 : 0,
    pages: 3,
    unsupportedFields: [],
  },
  error: null,
  createdBy: i === 0 ? kevin.id : null,
}));

const recent = runs.slice(-6);
export const deliveries: Delivery[] = [
  { op: 'testrail.add_results_for_cases', run: recent[2]!, status: 'pendiente', attempts: 3, http: 429, err: 'HTTP 429 · Retry-After', next: NOW + 20 * MIN },
  { op: 'testrail.close_run', run: recent[4]!, status: 'entregada', attempts: 1, http: 200, err: null, next: null },
  { op: 'notification.run_finished', run: recent[4]!, status: 'entregada', attempts: 1, http: 200, err: null, next: null },
  { op: 'testrail.add_results_for_cases', run: LIVE_RUN, status: 'pendiente', attempts: 0, http: null, err: null, next: null },
  { op: 'testrail.add_attachment_to_result', run: recent[0]!, status: 'requiere_intervencion', attempts: 5, http: 403, err: 'HTTP 403 · el usuario de servicio no tiene permiso para adjuntar', next: null },
].map((d, i) => ({
  id: uuid(),
  runId: d.run.id,
  targetId: d.run.targets[0]?.id ?? null,
  operation: d.op as Delivery['operation'],
  dedupKey: `${d.op}:${d.run.id}`,
  status: d.status as Delivery['status'],
  attempts: d.attempts,
  nextAttemptAt: d.next ? iso(d.next) : null,
  expiresAt: iso(NOW + DAY),
  externalId: d.status === 'entregada' ? String(3390 + i) : null,
  lastError: d.err,
  lastHttpStatus: d.http,
  createdAt: iso(NOW - (5 - i) * HOUR),
  updatedAt: iso(NOW - (5 - i) * HOUR + 10 * MIN),
}));

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------
const AUDIT_SAMPLE: [PanelUser | null, string, string, string, Record<string, unknown> | null][] = [
  [null, 'run.create', 'run', 'Humo diario', null],
  [carlos, 'test_case_link.review', 'test_case_link', 'C1312 · revisión v2 → v3', { caseRevision: 3 }],
  [ana, 'run.create', 'run', 'Regresión OC', null],
  [kevin, 'perf_threshold.update', 'perf_threshold', 'Agendamientos lista p95 → 10 s', { limit: { from: 12000, to: 10000 } }],
  [ana, 'schedule.pause', 'schedule', 'Agendamientos fin de semana', null],
  [kevin, 'test_user.create', 'test_user', 'Staging · qa.shipper2', { secretRef: 'ssm:/katalyst/staging/qa.shipper2' }],
];
export const audit: AuditEntry[] = [];
for (let i = 0; i < 80; i++) {
  const [u, action, entity, obj, diff] = AUDIT_SAMPLE[i % AUDIT_SAMPLE.length]!;
  audit.push({
    id: uuid(),
    actorKind: u ? 'panel_user' : 'sistema',
    actorId: u?.id ?? null,
    actorDisplay: u?.name ?? 'Programador',
    action,
    entity,
    entityId: obj,
    diff,
    requestId: `req-${i}`,
    createdAt: iso(NOW - i * 2.7 * HOUR),
  });
}

// ---------------------------------------------------------------------------
// Rendimiento, alertas, notificaciones, dispositivos
// ---------------------------------------------------------------------------
export const PERF_SERIES = [
  { endpointKey: 'GET warehouse/list/scheduling', screen: 'Agendamientos · lista', label: 'Agendamientos lista', base: 4200, growth: 8000, color: 'chart-1', metricKind: 'network_request' as const, source: 'ui' as const, wire: 112_000, body: 586_000 },
  { endpointKey: 'GET users/api/users/current', screen: 'Arranque', label: 'current', base: 2000, growth: 400, color: 'chart-3', metricKind: 'root_current_wait' as const, source: 'raiz' as const, wire: 150_000, body: 1_250_000 },
  { endpointKey: 'GET loadingOrder/filter', screen: 'Órdenes de carga', label: 'Órdenes de carga', base: 3200, growth: 800, color: 'chart-2', metricKind: 'network_request' as const, source: 'ui' as const, wire: 48_000, body: 310_000 },
  { endpointKey: 'GET warehouse/api/warehouse', screen: 'Instalaciones', label: 'Instalaciones', base: 800, growth: 300, color: 'chart-4', metricKind: 'network_request' as const, source: 'ui' as const, wire: 12_000, body: 64_000 },
];

export const thresholds: PerfThreshold[] = PERF_SERIES.map((s, i) => ({
  id: uuid(),
  environmentId: PROD.id,
  seriesSelector: { endpointKey: s.endpointKey, provenance: 'dxmon', source: s.source, metricKind: s.metricKind, cacheMode: 'desconocida', workerProfile: null },
  metric: 'p95',
  limit: [10_000, 5_000, 8_000, 5_000][i]!,
  windowMin: 60,
  minSamples: 20,
  enabled: true,
  label: `${s.label} p95`,
  unit: 'ms',
  lastEvaluation: { at: iso(NOW - 5 * MIN), state: i === 0 ? 'superado' : 'normal', value: i === 0 ? 14_200 : 2_600, n: 24 },
  createdBy: actorOf(kevin),
  createdAt: iso(NOW - 20 * DAY),
  updatedAt: iso(NOW - DAY),
  version: 2,
}));

export const marks: EventMark[] = [
  { id: uuid(), ts: iso(startOfToday() + 13 * HOUR), label: 'Despliegue v4.12', environmentId: PROD.id, frontendVersion: '4.12', backendVersion: '4.12', createdBy: actorOf(kevin), createdAt: iso(NOW - 2 * HOUR) },
];

export function startOfToday(): number {
  // America/La_Paz = UTC-4 sin DST.
  const t = NOW - 4 * HOUR;
  return t - (t % DAY) + 4 * HOUR;
}

export const alerts: Alert[] = [
  {
    id: uuid(),
    kind: 'umbral_rendimiento',
    environmentId: PROD.id,
    thresholdId: thresholds[0]!.id,
    runId: null,
    fingerprint: 'umbral:agendamientos:p95',
    status: 'activa',
    channel: 'slack',
    payload: { label: 'Agendamientos · lista', value: 14_200, limit: 10_000, n: 24, metric: 'p95', at: iso(startOfToday() + 17 * HOUR) },
    lastSentAt: iso(NOW - HOUR),
    recoveredAt: null,
    sendCount: 1,
    createdAt: iso(NOW - HOUR),
    updatedAt: iso(NOW - HOUR),
  },
  {
    id: uuid(),
    kind: 'corrida_fallida',
    environmentId: STAGING.id,
    thresholdId: null,
    runId: recent[4]!.id,
    fingerprint: `run:${recent[4]!.id}`,
    status: 'activa',
    channel: 'slack',
    payload: { label: 'Regresión OC' },
    lastSentAt: iso(NOW - 3 * HOUR),
    recoveredAt: null,
    sendCount: 1,
    createdAt: iso(NOW - 3 * HOUR),
    updatedAt: iso(NOW - 3 * HOUR),
  },
];

export const channels: NotificationChannel[] = [
  { kind: 'slack', enabled: true, secretRef: 'ssm:/katalyst/notify/slack-webhook', recipients: ['#qa-deltax'], smtp: null, lastTestAt: iso(NOW - 5 * DAY), lastTestOk: true, updatedAt: iso(NOW - 5 * DAY), version: 2 },
  { kind: 'correo', enabled: false, secretRef: null, recipients: ['qa@deltax.la'], smtp: { host: 'smtp.deltax.la', port: 587, from: 'katalyst@deltax.la', secure: true }, lastTestAt: null, lastTestOk: null, updatedAt: iso(NOW - 30 * DAY), version: 1 },
  { kind: 'teams', enabled: false, secretRef: null, recipients: [], smtp: null, lastTestAt: null, lastTestOk: null, updatedAt: iso(NOW - 30 * DAY), version: 1 },
];

export const preferences = new Map<string, NotificationPreferences>();

export const apiTokens: ApiToken[] = [
  { id: uuid(), name: 'CI de qa-tests', kind: 'token_api', principalId: kevin.id, scopes: ['runs.read', 'runs.create'], hint: 'x9Q2', expiresAt: iso(NOW + 90 * DAY), revokedAt: null, lastUsedAt: iso(NOW - DAY), createdAt: iso(NOW - 30 * DAY) },
];

export const devices: Device[] = [];
export const deviceState = { linked: false, online: false };
export const recordings: RecordingSession[] = [];
export const deviceAuthorizations = new Map<string, { userCode: string; clientName: string; clientVersion: string; platform: string; status: 'pendiente' | 'aprobada' | 'denegada' | 'vencida' | 'consumida'; expiresAt: string }>([
  ['ABCD-EFGH', { userCode: 'ABCD-EFGH', clientName: 'Asistente Katalyst', clientVersion: '0.1.0', platform: 'windows', status: 'pendiente', expiresAt: iso(NOW + 5 * MIN) }],
]);

export const ids = { TR_SUITE_ID };
