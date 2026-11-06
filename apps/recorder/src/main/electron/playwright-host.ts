/**
 * Integración con Playwright (@playwright/test 1.65.0) en el proceso main:
 * - Ubicación de Chromium: incluido en el instalador (`resources/ms-playwright`) o descargado en el primer uso a
 *   `userData/ms-playwright` (`playwright install chromium --no-shell`). En desarrollo se usa la caché por defecto.
 * - Navegador de login interactivo SIN captura (ESP §13.6: "pausa captura durante login"): el QA inicia sesión
 *   (MFA incluido) y el asistente obtiene el storageState para escribirlo en el directorio temporal 0600.
 * - Lanzador de codegen con el ejecutable de Electron como Node (`ELECTRON_RUN_AS_NODE`).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { userInfo } from 'node:os';
import { app } from 'electron';
import {
  CodegenSession,
  runBrowserInstall,
  type CodegenRunnerOptions,
  type ProcessHost,
} from '../core/codegen-runner.js';
import type { BrowserManager } from '../core/app-controller.js';
import type { CodegenHandle, LoginBrowser } from '../core/recording-controller.js';

const nodeRequire = createRequire(__filename);

/** Rutas dentro de app.asar no son ejecutables por procesos hijos: se usan las copias `app.asar.unpacked`. */
function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

export interface PlaywrightPaths {
  cliPath: string;
  browsersPath: string | null;
  source: 'incluido' | 'descargado' | 'cache';
}

function hasChromium(dir: string): boolean {
  try {
    return readdirSync(dir).some((d) => d.startsWith('chromium-'));
  } catch {
    return false;
  }
}

/** Debe llamarse ANTES del primer `require('@playwright/test')` (Playwright lee la variable al cargar). */
export function configurePlaywright(): PlaywrightPaths {
  // `cli.js` no está en `exports`: se resuelve desde package.json del paquete.
  const cliPath = unpacked(join(dirname(nodeRequire.resolve('@playwright/test/package.json')), 'cli.js'));
  if (!app.isPackaged) {
    return { cliPath, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, source: 'cache' };
  }
  const bundled = join(process.resourcesPath, 'ms-playwright');
  const browsersPath = hasChromium(bundled) ? bundled : join(app.getPath('userData'), 'ms-playwright');
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return { cliPath, browsersPath, source: browsersPath === bundled ? 'incluido' : 'descargado' };
}

interface PwChromium {
  executablePath(): string;
  launch(opts: Record<string, unknown>): Promise<PwBrowser>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  on(event: 'disconnected', cb: () => void): void;
}
interface PwContext {
  newPage(): Promise<{ goto(url: string, opts?: Record<string, unknown>): Promise<unknown> }>;
  storageState(): Promise<unknown>;
}

function chromium(): PwChromium {
  return (nodeRequire('@playwright/test') as { chromium: PwChromium }).chromium;
}

export function createBrowserManager(paths: PlaywrightPaths, host: ProcessHost): BrowserManager {
  return {
    async check() {
      let installed: boolean;
      try {
        installed = existsSync(chromium().executablePath());
      } catch {
        installed = false;
      }
      const source = !installed ? 'ninguno' : paths.source === 'incluido' ? 'incluido' : 'descargado';
      return { installed, source };
    },
    async install() {
      const r = await runBrowserInstall(runnerBase(paths, host));
      return r.ok;
    },
  };
}

export function runnerBase(
  paths: PlaywrightPaths,
  host: ProcessHost,
): Omit<CodegenRunnerOptions, 'pollIntervalMs' | 'killTimeoutMs'> {
  const browsersPath = paths.browsersPath ?? defaultCacheDir();
  return {
    host,
    nodeExecutable: process.execPath,
    cliPath: paths.cliPath,
    browsersPath,
    electronRunAsNode: true,
    baseEnv: process.env,
  };
}

export function createProcessHost(): ProcessHost {
  return {
    spawn: (command, args, options) => spawn(command, [...args], options),
    platform: process.platform,
    killTree: (pid) =>
      new Promise<void>((resolve) => {
        const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          shell: false,
        });
        k.once('exit', () => resolve());
        k.once('error', () => resolve());
      }),
  };
}

export function createCodegenFactory(paths: PlaywrightPaths, host: ProcessHost) {
  return (outputFile: string, onCode: (code: string) => void): CodegenHandle => {
    const opts: CodegenRunnerOptions = runnerBase(paths, host);
    return new CodegenSession(opts, outputFile, onCode);
  };
}

/** Caché por defecto de Playwright (solo desarrollo, sin PLAYWRIGHT_BROWSERS_PATH). */
function defaultCacheDir(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'ms-playwright');
  if (process.platform === 'darwin') return join(app.getPath('home'), 'Library', 'Caches', 'ms-playwright');
  return join(app.getPath('home'), '.cache', 'ms-playwright');
}

/** Chromium visible para el login interactivo. No graba acciones ni guarda nada hasta `storageState()`. */
export function createLoginBrowser(): LoginBrowser {
  let browser: PwBrowser | null = null;
  let context: PwContext | null = null;
  const closedCallbacks: (() => void)[] = [];
  return {
    async open(url) {
      browser = await chromium().launch({
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ],
      });
      browser.on('disconnected', () => closedCallbacks.splice(0).forEach((cb) => cb()));
      context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    },
    async storageState() {
      if (!context) return null;
      return context.storageState();
    },
    async close() {
      const b = browser;
      browser = null;
      context = null;
      await b?.close().catch(() => undefined);
    },
    onClosed(cb) {
      closedCallbacks.push(cb);
    },
  };
}

/** Windows: restringe la ACL del directorio temporal al usuario actual (best-effort). */
export function restrictDirectoryToUser(dir: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const user = userInfo().username;
  return new Promise((resolve) => {
    const p = spawn('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    p.once('exit', () => resolve());
    p.once('error', () => resolve());
  });
}
