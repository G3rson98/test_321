/**
 * Dependencias del checkout (ESP §4: "No instalar dependencias ni ejecutar código de tests dentro del backend";
 * deploy: instalación con la imagen del ejecutor, sin secretos). Si `@playwright/test` ya está en el checkout con la
 * versión congelada, no se instala nada. Si falta, se instala de forma aislada desde el lockfile del commit
 * (`--frozen-lockfile`/`npm ci`, `--ignore-scripts`). Versión distinta = error de infraestructura
 * (docs/infraestructura.md §5).
 */
import path from 'node:path';
import { resolvePlaywright } from '../executor/playwright-process.js';
import type { Logger } from '../logger.js';
import { pathExists } from '../util/fs.js';
import type { CheckoutResult } from './git-checkout.js';
import type { ExecutorLauncher } from './launcher/types.js';

export class DependencyError extends Error {
  readonly reason = 'dependencia_fallida' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

export interface DependencyInstaller {
  ensure(co: CheckoutResult, expectedPlaywrightVersion: string | null, signal?: AbortSignal): Promise<{ playwrightVersion: string }>;
}

export class IsolatedDependencyInstaller implements DependencyInstaller {
  private readonly locks = new Map<string, Promise<{ playwrightVersion: string }>>();

  constructor(
    private readonly o: {
      launcher: ExecutorLauncher;
      mode: 'auto' | 'never';
      workDir: string;
      timeoutMs: number;
      logger: Logger;
    },
  ) {}

  private check(co: CheckoutResult, expected: string | null): { playwrightVersion: string } | 'missing' {
    const pw = resolvePlaywright(co.testsDir);
    if (!pw) return 'missing';
    if (expected && pw.version !== expected) {
      throw new DependencyError(`@playwright/test ${pw.version} del commit no coincide con la versión congelada ${expected}`);
    }
    return { playwrightVersion: pw.version };
  }

  ensure(co: CheckoutResult, expected: string | null, signal?: AbortSignal): Promise<{ playwrightVersion: string }> {
    const key = co.root;
    const existing = this.locks.get(key);
    if (existing) return existing.then(() => this.ensureChecked(co, expected));
    const p = this.doEnsure(co, expected, signal).finally(() => this.locks.delete(key));
    this.locks.set(key, p);
    return p;
  }

  private ensureChecked(co: CheckoutResult, expected: string | null): { playwrightVersion: string } {
    const r = this.check(co, expected);
    if (r === 'missing') throw new DependencyError('@playwright/test no está instalado en el checkout');
    return r;
  }

  private async doEnsure(co: CheckoutResult, expected: string | null, signal?: AbortSignal): Promise<{ playwrightVersion: string }> {
    const first = this.check(co, expected);
    if (first !== 'missing') return first;
    if (this.o.mode === 'never') throw new DependencyError('@playwright/test no está instalado en el checkout');
    const lockAt = async (dir: string): Promise<'pnpm' | 'npm' | null> =>
      (await pathExists(path.join(dir, 'pnpm-lock.yaml'))) ? 'pnpm' : (await pathExists(path.join(dir, 'package-lock.json'))) ? 'npm' : null;
    const rootKind = await lockAt(co.root);
    const testsKind = rootKind ? null : await lockAt(co.testsDir);
    const kind = rootKind ?? testsKind;
    if (!kind) throw new DependencyError('El commit no tiene lockfile (pnpm-lock.yaml/package-lock.json): no se instala sin versiones fijadas');
    this.o.logger.info({ commit: co.commit, manager: kind }, 'instalando dependencias del checkout (aislado, sin secretos)');
    const r = await this.o.launcher.runIsolated({
      purpose: 'install',
      checkoutRoot: co.root,
      testsSubdir: co.testsSubdir,
      outputDir: path.join(this.o.workDir, `install-${co.commit.slice(0, 12)}`),
      command: (rt) =>
        kind === 'pnpm'
          ? ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false']
          : ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', `--prefix=${rootKind ? rt.root : rt.testsDir}`],
      env: () => ({ COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_update_notifier: 'false' }),
      network: 'egress',
      writableCheckout: true,
      cwd: rootKind ? 'root' : 'tests',
      timeoutMs: this.o.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (r.timedOut || r.exitCode !== 0) throw new DependencyError('La instalación aislada de dependencias del checkout falló');
    return this.ensureChecked(co, expected);
  }
}
