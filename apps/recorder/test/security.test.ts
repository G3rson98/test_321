/**
 * ESP §4 (Electron: sin Node en renderer, aislamiento de contexto, protocolo local seguro), RNF-SEG-01:
 * webPreferences de la ventana, endurecimiento de WebContents, CSP y validación Zod de cada mensaje IPC.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ALL_COMMANDS, IPC_COMMANDS } from '../src/shared/channels.js';
import { PROD_CSP } from '../src/shared/csp.js';
import { AppStateSchema, IPC_REQUEST_SCHEMAS } from '../src/shared/ipc.js';
import { ApiError } from '../src/main/core/api-client.js';
import { RecorderError } from '../src/main/core/errors.js';
import { createIpcRouter, type IpcHandlers, type IpcSender } from '../src/main/electron/ipc-router.js';
import {
  assertSecureWebPreferences,
  buildMainWindowOptions,
  hardenWebContents,
  isAppUrl,
  REQUIRED_WEB_PREFERENCES,
} from '../src/main/electron/window-security.js';

const INDEX = 'file:///C:/Program%20Files/Katalyst/resources/app.asar/out/renderer/index.html';

describe('ESP §4 configuración de seguridad de BrowserWindow', () => {
  it('webPreferences: contextIsolation, sandbox, sin nodeIntegration, sin webview, webSecurity', () => {
    const opts = buildMainWindowOptions('/app/out/preload/index.cjs', { devTools: false });
    const p = opts.webPreferences!;
    expect(p.contextIsolation).toBe(true);
    expect(p.nodeIntegration).toBe(false);
    expect(p.nodeIntegrationInWorker).toBe(false);
    expect(p.nodeIntegrationInSubFrames).toBe(false);
    expect(p.sandbox).toBe(true);
    expect(p.webSecurity).toBe(true);
    expect(p.allowRunningInsecureContent).toBe(false);
    expect(p.webviewTag).toBe(false);
    expect(p.experimentalFeatures).toBe(false);
    expect(p.navigateOnDragDrop).toBe(false);
    expect(p.devTools).toBe(false);
    expect(p.preload).toBe('/app/out/preload/index.cjs');
    expect(() => assertSecureWebPreferences(p)).not.toThrow();
  });

  it('assertSecureWebPreferences detecta configuraciones inseguras', () => {
    const base = { ...REQUIRED_WEB_PREFERENCES, preload: '/p/index.cjs' };
    expect(() => assertSecureWebPreferences({ ...base, contextIsolation: false })).toThrow(/contextIsolation/);
    expect(() => assertSecureWebPreferences({ ...base, nodeIntegration: true })).toThrow(/nodeIntegration/);
    expect(() => assertSecureWebPreferences({ ...base, sandbox: false })).toThrow(/sandbox/);
    expect(() => assertSecureWebPreferences({ ...base, preload: '/p/index.mjs' })).toThrow(/CommonJS/);
  });

  it('el main real usa buildMainWindowOptions (sin opciones inseguras sueltas)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    expect(src).toContain('new BrowserWindow(buildMainWindowOptions(');
    expect(src).not.toMatch(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/);
    expect(src).toContain('requestSingleInstanceLock');
    expect(src).toContain('setPermissionRequestHandler');
    // Sin servidores locales: el asistente no abre puertos.
    expect(src).not.toMatch(/createServer|\.listen\(/);
  });

  it('hardenWebContents: deniega ventanas nuevas y bloquea navegación fuera de la app', () => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    let openHandler: ((d: { url: string }) => { action: string }) | null = null;
    const contents = {
      setWindowOpenHandler: (h: typeof openHandler) => {
        openHandler = h;
      },
      on: (ev: string, h: (...a: unknown[]) => void) => {
        handlers.set(ev, h);
      },
    };
    hardenWebContents(contents as never, (u) => isAppUrl(u, { indexFileUrl: INDEX, devServerOrigin: null }));
    expect(openHandler!({ url: 'https://evil.example' })).toEqual({ action: 'deny' });
    const ev = { preventDefault: vi.fn() };
    handlers.get('will-navigate')!(ev, 'https://evil.example/phish');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    const ok = { preventDefault: vi.fn() };
    handlers.get('will-navigate')!(ok, INDEX);
    expect(ok.preventDefault).not.toHaveBeenCalled();
    const wv = { preventDefault: vi.fn() };
    handlers.get('will-attach-webview')!(wv);
    expect(wv.preventDefault).toHaveBeenCalled();
    const redirect = { preventDefault: vi.fn() };
    handlers.get('will-redirect')!(redirect, 'http://127.0.0.1:9/');
    expect(redirect.preventDefault).toHaveBeenCalled();
  });

  it('isAppUrl: solo el index.html empaquetado o el servidor Vite loopback en desarrollo', () => {
    expect(isAppUrl(INDEX, { indexFileUrl: INDEX, devServerOrigin: null })).toBe(true);
    expect(isAppUrl('file:///C:/Windows/system32/x.html', { indexFileUrl: INDEX, devServerOrigin: null })).toBe(false);
    expect(isAppUrl('http://localhost:5173/', { indexFileUrl: INDEX, devServerOrigin: null })).toBe(false);
    expect(isAppUrl('http://localhost:5173/', { indexFileUrl: INDEX, devServerOrigin: 'http://localhost:5173' })).toBe(
      true,
    );
    expect(
      isAppUrl('https://katalyst.example.test/', { indexFileUrl: INDEX, devServerOrigin: 'http://localhost:5173' }),
    ).toBe(false);
  });

  it('CSP estricta en el HTML de build: sin unsafe-inline/eval ni red desde el renderer', () => {
    expect(PROD_CSP).toContain("default-src 'none'");
    expect(PROD_CSP).toContain("script-src 'self'");
    expect(PROD_CSP).toContain("connect-src 'none'");
    expect(PROD_CSP).not.toMatch(/unsafe-(inline|eval)/);
    const html = readFileSync(join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it('el preload expone solo la API tipada (sin ipcRenderer ni canales arbitrarios)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8');
    expect(src).toContain("contextBridge.exposeInMainWorld('katalyst'");
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
    expect(src).not.toMatch(/send\(|sendSync\(/);
  });
});

describe('RNF-SEG-01 validación de mensajes IPC', () => {
  const trusted: IpcSender = { frameUrl: INDEX, isMainFrame: true, isAppWindow: true };
  const handlers = Object.fromEntries(
    ALL_COMMANDS.map((c) => [c, vi.fn(async (p: unknown) => ({ echo: p }))]),
  ) as unknown as IpcHandlers & Record<string, ReturnType<typeof vi.fn>>;
  const dispatch = createIpcRouter(handlers, (u) => isAppUrl(u, { indexFileUrl: INDEX, devServerOrigin: null }));

  it('hay esquema Zod para cada canal de la allowlist', () => {
    for (const c of ALL_COMMANDS) expect(IPC_REQUEST_SCHEMAS[c]).toBeDefined();
  });

  it('acepta un mensaje válido y entrega el payload ya validado', async () => {
    const id = '3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f';
    const r = await dispatch(IPC_COMMANDS.openRecording, trusted, { id });
    expect(r).toEqual({ ok: true, data: { echo: { id } } });
    const d = await dispatch(IPC_COMMANDS.startCapture, trusted, {});
    expect(d).toEqual({ ok: true, data: { echo: { skipLogin: false } } });
  });

  it('rechaza canales fuera de la allowlist, remitentes ajenos y payloads inválidos', async () => {
    expect(await dispatch('katalyst:shell:exec', trusted, {})).toMatchObject({
      ok: false,
      error: { code: 'IPC_INVALID' },
    });
    expect(
      await dispatch(IPC_COMMANDS.getState, { ...trusted, frameUrl: 'https://evil.example/' }, undefined),
    ).toMatchObject({ ok: false });
    expect(await dispatch(IPC_COMMANDS.getState, { ...trusted, isMainFrame: false }, undefined)).toMatchObject({
      ok: false,
    });
    expect(await dispatch(IPC_COMMANDS.getState, { ...trusted, isAppWindow: false }, undefined)).toMatchObject({
      ok: false,
    });
    const bad: [string, unknown][] = [
      [IPC_COMMANDS.openRecording, { id: '../../etc/passwd' }],
      [IPC_COMMANDS.openRecording, { id: '3f2b6c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f', token: 'x' }],
      [IPC_COMMANDS.setServerUrl, { serverUrl: 'x'.repeat(5000) }],
      [
        IPC_COMMANDS.submit,
        { draft: { title: 'x', tags: ['sin-arroba'], classification: 'lectura' }, acknowledgeWarnings: true },
      ],
      [IPC_COMMANDS.submit, { draft: { title: 'x', tags: [], classification: 'admin' }, acknowledgeWarnings: true }],
      [
        IPC_COMMANDS.submit,
        { draft: { title: 'x', tags: ['@a', '@a'], classification: 'lectura' }, acknowledgeWarnings: true },
      ],
      [IPC_COMMANDS.getState, { cualquier: 1 }],
      [IPC_COMMANDS.listRecordings, { scope: 'otra' }],
    ];
    for (const [channel, payload] of bad) {
      const r = await dispatch(channel, trusted, payload);
      expect(r, channel).toMatchObject({ ok: false, error: { code: 'IPC_INVALID' } });
    }
    expect(handlers[IPC_COMMANDS.submit]).not.toHaveBeenCalled();
  });

  it('traduce errores a mensajes en español sin detalles internos', async () => {
    const h = { ...handlers };
    h[IPC_COMMANDS.startLogin] = vi.fn(async () => {
      throw new RecorderError('PRODUCTION_BLOCKED');
    });
    h[IPC_COMMANDS.stopCapture] = vi.fn(async () => {
      throw new ApiError(0, 'NETWORK_ERROR', 'x');
    });
    h[IPC_COMMANDS.rerecord] = vi.fn(async () => {
      throw new Error('ENOENT /Users/qa/secreto');
    });
    const d = createIpcRouter(h, () => true);
    expect(await d(IPC_COMMANDS.startLogin, trusted, undefined)).toEqual({
      ok: false,
      error: { code: 'PRODUCTION_BLOCKED', message: expect.stringContaining('producción') },
    });
    expect(await d(IPC_COMMANDS.stopCapture, trusted, undefined)).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_ERROR' },
    });
    const internal = await d(IPC_COMMANDS.rerecord, trusted, undefined);
    expect(JSON.stringify(internal)).not.toContain('secreto');
  });

  it('el estado enviado al renderer no admite campos con credenciales', () => {
    const shape = AppStateSchema.shape;
    expect(Object.keys(shape)).not.toContain('accessToken');
    expect(Object.keys(shape.device.shape)).not.toContain('accessToken');
    expect(Object.keys(shape.device.shape)).not.toContain('deviceCode');
  });
});
