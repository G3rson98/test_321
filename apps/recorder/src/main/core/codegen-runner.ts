/**
 * Ejecución de `playwright codegen` (@playwright/test 1.65.0) en un proceso hijo (RF-GRB-01, RF-GRB-06):
 *   <node> <@playwright/test/cli.js> codegen --target=playwright-test --output <tmp>/recording.spec.ts
 *          --test-id-attribute data-testid --browser chromium [--load-storage <tmp>/state.json] <appUrl>
 * - `<node>` es el ejecutable de Electron con `ELECTRON_RUN_AS_NODE=1` (no se distribuye otro Node).
 * - El entorno del hijo es una lista blanca: sin `NODE_OPTIONS`, sin variables `KATALYST_*` ni credenciales.
 * - Ningún secreto va en argumentos (ESP §13.7): solo la RUTA del storageState, nunca su contenido; la URL se
 *   rechaza si incluye usuario/contraseña.
 * - La salida se lee por sondeo del archivo (codegen la reescribe cada ~250 ms mientras se graba).
 * - Detener: SIGTERM (Playwright cierra el navegador) con escalado a SIGKILL; en Windows `taskkill /T /F`.
 */
import { promises as fs } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export const PLAYWRIGHT_VERSION = '1.65.0';

export interface CodegenArgsInput {
  cliPath: string;
  outputFile: string;
  storageStatePath: string | null;
  url: string | null;
  testIdAttribute?: string;
}

export function buildCodegenArgs(input: CodegenArgsInput): string[] {
  const args = [
    input.cliPath,
    'codegen',
    '--target=playwright-test',
    '--output',
    input.outputFile,
    '--test-id-attribute',
    input.testIdAttribute ?? 'data-testid',
    '--browser',
    'chromium',
  ];
  if (input.storageStatePath) args.push('--load-storage', input.storageStatePath);
  if (input.url) {
    const u = new URL(input.url);
    if (u.username || u.password) throw new Error('La URL no puede contener credenciales');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL no soportada');
    args.push(u.toString());
  }
  return args;
}

export function buildInstallArgs(cliPath: string): string[] {
  return [cliPath, 'install', 'chromium', '--no-shell'];
}

/** Variables heredables al proceso de Playwright (lista blanca). */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { browsersPath: string; electronRunAsNode: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (base[k] !== undefined) env[k] = base[k];
  env.PLAYWRIGHT_BROWSERS_PATH = opts.browsersPath;
  env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  if (opts.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ProcessHost {
  spawn: SpawnFn;
  platform: NodeJS.Platform;
  /** Mata el árbol del proceso (Windows). */
  killTree?: (pid: number) => Promise<void>;
}

export interface CodegenRunnerOptions {
  host: ProcessHost;
  nodeExecutable: string;
  cliPath: string;
  browsersPath: string;
  electronRunAsNode: boolean;
  baseEnv: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  /** Tiempo de gracia antes de forzar el cierre. */
  killTimeoutMs?: number;
}

export type CodegenExit = { code: number | null; signal: NodeJS.Signals | null; stoppedByUser: boolean };

export class CodegenSession {
  private child: ChildProcess | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastContent = '';
  private stopRequested = false;
  private stderrTail = '';
  readonly exited: Promise<CodegenExit>;
  private resolveExit!: (e: CodegenExit) => void;

  constructor(
    private readonly opts: CodegenRunnerOptions,
    private readonly outputFile: string,
    private readonly onCode: (code: string) => void,
  ) {
    this.exited = new Promise((r) => {
      this.resolveExit = r;
    });
  }

  start(args: { storageStatePath: string | null; url: string | null }): void {
    const argv = buildCodegenArgs({
      cliPath: this.opts.cliPath,
      outputFile: this.outputFile,
      storageStatePath: args.storageStatePath,
      url: args.url,
    });
    const child = this.opts.host.spawn(this.opts.nodeExecutable, argv, {
      env: buildChildEnv(this.opts.baseEnv, {
        browsersPath: this.opts.browsersPath,
        electronRunAsNode: this.opts.electronRunAsNode,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: false,
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      // Se conserva solo un final corto para diagnóstico; nunca se registra (podría contener URLs).
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000);
    });
    child.once('error', () => this.finish(null, null));
    child.once('exit', (code, signal) => this.finish(code, signal));
    this.pollTimer = setInterval(() => void this.poll(), this.opts.pollIntervalMs ?? 750);
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Diagnóstico local (no se envía a la API). */
  get lastError(): string {
    return this.stderrTail;
  }

  async poll(): Promise<string | null> {
    let content: string;
    try {
      content = await fs.readFile(this.outputFile, 'utf8');
    } catch {
      return null;
    }
    if (content !== this.lastContent) {
      this.lastContent = content;
      this.onCode(content);
    }
    return content;
  }

  async stop(): Promise<CodegenExit> {
    this.stopRequested = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      if (this.opts.host.platform === 'win32' && this.opts.host.killTree) {
        await this.opts.host.killTree(child.pid).catch(() => child.kill());
      } else {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, this.opts.killTimeoutMs ?? 5000);
        await this.exited;
        clearTimeout(timer);
      }
    }
    return this.exited;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    void this.poll().finally(() => this.resolveExit({ code, signal, stoppedByUser: this.stopRequested }));
  }
}

/** Ejecuta `playwright install chromium --no-shell` hacia `browsersPath` (primer uso). */
export function runBrowserInstall(
  opts: Omit<CodegenRunnerOptions, 'pollIntervalMs' | 'killTimeoutMs'>,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = opts.host.spawn(opts.nodeExecutable, buildInstallArgs(opts.cliPath), {
      env: buildChildEnv(opts.baseEnv, { browsersPath: opts.browsersPath, electronRunAsNode: opts.electronRunAsNode }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let tail = '';
    child.stderr?.on('data', (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-2000);
    });
    child.once('error', () => resolve({ ok: false, tail }));
    child.once('exit', (code) => resolve({ ok: code === 0, tail }));
  });
}
