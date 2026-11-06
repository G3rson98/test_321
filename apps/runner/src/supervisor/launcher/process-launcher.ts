/**
 * Launcher `process` (SOLO desarrollo local sin Docker): el ejecutor corre como proceso hijo líder de su grupo,
 * con directorio temporal propio (`<shardDir>/{state,home,tmp}`), entorno MÍNIMO construido desde cero (no hereda
 * credenciales del supervisor) y sin argumentos sensibles. No aísla red ni sistema de archivos como el contenedor;
 * `loadSupervisorConfig` lo rechaza con NODE_ENV=production. Cancelación: SIGTERM al grupo, gracia y SIGKILL del
 * árbol completo (incluido Chromium, que es líder de su propio grupo). ESP §13.3, §13.7.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from '../../logger.js';
import { sanitizeLogText } from '../../logger.js';
import { ensureDir } from '../../util/fs.js';
import { commandOf, isAlive, killTree } from '../../util/process-tree.js';
import { raceTimeout, writeControlFile } from './common.js';
import type {
  ExecutorExit,
  ExecutorHandle,
  ExecutorLaunchSpec,
  ExecutorLauncher,
  IsolatedRunResult,
  IsolatedRunSpec,
  RunningExecutor,
  RuntimePaths,
} from './types.js';

export const PID_FILE = 'executor.pid';

export interface ProcessLauncherOptions {
  logger: Logger;
  /** Entrada del ejecutor: [ejecutable, ...args]. Por defecto dist/main.executor.js o src/ con tsx. */
  entry?: { command: string; args: string[] };
  /** Navegadores de Playwright (el HOME del hijo es temporal). */
  browsersPath?: string;
  extraEnv?: Record<string, string>;
}

/** Ruta por defecto de navegadores de Playwright según la plataforma del HOME real del supervisor. */
export function defaultBrowsersPath(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? home, 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
}

/** Entrada del ejecutor junto a este módulo: `.js` compilado o `.ts` con el loader de tsx (desarrollo). */
export function defaultExecutorEntry(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const entry = path.join(path.dirname(here), '..', '..', `main.executor${ext}`);
  if (ext === '.ts') {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    return { command: process.execPath, args: ['--conditions=source', '--import', tsx, entry] };
  }
  return { command: process.execPath, args: [entry] };
}

function minimalPath(): string {
  return [path.dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(path.delimiter);
}

export class ProcessExecutorLauncher implements ExecutorLauncher {
  readonly kind = 'process' as const;
  constructor(private readonly o: ProcessLauncherOptions) {}

  async launch(spec: ExecutorLaunchSpec): Promise<ExecutorHandle> {
    const stateDir = path.join(spec.shardDir, 'state');
    const home = path.join(spec.shardDir, 'home');
    const tmp = path.join(spec.shardDir, 'tmp');
    for (const d of [stateDir, home, tmp, spec.outputDir]) await ensureDir(d);
    const testsDir = spec.testsSubdir ? path.join(spec.checkoutRoot, spec.testsSubdir) : spec.checkoutRoot;
    const env: NodeJS.ProcessEnv = {
      PATH: minimalPath(),
      HOME: home,
      TMPDIR: tmp,
      TZ: 'UTC',
      NODE_ENV: 'development',
      LOG_LEVEL: spec.logLevel,
      KATALYST_WORKER_API_URL: spec.workerApiUrl,
      KATALYST_SECRETS_DIR: spec.secretsDir,
      KATALYST_STATE_DIR: stateDir,
      KATALYST_TESTS_DIR: testsDir,
      KATALYST_OUTPUT_DIR: spec.outputDir,
      PLAYWRIGHT_BROWSERS_PATH: this.o.browsersPath ?? defaultBrowsersPath(),
      ...(spec.image?.image ? { KATALYST_IMAGE: spec.image.image } : {}),
      ...(this.o.extraEnv ?? {}),
    };
    const entry = this.o.entry ?? defaultExecutorEntry();
    const child = spawn(entry.command, entry.args, {
      cwd: spec.shardDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    if (!pid) throw new Error('no se pudo iniciar el proceso ejecutor');
    await fs.writeFile(path.join(spec.shardDir, PID_FILE), String(pid), { mode: 0o600 });
    const listeners: Array<(line: string) => void> = [];
    const pipe = (s: NodeJS.ReadableStream | null) => {
      if (!s) return;
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = sanitizeLogText(buf.slice(0, i));
          buf = buf.slice(i + 1);
          for (const l of listeners) l(line);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    const exited = new Promise<ExecutorExit>((resolve) => {
      child.on('exit', (code, signal) => resolve({ exitCode: code, signal }));
      child.on('error', () => resolve({ exitCode: null, signal: null }));
    });
    this.o.logger.info({ runId: spec.runId, shardId: spec.shardId, pid }, 'proceso ejecutor iniciado');
    return {
      id: `pid:${pid}`,
      runId: spec.runId,
      shardId: spec.shardId,
      exited,
      onLog: (l) => listeners.push(l),
      stop: async (reason, graceMs) => {
        await writeControlFile(spec.secretsDir, reason);
        if (child.exitCode !== null || child.signalCode !== null) return;
        await killTree(pid, { signal: 'SIGTERM', graceMs, processGroup: true, signalDescendants: false, exited });
        await raceTimeout(exited, 2_000);
      },
    };
  }

  async runIsolated(spec: IsolatedRunSpec): Promise<IsolatedRunResult> {
    await ensureDir(spec.outputDir);
    const home = path.join(spec.outputDir, 'home');
    await ensureDir(home);
    const rt: RuntimePaths = {
      node: process.execPath,
      root: spec.checkoutRoot,
      testsDir: spec.testsSubdir ? path.join(spec.checkoutRoot, spec.testsSubdir) : spec.checkoutRoot,
      outDir: spec.outputDir,
    };
    const [cmd, ...args] = spec.command(rt);
    if (!cmd) throw new Error('comando vacío');
    const child = spawn(cmd, args, {
      cwd: spec.cwd === 'root' ? rt.root : rt.testsDir,
      env: {
        PATH: minimalPath(),
        HOME: home,
        TZ: 'UTC',
        CI: '1',
        PLAYWRIGHT_BROWSERS_PATH: this.o.browsersPath ?? defaultBrowsersPath(),
        ...spec.env(rt),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let tail = '';
    const keep = (c: Buffer) => {
      tail = (tail + c.toString('utf8')).slice(-8192);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });
    const kill = () => {
      if (child.pid) void killTree(child.pid, { signal: 'SIGKILL', graceMs: 0, processGroup: true });
    };
    spec.signal?.addEventListener('abort', kill, { once: true });
    const r = await raceTimeout(exited, spec.timeoutMs);
    spec.signal?.removeEventListener('abort', kill);
    if (r === 'timeout') {
      kill();
      return { exitCode: null, timedOut: true, outputTail: sanitizeLogText(tail) };
    }
    return { exitCode: r, timedOut: false, outputTail: sanitizeLogText(tail) };
  }

  /** Procesos ejecutores de una instancia anterior (por `executor.pid` en cada shardDir). */
  async listExecutorsIn(shardsDir: string): Promise<RunningExecutor[]> {
    const out: RunningExecutor[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(shardsDir);
    } catch {
      return out;
    }
    for (const shardId of entries) {
      try {
        const pid = Number((await fs.readFile(path.join(shardsDir, shardId, PID_FILE), 'utf8')).trim());
        if (Number.isInteger(pid) && pid > 1) out.push({ id: `pid:${pid}`, runId: '', shardId, running: isAlive(pid) });
      } catch {
        // sin pid
      }
    }
    return out;
  }

  private shardsDir: string | null = null;
  setShardsDir(dir: string): void {
    this.shardsDir = dir;
  }

  async listExecutors(): Promise<RunningExecutor[]> {
    return this.shardsDir ? this.listExecutorsIn(this.shardsDir) : [];
  }

  /** Un proceso de una instancia anterior no puede retomarse (sin stdio): se elimina. */
  adopt(): ExecutorHandle | null {
    return null;
  }

  async destroy(e: RunningExecutor): Promise<void> {
    const pid = Number(e.id.replace(/^pid:/, ''));
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return;
    // PID reutilizado por otro proceso: nunca se toca.
    if (!(await commandOf(pid))?.includes('main.executor')) return;
    await killTree(pid, { signal: 'SIGKILL', graceMs: 0, processGroup: true });
  }
}
