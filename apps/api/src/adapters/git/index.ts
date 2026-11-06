/**
 * Lectura del repositorio de tests aprobado (RF-CAT-01, ESP §9 "el cliente no puede proporcionar comandos, rutas o
 * refs Git arbitrarios", §13.1 "resolver desde un único manifiesto de la rama protegida").
 * `GitRepoReader.resolveProtectedCommit()` devuelve el SHA COMPLETO de la punta de `GIT_PROTECTED_BRANCH`; la rama la
 * fija la configuración del servidor. Adaptadores: GitHub, GitLab (plataforma pendiente ESP §12) y `local` (repositorio
 * bare de desarrollo, leído desde el sistema de archivos sin ejecutar `git`). La API NUNCA lee ni ejecuta el código de
 * tests: el listado lo hace el runner aislado sobre este commit.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCommitShaSchema, KatalystError } from '@katalyst/shared';
import type { Config } from '../../config.js';
import { HttpGuard } from '../../lib/http-guard.js';
import type { SecretProvider } from '../../lib/secrets.js';

export interface GitRepoReader {
  readonly provider: 'github' | 'gitlab' | 'local';
  readonly branch: string;
  resolveProtectedCommit(): Promise<string>;
}

const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

function assertSha(sha: unknown): string {
  const p = GitCommitShaSchema.safeParse(typeof sha === 'string' ? sha.trim().toLowerCase() : sha);
  if (!p.success) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE', 'La plataforma Git devolvió un commit inválido.');
  return p.data;
}

/** Repositorio bare local (`GIT_PROVIDER=local`, solo desarrollo): `refs/heads/<rama>` o `packed-refs`. */
export class LocalGitRepoReader implements GitRepoReader {
  readonly provider = 'local' as const;
  constructor(
    private readonly repoPath: string,
    readonly branch: string,
  ) {
    if (!BRANCH_RE.test(branch)) throw new Error('Rama protegida inválida');
  }
  async resolveProtectedCommit(): Promise<string> {
    try {
      return assertSha(await readFile(join(this.repoPath, 'refs', 'heads', ...this.branch.split('/')), 'utf8'));
    } catch (e) {
      if (e instanceof KatalystError) throw e;
    }
    try {
      const packed = await readFile(join(this.repoPath, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` refs/heads/${this.branch}`));
      if (line) return assertSha(line.split(' ')[0]);
    } catch {
      // sin packed-refs
    }
    throw new KatalystError('COMMIT_UNAVAILABLE', 'La rama protegida no existe en el repositorio local.');
  }
}

export class GitHubRepoReader implements GitRepoReader {
  readonly provider = 'github' as const;
  constructor(
    private readonly o: { apiBaseUrl: string; repository: string; branch: string; token: () => Promise<string | null>; http: HttpGuard },
  ) {
    if (!BRANCH_RE.test(o.branch) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repository)) throw new Error('Repositorio/rama inválidos');
  }
  get branch(): string {
    return this.o.branch;
  }
  async resolveProtectedCommit(): Promise<string> {
    const token = await this.o.token();
    const url = `${this.o.apiBaseUrl.replace(/\/+$/, '')}/repos/${this.o.repository}/commits/${encodeURIComponent(this.o.branch)}`;
    const res = await this.o.http
      .request(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeoutMs: 15_000,
      })
      .catch(() => {
        throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
      });
    if (res.status === 404 || res.status === 422) throw new KatalystError('COMMIT_UNAVAILABLE');
    if (res.status !== 200) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
    return assertSha(res.json<{ sha?: string }>().sha);
  }
}

export class GitLabRepoReader implements GitRepoReader {
  readonly provider = 'gitlab' as const;
  constructor(
    private readonly o: { apiBaseUrl: string; repository: string; branch: string; token: () => Promise<string | null>; http: HttpGuard },
  ) {
    if (!BRANCH_RE.test(o.branch)) throw new Error('Rama protegida inválida');
  }
  get branch(): string {
    return this.o.branch;
  }
  async resolveProtectedCommit(): Promise<string> {
    const token = await this.o.token();
    const project = encodeURIComponent(this.o.repository);
    const url = `${this.o.apiBaseUrl.replace(/\/+$/, '')}/projects/${project}/repository/branches/${encodeURIComponent(this.o.branch)}`;
    const res = await this.o.http
      .request(url, { headers: { accept: 'application/json', ...(token ? { 'private-token': token } : {}) }, timeoutMs: 15_000 })
      .catch(() => {
        throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
      });
    if (res.status === 404) throw new KatalystError('COMMIT_UNAVAILABLE');
    if (res.status !== 200) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
    const b = res.json<{ commit?: { id?: string }; protected?: boolean }>();
    if (b.protected === false) throw new KatalystError('COMMIT_UNAVAILABLE', 'La rama configurada no está protegida.');
    return assertSha(b.commit?.id);
  }
}

let override: GitRepoReader | null | undefined;
/** Pruebas: reemplaza el lector (`null` = sin proveedor). */
export function setGitRepoReader(r: GitRepoReader | null | undefined): void {
  override = r;
}

export function getGitRepoReader(config: Config, secrets: SecretProvider): GitRepoReader | null {
  if (override !== undefined) return override;
  const token = async () => (config.GIT_TOKEN_REF ? secrets.get(config.GIT_TOKEN_REF) : null);
  const host = (u: string) => new URL(u).hostname;
  switch (config.GIT_PROVIDER) {
    case 'local':
      return config.GIT_LOCAL_REPO_PATH ? new LocalGitRepoReader(config.GIT_LOCAL_REPO_PATH, config.GIT_PROTECTED_BRANCH) : null;
    case 'github': {
      const base = config.GIT_BASE_URL ?? 'https://api.github.com';
      if (!config.GIT_REPOSITORY) return null;
      return new GitHubRepoReader({
        apiBaseUrl: base,
        repository: config.GIT_REPOSITORY,
        branch: config.GIT_PROTECTED_BRANCH,
        token,
        http: new HttpGuard({ policy: { allowedHosts: [host(base)], allowedSchemes: ['https'] } }),
      });
    }
    case 'gitlab': {
      if (!config.GIT_BASE_URL || !config.GIT_REPOSITORY) return null;
      return new GitLabRepoReader({
        apiBaseUrl: config.GIT_BASE_URL,
        repository: config.GIT_REPOSITORY,
        branch: config.GIT_PROTECTED_BRANCH,
        token,
        http: new HttpGuard({ policy: { allowedHosts: [host(config.GIT_BASE_URL)], allowedSchemes: ['https'] } }),
      });
    }
    default:
      return null;
  }
}
