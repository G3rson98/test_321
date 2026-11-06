/** Tests de fixtures: pasado, fallido (con canario), inestable, timeout de operación, skip autorizado, lento. */
import { expect, stableKey, test } from '../fixtures/test.ts';

test('C1 Panel visible @humo', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000001')] }, async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
});

test('C2 Título incorrecto @humo', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000002')] }, async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading').first(), 'título esperado KATALYST_CANARY_TOKEN_e2e').toHaveText('Otro título', { timeout: 1_000 });
});

test('C3 Inestable @humo', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000003')] }, async ({ page }, testInfo) => {
  await page.goto('/app');
  expect(testInfo.retry, 'falla solo en el primer intento').toBeGreaterThan(0);
});

test('C4 Operación que no termina @humo', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000004')] }, async ({ page }) => {
  await page.goto('/app');
  await page.getByTestId('nunca-aparece').click({ timeout: 1_000 });
});

test('C5 Omitido autorizado @rendimiento', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000005')] }, async () => {
  // katalyst-skip-autorizado: dxmon_no_disponible
  test.skip(true, 'dxmon_no_disponible: scripts legados ausentes');
});

test('C6 Lento @lento', { annotation: [stableKey('0f6c2a51-6f0e-4d0a-9c11-000000000006')] }, async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByTestId('nunca-aparece')).toBeVisible({ timeout: 110_000 });
});
