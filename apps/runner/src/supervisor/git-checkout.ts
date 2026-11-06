/**
 * Checkout del commit SHA EXACTO del repositorio de tests (ESP §13.1): "Si el commit ya no puede obtenerse,
 * interrumpir con causa; no sustituirlo por la última rama". El commit debe pertenecer a la rama protegida
 * (aprobación = merge protegido). Cache en `/data/runner/checkouts/<sha>` (touch al usar; limpieza por mtime).
 * Credencial de Git por variables de entorno del proceso git (`http.extraHeader`), nunca en argumentos/URL.
 * La revalidación del hash del manifiesto la hace el llamador (`verifyManifestHash`).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitCommitShaSchema } from '@katalyst/shared';
import type { Logger } from '../logger.js';
import { pathExists, readJsonFile, rmrf, touch, writeFileAtomic } from '../util/fs.js';

export interface CheckoutResult {
  root: string;
  testsSubdir: string;
  testsDir: string;
  commit: string;
  commitVerified: boolean;
}

export interface GitCheckout {
  prepare(commit: string, signal?: AbortSignal): Promise<CheckoutResult>;
}

export class CommitNotAvailableError extends Error {
  readonly reason = 'commit_no_disponible' as const;
  constructor() {
    super('El commit asignado no puede obtenerse del repositorio de tests');
    this.name = 'CommitNotAvailableError';
  }
}

export class CommitNotAllowedError extends Error {
  readonly reason = 'test_no_aprobado' as const;
  constructor(branch: string) {
    super(`El commit asignado no pertenece a la rama protegida ${branch}`);
    this.name = 'CommitNotAllowedError';
  }
}

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export const CHECKOUT_MARKER = '.katalyst-checkout.json';

export interface CliGitCheckoutOptions {
  gitBin: string;
  repoUrl: string;
  protectedBranch: string;
  testsSubdir: string;
  checkoutsDir: string;
  timeoutMs: number;
  /** Token del repositorio (opcional); se resuelve en cada operación y no se persiste. */
  token?: () => Promise<string | null>;
  tokenUser?: string;
  logger: Logger;
}

interface GitRunResult {
  code: number;
  stdout: string;
}

export class CliGitCheckout implements GitCheckout {
  private readonly inProgress = new Map<string, Promise<CheckoutResult>>();

  constructor(private readonly o: CliGitCheckoutOptions) {}

  private async gitEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: os.tmpdir(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_ASKPASS: 'true',
      LANG: 'C',
    };
    const token = await this.o.token?.();
    if (token) {
      const basic = Buffer.from(`${this.o.tokenUser ?? 'x-access-token'}:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }

  private git(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.o.gitBin,
        args,
        { cwd, env, timeout: this.o.timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
        (err, stdout) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR') return reject(new CheckoutError('checkout abortado'));
          if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(new CheckoutError('git no pudo ejecutarse'));
          resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout: String(stdout) });
        },
      );
    });
  }

  private async mustGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, what: string, signal?: AbortSignal): Promise<string> {
    const r = await this.git(args, cwd, env, signal);
    if (r.code !== 0) throw new CheckoutError(`git: falló ${what}`);
    return r.stdout;
  }

  prepare(commit: string, signal?: AbortSignal): Promise<CheckoutResult> {
    if (!GitCommitShaSchema.safeParse(commit).success) return Promise.reject(new CheckoutError('SHA de commit inválido'));
    const existing = this.inProgress.get(commit);
    if (existing) return existing;
    const p = this.doPrepare(commit, signal).finally(() => this.inProgress.delete(commit));
    this.inProgress.set(commit, p);
    return p;
  }

  private result(root: string, commit: string): CheckoutResult {
    const testsDir = this.o.testsSubdir ? path.join(root, this.o.testsSubdir) : root;
    return { root, testsSubdir: this.o.testsSubdir, testsDir, commit, commitVerified: true };
  }

  private async doPrepare(commit: string, signal?: AbortSignal): Promise<CheckoutResult> {
    const final = path.join(this.o.checkoutsDir, commit);
    const marker = path.join(final, CHECKOUT_MARKER);
    if (await pathExists(marker)) {
      const m = await readJsonFile<{ commit?: string }>(marker).catch(() => null);
      if (m?.commit === commit) {
        await touch(final);
        return this.result(final, commit);
      }
      await rmrf(final);
    }
    await fs.mkdir(this.o.checkoutsDir, { recursive: true, mode: 0o750 });
    const tmp = path.join(this.o.checkoutsDir, `.tmp-${commit.slice(0, 12)}-${randomBytes(4).toString('hex')}`);
    const env = await this.gitEnv();
    const branch = this.o.protectedBranch;
    try {
      await fs.mkdir(tmp, { recursive: true, mode: 0o750 });
      await this.mustGit(['init', '--quiet', '.'], tmp, env, 'init', signal);
      await this.mustGit(['remote', 'add', 'origin', this.o.repoUrl], tmp, env, 'remote add', signal);
      const fetchBranch = await this.git(
        ['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        tmp,
        env,
        signal,
      );
      if (fetchBranch.code !== 0) throw new CheckoutError('no se pudo obtener la rama protegida del repositorio de tests');
      const has = async () => (await this.git(['cat-file', '-e', `${commit}^{commit}`], tmp, env, signal)).code === 0;
      if (!(await has())) {
        await this.git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', commit], tmp, env, signal);
        if (!(await has())) throw new CommitNotAvailableError();
      }
      const ancestor = await this.git(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`], tmp, env, signal);
      if (ancestor.code === 1) throw new CommitNotAllowedError(branch);
      if (ancestor.code !== 0) throw new CheckoutError('no se pudo verificar la ascendencia del commit');
      await this.mustGit(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], tmp, env, 'checkout', signal);
      const head = (await this.mustGit(['rev-parse', 'HEAD'], tmp, env, 'rev-parse', signal)).trim();
      if (head !== commit) throw new CheckoutError('HEAD no coincide con el commit asignado');
      await rmrf(path.join(tmp, '.git'));
      if (this.o.testsSubdir && !(await pathExists(path.join(tmp, this.o.testsSubdir)))) {
        throw new CheckoutError('el subdirectorio de tests no existe en el commit');
      }
      await writeFileAtomic(path.join(tmp, CHECKOUT_MARKER), JSON.stringify({ commit, at: new Date().toISOString() }), 0o644);
      try {
        await fs.rename(tmp, final);
      } catch {
        // Otra preparación concurrente ganó la carrera: se usa la existente.
        await rmrf(tmp);
      }
      this.o.logger.info({ commit }, 'checkout preparado');
      return this.result(final, commit);
    } catch (e) {
      await rmrf(tmp);
      throw e;
    }
  }
}

/**
 * Solo desarrollo (`KATALYST_CHECKOUT_MODE=local-dir`): usa un directorio local (p. ej. `qa-tests` del monorepo).
 * El commit NO puede verificarse (`commitVerified=false`); el hash del manifiesto sí se revalida.
 */
export class LocalDirCheckout implements GitCheckout {
  constructor(private readonly dir: string, private readonly logger: Logger) {}
  async prepare(commit: string): Promise<CheckoutResult> {
    if (!GitCommitShaSchema.safeParse(commit).success) throw new CheckoutError('SHA de commit inválido');
    const root = path.resolve(this.dir);
    if (!(await pathExists(root))) throw new CommitNotAvailableError();
    this.logger.warn({ commit }, 'checkout local-dir: el commit no se verifica (solo desarrollo)');
    return { root, testsSubdir: '', testsDir: root, commit, commitVerified: false };
  }
}
