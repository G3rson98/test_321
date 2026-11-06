/**
 * Validación local previa al envío (ESP §13.6, §10 reglas 3/11, RNF-SEG-01): rechazo de secretos sin reflejarlos,
 * `waitForTimeout`, tamaño ≤ 1 MiB, `TODO selector` como advertencia visible; título con ID de caso y etiquetas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestTitle, prepareCodeForSubmit, relativizeGotos } from '../src/main/core/code-transform.js';
import { parseCodegenOutput } from '../src/main/core/step-parser.js';
import { maskSensitiveValues, validateBeforeSubmit } from '../src/main/core/validation.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'codegen', `${name}.codegen.txt`), 'utf8');
const validate = (code: string, extra = 0) =>
  validateBeforeSubmit(code, { parse: parseCodegenOutput(code), extraPendingVerifications: extra });
const prepared = (code: string) =>
  prepareCodeForSubmit(code, {
    caseRef: 'C1501',
    title: 'Filtrar órdenes',
    tags: ['@oc', '@humo'],
    appUrl: 'http://127.0.0.1:58057/',
  });

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkthdGFseXN0In0.c2lnbmF0dXJlLXNpbnRldGljYS1kZS1wcnVlYmE';

describe('RF-GRB-02 preparación del código', () => {
  it('título con ID del caso y etiquetas elegidas, goto relativos al baseURL', () => {
    const code = prepared(fixture('verificaciones'));
    expect(code).toContain("test('C1501 Filtrar órdenes @oc @humo', async ({ page }) => {");
    expect(code).toContain("await page.goto('/');");
    expect(code).not.toContain('127.0.0.1');
  });
  it('no duplica el caso ni etiquetas y escapa comillas', () => {
    expect(buildTestTitle('C1501', 'C1501 Ver @oc', ['@oc', '@humo'])).toBe('C1501 Ver @oc @humo');
    const code = prepareCodeForSubmit("test('test', async ({ page }) => {});", {
      caseRef: 'C7',
      title: "Ver 'OC'",
      tags: [],
      appUrl: null,
    });
    expect(code).toContain("test('C7 Ver \\'OC\\'', async");
  });
  it('solo relativiza el origen del ambiente', () => {
    expect(relativizeGotos("page.goto('https://otra.example/x')", 'https://staging.example/')).toBe(
      "page.goto('https://otra.example/x')",
    );
  });
});

describe('RNF-SEG-01 validación local previa al envío', () => {
  it('una grabación real con verificaciones pasa sin errores ni advertencias', () => {
    const r = validate(prepared(fixture('verificaciones')));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rechaza secretos y datos personales sin reflejar el valor (JWT, Bearer, correo, canario)', () => {
    const code = prepared(
      [
        "import { test, expect } from '@playwright/test';",
        "test('test', async ({ page }) => {",
        `  await page.goto('http://127.0.0.1:58057/?token=${JWT}');`,
        "  await page.getByLabel('Correo').fill('ana.rojas@cliente.com');",
        "  await page.getByLabel('Clave API').fill('Bearer abcdefghijklmnopqrstuvwxyz0123456789');",
        "  await page.getByLabel('Nota').fill('KATALYST_CANARY_9f8e7d');",
        "  await expect(page.getByRole('heading')).toBeVisible();",
        '});',
      ].join('\n'),
    );
    const r = validate(code);
    expect(r.ok).toBe(false);
    const secretIssues = r.issues.filter((i) => i.code === 'SECRET_DETECTED');
    expect(secretIssues.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(r);
    for (const leaked of [
      JWT,
      'ana.rojas@cliente.com',
      'abcdefghijklmnopqrstuvwxyz0123456789',
      'KATALYST_CANARY_9f8e7d',
    ])
      expect(text).not.toContain(leaked);
    expect(secretIssues.every((i) => typeof i.line === 'number')).toBe(true);
  });

  it('enmascarar reemplaza los valores y permite enviar con advertencia para el desarrollador', () => {
    const raw = prepared(
      "import { test, expect } from '@playwright/test';\ntest('test', async ({ page }) => {\n  await page.goto('http://127.0.0.1:58057/?access_token=abc123');\n  await page.getByLabel('Correo').fill('ana.rojas@cliente.com');\n  await expect(page.getByRole('heading')).toBeVisible();\n});\n",
    );
    const { code, masked } = maskSensitiveValues(raw);
    expect(masked).toBe(2);
    expect(code).not.toContain('ana.rojas@cliente.com');
    expect(code).not.toContain('abc123');
    const r = validate(code);
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain('MASKED_VALUES');
  });

  it('waitForTimeout bloquea; TODO selector y verificaciones pendientes son advertencias visibles', () => {
    const wait = validate(
      prepared(
        "test('test', async ({ page }) => {\n  await page.goto('/');\n  await page.waitForTimeout(2000);\n  await expect(page.getByRole('heading')).toBeVisible();\n});",
      ),
    );
    expect(wait.ok).toBe(false);
    expect(wait.issues.find((i) => i.code === 'WAIT_FOR_TIMEOUT')?.severity).toBe('error');

    const todo = validate(
      prepared(
        "test('test', async ({ page }) => {\n  await page.goto('/');\n  // TODO selector: exportar\n  await page.getByRole('button', { name: 'X' }).click();\n});",
      ),
      1,
    );
    expect(todo.ok).toBe(true);
    const codes = todo.issues.filter((i) => i.severity === 'advertencia').map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['TODO_SELECTOR', 'NO_VERIFICATION', 'REQUESTED_VERIFICATION_PENDING']),
    );
  });

  it('rechaza código > 1 MiB', () => {
    const big = "test('C1 x', async ({ page }) => {\n" + '  // relleno\n'.repeat(100_000) + '});';
    const r = validate(big);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('TOO_LARGE');
    expect(r.bytes).toBeGreaterThan(1024 * 1024);
  });

  it('.only y credenciales escritas bloquean el envío', () => {
    const r = validate(
      "test.only('C1 x', async ({ page }) => {\n  await page.getByLabel('Contraseña').fill('password', 'S3cret!');\n  await expect(page.getByRole('heading')).toBeVisible();\n});",
    );
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('ONLY_FOUND');
  });
});
