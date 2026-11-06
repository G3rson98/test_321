/**
 * Invocación de `playwright test` del CHECKOUT (misma versión exacta que el commit; ESP §4, §13.1) como proceso
 * hijo con canal IPC para el reporter de Katalyst. Detención: SIGINT (Playwright cierra navegadores y reporta
 * `interrupted`) y, tras la gracia, SIGKILL de todo el árbol (Chromium corre en su propio grupo de procesos).
 * RF-EJE-03, RNF-CON-03, ESP §13.3 (árbol detenido < 30 s).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeLogText } from '../logger.js';
import type { ReporterMessage } from '../reporter/protocol.js';
import { killTree } from '../util/process-tree.js';

export interface PlaywrightInstall {
  cliPath: string;
  version: string;
  chromiumVersion: string | null;
}

/** Resuelve `@playwright/test` desde el checkout (no desde el runner): evita dos instancias del paquete. */
export function resolvePlaywright(testsDir: string): PlaywrightInstall | null {
  try {
    const req = createRequire(path.join(testsDir, 'package.json'));
    const pkgPath = req.resolve('@playwright/test/package.json');
    const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
    const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
    let chromiumVersion: string | null = null;
    try {
      const req2 = createRequire(pkgPath);
      const pwPkg = req2.resolve('playwright/package.json');
      const corePkg = createRequire(pwPkg).resolve('playwright-core/package.json');
      const browsers = JSON.parse(readFileSync(path.join(path.dirname(corePkg), 'browsers.json'), 'utf8')) as {
        browsers: Array<{ name: string; browserVersion?: string }>;
      };
      chromiumVersion = browsers.browsers.find((b) => b.name === 'chromium')?.browserVersion ?? null;
    } catch {
      chromiumVersion = null;
    }
    if (!existsSync(cliPath)) return null;
    return { cliPath, version, chromiumVersion };
  } catch {
    return null;
  }
}

/** Ruta del reporter compilado (dist/*.js) o fuente (src/*.ts en desarrollo). */
export function reporterModulePath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  return path.join(path.dirname(here), '..', 'reporter', `katalyst-reporter${ext}`);
}

export interface PlaywrightRunSpec {
  cliPath: string;
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Procesa mensajes del reporter EN ORDEN (se espera cada uno antes del siguiente). */
  onMessage: (msg: ReporterMessage) => Promise<void>;
  /** Salida cruda del proceso; se sanitiza antes de escribirse. */
  logFile?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface PlaywrightExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function isReporterMessage(m: unknown): m is ReporterMessage {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

export class PlaywrightProcess {
  private child: ChildProcess | null = null;
  private queue: Promise<void> = Promise.resolve();
  private log: WriteStream | null = null;
  exited!: Promise<PlaywrightExit>;

  constructor(private readonly spec: PlaywrightRunSpec) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const s = this.spec;
    if (s.logFile) this.log = createWriteStream(s.logFile, { flags: 'a', mode: 0o600 });
    const child = fork(s.cliPath, s.args, {
      cwd: s.cwd,
      env: s.env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      serialization: 'json',
    });
    this.child = child;
    child.on('message', (m) => {
      if (!isReporterMessage(m)) return;
      this.queue = this.queue.then(() => s.onMessage(m)).catch(() => undefined);
    });
    const pipeLines = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!stream) return;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = sanitizeLogText(buf.slice(0, i));
          buf = buf.slice(i + 1);
          this.log?.write(`${line}\n`);
          s.onLine?.(line, name);
        }
        if (buf.length > 64 * 1024) {
          const line = sanitizeLogText(buf);
          buf = '';
          this.log?.write(`${line}\n`);
        }
      });
    };
    pipeLines(child.stdout, 'stdout');
    pipeLines(child.stderr, 'stderr');
    this.exited = new Promise<PlaywrightExit>((resolve) => {
      child.on('exit', (code, signal) => {
        // Drenar los mensajes ya recibidos antes de declarar el fin.
        void this.queue.then(() => {
          this.log?.end();
          resolve({ code, signal });
        });
      });
      child.on('error', () => {
        this.log?.end();
        resolve({ code: null, signal: null });
      });
    });
  }

  /** Detiene Playwright: SIGINT → espera `graceMs` → SIGKILL del árbol. */
  async stop(graceMs: number): Promise<number[]> {
    const pid = this.child?.pid;
    if (!pid || this.child?.exitCode !== null) return [];
    return killTree(pid, {
      signal: 'SIGINT',
      graceMs,
      processGroup: false,
      signalDescendants: false,
      exited: this.exited,
    });
  }
}
