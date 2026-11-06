/**
 * Tests de la fixture LOCAL de Katalyst (scripts/fake-deltax.mjs). Solo existen en el repositorio git local que arma
 * `scripts/dev-stack.sh` (copia de qa-tests + este archivo); nunca apuntan a staging/producción de DeltaX.
 * Clasificación: lectura. C900006..C900009 son casos del TestRail FALSO (scripts/fake-testrail.mjs).
 */
import { expect, stableKey, test } from '../../fixtures/test.ts';

test(
  'C900006 Abrir la página local y ver el centro de control @local @humo',
  { annotation: [stableKey('36c33ab8-b663-4bd9-98a0-f89a16308322')] },
  async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Centro de control local' })).toBeVisible();
    await expect(page.getByTestId('estado')).toHaveText('Aplicación lista');
  },
);

test(
  'C900007 Ver un indicador inexistente en la página local @local',
  { annotation: [stableKey('9797e4e1-d8bb-4d10-b991-5a8a86c3dd17')] },
  async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Indicador que no existe'), 'falla esperada de la fixture local').toBeVisible({ timeout: 3_000 });
  },
);

test(
  'C900008 Esperar un indicador que nunca aparece @local @lento',
  { annotation: [stableKey('1fadf4c1-b985-4282-ac7e-784ac3a9f7f3')] },
  async ({ page }) => {
    await page.goto('/espera');
    await expect(page.getByText('Indicador listo')).toBeVisible({ timeout: 100_000 });
  },
);

test(
  'C900009 Página de canarios con datos sensibles sembrados @local @canario',
  { annotation: [stableKey('838f47d1-b689-4118-aa2a-7c3d446ce0c6')] },
  async ({ page }) => {
    // Ensayo ESP §13.7: los valores llegan de la app (no del repo); el error final los incluye a propósito.
    const api = await page.request.get('/api/canario');
    const datos = (await api.json()) as { accessToken: string; clave: string; cliente: { documento: string } };
    console.log('respuesta canario', JSON.stringify(datos));
    await page.goto(`/canario?token=${encodeURIComponent(datos.accessToken)}`);
    await expect(page.getByTestId('respuesta')).toBeVisible();
    const visible = await page.getByTestId('secreto').textContent();
    expect(visible, `valor sensible ${visible} token ${datos.accessToken} documento ${datos.cliente.documento}`).toBe('valor-que-no-coincide');
  },
);
