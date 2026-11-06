/**
 * Validador del manifiesto de tests (katalyst.manifest.json). RF-CAT-01, RF-CAT-05, RF-GRB-05, RF-EJE-06;
 * ESP §10 reglas 1, 3, 9 y 11; ESP §13.1; plan §4.2.
 *
 * Validación LOCAL y autocontenida: en la integración del monorepo se reemplaza por el validador compartido de
 * `@katalyst/shared/manifest` (mismo contrato). Se ejecuta con Node 24 (type stripping): `node scripts/validate-manifest.ts`.
 *
 * Uso:
 *   node scripts/validate-manifest.ts [--strict] [--list-file <playwright-list.json>] [--cases <casos.json>] [--json]
 *
 *   --strict      Los bloqueos de aprobación (TODO selector, IDs placeholder, skips no autorizados, sin_clasificar)
 *                 hacen fallar la validación (check obligatorio de merge protegido, ESP §13.1).
 *   --list-file   Usa una salida previa de `playwright test --list --reporter=json` (p. ej. generada en sandbox).
 *                 Sin esta opción se ejecuta el listado localmente.
 *   --cases       JSON con los IDs de casos existentes en TestRail (["C123", ...] o [{"id":"C123"}|{"tr_case_id":123}]).
 *                 Un caso del manifiesto ausente de la lista es un caso inventado (error).
 *   --json        Imprime el informe como JSON en stdout.
 *
 * Códigos de salida: 0 válido; 1 errores; 2 bloqueos de aprobación con --strict.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'katalyst.manifest.json');
const INFRA_PROJECTS = new Set(['setup']);
const CLASSIFICATIONS = ['lectura', 'escritura', 'sin_clasificar'] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CASE_ID = /^C[1-9]\d*$/;
const TAG = /^@[a-z0-9][a-z0-9_-]*$/;
const PARAM_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** IDs reservados como placeholder hasta Bloque 0 (C900000–C900999). */
const PLACEHOLDER_CASE = /^C900\d{3}$/;
const SKIP_MARKER = 'katalyst-skip-autorizado:';
const WAIT_FOR_TIMEOUT_ALLOWED = ['tests/rendimiento/', 'tools/'];

type Classification = (typeof CLASSIFICATIONS)[number];

interface ManifestTest {
  stableKey: string;
  file: string;
  title: string;
  cases: string[];
  tags: string[];
  classification: Classification;
  parameterKeys: string[];
  writeIdempotencyApproved: boolean;
  owner: string;
}

interface Finding {
  code: string;
  message: string;
  stableKey?: string;
  file?: string;
}

interface ListedTest {
  file: string;
  title: string;
  tags: string[];
  projects: string[];
  stableKeys: string[];
}

interface Report {
  ok: boolean;
  strict: boolean;
  manifestSha256: string | null;
  tests: number;
  listed: number;
  errors: Finding[];
  approvalBlockers: Finding[];
  warnings: Finding[];
}

const errors: Finding[] = [];
const blockers: Finding[] = [];
const warnings: Finding[] = [];

function parseArgs(argv: string[]): { strict: boolean; listFile?: string; casesFile?: string; json: boolean } {
  const out: { strict: boolean; listFile?: string; casesFile?: string; json: boolean } = { strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') out.strict = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--list-file') out.listFile = argv[++i];
    else if (arg === '--cases') out.casesFile = argv[++i];
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  return out;
}

/** JSON canónico (claves ordenadas, sin espacios) para el hash del snapshot (ESP §13.1). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Estructura del manifiesto
// ---------------------------------------------------------------------------------------------------------------

const TEST_KEYS = ['stableKey', 'file', 'title', 'cases', 'tags', 'classification', 'parameterKeys', 'writeIdempotencyApproved', 'owner'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function validateStructure(raw: unknown): ManifestTest[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'manifiesto_invalido', message: 'El manifiesto debe ser un objeto JSON.' });
    return [];
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== 'schemaVersion' && key !== 'tests') errors.push({ code: 'manifiesto_clave_desconocida', message: `Clave raíz no soportada: ${key}` });
  }
  if (root['schemaVersion'] !== 1) errors.push({ code: 'manifiesto_version', message: 'schemaVersion debe ser 1.' });
  if (!Array.isArray(root['tests'])) {
    errors.push({ code: 'manifiesto_invalido', message: '"tests" debe ser un arreglo.' });
    return [];
  }
  const out: ManifestTest[] = [];
  const keys = new Set<string>();
  const fileTitles = new Set<string>();
  (root['tests'] as unknown[]).forEach((item, index) => {
    const where = `tests[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ code: 'manifiesto_invalido', message: `${where} debe ser un objeto.` });
      return;
    }
    const t = item as Record<string, unknown>;
    const push = (code: string, message: string): void => {
      errors.push({ code, message: `${where}: ${message}`, ...(typeof t['stableKey'] === 'string' ? { stableKey: t['stableKey'] } : {}) });
    };
    for (const key of Object.keys(t)) if (!TEST_KEYS.includes(key)) push('manifiesto_clave_desconocida', `clave no soportada "${key}"`);
    for (const key of TEST_KEYS) if (!(key in t)) push('manifiesto_campo_faltante', `falta "${key}"`);

    const stableKey = t['stableKey'];
    if (typeof stableKey !== 'string' || !UUID_V4.test(stableKey)) push('stablekey_invalido', 'stableKey debe ser UUID v4 en minúsculas.');
    else if (keys.has(stableKey)) push('stablekey_duplicado', `stableKey duplicado ${stableKey}`);
    else keys.add(stableKey);

    const file = t['file'];
    if (typeof file !== 'string' || !/^tests\/[A-Za-z0-9_./-]+\.spec\.ts$/.test(file) || file.includes('..')) {
      push('archivo_invalido', 'file debe ser una ruta tests/**/*.spec.ts relativa al repositorio.');
    } else if (!fs.existsSync(path.join(REPO_ROOT, file))) {
      push('archivo_inexistente', `no existe ${file}`);
    }
    const title = t['title'];
    if (typeof title !== 'string' || title.trim() === '') push('titulo_invalido', 'title vacío.');
    if (typeof file === 'string' && typeof title === 'string') {
      const ft = `${file}\u0000${title}`;
      if (fileTitles.has(ft)) push('titulo_duplicado', 'título duplicado en el mismo archivo.');
      fileTitles.add(ft);
    }
    const cases = t['cases'];
    if (!isStringArray(cases) || cases.length === 0) push('casos_invalidos', 'cases debe ser un arreglo no vacío.');
    else {
      for (const c of cases) if (!CASE_ID.test(c)) push('caso_invalido', `ID de caso inválido "${c}" (formato C1234).`);
      if (new Set(cases).size !== cases.length) push('caso_duplicado', 'cases contiene duplicados.');
    }
    const tags = t['tags'];
    if (!isStringArray(tags)) push('etiquetas_invalidas', 'tags debe ser un arreglo de strings.');
    else {
      for (const tag of tags) if (!TAG.test(tag)) push('etiqueta_invalida', `etiqueta inválida "${tag}" (formato @minusculas).`);
      if (new Set(tags).size !== tags.length) push('etiqueta_duplicada', 'tags contiene duplicados.');
    }
    const classification = t['classification'];
    if (typeof classification !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(classification)) {
      push('clasificacion_invalida', `classification debe ser ${CLASSIFICATIONS.join(' | ')}.`);
    }
    const params = t['parameterKeys'];
    if (!isStringArray(params) || params.length === 0) push('parametros_invalidos', 'parameterKeys debe ser un arreglo no vacío.');
    else {
      for (const p of params) if (!PARAM_KEY.test(p)) push('parametro_invalido', `parameterKey inválida "${p}".`);
      if (new Set(params).size !== params.length) push('parametro_duplicado', 'parameterKeys contiene duplicados.');
    }
    if (typeof t['writeIdempotencyApproved'] !== 'boolean') push('idempotencia_invalida', 'writeIdempotencyApproved debe ser booleano.');
    if (typeof t['owner'] !== 'string' || (t['owner'] as string).trim() === '') push('owner_invalido', 'owner vacío.');

    if (
      typeof stableKey === 'string' &&
      typeof file === 'string' &&
      typeof title === 'string' &&
      isStringArray(cases) &&
      isStringArray(tags) &&
      isStringArray(params) &&
      typeof classification === 'string'
    ) {
      out.push({
        stableKey,
        file,
        title,
        cases,
        tags,
        classification: classification as Classification,
        parameterKeys: params,
        writeIdempotencyApproved: t['writeIdempotencyApproved'] === true,
        owner: String(t['owner'] ?? ''),
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Reglas semánticas por test
// ---------------------------------------------------------------------------------------------------------------

function titleCases(title: string): string[] {
  return [...title.matchAll(/\bC\d+\b/g)].map((m) => m[0]);
}

function titleTags(title: string): string[] {
  return [...title.matchAll(/(?:^|\s)(@[\p{L}\p{N}_-]+)/gu)].map((m) => m[1] as string);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

function validateSemantics(tests: ManifestTest[], knownCases: Set<string> | undefined): void {
  for (const t of tests) {
    const ref = { stableKey: t.stableKey, file: t.file };
    if (!sameSet(titleCases(t.title), t.cases)) {
      errors.push({ ...ref, code: 'divergencia_casos_titulo', message: `IDs del título (${titleCases(t.title).join(' ') || 'ninguno'}) ≠ cases (${t.cases.join(' ')}).` });
    }
    if (!sameSet(titleTags(t.title), t.tags)) {
      errors.push({ ...ref, code: 'divergencia_etiquetas_titulo', message: `Etiquetas del título (${titleTags(t.title).join(' ') || 'ninguna'}) ≠ tags (${t.tags.join(' ')}).` });
    }
    const hasWriteTag = t.tags.includes('@escritura');
    if (t.classification === 'escritura' && !hasWriteTag) {
      errors.push({ ...ref, code: 'escritura_sin_etiqueta', message: '@escritura es derivada: un test de escritura debe llevarla.' });
    }
    if (t.classification !== 'escritura' && hasWriteTag) {
      errors.push({ ...ref, code: 'etiqueta_escritura_contradictoria', message: `@escritura con clasificación ${t.classification}.` });
    }
    if (t.writeIdempotencyApproved && t.classification !== 'escritura') {
      errors.push({ ...ref, code: 'idempotencia_sin_escritura', message: 'writeIdempotencyApproved solo aplica a tests de escritura.' });
    }
    if (t.tags.includes('@rendimiento') && t.classification !== 'lectura') {
      errors.push({ ...ref, code: 'rendimiento_no_lectura', message: '@rendimiento solo repite GET aprobados: debe clasificarse lectura.' });
    }
    if (t.classification === 'sin_clasificar') {
      blockers.push({ ...ref, code: 'sin_clasificar', message: 'Test sin clasificación: no puede aprobarse ni correr en producción (RF-EJE-06).' });
    }
    for (const c of t.cases) {
      if (PLACEHOLDER_CASE.test(c)) {
        blockers.push({ ...ref, code: 'caso_placeholder', message: `${c} es un ID placeholder; sustituir por el ID real de TestRail (Bloque 0).` });
      }
      if (knownCases && !knownCases.has(c)) {
        errors.push({ ...ref, code: 'caso_inventado', message: `${c} no existe en la lista de casos de TestRail provista.` });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Correspondencia con `playwright test --list --reporter=json`
// ---------------------------------------------------------------------------------------------------------------

interface JsonSuite {
  title?: string;
  file?: string;
  specs?: Array<{ title: string; file: string; tags?: string[]; tests?: Array<{ projectName?: string; annotations?: Array<{ type: string; description?: string }> }> }>;
  suites?: JsonSuite[];
}

function runPlaywrightList(): unknown {
  const cli = createRequire(path.join(REPO_ROOT, 'package.json')).resolve('@playwright/test/cli');
  const env: NodeJS.ProcessEnv = { ...process.env };
  // El listado no necesita credenciales: no se propagan referencias de secretos al proceso hijo.
  delete env['KATALYST_TEST_USER_FILE'];
  delete env['KATALYST_STORAGE_STATE_PATH'];
  const res = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    errors.push({
      code: res.status === 0 ? 'listado_no_json' : 'listado_fallido',
      message:
        res.status === 0
          ? 'La salida de playwright --list no es JSON (¿algo imprime en stdout?).'
          : `playwright test --list terminó con ${res.status}: ${res.stderr.slice(0, 500)}`,
    });
    return undefined;
  }
  // Con status != 0 el reporte JSON trae `errors` (p. ej. forbidOnly); se informan en collectListed.
  if (res.status !== 0) errors.push({ code: 'listado_con_errores', message: `playwright test --list terminó con ${res.status}.` });
  return parsed;
}

function collectListed(report: unknown): ListedTest[] {
  if (!report || typeof report !== 'object') return [];
  const r = report as { config?: { rootDir?: string }; suites?: JsonSuite[]; errors?: Array<{ message?: string }> };
  for (const e of r.errors ?? []) errors.push({ code: 'error_carga_tests', message: (e.message ?? 'error').slice(0, 500) });
  const rootDir = r.config?.rootDir ?? path.join(REPO_ROOT, 'tests');
  const byKey = new Map<string, ListedTest>();
  const walk = (suite: JsonSuite, titlePath: string[]): void => {
    for (const spec of suite.specs ?? []) {
      const projects = (spec.tests ?? []).map((t) => t.projectName ?? '');
      const nonInfra = projects.filter((p) => !INFRA_PROJECTS.has(p));
      if (nonInfra.length === 0) continue;
      const file = path.relative(REPO_ROOT, path.resolve(rootDir, spec.file)).split(path.sep).join('/');
      const title = [...titlePath, spec.title].join(' › ');
      const key = `${file}\u0000${title}`;
      const stableKeys = (spec.tests ?? [])
        .flatMap((t) => t.annotations ?? [])
        .filter((a) => a.type === 'katalyst.stableKey' && typeof a.description === 'string')
        .map((a) => a.description as string);
      const prev = byKey.get(key);
      if (prev) {
        prev.projects.push(...nonInfra);
        prev.stableKeys.push(...stableKeys);
      } else {
        byKey.set(key, { file, title, tags: (spec.tags ?? []).map((t) => (t.startsWith('@') ? t : `@${t}`)), projects: nonInfra, stableKeys });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titlePath, child.title ?? ''].filter(Boolean));
  };
  for (const fileSuite of r.suites ?? []) walk(fileSuite, []);
  return [...byKey.values()];
}

function validateCorrespondence(tests: ManifestTest[], listed: ListedTest[]): void {
  const byFileTitle = new Map(listed.map((l) => [`${l.file}\u0000${l.title}`, l]));
  const matched = new Set<ListedTest>();
  for (const t of tests) {
    const ref = { stableKey: t.stableKey, file: t.file };
    const hit = byFileTitle.get(`${t.file}\u0000${t.title}`);
    if (!hit) {
      const byKey = listed.find((l) => l.stableKeys.includes(t.stableKey));
      if (byKey) {
        errors.push({ ...ref, code: 'divergencia_titulo_manifiesto', message: `El test con este stableKey se lista como "${byKey.title}" (${byKey.file}); actualice el manifiesto en el mismo PR.` });
        matched.add(byKey);
      } else {
        errors.push({ ...ref, code: 'test_no_listado', message: `Playwright no lista "${t.title}" en ${t.file}.` });
      }
      continue;
    }
    matched.add(hit);
    const keys = [...new Set(hit.stableKeys)];
    if (keys.length === 0) warnings.push({ ...ref, code: 'sin_anotacion_stablekey', message: 'El test no declara la anotación katalyst.stableKey.' });
    else if (keys.length > 1 || keys[0] !== t.stableKey) {
      errors.push({ ...ref, code: 'divergencia_stablekey', message: `Anotación stableKey (${keys.join(', ')}) ≠ manifiesto.` });
    }
    if (!sameSet(hit.tags, t.tags)) {
      errors.push({ ...ref, code: 'divergencia_etiquetas_listado', message: `Etiquetas listadas (${hit.tags.join(' ')}) ≠ manifiesto (${t.tags.join(' ')}).` });
    }
  }
  for (const l of listed) {
    if (!matched.has(l)) errors.push({ code: 'test_sin_manifiesto', file: l.file, message: `"${l.title}" no está en el manifiesto (todo test ejecutable necesita stableKey y clasificación).` });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Reglas de código fuente (ESP §10 reglas 3 y 11)
// ---------------------------------------------------------------------------------------------------------------

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function listFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', 'dxmon-output'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

function importsOf(file: string): string[] {
  const code = fs.readFileSync(file, 'utf8');
  const specs = [...code.matchAll(/(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1] as string);
  const out: string[] = [];
  for (const s of specs) {
    const base = path.resolve(path.dirname(file), s);
    const candidate = [base, `${base}.ts`, path.join(base, 'index.ts')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (candidate && candidate.startsWith(REPO_ROOT)) out.push(candidate);
  }
  return out;
}

function transitiveFiles(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f) || !/\.(ts|js|mjs)$/.test(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return [...seen];
}

function validateSource(tests: ManifestTest[]): void {
  const codeFiles = [
    ...listFiles(path.join(REPO_ROOT, 'tests'), ['.ts']),
    ...listFiles(path.join(REPO_ROOT, 'pages'), ['.ts']),
    ...listFiles(path.join(REPO_ROOT, 'fixtures'), ['.ts']),
    ...listFiles(path.join(REPO_ROOT, 'tools'), ['.ts']),
    ...['auth.setup.ts', 'playwright.config.ts', 'global-teardown.ts'].map((f) => path.join(REPO_ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  for (const file of codeFiles) {
    const r = rel(file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (/\b(?:test|describe|it|setup)(?:\.describe)?\.only\s*\(/.test(code)) {
      errors.push({ code: 'only_prohibido', file: r, message: '`.only` no está permitido (ESP §10 regla 11).' });
    }
    if (/\bwaitForTimeout\s*\(/.test(code) && !WAIT_FOR_TIMEOUT_ALLOWED.some((p) => r.startsWith(p))) {
      errors.push({ code: 'wait_for_timeout_prohibido', file: r, message: '`waitForTimeout` solo se permite en el monitor de rendimiento (ESP §10 regla 3).' });
    }
    if (r.startsWith('tests/')) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\b(?:test|describe)(?:\.describe)?\.(?:skip|fixme)\s*\(/.test(stripComments(line))) {
          const prev = lines[i - 1] ?? '';
          if (!prev.includes(SKIP_MARKER)) {
            blockers.push({ code: 'skip_no_autorizado', file: r, message: `línea ${i + 1}: skip/fixme sin marcador "// ${SKIP_MARKER} <motivo>".` });
          }
        }
      });
    }
  }

  // auth.setup.ts es dependencia de todos los tests: sus selectores pendientes bloquean la aprobación de todos.
  const setupFile = path.join(REPO_ROOT, 'auth.setup.ts');
  if (fs.existsSync(setupFile)) {
    const setupTodo = transitiveFiles(setupFile)
      .map((f) => ({ f: rel(f), n: (fs.readFileSync(f, 'utf8').match(/TODO selector/g) ?? []).length }))
      .filter((x) => x.n > 0);
    if (setupTodo.length > 0) {
      blockers.push({
        file: 'auth.setup.ts',
        code: 'todo_selector_setup',
        message: `Login con selectores pendientes (afecta a todos los tests): ${setupTodo.map((x) => `${x.f} (${x.n})`).join(', ')}.`,
      });
    }
  }

  for (const t of tests) {
    const abs = path.join(REPO_ROOT, t.file);
    if (!fs.existsSync(abs)) continue;
    const withTodo = transitiveFiles(abs)
      .map((f) => ({ f: rel(f), n: (fs.readFileSync(f, 'utf8').match(/TODO selector/g) ?? []).length }))
      .filter((x) => x.n > 0);
    if (withTodo.length > 0) {
      blockers.push({
        stableKey: t.stableKey,
        file: t.file,
        code: 'todo_selector',
        message: `Selectores pendientes: ${withTodo.map((x) => `${x.f} (${x.n})`).join(', ')}.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Escaneo simple de secretos (complementa gitleaks, ESP §11 Bloque 1 y §13.7)
// ---------------------------------------------------------------------------------------------------------------

const PK = ['PRIVATE', 'KEY'].join(' ');
const SECRET_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { code: 'clave_privada', re: new RegExp(`-----BEGIN (?:[A-Z]+ )?${PK}-----`) },
  { code: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { code: 'bearer_literal', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/ },
  {
    code: 'credencial_literal',
    re: /["']?(?:password|passwd|contrase(?:ñ|n)a|secret|api[_-]?key|client[_-]?secret|token)["']?\s*[:=]\s*["'][^"'<>${}\s]{6,}["']/i,
  },
];

function scanSecrets(): void {
  const files = listFiles(REPO_ROOT, ['.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.toml', '.txt', '.env', '.example']);
  for (const file of files) {
    const r = rel(file);
    if (/(^|\/)storageState[^/]*$/i.test(r) || r.startsWith('.auth/')) {
      errors.push({ code: 'storage_state_versionado', file: r, message: 'Archivo de storageState dentro del repositorio (RNF-SEG-01).' });
      continue;
    }
    if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (r.endsWith('.json') && /"cookies"\s*:/.test(content) && /"origins"\s*:/.test(content)) {
      errors.push({ code: 'storage_state_versionado', file: r, message: 'JSON con forma de storageState (cookies + origins).' });
    }
    for (const { code, re } of SECRET_PATTERNS) {
      if (re.test(content)) errors.push({ code: `secreto_${code}`, file: r, message: `Posible secreto (${code}). Revise y elimine; no se muestra el valor.` });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

function loadKnownCases(file: string): Set<string> {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown[] }).cases ?? [];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string') out.add(item.startsWith('C') ? item : `C${item}`);
    else if (typeof item === 'number') out.add(`C${item}`);
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const id = o['id'] ?? o['tr_case_id'] ?? o['caseId'];
      if (typeof id === 'string') out.add(id.startsWith('C') ? id : `C${id}`);
      if (typeof id === 'number') out.add(`C${id}`);
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let manifestRaw: unknown;
  let manifestSha256: string | null = null;
  try {
    manifestRaw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    manifestSha256 = createHash('sha256').update(canonical(manifestRaw)).digest('hex');
  } catch (e) {
    errors.push({ code: 'manifiesto_ilegible', message: `No se pudo leer katalyst.manifest.json: ${(e as Error).message}` });
  }
  const tests = manifestRaw === undefined ? [] : validateStructure(manifestRaw);
  const knownCases = args.casesFile ? loadKnownCases(args.casesFile) : undefined;
  if (!knownCases) {
    warnings.push({ code: 'casos_no_verificados', message: 'Sin --cases: no se verificó la existencia de los casos en TestRail.' });
  }
  validateSemantics(tests, knownCases);

  const listing = args.listFile ? (JSON.parse(fs.readFileSync(path.resolve(args.listFile), 'utf8')) as unknown) : runPlaywrightList();
  const listed = collectListed(listing);
  if (listing !== undefined) validateCorrespondence(tests, listed);
  validateSource(tests);
  scanSecrets();

  const report: Report = {
    ok: errors.length === 0 && (!args.strict || blockers.length === 0),
    strict: args.strict,
    manifestSha256,
    tests: tests.length,
    listed: listed.length,
    errors,
    approvalBlockers: blockers,
    warnings,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const fmt = (f: Finding): string => `  - [${f.code}]${f.file ? ` ${f.file}` : ''}${f.stableKey ? ` (${f.stableKey})` : ''}: ${f.message}`;
    console.log(`Manifiesto: ${tests.length} test(s); listados por Playwright: ${listed.length}; sha256 canónico: ${manifestSha256 ?? 'n/d'}`);
    if (errors.length) console.log(`\nErrores (${errors.length}):\n${errors.map(fmt).join('\n')}`);
    if (blockers.length) console.log(`\nBloqueos de aprobación (${blockers.length})${args.strict ? '' : ' — informativos sin --strict'}:\n${blockers.map(fmt).join('\n')}`);
    if (warnings.length) console.log(`\nAdvertencias (${warnings.length}):\n${warnings.map(fmt).join('\n')}`);
    console.log(`\nResultado: ${report.ok ? 'VÁLIDO' : 'INVÁLIDO'}${args.strict ? ' (modo estricto)' : ''}`);
  }
  process.exitCode = errors.length > 0 ? 1 : args.strict && blockers.length > 0 ? 2 : 0;
}

main();
