/**
 * Genera las fixtures de `test/fixtures/codegen/*.codegen.txt` con el MISMO generador que `playwright codegen`
 * (@playwright/test 1.65.0, target playwright-test) contra una página sintética servida en loopback.
 * Las verificaciones se agregan pulsando los botones Assert de la barra flotante del recorder.
 * Uso: node scripts/generate-codegen-fixtures.cjs [escenario]   (requiere Chromium instalado)
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const http = require('http');

const PAGE = `<!doctype html><html lang="es"><head><title>Staging sintético</title></head><body>
<h1>Órdenes de carga</h1>
<div role="tablist"><button role="tab" data-testid="tab-abastecimiento">Abastecimiento</button><button role="tab">Distribuidores</button></div>
<label for="q">Buscar orden</label><input id="q" type="text">
<label><input type="checkbox" id="solo"> Solo pendientes</label>
<select aria-label="Estado"><option value="todos">Todos</option><option value="confirmado">Confirmado</option></select>
<button onclick="document.getElementById('res').textContent='3 resultados'">Filtrar</button>
<div id="res" role="status"></div>
<a href="/detalle" id="lnk">Ver detalle</a>
<button onclick="alert('hola')">Avisar</button>
<button onclick="window.open('/detalle')">Abrir ventana</button>
</body></html>`;
const DETAIL = `<!doctype html><html lang="es"><body><h1>Detalle OC-1</h1><a href="/">Volver</a></body></html>`;

async function setMode(page, mode) {
  const x = { assertingVisibility: 636, assertingText: 668, assertingValue: 700, assertingSnapshot: 732 }[mode];
  await page.mouse.click(x, 16);
  await page.waitForTimeout(300);
}
async function main() {
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html; charset=utf-8');
    r.end(q.url.startsWith('/detalle') ? DETAIL : PAGE);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outDir = path.join(__dirname, '..', 'test', 'fixtures', 'codegen');
  const scenarios = {
    'acciones-basicas': async (page) => {
      await page.goto(base + '/');
      await page.getByRole('tab', { name: 'Distribuidores' }).click();
      await page.getByLabel('Buscar orden').click();
      await page.getByLabel('Buscar orden').fill('OC-123');
      await page.getByLabel('Buscar orden').press('Enter');
      await page.getByLabel('Solo pendientes').check();
      await page.getByLabel('Estado').selectOption('confirmado');
      await page.getByRole('button', { name: 'Filtrar' }).click();
    },
    'navegacion-y-testid': async (page) => {
      await page.goto(base + '/');
      await page.getByTestId('tab-abastecimiento').click();
      await page.getByRole('link', { name: 'Ver detalle' }).click();
      await page.waitForURL('**/detalle');
      await page.getByRole('link', { name: 'Volver' }).click();
    },
    'dialogo-y-popup': async (page) => {
      await page.goto(base + '/');
      page.once('dialog', (d) => d.dismiss().catch(() => {}));
      await page.getByRole('button', { name: 'Avisar' }).click();
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Abrir ventana' }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      await popup.getByRole('link', { name: 'Volver' }).click();
    },
  };
  scenarios['verificaciones'] = async (page) => {
    await page.goto(base + '/');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await page.getByLabel('Buscar orden').fill('OC-9');
    await setMode(page, 'assertingVisibility');
    await page.getByRole('heading').click();
    await page.waitForTimeout(400);
    await setMode(page, 'assertingText');
    await page.getByRole('status').click();
    await page.waitForTimeout(400);
    await page.mouse.click(366, 160);
    await page.waitForTimeout(400);
    await setMode(page, 'assertingValue');
    await page.getByLabel('Buscar orden').click();
    await page.waitForTimeout(400);
    await setMode(page, 'assertingValue');
    await page.getByLabel('Solo pendientes').click();
    await page.waitForTimeout(400);
    await setMode(page, 'assertingSnapshot');
    await page.getByRole('tablist').click();
    await page.waitForTimeout(400);
  };
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  for (const [name, fn] of Object.entries(scenarios)) {
    if (process.argv[2] && name !== process.argv[2]) continue;
    const context = await browser.newContext();
    const outputFile = path.join(outDir, `${name}.codegen.txt`);
    await context._showRecorder({
      language: 'playwright-test',
      mode: 'recording',
      outputFile,
      testIdAttributeName: 'data-testid',
      handleSIGINT: false,
    });
    const page = await context.newPage();
    await fn(page, context, outputFile);
    await page.waitForTimeout(800);
    await context.close();
    await new Promise((r) => setTimeout(r, 400));
    console.log(name, fs.existsSync(outputFile) ? 'ok' : '(sin archivo)');
  }
  await browser.close();
  server.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
