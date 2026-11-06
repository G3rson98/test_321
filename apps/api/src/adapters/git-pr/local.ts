/**
 * Adaptador `local` (desarrollo/pruebas): escribe ramas en un repositorio git local mediante un clon temporal y
 * `git push` al origen local. No ejecuta hooks ni código del repositorio (core.hooksPath=/dev/null). El "PR" es la
 * rama publicada; la rama protegida nunca se modifica.
 * RF-GRB-02, RF-GRB-05.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  assertKatalystBranch,
  assertSafeRef,
  assertSafeRepoPath,
  GitProviderError,
  type ChangeResult,
  type GitPrProvider,
  type OpenChangeRequest,
  type PushRequest,
} from './types.js';

const exec = promisify(execFile);
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Katalyst',
  GIT_AUTHOR_EMAIL: 'katalyst@localhost',
  GIT_COMMITTER_NAME: 'Katalyst',
  GIT_COMMITTER_EMAIL: 'katalyst@localhost',
};

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), ...GIT_ENV },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch {
    throw new GitProviderError('Operación git local fallida');
  }
}

export class LocalGitPrProvider implements GitPrProvider {
  readonly kind = 'local' as const;
  constructor(
    private readonly repoPath: string,
    private readonly protectedBranch = 'main',
  ) {}

  async readFile(ref: string, path: string): Promise<string | null> {
    assertSafeRef(ref);
    assertSafeRepoPath(path);
    try {
      return await git(['-C', this.repoPath, 'show', `${ref}:${path}`]);
    } catch {
      return null;
    }
  }

  private async withClone<T>(branch: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'katalyst-git-'));
    try {
      await git(['clone', '--quiet', '--no-hardlinks', '--branch', branch, this.repoPath, dir]);
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async writeFiles(dir: string, files: { path: string; content: string }[]): Promise<void> {
    for (const f of files) {
      assertSafeRepoPath(f.path);
      const target = join(dir, f.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, { mode: 0o644 });
      await git(['add', '--', f.path], dir);
    }
  }

  async openChange(req: OpenChangeRequest): Promise<ChangeResult> {
    assertSafeRef(req.baseBranch);
    assertKatalystBranch(req.branch, this.protectedBranch);
    return this.withClone(req.baseBranch, async (dir) => {
      await git(['checkout', '--quiet', '-B', req.branch], dir);
      await this.writeFiles(dir, req.files);
      await git(['commit', '--quiet', '--allow-empty', '-m', req.commitMessage], dir);
      await git(['push', '--quiet', '--force', 'origin', `${req.branch}:refs/heads/${req.branch}`], dir);
      const commit = (await git(['rev-parse', 'HEAD'], dir)).trim();
      return { branch: req.branch, commit, url: `local://${req.branch}`, number: null };
    });
  }

  async pushToBranch(req: PushRequest): Promise<{ commit: string }> {
    assertKatalystBranch(req.branch, this.protectedBranch);
    return this.withClone(req.branch, async (dir) => {
      await this.writeFiles(dir, req.files);
      await git(['commit', '--quiet', '--allow-empty', '-m', req.commitMessage], dir);
      await git(['push', '--quiet', 'origin', `${req.branch}:refs/heads/${req.branch}`], dir);
      return { commit: (await git(['rev-parse', 'HEAD'], dir)).trim() };
    });
  }
}
