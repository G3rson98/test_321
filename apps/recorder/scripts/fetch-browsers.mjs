/**
 * Descarga Chromium de @playwright/test 1.65.0 a build/ms-playwright para incluirlo en el instalador
 * (extraResources → resources/ms-playwright). Ejecutar en la MISMA plataforma del instalador (Windows 11 x64):
 * los binarios de Chromium son específicos de cada SO. Sin este paso, el asistente lo descarga en el primer uso.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const target = join(here, '..', 'build', 'ms-playwright');
if (process.platform !== 'win32')
  console.warn(`Aviso: se descargará Chromium para ${process.platform}, no para Windows.`);
const r = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: target },
});
process.exit(r.status ?? 1);
