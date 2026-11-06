/* global window -- usado dentro de callbacks evaluados en el renderer */
/**
 * Humo E2E del asistente construido (out/) con Playwright `_electron` contra un servidor falso en loopback:
 * vínculo por dispositivo → lista → grabación con codegen REAL (Chromium visible) → detener → revisión → PR.
 * Verifica también que el renderer no tiene Node y que la ventana usa contextIsolation/sandbox.
 * Uso: pnpm --filter @katalyst/recorder e2e:smoke [carpeta-de-capturas]   (Windows 11 o macOS; requiere Chromium)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createRequire } = require('module');
const APP = path.join(__dirname, '..', '..');
const req = createRequire(path.join(APP, 'package.json'));
const { _electron } = req('@playwright/test');
const electronPath = req('electron');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(require('os').tmpdir(), 'katalyst-smoke-'));
const shots = (n) => path.join(OUT, n + '.png');

const TOKEN = 'kdev_' + 'e'.repeat(48);
const envId = randomUUID();
const recId = randomUUID();
let polls = 0;
const log = [];
let port;
const now = Date.now();
const recording = {
  id: recId,
  caseId: randomUUID(),
  caseRef: 'C1501',
  environmentId: envId,
  createdBy: randomUUID(),
  deviceId: null,
  status: 'creada',
  tags: ['@agendamiento'],
  expiresAt: new Date(now + 7200e3).toISOString(),
  branch: null,
  prUrl: null,
  commit: null,
  rejectionReasons: [],
  steps: [],
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
const server = http.createServer((q, r) => {
  let b = '';
  q.on('data', (c) => (b += c));
  q.on('end', () => {
    const u = new URL(q.url, 'http://x');
    const p = u.pathname;
    log.push(`${q.method} ${p} ${q.headers.authorization ? 'auth' : ''}`);
    const json = (s, o) => {
      r.writeHead(s, { 'content-type': 'application/json' });
      r.end(o === undefined ? '' : JSON.stringify(o));
    };
    const err = (s, code) => json(s, { error: { code, message: code, requestId: 'x' } });
    if (p === '/app') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return r.end('<!doctype html><html lang="es"><body><h1>Agendamientos</h1><button>Lista</button></body></html>');
    }
    if (p === '/api/v1/devices/authorize')
      return json(200, {
        deviceCode: 'dc_' + 'x'.repeat(40),
        userCode: 'QWER-7Y2K',
        verificationUri: `http://127.0.0.1:${port}/dispositivos`,
        verificationUriComplete: `http://127.0.0.1:${port}/dispositivos?codigo=QWER-7Y2K`,
        expiresIn: 300,
        interval: 1,
      });
    if (p === '/api/v1/devices/token') {
      polls++;
      return polls < 3
        ? err(400, 'DEVICE_AUTHORIZATION_PENDING')
        : json(200, {
            accessToken: TOKEN,
            tokenType: 'Bearer',
            deviceId: randomUUID(),
            expiresAt: '2099-01-01T00:00:00.000Z',
          });
    }
    if (q.headers.authorization !== `Bearer ${TOKEN}`) return err(401, 'UNAUTHENTICATED');
    if (p === '/api/v1/devices/heartbeat') return json(204);
    if (p === '/api/v1/environments')
      return json(200, {
        items: [{ id: envId, name: 'staging', isProduction: false, enabled: true, recordingAllowed: true }],
      });
    if (p === '/api/v1/recordings') return json(200, { items: [recording], nextCursor: null, hasNext: false });
    if (p === `/api/v1/recordings/${recId}`)
      return json(200, {
        ...recording,
        environment: {
          id: envId,
          name: 'staging',
          appUrl: `http://127.0.0.1:${port}/app`,
          isProduction: false,
          recordingAllowed: true,
          enabled: true,
        },
      });
    if (p === `/api/v1/recordings/${recId}/status`) {
      const s = JSON.parse(b);
      recording.status = s.status;
      if (s.steps) recording.steps = s.steps;
      return json(200, recording);
    }
    if (p === `/api/v1/recordings/${recId}/complete`) {
      fs.writeFileSync(path.join(OUT, 'complete-body.json'), b);
      Object.assign(recording, {
        status: 'pr_abierto',
        prUrl: 'https://github.com/deltax/qa-tests/pull/84',
        branch: 'grabacion/c1501',
      });
      return json(200, recording);
    }
    if (p === `/api/v1/recordings/${recId}/cancel`) {
      recording.status = 'cancelada';
      return json(200, recording);
    }
    err(404, 'NOT_FOUND');
  });
});

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  const userData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'katalyst-e2e-ud-'));
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [path.join(APP, 'out/main/index.cjs'), `--user-data-dir=${userData}`],
    env: { ...process.env, KATALYST_RECORDER_DEV: '1', KATALYST_SERVER_URL: `http://127.0.0.1:${port}` },
    cwd: APP,
  });
  const win = await app.firstWindow();
  await win.setViewportSize?.({ width: 1100, height: 800 }).catch(() => {});
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  for (const [k, v] of Object.entries({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  })) {
    if (prefs[k] !== v) throw new Error(`webPreferences.${k} = ${prefs[k]}`);
  }
  const nodeInRenderer = await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined');
  if (nodeInRenderer) throw new Error('El renderer tiene acceso a Node');
  const bridgeKeys = await win.evaluate(() => Object.keys(window.katalyst));
  fs.writeFileSync(path.join(OUT, 'renderer.json'), JSON.stringify({ nodeInRenderer, bridgeKeys, prefs }, null, 2));
  await win.getByRole('button', { name: 'Vincular asistente' }).waitFor();
  await win.screenshot({ path: shots('01-vinculo') });
  await win.getByRole('button', { name: 'Vincular asistente' }).click();
  await win.getByText('QWER-7Y2K').waitFor();
  await win.screenshot({ path: shots('02-codigo') });
  await win.getByRole('heading', { name: 'Grabaciones' }).waitFor({ timeout: 15000 });
  await win.getByRole('cell', { name: 'C1501' }).waitFor();
  await win.screenshot({ path: shots('03-lista') });
  await win.getByRole('button', { name: 'Abrir' }).click();
  await win.getByRole('button', { name: 'Grabar sin iniciar sesión' }).waitFor();
  await win.screenshot({ path: shots('04-grabacion-lista') });
  await win.getByRole('button', { name: 'Grabar sin iniciar sesión' }).click();
  await win.getByText('Ir a /app').waitFor({ timeout: 30000 });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: shots('05-grabando') });
  await win.getByRole('button', { name: 'Agregar verificación' }).click();
  await win.waitForTimeout(300);
  await win.screenshot({ path: shots('06-agregar-verificacion') });
  await win.getByRole('button', { name: 'Detener' }).click();
  await win.getByRole('textbox', { name: 'Título del test' }).waitFor({ timeout: 15000 });
  await win.getByRole('textbox', { name: 'Título del test' }).fill('Abrir agendamientos');
  await win.waitForTimeout(800);
  await win.screenshot({ path: shots('07-revision') });
  const ack = win.getByRole('checkbox');
  if (await ack.count()) await ack.check();
  await win.getByRole('button', { name: 'Enviar PR' }).click();
  await win.getByRole('button', { name: 'Abrir pull request' }).waitFor({ timeout: 15000 });
  await win.screenshot({ path: shots('08-pr') });
  fs.writeFileSync(path.join(OUT, 'requests.log'), log.join('\n'));
  await app.close();
  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('E2E OK — capturas en', OUT);
})().catch(async (e) => {
  console.error('E2E FAIL', e);
  fs.writeFileSync(path.join(OUT, 'requests.log'), log.join('\n'));
  process.exit(1);
});
