import { describe, expect, it } from 'vitest';
import {
  canonicalManifest,
  caseRefsInTitle,
  effectiveTags,
  flattenPlaywrightList,
  lintTestSource,
  manifestHash,
  ManifestSchema,
  tagsInTitle,
  validateManifest,
  type ManifestInput,
} from '../src/manifest/index.js';

const K1 = '9050dd7e-9ec9-4634-91ac-5b1ecfc8a990';
const K2 = '254f1b1d-74af-489f-b953-a6a87cfbcf39';
const K3 = 'cb8366a4-09c9-4701-a96f-86aa9e2b6e37';

function manifest(over: Partial<ManifestInput['tests'][number]>[] = [{}]): ManifestInput {
  return {
    schemaVersion: 1,
    tests: over.map((o, i) => ({
      stableKey: [K1, K2, K3][i]!,
      file: `tests/oc/t${i}.spec.ts`,
      title: `C10${i} Abrir pantalla ${i} @oc @humo`,
      cases: [`C10${i}`],
      tags: ['@oc', '@humo'],
      classification: 'lectura' as const,
      parameterKeys: ['default'],
      writeIdempotencyApproved: false,
      owner: 'qa-automation',
      ...o,
    })),
  };
}

/** Salida mínima de `playwright test --list --reporter=json` (tags sin `@` como en el reporter JSON). */
function pwList(specs: { file: string; title: string; tags?: string[]; describe?: string; projects?: string[] }[]) {
  return {
    config: {},
    suites: specs.map((s) => ({
      title: s.file,
      file: s.file,
      specs: s.describe
        ? []
        : [
            {
              title: s.title,
              file: s.file,
              tags: s.tags ?? [],
              tests: (s.projects ?? ['staging']).map((p) => ({ projectName: p })),
            },
          ],
      suites: s.describe
        ? [
            {
              title: s.describe,
              file: s.file,
              specs: [{ title: s.title, file: s.file, tags: s.tags ?? [], tests: [{ projectName: 'staging' }] }],
            },
          ]
        : [],
    })),
  };
}

const listFor = (m: ManifestInput) =>
  pwList(
    m.tests.map((t) => ({
      file: t.file.replace(/^tests\//, ''),
      title: t.title,
      tags: effectiveTags({ tags: t.tags, classification: t.classification }).map((x) => x.slice(1)),
    })),
  );

describe('RF-CAT-05 esquema del manifiesto (plan §4.2)', () => {
  it('acepta el ejemplo y aplica defaults', () => {
    const m = ManifestSchema.parse({
      schemaVersion: 1,
      tests: [{ ...manifest().tests[0]!, parameterKeys: undefined, writeIdempotencyApproved: undefined }],
    });
    expect(m.tests[0]!.parameterKeys).toEqual(['default']);
    expect(m.tests[0]!.writeIdempotencyApproved).toBe(false);
    expect(m.tests[0]!.status).toBe('aprobado');
  });
  it.each([
    [{ stableKey: 'no-uuid' }],
    [{ stableKey: '9050dd7e-9ec9-1634-91ac-5b1ecfc8a990' }], // no v4
    [{ file: '../fuera.spec.ts' }],
    [{ file: '/abs/x.spec.ts' }],
    [{ file: 'tests/x.ts' }],
    [{ cases: [] }],
    [{ cases: ['C1', 'C1'] }],
    [{ cases: ['1234'] }],
    [{ tags: ['oc'] }],
    [{ classification: 'otra' }],
    [{ owner: '' }],
  ])('rechaza %j', (over) => {
    const r = validateManifest(manifest([over as never]));
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toBe('MANIFEST_SCHEMA');
    expect(r.hash).toBeNull();
  });
  it('rechaza versión y campos desconocidos', () => {
    expect(validateManifest({ ...manifest(), schemaVersion: 2 }).ok).toBe(false);
    expect(validateManifest({ ...manifest(), extra: 1 }).ok).toBe(false);
    expect(validateManifest(manifest([{ extra: true } as never])).ok).toBe(false);
  });
});

describe('RF-CAT-05 validador del manifiesto', () => {
  it('manifiesto válido con lista de Playwright coincidente', () => {
    const m = manifest([{}, {}]);
    const r = validateManifest(m, { playwrightList: listFor(m), knownCaseRefs: new Set(['C100', 'C101']) });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('unicidad de stableKey y de referencia a test', () => {
    const m = manifest([{}, {}]);
    m.tests[1]!.stableKey = K1;
    expect(validateManifest(m).errors.map((e) => e.code)).toContain('DUPLICATE_STABLE_KEY');
    const m2 = manifest([{}, {}]);
    m2.tests[1]!.file = m2.tests[0]!.file;
    m2.tests[1]!.title = m2.tests[0]!.title;
    m2.tests[1]!.cases = m2.tests[0]!.cases;
    expect(validateManifest(m2).errors.map((e) => e.code)).toContain('DUPLICATE_TEST_REFERENCE');
  });

  it('IDs C\\d+ del título deben coincidir con los casos', () => {
    const r = validateManifest(manifest([{ title: 'C100 C999 Abrir @oc @humo' }]));
    expect(r.errors.map((e) => e.code)).toEqual(['TITLE_CASE_MISMATCH']);
  });

  it('etiquetas del título coherentes con etiquetas efectivas', () => {
    expect(validateManifest(manifest([{ title: 'C100 Abrir @oc' }])).errors.map((e) => e.code)).toEqual([
      'TITLE_TAG_MISMATCH',
    ]);
  });

  it('escritura ⇒ @escritura derivada; @escritura con lectura es contradicción', () => {
    const ok = validateManifest(
      manifest([{ classification: 'escritura', title: 'C100 Crear OC @oc @humo @escritura' }]),
    );
    expect(ok.ok).toBe(true);
    const missing = validateManifest(manifest([{ classification: 'escritura' }]));
    expect(missing.errors.map((e) => e.code)).toEqual(['TITLE_TAG_MISMATCH']);
    const contra = validateManifest(
      manifest([{ tags: ['@oc', '@humo', '@escritura'], title: 'C100 Abrir @oc @humo @escritura' }]),
    );
    expect(contra.errors.map((e) => e.code)).toContain('CLASSIFICATION_CONTRADICTION');
    expect(effectiveTags({ tags: ['@b', '@escritura', '@a'], classification: 'lectura' })).toEqual(['@a', '@b']);
  });

  it('sin_clasificar bloquea aprobación; en catálogo es advertencia', () => {
    const m = manifest([{ classification: 'sin_clasificar' }]);
    expect(validateManifest(m).errors.map((e) => e.code)).toEqual(['UNCLASSIFIED']);
    const cat = validateManifest(m, { mode: 'catalog' });
    expect(cat.ok).toBe(true);
    expect(cat.warnings.map((w) => w.code)).toEqual(['UNCLASSIFIED']);
  });

  it('idempotencia aprobada en test de lectura es advertencia', () => {
    expect(validateManifest(manifest([{ writeIdempotencyApproved: true }])).warnings.map((w) => w.code)).toEqual([
      'IDEMPOTENCY_ON_READ_TEST',
    ]);
  });

  it('casos inexistentes ("casos inventados")', () => {
    const r = validateManifest(manifest(), { knownCaseRefs: new Set(['C1']) });
    expect(r.errors.map((e) => e.code)).toEqual(['UNKNOWN_CASE']);
  });

  it('correspondencia con playwright --list: faltantes, sobrantes, tags y describe', () => {
    const m = manifest([{}, {}]);
    const list = pwList([
      { file: 'oc/t0.spec.ts', title: m.tests[0]!.title, tags: ['oc', 'humo'] },
      { file: 'oc/extra.spec.ts', title: 'C5 Extra @x', tags: ['x'] },
      { file: 'auth.setup.ts', title: 'autenticar', projects: ['setup'] },
      { file: 'oc/setup-like.spec.ts', title: 'infra', projects: ['setup'] },
    ]);
    const codes = validateManifest(m, { playwrightList: list }).errors.map((e) => e.code);
    expect(codes).toContain('MISSING_IN_PLAYWRIGHT_LIST');
    expect(codes).toContain('NOT_IN_MANIFEST');
    expect(codes.filter((c) => c === 'NOT_IN_MANIFEST')).toHaveLength(1);

    const tagMismatch = pwList([{ file: 'oc/t0.spec.ts', title: m.tests[0]!.title, tags: ['oc'] }]);
    expect(validateManifest(manifest(), { playwrightList: tagMismatch }).errors.map((e) => e.code)).toEqual([
      'TITLE_TAG_MISMATCH',
    ]);

    const withDescribe = pwList([
      { file: 'tests/oc/t0.spec.ts', title: m.tests[0]!.title, describe: 'Órdenes', tags: ['oc', 'humo'] },
    ]);
    expect(validateManifest(manifest(), { playwrightList: withDescribe }).ok).toBe(true);
    expect(flattenPlaywrightList(withDescribe)[0]!.fullTitle).toBe(`Órdenes > ${m.tests[0]!.title}`);

    // mismo spec en varios projects no cuenta como sobrante
    const multi = {
      suites: [
        {
          title: 'oc/t0.spec.ts',
          file: 'oc/t0.spec.ts',
          specs: [{ title: m.tests[0]!.title, tags: ['@oc', '@humo'], tests: [{ projectName: 'a' }] }],
        },
        {
          title: 'oc/t0.spec.ts',
          file: 'oc/t0.spec.ts',
          specs: [{ title: m.tests[0]!.title, tags: ['@oc', '@humo'], tests: [{ projectName: 'b' }] }],
        },
      ],
    };
    expect(validateManifest(manifest(), { playwrightList: multi }).ok).toBe(true);
  });

  it('salida de playwright inválida', () => {
    expect(validateManifest(manifest(), { playwrightList: { nope: 1 } }).errors[0]!.code).toBe(
      'PLAYWRIGHT_LIST_INVALID',
    );
    expect(() => flattenPlaywrightList(null)).toThrow(TypeError);
    expect(flattenPlaywrightList({ suites: [{ specs: [{}], suites: 'x' }] })).toEqual([
      { file: '', title: '', fullTitle: '', tags: [], projects: [] },
    ]);
  });

  it('helpers de título', () => {
    expect(caseRefsInTitle('C12 C3 Abrir C12 @oc')).toEqual(['C12', 'C3']);
    expect(caseRefsInTitle('Sin casos C0 c12')).toEqual([]);
    expect(tagsInTitle('C1 Abrir @oc foo@bar @humo')).toEqual(['@humo', '@oc']);
  });
});

describe('RF-CAT-05 hash canónico SHA-256 (ESP §13.1)', () => {
  it('independiente del orden de tests, casos y etiquetas', () => {
    const a = ManifestSchema.parse(manifest([{}, {}]));
    const b = ManifestSchema.parse({ ...manifest([{}, {}]), tests: [...manifest([{}, {}]).tests].reverse() });
    b.tests[0]!.tags = [...b.tests[0]!.tags].reverse();
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(canonicalManifest(b).tests[0]!.stableKey).toBe(K2 < K1 ? K2 : K1);
  });
  it('cambia ante cualquier cambio de contenido', () => {
    const a = ManifestSchema.parse(manifest());
    const b = ManifestSchema.parse(manifest([{ owner: 'otro' }]));
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

describe('RF-GRB-05 revisión estática de código de test (ESP §10 regla 11)', () => {
  const good = `import { test, expect } from '@playwright/test';
test('C1234 Abrir Órdenes de carga @oc @humo', async ({ page }) => {
  await page.goto('/loadOrder');
  await expect(page.getByRole('heading', { name: 'Órdenes de carga' })).toBeVisible();
});`;
  it('código conforme pasa', () => {
    expect(lintTestSource(good)).toEqual({ ok: true, issues: [] });
  });
  it('detecta .only, .skip, TODO selector, verificación pendiente, waitForTimeout, XPath, css generada, credenciales', () => {
    const bad = `test.only('C1 x', async ({ page }) => {
  // TODO selector
  // TODO verificación del total
  await page.waitForTimeout(1000);
  await page.locator('//div/span[2]').click();
  await page.locator('.css-2etuwl').click();
  await page.getByLabel('Password').fill('password', 'Secreta123');
  test.skip();
});`;
    const codes = lintTestSource(bad).issues.map((i) => i.code);
    for (const c of [
      'ONLY_FOUND',
      'TODO_SELECTOR',
      'PENDING_VERIFICATION',
      'WAIT_FOR_TIMEOUT',
      'XPATH_POSITIONAL',
      'GENERATED_CSS_CLASS',
      'HARDCODED_CREDENTIALS',
      'SKIP_FOUND',
      'NO_ASSERTION',
    ]) {
      expect(codes).toContain(c);
    }
  });
  it('permite waitForTimeout en rendimiento y skip autorizado', () => {
    const perf = good.replace(
      "await page.goto('/loadOrder');",
      "await page.goto('/'); await page.waitForTimeout(500); test.skip(true, 'motivo');",
    );
    expect(lintTestSource(perf, { allowWaitForTimeout: true, allowSkip: true }).ok).toBe(true);
  });
  it('sin test, título sin caso, demasiado grande, secretos (sin reflejarlos)', () => {
    expect(lintTestSource('const x = 1; expect(x)').issues.map((i) => i.code)).toContain('NO_TEST');
    expect(
      lintTestSource("test('Abrir sin caso', async () => { expect(1).toBe(1); });").issues.map((i) => i.code),
    ).toEqual(['TITLE_WITHOUT_CASE']);
    expect(lintTestSource('x'.repeat(1024 * 1024 + 1)).issues[0]!.code).toBe('TOO_LARGE');
    const leaked = good.replace("'/loadOrder'", "'/loadOrder?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2ln'");
    const r = lintTestSource(leaked);
    expect(r.issues.map((i) => i.code)).toEqual(['SECRET_DETECTED']);
    expect(r.issues[0]!.message).not.toContain('eyJ');
  });
});
