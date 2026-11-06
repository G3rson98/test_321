/**
 * RF-GRB-06: lectura de pasos sobre salidas REALES de `playwright codegen` 1.65.0 (fixtures generadas con
 * scripts/generate-codegen-fixtures.cjs, mismo generador que el CLI) más casos sintéticos de interacciones no soportadas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodegenOutput, splitStatements, toApiSteps } from '../src/main/core/step-parser.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'codegen', `${name}.codegen.txt`), 'utf8');

describe('RF-GRB-06 step-parser sobre salidas reales de codegen', () => {
  it('reconoce acciones básicas (goto, click, fill, press, check, selectOption)', () => {
    const r = parseCodegenOutput(fixture('acciones-basicas'));
    expect(r.testCount).toBe(1);
    expect(r.steps.map((s) => s.kind)).toEqual(Array(8).fill('accion'));
    expect(r.steps.map((s) => s.description)).toEqual([
      'Ir a /',
      'Clic en pestaña "Distribuidores"',
      'Clic en campo "Buscar orden"',
      'Escribir "OC-123" en campo "Buscar orden"',
      'Pulsar Enter en campo "Buscar orden"',
      'Marcar casilla "Solo pendientes"',
      'Seleccionar confirmado en campo "Estado"',
      'Clic en botón "Filtrar"',
    ]);
    expect(r.steps[0]!.line).toBe(4);
    expect(r.verificationCount).toBe(0);
    expect(r.pendingVerifications).toBe(1);
    expect(r.warnings.map((w) => w.code)).toContain('NO_VERIFICATION');
  });

  it('reconoce verificaciones de visibilidad, texto, valor, marcado y snapshot ARIA', () => {
    const r = parseCodegenOutput(fixture('verificaciones'));
    const verifs = r.steps.filter((s) => s.kind === 'verificacion').map((s) => s.description);
    expect(verifs).toEqual([
      'Verificar que título "Órdenes de carga" está visible',
      'Verificar que elemento #res contiene "3 resultados"',
      'Verificar que campo "Buscar orden" tiene el valor "OC-9"',
      'Verificar que casilla "Solo pendientes" no está marcado',
      'Verificar la estructura (snapshot ARIA) de pestañas',
    ]);
    expect(r.actionCount).toBe(3);
    // La última sentencia es una verificación ⇒ no hay verificaciones pendientes.
    expect(r.pendingVerifications).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('getByTestId y navegación por enlaces; advierte acciones finales sin verificación', () => {
    const r = parseCodegenOutput(fixture('navegacion-y-testid'));
    expect(r.steps.map((s) => s.description)).toEqual([
      'Ir a /',
      'Clic en [data-testid=tab-abastecimiento]',
      'Clic en enlace "Ver detalle"',
      'Clic en enlace "Volver"',
    ]);
  });

  it('advierte diálogos nativos y ventanas emergentes como interacciones a revisar', () => {
    const r = parseCodegenOutput(fixture('dialogo-y-popup'));
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain('DIALOG');
    expect(codes).toContain('POPUP');
    const dialog = r.steps.find((s) => s.description.startsWith('Diálogo nativo'));
    expect(dialog?.kind).toBe('no_soportada');
    // `const page1 = await page1Promise` es auxiliar y no se muestra; la acción en la ventana emergente sí.
    expect(r.steps.some((s) => s.description === 'Clic en enlace "Volver"')).toBe(true);
    expect(r.steps.some((s) => s.description.includes('page1Promise'))).toBe(false);
  });

  it('pasos para la API respetan RecordingStepSchema (≤ 500 caracteres)', () => {
    const steps = toApiSteps(parseCodegenOutput(fixture('verificaciones')));
    expect(steps.length).toBe(8);
    for (const s of steps) expect(s.description.length).toBeLessThanOrEqual(500);
  });
});

describe('RF-GRB-06 interacciones no soportadas y reglas de ESP §10', () => {
  const wrap = (body: string) =>
    `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n${body}\n});\n`;

  it('mouse por coordenadas, subida de archivos, esperas fijas y XPath', () => {
    const r = parseCodegenOutput(
      wrap(
        [
          "  await page.goto('https://staging.example.test/loadOrder');",
          '  await page.mouse.click(120, 300);',
          "  await page.getByLabel('Adjunto').setInputFiles('C:\\\\Users\\\\qa\\\\factura.pdf');",
          '  await page.waitForTimeout(3000);',
          "  await page.locator('xpath=//div[3]/span[2]').click();",
          '  // TODO selector: botón de exportar',
          "  await expect(page.locator('.css-2etuwl')).toBeVisible();",
        ].join('\n'),
      ),
    );
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(['COORDINATES', 'FILE_UPLOAD', 'WAIT_FOR_TIMEOUT', 'FRAGILE_SELECTOR', 'TODO_SELECTOR']),
    );
    expect(r.unsupportedCount).toBe(3);
    expect(r.steps.find((s) => s.description === 'Ir a /loadOrder')).toBeTruthy();
  });

  it('iframes y acciones dentro de frames se reconocen con advertencia', () => {
    const r = parseCodegenOutput(
      wrap("  await page.locator('#visor').contentFrame().getByRole('button', { name: 'Ver' }).click();"),
    );
    expect(r.steps[0]!.kind).toBe('accion');
    expect(r.steps[0]!.description).toContain('botón "Ver"');
    expect(r.warnings.map((w) => w.code)).toContain('IFRAME');
  });

  it('instrucciones desconocidas quedan como no soportadas (no se promete un test válido)', () => {
    const r = parseCodegenOutput(wrap('  await page.evaluate(() => window.scrollTo(0, 999));\n  const x = 1;'));
    expect(r.steps.every((s) => s.kind === 'no_soportada')).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'UNSUPPORTED_INTERACTION').length).toBe(2);
  });

  it('acciones después de la última verificación generan "falta verificación del paso N"', () => {
    const r = parseCodegenOutput(
      wrap(
        [
          "  await page.goto('/schedulings');",
          "  await expect(page.getByRole('heading', { name: 'Agendamientos' })).toBeVisible();",
          "  await page.getByRole('tab', { name: 'Lista' }).click();",
        ].join('\n'),
      ),
    );
    const w = r.warnings.find((x) => x.code === 'ACTIONS_WITHOUT_VERIFICATION');
    expect(w?.message).toBe('Falta verificación del paso 3: hay acciones después de la última verificación.');
    expect(r.pendingVerifications).toBe(1);
  });

  it('las descripciones no reflejan secretos ni correos escritos en el formulario (RNF-SEG-01)', () => {
    const r = parseCodegenOutput(wrap("  await page.getByLabel('Correo').fill('ana.rojas@cliente.com');"));
    expect(r.steps[0]!.description).not.toContain('ana.rojas@cliente.com');
    expect(r.steps[0]!.description).toContain('[REDACTED');
  });

  it('archivo incompleto (codegen escribiendo) no rompe el análisis', () => {
    const r = parseCodegenOutput(
      "import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n  await page.goto('",
    );
    expect(r.testCount).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain('NO_TEST');
  });

  it('splitStatements respeta cadenas con ; y plantillas multilínea', () => {
    const st = splitStatements("a('x;y');\nb(`l1;\nl2`);\n// c;\nd();", 10);
    expect(st.map((s) => s.text)).toEqual(["a('x;y')", 'b(`l1;\nl2`)', 'd()']);
    expect(st.map((s) => s.line)).toEqual([10, 11, 14]);
  });
});
