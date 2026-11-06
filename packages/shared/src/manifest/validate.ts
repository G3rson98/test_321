/**
 * Validador del manifiesto (plan §4.1/§4.2, ESP §10 reglas 1, 9 y 11; §13.1).
 * - Esquema y unicidad de `stableKey`.
 * - Correspondencia 1:1 con `playwright test --list --reporter=json`.
 * - IDs `C\d+` del título = casos del manifiesto; etiquetas del título = etiquetas efectivas.
 * - `@escritura` solo si la clasificación es `escritura` (etiqueta derivada).
 * - `sin_clasificar` bloquea aprobación.
 * - Casos inexistentes en TestRail ("casos inventados") son error.
 * RF-CAT-01, RF-CAT-05, RF-GRB-05, RF-EJE-06.
 */
import { CASE_REF_REGEX } from '../schemas/common.js';
import { effectiveTags, ManifestSchema, manifestHash, WRITE_TAG, type Manifest } from './schema.js';

export type ManifestIssueCode =
  | 'MANIFEST_SCHEMA'
  | 'DUPLICATE_STABLE_KEY'
  | 'DUPLICATE_TEST_REFERENCE'
  | 'MISSING_IN_PLAYWRIGHT_LIST'
  | 'NOT_IN_MANIFEST'
  | 'TITLE_CASE_MISMATCH'
  | 'TITLE_TAG_MISMATCH'
  | 'CLASSIFICATION_CONTRADICTION'
  | 'UNCLASSIFIED'
  | 'UNKNOWN_CASE'
  | 'IDEMPOTENCY_ON_READ_TEST'
  | 'PLAYWRIGHT_LIST_INVALID';

export interface ManifestIssue {
  code: ManifestIssueCode;
  message: string;
  stableKey: string | null;
  path?: string;
}

export interface ManifestValidationOptions {
  /** Salida JSON de `playwright test --list --reporter=json` (objeto ya parseado). */
  playwrightList?: unknown;
  /** Referencias `C<n>` de casos vigentes (no archivados) sincronizados de TestRail. */
  knownCaseRefs?: ReadonlySet<string>;
  /** `approval`: CI/aprobación (sin_clasificar es error). `catalog`: refresco (sin_clasificar es advertencia). */
  mode?: 'approval' | 'catalog';
  /** Projects de infraestructura cuyos specs no son tests de catálogo (default `['setup']`). */
  ignoreProjects?: readonly string[];
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
  manifest: Manifest | null;
  hash: string | null;
}

/** Spec aplanado de la salida JSON de Playwright. */
export interface PlaywrightListedSpec {
  file: string;
  title: string;
  fullTitle: string;
  tags: string[];
  projects: string[];
}

interface PwSpec {
  title?: unknown;
  file?: unknown;
  tags?: unknown;
  tests?: unknown;
}
interface PwSuite {
  title?: unknown;
  file?: unknown;
  specs?: unknown;
  suites?: unknown;
}

/** Aplana `suites[].specs[]` recursivamente (describe anidados). Tags se normalizan con `@`. */
export function flattenPlaywrightList(json: unknown): PlaywrightListedSpec[] {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { suites?: unknown }).suites)) {
    throw new TypeError('Salida de playwright --list inválida: falta "suites"');
  }
  const out: PlaywrightListedSpec[] = [];
  const visit = (suite: PwSuite, describePath: string[], inheritedFile: string | null, isFileSuite: boolean) => {
    const file = typeof suite.file === 'string' ? suite.file : inheritedFile;
    const title = typeof suite.title === 'string' ? suite.title : '';
    const path = isFileSuite ? describePath : [...describePath, title].filter(Boolean);
    for (const spec of (Array.isArray(suite.specs) ? suite.specs : []) as PwSpec[]) {
      const specTitle = typeof spec.title === 'string' ? spec.title : '';
      const specFile = typeof spec.file === 'string' ? spec.file : (file ?? '');
      const tags = (Array.isArray(spec.tags) ? spec.tags : [])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => (t.startsWith('@') ? t : `@${t}`));
      const projects = (Array.isArray(spec.tests) ? spec.tests : [])
        .map((t) => (t && typeof t === 'object' ? (t as { projectName?: unknown }).projectName : undefined))
        .filter((p): p is string => typeof p === 'string');
      out.push({ file: specFile, title: specTitle, fullTitle: [...path, specTitle].join(' > '), tags, projects });
    }
    for (const child of (Array.isArray(suite.suites) ? suite.suites : []) as PwSuite[]) {
      visit(child, path, file, false);
    }
  };
  for (const s of (json as { suites: PwSuite[] }).suites) visit(s, [], null, true);
  return out;
}

const SETUP_FILE_RE = /\.(?:setup|teardown)\.[cm]?[jt]s$/;

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function samePath(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export function caseRefsInTitle(title: string): string[] {
  return [...new Set(title.split(/\s+/).filter((tok) => CASE_REF_REGEX.test(tok)))].sort();
}

export function tagsInTitle(title: string): string[] {
  return [...new Set(title.match(/(?<=^|\s)@[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [])].sort();
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export function validateManifest(raw: unknown, opts: ManifestValidationOptions = {}): ManifestValidationResult {
  const mode = opts.mode ?? 'approval';
  const errors: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ code: 'MANIFEST_SCHEMA', message: issue.message, stableKey: null, path: issue.path.join('.') });
    }
    return { ok: false, errors, warnings, manifest: null, hash: null };
  }
  const m = parsed.data;

  const keys = new Map<string, number>();
  const refs = new Map<string, string>();
  for (const t of m.tests) {
    keys.set(t.stableKey, (keys.get(t.stableKey) ?? 0) + 1);
    const ref = `${normPath(t.file)}::${t.title}`;
    if (refs.has(ref)) {
      errors.push({
        code: 'DUPLICATE_TEST_REFERENCE',
        message: `Dos entradas apuntan al mismo test (${t.file})`,
        stableKey: t.stableKey,
      });
    } else refs.set(ref, t.stableKey);
  }
  for (const [k, n] of keys) {
    if (n > 1) errors.push({ code: 'DUPLICATE_STABLE_KEY', message: `stableKey repetido ${n} veces`, stableKey: k });
  }

  for (const t of m.tests) {
    const titleCases = caseRefsInTitle(t.title);
    if (!sameSet(titleCases, t.cases)) {
      errors.push({
        code: 'TITLE_CASE_MISMATCH',
        message: `IDs del título [${titleCases.join(' ')}] ≠ casos del manifiesto [${[...t.cases].sort().join(' ')}]`,
        stableKey: t.stableKey,
      });
    }
    const declaredWrite = t.tags.includes(WRITE_TAG) || tagsInTitle(t.title).includes(WRITE_TAG);
    if (declaredWrite && t.classification !== 'escritura') {
      errors.push({
        code: 'CLASSIFICATION_CONTRADICTION',
        message: `${WRITE_TAG} presente con clasificación ${t.classification}`,
        stableKey: t.stableKey,
      });
    }
    const eff = effectiveTags(t);
    const titleTags = tagsInTitle(t.title);
    if (!sameSet(titleTags, eff)) {
      errors.push({
        code: 'TITLE_TAG_MISMATCH',
        message: `Etiquetas del título [${titleTags.join(' ')}] ≠ etiquetas efectivas [${eff.join(' ')}]`,
        stableKey: t.stableKey,
      });
    }
    if (t.classification === 'sin_clasificar') {
      (mode === 'approval' ? errors : warnings).push({
        code: 'UNCLASSIFIED',
        message: 'Clasificación ausente: bloquea aprobación y producción',
        stableKey: t.stableKey,
      });
    }
    if (t.classification !== 'escritura' && t.writeIdempotencyApproved) {
      warnings.push({
        code: 'IDEMPOTENCY_ON_READ_TEST',
        message: 'writeIdempotencyApproved solo aplica a tests de escritura',
        stableKey: t.stableKey,
      });
    }
    if (opts.knownCaseRefs) {
      for (const c of t.cases) {
        if (!opts.knownCaseRefs.has(c)) {
          errors.push({
            code: 'UNKNOWN_CASE',
            message: `Caso ${c} inexistente o archivado en TestRail`,
            stableKey: t.stableKey,
          });
        }
      }
    }
  }

  if (opts.playwrightList !== undefined) {
    let listed: PlaywrightListedSpec[] = [];
    const ignoreProjects = new Set(opts.ignoreProjects ?? ['setup']);
    try {
      listed = flattenPlaywrightList(opts.playwrightList).filter(
        (s) =>
          !SETUP_FILE_RE.test(s.file) && !(s.projects.length > 0 && s.projects.every((p) => ignoreProjects.has(p))),
      );
    } catch (e) {
      errors.push({ code: 'PLAYWRIGHT_LIST_INVALID', message: (e as Error).message, stableKey: null });
    }
    const matched = new Set<number>();
    for (const t of m.tests) {
      const idx = listed.findIndex(
        (s, i) => !matched.has(i) && samePath(s.file, t.file) && (s.title === t.title || s.fullTitle === t.title),
      );
      if (idx < 0) {
        errors.push({
          code: 'MISSING_IN_PLAYWRIGHT_LIST',
          message: `No existe en Playwright: ${t.file} › ${t.title}`,
          stableKey: t.stableKey,
        });
        continue;
      }
      matched.add(idx);
      const spec = listed[idx]!;
      if (spec.tags.length && !sameSet([...new Set(spec.tags)], effectiveTags(t))) {
        errors.push({
          code: 'TITLE_TAG_MISMATCH',
          message: `Etiquetas de Playwright [${spec.tags.join(' ')}] ≠ etiquetas efectivas [${effectiveTags(t).join(' ')}]`,
          stableKey: t.stableKey,
        });
      }
    }
    listed.forEach((s, i) => {
      if (!matched.has(i)) {
        // Un mismo spec listado varias veces (varios projects) no cuenta como test nuevo.
        const dupOfMatched = [...matched].some((j) => listed[j]!.file === s.file && listed[j]!.title === s.title);
        if (!dupOfMatched) {
          errors.push({
            code: 'NOT_IN_MANIFEST',
            message: `Test sin entrada en el manifiesto: ${s.file} › ${s.fullTitle}`,
            stableKey: null,
          });
        }
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings, manifest: m, hash: manifestHash(m) };
}
