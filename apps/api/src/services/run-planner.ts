/**
 * Planificador de corrida (ESP §13.1, §17.3; RF-EJE-01, RF-EJE-06, RF-EJE-07, RNF-SEG-04).
 * Resuelve una selección discriminada (`suite | cases | tags`) contra UNA revisión completa y consistente del catálogo
 * (manifiesto de la rama protegida + commit SHA completo) y produce:
 *  - el plan visible (`RunPreviewResponse`): casos y tests/variantes con motivos de bloqueo y conteos separados;
 *  - el snapshot inmutable (`RunSnapshot`) que congela selector, tests, casos+revisiones, vínculos, clasificación,
 *    ambiente, usuario reservado (solo referencia), reintentos, timeouts, commit y manifestHash. Nunca secretos.
 * Reglas de producción: solo tests aprobados con clasificación explícita `lectura`, vínculos vigentes y usuario de
 * prueba de solo lectura; escritura, sin clasificar y contradicciones quedan bloqueados con causa estable.
 * Casos sin automatización permanecen en el plan como bloqueados (`sin_automatizacion`). Selector vacío ⇒ 422.
 */
import type { Prisma } from '@prisma/client';
import {
  ArtifactPolicySchema,
  DEFAULT_PARAMETER_KEY,
  DEFAULT_PRODUCTION_ARTIFACT_POLICY,
  KatalystError,
  ManifestSchema,
  RuntimeSettingsSchema,
  SuiteSelectorSchema,
  WRITE_TAG,
  canonicalJson,
  effectiveTags,
  manifestHash as computeManifestHash,
  sha256Hex,
  type ArtifactPolicy,
  type Classification,
  type Coverage,
  type ManifestTest,
  type PlanCase,
  type PlanTest,
  type ResultReason,
  type RunPreviewResponse,
  type RunSelection,
  type RunSnapshot,
  type RunTrigger,
  type RuntimeSettings,
  type SuiteSelector,
  type TestRailTargetOptions,
} from '@katalyst/shared';

export type Db = Prisma.TransactionClient;

/** Versiones de runtime fijadas (docs/pendientes-integracion.md "De qa-tests"). */
export const RUNTIME_DEFAULTS = {
  playwrightVersion: '1.65.0',
  image: 'mcr.microsoft.com/playwright:v1.65.0-noble',
  imageDigest: 'sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d',
} as const;

export const RUNTIME_SETTINGS_KEY = 'runtime';
export const PERF_TAG = '@rendimiento';

/** Parámetros administrativos (RuntimeSetting `runtime`), con defaults de ESP §13.3/§13.5 si no existen. */
export async function loadRuntimeSettings(db: Db): Promise<RuntimeSettings> {
  const row = await db.runtimeSetting.findUnique({ where: { key: RUNTIME_SETTINGS_KEY } });
  const base = { timeouts: {}, capacity: {}, schedule: {}, version: 0 };
  const raw = row?.value && typeof row.value === 'object' ? { ...base, ...(row.value as object) } : base;
  const parsed = RuntimeSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : RuntimeSettingsSchema.parse(base);
}

/** Política de evidencia del ambiente; sin configuración válida se usa la restrictiva por defecto (ESP §13.7). */
export function artifactPolicyOf(raw: unknown): ArtifactPolicy {
  if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
    const p = ArtifactPolicySchema.safeParse(raw);
    if (p.success) return p.data;
  }
  return {
    ...DEFAULT_PRODUCTION_ARTIFACT_POLICY,
    enabledKinds: [...DEFAULT_PRODUCTION_ARTIFACT_POLICY.enabledKinds, 'dxmon_samples', 'dxmon_summary'],
  };
}

export interface PlanRequest {
  selection: RunSelection;
  environmentId: string;
  retries: number;
  excludeFlaky: boolean;
  testrail: TestRailTargetOptions;
  trigger: RunTrigger;
  scheduleId?: string | null;
  scheduleRevision?: number | null;
}

export interface PlanTarget {
  testrailSuiteId: string;
  name: string;
  caseIds: string[];
}

export interface ResolvedPlan {
  preview: RunPreviewResponse;
  snapshot: RunSnapshot;
  previewToken: string;
  catalogRevisionId: string;
  environment: { id: string; name: string; isProduction: boolean; maxConcurrency: number; enabled: boolean };
  testUser: { id: string; allowsConcurrency: boolean; readOnly: boolean } | null;
  targets: PlanTarget[];
  settings: RuntimeSettings;
  /** Tests ejecutables (variantes) que irán a shards. */
  executableTests: PlanTest[];
}

interface TestRow {
  id: string;
  stableKey: string;
  filePath: string;
  title: string;
  tags: string[];
  classification: Classification;
  status: 'borrador' | 'aprobado' | 'retirado';
  parameterKeys: string[];
  writeIdempotencyApproved: boolean;
  flakyScore: number | null;
  flakyDenominator: number;
  links: { caseId: string; reviewStatus: 'vigente' | 'requiere_revision' }[];
}

interface CaseRow {
  id: string;
  trCaseId: number;
  title: string;
  revision: number;
  suiteId: string;
  archivedAt: Date | null;
}

const uniq = <T>(arr: Iterable<T>): T[] => [...new Set(arr)];

function foreign(field: string, message?: string): KatalystError {
  return new KatalystError('SELECTION_FOREIGN_IDS', message, { reasons: [field] });
}

/** ¿El test está marcado flaky (≥ 10 observaciones y score ≥ 0,20, ESP §13.1)? */
export function isFlaky(t: { flakyScore: number | null; flakyDenominator: number }): boolean {
  return t.flakyDenominator >= 10 && t.flakyScore !== null && t.flakyScore >= 0.2;
}

/** Contradicciones entre BD, manifiesto y etiquetas (clasificación ⇒ RF-EJE-06 "contradictoria"). */
export function classificationContradiction(t: TestRow, m: ManifestTest | undefined): boolean {
  if (m) {
    if (m.classification !== t.classification) return true;
    if (m.status === 'retirado' && t.status === 'aprobado') return true;
  }
  const hasWriteTag = t.tags.includes(WRITE_TAG);
  if (hasWriteTag && t.classification !== 'escritura') return true;
  return false;
}

/** Secciones descendientes (incluye las indicadas). */
async function descendantSections(db: Db, sectionIds: string[]): Promise<string[]> {
  if (sectionIds.length === 0) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM testrail_section WHERE id = ANY(${sectionIds}::uuid[])
      UNION
      SELECT s.id FROM testrail_section s JOIN tree t ON s.parent_id = t.id
    )
    SELECT id::text AS id FROM tree`;
  return rows.map((r) => r.id);
}

export async function resolvePlan(db: Db, req: PlanRequest): Promise<ResolvedPlan> {
  // --- Ambiente -------------------------------------------------------------------------------------------------
  const env = await db.environment.findUnique({
    where: { id: req.environmentId },
    include: {
      testUsers: { where: { enabled: true, disabledAt: null }, orderBy: [{ label: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!env) throw foreign('environmentId', 'El ambiente no existe.');
  if (!env.enabled || env.disabledAt) throw new KatalystError('ENVIRONMENT_DISABLED');

  // --- Revisión consistente del catálogo ------------------------------------------------------------------------
  const rev = await db.catalogRevision.findFirst({
    where: { status: 'completa', gitCommit: { not: null }, manifestHash: { not: null } },
    orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
  });
  if (!rev || !rev.gitCommit || !rev.manifestHash) throw new KatalystError('CATALOG_REVISION_INCOMPLETE');
  let manifestByKey = new Map<string, ManifestTest>();
  if (rev.manifest !== null && rev.manifest !== undefined) {
    const parsed = ManifestSchema.safeParse(rev.manifest);
    if (!parsed.success || computeManifestHash(parsed.data) !== rev.manifestHash) {
      throw new KatalystError('MANIFEST_INVALID');
    }
    manifestByKey = new Map(parsed.data.tests.map((t) => [t.stableKey, t]));
  }

  const testRows: TestRow[] = await db.automatedTest.findMany({
    where: { catalogRevisionId: rev.id },
    select: {
      id: true,
      stableKey: true,
      filePath: true,
      title: true,
      tags: true,
      classification: true,
      status: true,
      parameterKeys: true,
      writeIdempotencyApproved: true,
      flakyScore: true,
      flakyDenominator: true,
      links: { select: { caseId: true, reviewStatus: true } },
    },
    orderBy: [{ filePath: 'asc' }, { title: 'asc' }, { id: 'asc' }],
  });
  const testsById = new Map(testRows.map((t) => [t.id, t]));
  const testsByCase = new Map<string, TestRow[]>();
  for (const t of testRows) {
    for (const l of t.links) {
      const list = testsByCase.get(l.caseId) ?? [];
      list.push(t);
      testsByCase.set(l.caseId, list);
    }
  }

  // --- Selección ------------------------------------------------------------------------------------------------
  let suite: { id: string; name: string; selector: SuiteSelector } | null = null;
  let explicitCaseIds: string[] = [];
  let tags: string[] = [];
  let sectionIds: string[] = [];
  let excludeFlaky = req.excludeFlaky;
  const warnings: { code: string; message: string }[] = [];
  const blockers: { code: string; message: string }[] = [];

  switch (req.selection.kind) {
    case 'cases':
      explicitCaseIds = req.selection.caseIds;
      break;
    case 'tags':
      tags = req.selection.tags;
      break;
    case 'suite': {
      const s = await db.suite.findUnique({ where: { id: req.selection.suiteId } });
      if (!s || s.deletedAt) throw foreign('suiteId', 'La suite no existe.');
      const sel = SuiteSelectorSchema.safeParse(s.selector);
      if (!sel.success) throw new KatalystError('SELECTION_EMPTY', 'El selector de la suite es inválido.');
      suite = { id: s.id, name: s.name, selector: sel.data };
      explicitCaseIds = sel.data.caseIds ?? [];
      tags = sel.data.tags ?? [];
      sectionIds = sel.data.sectionIds ?? [];
      excludeFlaky = excludeFlaky || sel.data.excludeFlaky;
      break;
    }
  }

  // Casos explícitos: deben existir y no estar archivados (en suites dinámicas se omiten con advertencia).
  const explicitRows: CaseRow[] = explicitCaseIds.length
    ? await db.testRailCase.findMany({
        where: { id: { in: explicitCaseIds } },
        select: { id: true, trCaseId: true, title: true, revision: true, suiteId: true, archivedAt: true },
      })
    : [];
  if (explicitRows.length !== uniq(explicitCaseIds).length) throw foreign('caseIds');
  const archived = explicitRows.filter((c) => c.archivedAt);
  if (archived.length > 0) {
    if (req.selection.kind === 'cases') throw new KatalystError('CASE_ARCHIVED');
    warnings.push({ code: 'CASE_ARCHIVED', message: `${archived.length} caso(s) archivado(s) de la suite se omiten.` });
  }
  // Casos "completos": explícitos o por sección ejecutan su conjunto requerido completo (ESP §13.4).
  const fullCaseIds = new Set(explicitRows.filter((c) => !c.archivedAt).map((c) => c.id));
  if (sectionIds.length) {
    const secs = await descendantSections(db, sectionIds);
    const inSections = await db.testRailCase.findMany({
      where: { sectionId: { in: secs }, archivedAt: null },
      select: { id: true },
    });
    for (const c of inSections) fullCaseIds.add(c.id);
  }
  const selectedCaseIds = new Set(fullCaseIds);

  // Tests por etiqueta (OR): solo aprobados de la revisión; `@escritura` es etiqueta derivada.
  const tagSet = new Set(tags);
  const tagTests = tagSet.size
    ? testRows.filter(
        (t) =>
          t.status === 'aprobado' &&
          effectiveTags({ tags: t.tags, classification: t.classification }).some((x) => tagSet.has(x)),
      )
    : [];
  for (const t of tagTests) for (const l of t.links) selectedCaseIds.add(l.caseId);

  const caseRows: CaseRow[] = selectedCaseIds.size
    ? await db.testRailCase.findMany({
        where: { id: { in: [...selectedCaseIds] } },
        select: { id: true, trCaseId: true, title: true, revision: true, suiteId: true, archivedAt: true },
        orderBy: [{ trCaseId: 'asc' }],
      })
    : [];
  // Casos tocados por tests de etiqueta que estén archivados no se seleccionan.
  const cases = caseRows.filter((c) => !c.archivedAt);
  const caseIdSet = new Set(cases.map((c) => c.id));

  // Conjunto de tests a correr: requeridos de casos completos ∪ tests de etiqueta (cobertura posiblemente parcial).
  const runTestIds = new Set<string>(tagTests.map((t) => t.id));
  const requiredByCase = new Map<string, TestRow[]>();
  for (const c of cases) {
    const approved = (testsByCase.get(c.id) ?? []).filter((t) => t.status === 'aprobado');
    requiredByCase.set(c.id, approved);
    if (fullCaseIds.has(c.id)) for (const t of approved) runTestIds.add(t.id);
  }

  if (cases.length === 0 && runTestIds.size === 0) throw new KatalystError('SELECTION_EMPTY');

  // --- Usuario de prueba y política -----------------------------------------------------------------------------
  const testUser = env.isProduction ? (env.testUsers.find((u) => u.readOnly) ?? null) : (env.testUsers[0] ?? null);
  const productionUserProblem = env.isProduction && (!testUser || !testUser.readOnly);
  if (productionUserProblem) {
    blockers.push({
      code: 'PRODUCTION_BLOCKED',
      message: 'Producción requiere un usuario de prueba con permisos de solo lectura.',
    });
  }
  if (!testUser && !env.isProduction) {
    warnings.push({ code: 'TEST_USER_MISSING', message: 'El ambiente no tiene usuario de prueba habilitado.' });
  }
  const scheduled = req.trigger === 'programada';

  // --- Tests/variantes con motivos ------------------------------------------------------------------------------
  const tests: PlanTest[] = [];
  let reviewWarning = false;
  for (const id of [...runTestIds].sort((a, b) => cmpTest(testsById.get(a)!, testsById.get(b)!))) {
    const t = testsById.get(id)!;
    const m = manifestByKey.get(t.stableKey);
    const reasons = new Set<ResultReason>();
    if (t.status === 'borrador') reasons.add('test_no_aprobado');
    if (t.status === 'retirado') reasons.add('test_retirado');
    const contradictory = classificationContradiction(t, m);
    const needsReview = t.links.some((l) => l.reviewStatus === 'requiere_revision');
    if (env.isProduction) {
      if (contradictory) reasons.add('clasificacion_contradictoria');
      else if (t.classification === 'escritura') reasons.add('escritura_en_produccion');
      else if (t.classification === 'sin_clasificar') reasons.add('clasificacion_ausente');
      if (needsReview) reasons.add('revision_pendiente');
      if (productionUserProblem) reasons.add('usuario_con_escritura');
    } else {
      if (contradictory) warnings.push({ code: 'CLASSIFICATION_CONTRADICTORY', message: `Clasificación contradictoria en «${t.title}».` });
      if (needsReview) {
        if (scheduled) reasons.add('revision_pendiente');
        else reviewWarning = true;
      }
    }
    const flaky = excludeFlaky && isFlaky(t);
    if (flaky) reasons.add('excluido_inestable');
    const linkedCaseIds = t.links.map((l) => l.caseId);
    const selectedFor = linkedCaseIds.filter((c) => caseIdSet.has(c)).sort();
    const touched = linkedCaseIds.filter((c) => !caseIdSet.has(c)).sort();
    const keys = t.parameterKeys.length ? [...t.parameterKeys].sort() : [DEFAULT_PARAMETER_KEY];
    for (const parameterKey of keys) {
      tests.push({
        automatedTestId: t.id,
        stableKey: t.stableKey,
        filePath: t.filePath,
        title: t.title,
        classification: t.classification,
        parameterKey,
        retries: req.retries,
        writeIdempotencyApproved: t.writeIdempotencyApproved,
        executable: reasons.size === 0,
        blockReasons: [...reasons],
        selectedCaseIds: selectedFor,
        touchedCaseIds: touched,
      });
    }
  }
  if (reviewWarning) {
    warnings.push({
      code: 'LINK_REVIEW_PENDING',
      message: 'Hay vínculos test↔caso con revisión pendiente; en producción y programaciones quedarían bloqueados.',
    });
  }
  const variantKey = (stableKey: string, p: string) => `${stableKey}#${p}`;
  const variantsInRun = new Map(tests.map((t) => [variantKey(t.stableKey, t.parameterKey), t]));

  // --- Casos con conjunto requerido y cobertura esperada --------------------------------------------------------
  const planCases: PlanCase[] = cases.map((c) => {
    const required = requiredByCase.get(c.id) ?? [];
    const requiredTests = required
      .flatMap((t) =>
        (t.parameterKeys.length ? t.parameterKeys : [DEFAULT_PARAMETER_KEY]).map((p) => ({
          stableKey: t.stableKey,
          parameterKey: p,
        })),
      )
      .sort((a, b) => variantKey(a.stableKey, a.parameterKey).localeCompare(variantKey(b.stableKey, b.parameterKey)));
    const reasons = new Set<ResultReason>();
    if (requiredTests.length === 0) {
      const linked = testsByCase.get(c.id) ?? [];
      if (linked.some((t) => t.status === 'borrador')) reasons.add('test_no_aprobado');
      else if (linked.some((t) => t.status === 'retirado')) reasons.add('test_retirado');
      else reasons.add('sin_automatizacion');
    }
    const executableVariants = requiredTests.filter(
      (v) => variantsInRun.get(variantKey(v.stableKey, v.parameterKey))?.executable === true,
    );
    if (requiredTests.length > 0 && executableVariants.length === 0) {
      for (const v of requiredTests) {
        const pt = variantsInRun.get(variantKey(v.stableKey, v.parameterKey));
        if (pt) for (const r of pt.blockReasons) reasons.add(r);
        else reasons.add('variante_faltante');
      }
    }
    const expectedCoverage: Coverage =
      executableVariants.length === 0
        ? 'ninguna'
        : executableVariants.length === requiredTests.length
          ? 'completa'
          : 'parcial';
    return {
      caseId: c.id,
      trCaseId: c.trCaseId,
      ref: `C${c.trCaseId}`,
      title: c.title,
      revision: c.revision,
      testrailSuiteId: c.suiteId,
      executable: executableVariants.length > 0,
      blockReasons: [...reasons],
      requiredTests,
      expectedCoverage,
    };
  });

  // --- Destinos TestRail por suite ------------------------------------------------------------------------------
  const targets: PlanTarget[] = [];
  const connection = await db.testRailConnection.findFirst({ where: { enabled: true }, select: { id: true } });
  if (req.testrail.mode !== 'ninguno' && connection && planCases.length > 0) {
    const bySuite = new Map<string, string[]>();
    for (const c of planCases) bySuite.set(c.testrailSuiteId, [...(bySuite.get(c.testrailSuiteId) ?? []), c.caseId]);
    if (req.testrail.mode === 'existente' && bySuite.size > 1) {
      throw new KatalystError(
        'VALIDATION_FAILED',
        'Una corrida existente de TestRail solo admite casos de una única suite.',
      );
    }
    const suites = await db.testRailSuite.findMany({
      where: { id: { in: [...bySuite.keys()] } },
      select: { id: true, name: true },
    });
    for (const s of suites.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      targets.push({ testrailSuiteId: s.id, name: s.name, caseIds: bySuite.get(s.id) ?? [] });
    }
  } else if (req.testrail.mode !== 'ninguno' && !connection) {
    warnings.push({ code: 'TESTRAIL_NOT_CONFIGURED', message: 'Sin conexión TestRail habilitada: no se publicará.' });
  }

  // --- Snapshot -------------------------------------------------------------------------------------------------
  const settings = await loadRuntimeSettings(db);
  const executableTests = tests.filter((t) => t.executable);
  const isPerf =
    executableTests.length > 0 &&
    executableTests.every((t) => (testsById.get(t.automatedTestId)?.tags ?? []).includes(PERF_TAG));
  const artifactPolicy = artifactPolicyOf(env.artifactPolicy);
  const snapshot: RunSnapshot = {
    schemaVersion: 1,
    selection: req.selection,
    suite,
    scheduleId: req.scheduleId ?? null,
    scheduleRevision: req.scheduleRevision ?? null,
    catalogRevisionId: rev.id,
    gitCommit: rev.gitCommit,
    manifestHash: rev.manifestHash,
    environment: {
      id: env.id,
      name: env.name,
      appUrl: env.appUrl,
      apiUrl: env.apiUrl,
      isProduction: env.isProduction,
    },
    testUser: testUser ? { testUserId: testUser.id, label: testUser.label, readOnly: testUser.readOnly } : null,
    retries: req.retries,
    excludeFlaky,
    timeouts: {
      testMs: settings.timeouts.testMs,
      setupMs: settings.timeouts.setupMs,
      runMs: isPerf ? settings.timeouts.perfRunMs : settings.timeouts.functionalRunMs,
      finalizingMs: settings.timeouts.finalizingMs,
    },
    artifactPolicy,
    testrail: req.testrail,
    cases: planCases,
    tests,
    kind: isPerf ? 'rendimiento' : 'funcional',
  };

  const previewToken = sha256Hex(
    canonicalJson({
      v: 1,
      selection: req.selection,
      environmentId: env.id,
      environmentVersion: env.version,
      testUserId: testUser?.id ?? null,
      catalogRevisionId: rev.id,
      gitCommit: rev.gitCommit,
      manifestHash: rev.manifestHash,
      retries: req.retries,
      excludeFlaky,
      testrail: req.testrail,
      tests: tests.map((t) => [t.stableKey, t.parameterKey, t.executable, t.blockReasons]),
      cases: planCases.map((c) => [c.caseId, c.revision, c.executable]),
    }),
  );

  const preview: RunPreviewResponse = {
    previewToken,
    selection: req.selection,
    environment: {
      id: env.id,
      name: env.name,
      isProduction: env.isProduction,
      enabled: env.enabled,
      recordingAllowed: env.recordingAllowed,
    },
    catalogRevisionId: rev.id,
    gitCommit: rev.gitCommit,
    manifestHash: rev.manifestHash,
    cases: planCases,
    tests,
    counts: {
      cases: planCases.length,
      executableCases: planCases.filter((c) => c.executable).length,
      blockedCases: planCases.filter((c) => !c.executable).length,
      tests: tests.length,
      executableTests: executableTests.length,
    },
    blockers,
    warnings,
    willLaunchBrowser: executableTests.length > 0,
    testrailTargets: targets.map((t) => ({ testrailSuiteId: t.testrailSuiteId, name: t.name, caseCount: t.caseIds.length })),
  };

  return {
    preview,
    snapshot,
    previewToken,
    catalogRevisionId: rev.id,
    environment: {
      id: env.id,
      name: env.name,
      isProduction: env.isProduction,
      maxConcurrency: env.maxConcurrency,
      enabled: env.enabled,
    },
    testUser: testUser
      ? { id: testUser.id, allowsConcurrency: testUser.allowsConcurrency, readOnly: testUser.readOnly }
      : null,
    targets,
    settings,
    executableTests,
  };
}

function cmpTest(a: TestRow, b: TestRow): number {
  return a.filePath.localeCompare(b.filePath) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
