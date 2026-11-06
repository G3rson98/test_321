/**
 * Proceso main del asistente local de grabación Katalyst (Electron). RF-GRB-01, RF-GRB-02, RF-GRB-06, RNF-SEG-01.
 * - Una sola instancia (single instance lock); protocolo `katalyst://` que solo transporta el ID de sesión.
 * - Ventana con contextIsolation + sandbox, sin Node en el renderer, CSP estricta, navegación y ventanas bloqueadas.
 * - Sin puertos locales: solo conexiones salientes HTTPS a la API de Katalyst.
 * - Limpieza de sesiones abandonadas al iniciar, periódica (5 min) y al salir.
 */
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_COMMANDS, IPC_EVENTS } from '../shared/channels.js';
import { AppStateSchema, RecordingDraftSchema, type AppState } from '../shared/ipc.js';
import { DEV_CSP } from '../shared/csp.js';
import { AppController, type ConfigPersistence } from './core/app-controller.js';
import { sweepSessions, startPeriodicCleanup } from './core/cleanup.js';
import { isLoopbackHost } from './core/config.js';
import { CredentialStore } from './core/credential-store.js';
import { findDeepLinkInArgv, PROTOCOL_SCHEME } from './core/deep-link.js';
import { SessionStore } from './core/session-store.js';
import { createIpcRouter, type IpcHandlers } from './electron/ipc-router.js';
import {
  configurePlaywright,
  createBrowserManager,
  createCodegenFactory,
  createLoginBrowser,
  createProcessHost,
  restrictDirectoryToUser,
} from './electron/playwright-host.js';
import { electronEncryptor } from './electron/safe-storage.js';
import { buildMainWindowOptions, hardenWebContents, isAppUrl, securityHeaders } from './electron/window-security.js';

const devMode = !app.isPackaged && process.env.KATALYST_RECORDER_DEV === '1';
const devServerUrl = !app.isPackaged ? (process.env.ELECTRON_RENDERER_URL ?? null) : null;
const devServerOrigin = (() => {
  if (!devServerUrl) return null;
  try {
    const u = new URL(devServerUrl);
    return u.protocol === 'http:' && isLoopbackHost(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
})();
const indexHtmlPath = join(__dirname, '../renderer/index.html');
const indexFileUrl = pathToFileURL(indexHtmlPath).toString();
const isTrustedUrl = (url: string) => isAppUrl(url, { indexFileUrl, devServerOrigin });

let mainWindow: BrowserWindow | null = null;
let controller: AppController | null = null;
const pendingLinks: string[] = [];

// ---- Instancia única y protocolo --------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  } else if (process.env.KATALYST_RECORDER_REGISTER_PROTOCOL === '1' && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [process.argv[1]]);
  }
  app.on('second-instance', (_e, argv) => {
    const link = findDeepLinkInArgv(argv);
    if (link) dispatchLink(link);
    focusWindow();
  });
  // macOS entrega los enlaces por `open-url` (puede llegar antes de `ready`).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    dispatchLink(url);
  });
  const initial = findDeepLinkInArgv(process.argv);
  if (initial) pendingLinks.push(initial);
  app
    .whenReady()
    .then(main)
    .catch((e: unknown) => {
      // Sin detalles internos al usuario (RNF-USA-02); el nombre del error basta para soporte.
      dialog.showErrorBox('Katalyst Grabador', 'No se pudo iniciar el asistente. Vuelve a abrirlo o reinstálalo.');
      console.error('No se pudo iniciar el asistente', e instanceof Error ? e.name : 'error');
      app.exit(1);
    });
}

function dispatchLink(url: string): void {
  if (controller) void controller.handleDeepLink(url);
  else pendingLinks.push(url);
}

function focusWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// ---- Configuración persistida ------------------------------------------------------------------------------

const ConfigFileSchema = z.object({ serverUrl: z.string().max(2048).nullable().optional() });

function configPersistence(): ConfigPersistence {
  const userConfig = join(app.getPath('userData'), 'config.json');
  const packagedDefault = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
    'katalyst.config.json',
  );
  const read = async (p: string) => {
    try {
      return ConfigFileSchema.parse(JSON.parse(await fs.readFile(p, 'utf8')));
    } catch {
      return null;
    }
  };
  return {
    async load() {
      const user = await read(userConfig);
      const def = await read(packagedDefault);
      return { serverUrl: user?.serverUrl ?? def?.serverUrl ?? process.env.KATALYST_SERVER_URL ?? null };
    },
    async save(cfg) {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(userConfig, JSON.stringify({ serverUrl: cfg.serverUrl }, null, 2), { mode: 0o600 });
    },
  };
}

// ---- Arranque ----------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (devServerOrigin) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, ...securityHeaders(DEV_CSP) } });
    });
  }
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, isTrustedUrl));

  const store = new SessionStore({
    baseDir: join(app.getPath('temp'), 'katalyst-recorder'),
    restrictDirectory: restrictDirectoryToUser,
  });
  await store.ensureBase();
  await sweepSessions(store, { startup: true }).catch(() => undefined);

  const paths = configurePlaywright();
  const host = createProcessHost();
  controller = new AppController({
    version: app.getVersion(),
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    devMode,
    config: configPersistence(),
    credentials: new CredentialStore(join(app.getPath('userData'), 'device-credential.bin'), electronEncryptor),
    store,
    browser: createBrowserManager(paths, host),
    openExternal: (url) => shell.openExternal(url),
    createLoginBrowser,
    createCodegen: createCodegenFactory(paths, host),
    onState: sendState,
  });
  const stopCleanup = startPeriodicCleanup(() =>
    sweepSessions(store, { activeIds: controller?.activeRecordingIds ?? new Set() }),
  );
  registerIpc(controller);
  await controller.init();
  createWindow();
  for (const link of pendingLinks.splice(0)) void controller.handleDeepLink(link);

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopCleanup();
    void (async () => {
      await controller?.shutdown().catch(() => undefined);
      // Al cerrar: ningún storageState sobrevive (ESP §13.6); el código sin enviar se conserva ≤ 24 h.
      await sweepSessions(store, { startup: true }).catch(() => undefined);
      app.exit(0);
    })();
  });
  app.on('window-all-closed', () => app.quit());
}

function createWindow(): void {
  const preload = join(__dirname, '../preload/index.cjs');
  mainWindow = new BrowserWindow(buildMainWindowOptions(preload, { devTools: !app.isPackaged }));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (devServerOrigin && devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(indexHtmlPath);
}

function sendState(state: AppState): void {
  const parsed = AppStateSchema.safeParse(state);
  if (!parsed.success || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_EVENTS.stateChanged, parsed.data);
}

// ---- IPC ---------------------------------------------------------------------------------------------------

function registerIpc(ctl: AppController): void {
  const rec = () => ctl.recordingController();
  const handlers: IpcHandlers = {
    [IPC_COMMANDS.getState]: async () => AppStateSchema.parse(ctl.state()),
    [IPC_COMMANDS.setServerUrl]: (p) => ctl.setServerUrl(p.serverUrl),
    [IPC_COMMANDS.startLink]: () => ctl.startLink(),
    [IPC_COMMANDS.cancelLink]: async () => ctl.cancelLink(),
    [IPC_COMMANDS.openVerification]: () => ctl.openVerification(),
    [IPC_COMMANDS.unlink]: () => ctl.unlink(),
    [IPC_COMMANDS.installBrowser]: () => ctl.installBrowser(),
    [IPC_COMMANDS.listRecordings]: (p) => ctl.listRecordings(p.scope, p.cursor),
    [IPC_COMMANDS.openRecording]: (p) => ctl.openRecording(p.id),
    [IPC_COMMANDS.startLogin]: () => rec().startLogin(),
    [IPC_COMMANDS.startCapture]: (p) => rec().startCapture({ skipLogin: p.skipLogin }),
    [IPC_COMMANDS.stopCapture]: () => rec().stop(),
    [IPC_COMMANDS.rerecord]: () => rec().rerecord(),
    [IPC_COMMANDS.addVerification]: () => rec().addVerification(),
    [IPC_COMMANDS.validateDraft]: (p) => rec().validate(RecordingDraftSchema.parse(p.draft)),
    [IPC_COMMANDS.maskSensitive]: () => rec().maskSensitive(),
    [IPC_COMMANDS.submit]: (p) => rec().submit(p.draft, p.acknowledgeWarnings),
    [IPC_COMMANDS.discard]: (p) => rec().discard(p.reason),
    [IPC_COMMANDS.closeRecording]: () => rec().close(),
    [IPC_COMMANDS.openPullRequest]: () => ctl.openPullRequest(),
  };
  const dispatch = createIpcRouter(handlers, isTrustedUrl);
  for (const channel of Object.values(IPC_COMMANDS)) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      const frame = event.senderFrame;
      const result = await dispatch(
        channel,
        {
          frameUrl: frame?.url ?? null,
          isMainFrame: frame !== null && frame !== undefined && frame === event.sender.mainFrame,
          isAppWindow: mainWindow !== null && event.sender === mainWindow.webContents,
        },
        payload,
      );
      return result;
    });
  }
}
