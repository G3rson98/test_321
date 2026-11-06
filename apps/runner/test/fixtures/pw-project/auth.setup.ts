/** Login contra la página local; valida identidad esperada y guarda storageState 0600 en tmpfs (RF-AMB-03). */
import fs from 'node:fs';
import { expect, test as setup } from '@playwright/test';

setup('autenticar', async ({ page }) => {
  const file = process.env.KATALYST_TEST_USER_FILE;
  if (!file) throw new Error('[auth_credenciales_no_disponibles] Falta KATALYST_TEST_USER_FILE');
  const { username, password } = JSON.parse(fs.readFileSync(file, 'utf8')) as { username: string; password: string };
  await page.goto('/login');
  await page.getByLabel('Usuario').fill(username);
  await page.getByLabel('Clave').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByTestId('identidad')).toHaveText(process.env.KATALYST_EXPECTED_USERNAME ?? username);
  const target = process.env.KATALYST_STORAGE_STATE_PATH!;
  await page.context().storageState({ path: target });
  fs.chmodSync(target, 0o600);
});
