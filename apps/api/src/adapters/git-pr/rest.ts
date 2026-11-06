/**
 * Adaptadores REST de GitHub (Git Data API + Pulls) y GitLab (Commits API + Merge Requests). Token por referencia
 * de secreto, enviado solo en encabezados; los errores no reflejan cuerpos ni URLs con credenciales.
 * Nunca se llama a endpoints de merge.
 * RF-GRB-02, RF-GRB-03, RF-GRB-04.
 */
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

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RestGitOptions {
  baseUrl: string;
  /** GitHub `owner/repo`; GitLab ruta del proyecto o ID numérico. */
  repository: string;
  /** Resuelve el token en el momento de uso (SecretProvider). */
  token: () => Promise<string>;
  protectedBranch?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

abstract class RestBase {
  protected readonly fetchFn: FetchLike;
  constructor(protected readonly opts: RestGitOptions) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }
  protected abstract authHeaders(token: string): Record<string, string>;

  protected async call(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/json',
  ): Promise<{ status: number; json: unknown; text: string }> {
    const token = await this.opts.token();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          accept,
          'user-agent': 'katalyst-qa-runner',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.authHeaders(token),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch {
      throw new GitProviderError('La plataforma Git no respondió');
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  protected ok<T>(r: { status: number; json: unknown }, what: string): T {
    if (r.status >= 200 && r.status < 300) return r.json as T;
    throw new GitProviderError(`${what}: la plataforma Git respondió ${r.status}`, r.status);
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export class GitHubPrProvider extends RestBase implements GitPrProvider {
  readonly kind = 'github' as const;
  protected authHeaders(token: string) {
    return { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  }
  private repo(): string {
    const [owner, name] = this.opts.repository.split('/');
    if (!owner || !name) throw new GitProviderError('Repositorio GitHub inválido');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }
  private encPath(p: string): string {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    assertSafeRef(ref);
    assertSafeRepoPath(path);
    const r = await this.call(
      'GET',
      `${this.repo()}/contents/${this.encPath(path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      'application/vnd.github.raw+json',
    );
    if (r.status === 404) return null;
    if (r.status >= 200 && r.status < 300) return r.text;
    throw new GitProviderError(`Lectura: la plataforma Git respondió ${r.status}`, r.status);
  }

  private async commitOn(parentSha: string, files: { path: string; content: string }[], message: string) {
    const parent = this.ok<{ tree: { sha: string } }>(
      await this.call('GET', `${this.repo()}/git/commits/${parentSha}`),
      'Commit base',
    );
    const tree = this.ok<{ sha: string }>(
      await this.call('POST', `${this.repo()}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      }),
      'Árbol',
    );
    return this.ok<{ sha: string }>(
      await this.call('POST', `${this.repo()}/git/commits`, { message, tree: tree.sha, parents: [parentSha] }),
      'Commit',
    ).sha;
  }

  async openChange(req: OpenChangeRequest): Promise<ChangeResult> {
    assertSafeRef(req.baseBranch);
    assertKatalystBranch(req.branch, this.opts.protectedBranch);
    req.files.forEach((f) => assertSafeRepoPath(f.path));
    const baseRef = this.ok<{ object: { sha: string } }>(
      await this.call('GET', `${this.repo()}/git/ref/heads/${this.encPath(req.baseBranch)}`),
      'Rama base',
    );
    const commit = await this.commitOn(baseRef.object.sha, req.files, req.commitMessage);
    const created = await this.call('POST', `${this.repo()}/git/refs`, { ref: `refs/heads/${req.branch}`, sha: commit });
    if (created.status === 422) {
      this.ok(
        await this.call('PATCH', `${this.repo()}/git/refs/heads/${this.encPath(req.branch)}`, { sha: commit, force: true }),
        'Actualizar rama',
      );
    } else this.ok(created, 'Crear rama');
    const pr = await this.call('POST', `${this.repo()}/pulls`, {
      title: req.title,
      head: req.branch,
      base: req.baseBranch,
      body: req.body,
      draft: req.draft,
      maintainer_can_modify: false,
    });
    if (pr.status === 422) {
      const owner = this.opts.repository.split('/')[0]!;
      const list = this.ok<{ html_url: string; number: number }[]>(
        await this.call(
          'GET',
          `${this.repo()}/pulls?state=open&head=${encodeURIComponent(`${owner}:${req.branch}`)}`,
        ),
        'Buscar PR',
      );
      const existing = list[0];
      if (!existing) throw new GitProviderError('No se pudo abrir el pull request', 422);
      return { branch: req.branch, commit, url: existing.html_url, number: existing.number };
    }
    const created2 = this.ok<{ html_url: string; number: number }>(pr, 'Pull request');
    return { branch: req.branch, commit, url: created2.html_url, number: created2.number };
  }

  async pushToBranch(req: PushRequest): Promise<{ commit: string }> {
    assertKatalystBranch(req.branch, this.opts.protectedBranch);
    req.files.forEach((f) => assertSafeRepoPath(f.path));
    const ref = this.ok<{ object: { sha: string } }>(
      await this.call('GET', `${this.repo()}/git/ref/heads/${this.encPath(req.branch)}`),
      'Rama',
    );
    const commit = await this.commitOn(ref.object.sha, req.files, req.commitMessage);
    this.ok(
      await this.call('PATCH', `${this.repo()}/git/refs/heads/${this.encPath(req.branch)}`, { sha: commit, force: false }),
      'Actualizar rama',
    );
    return { commit };
  }
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export class GitLabPrProvider extends RestBase implements GitPrProvider {
  readonly kind = 'gitlab' as const;
  protected authHeaders(token: string) {
    return { 'private-token': token };
  }
  private project(): string {
    return `/projects/${encodeURIComponent(this.opts.repository)}`;
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    assertSafeRef(ref);
    assertSafeRepoPath(path);
    const r = await this.call(
      'GET',
      `${this.project()}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      undefined,
      'text/plain',
    );
    if (r.status === 404) return null;
    if (r.status >= 200 && r.status < 300) return r.text;
    throw new GitProviderError(`Lectura: la plataforma Git respondió ${r.status}`, r.status);
  }

  private async actions(ref: string, files: { path: string; content: string }[]) {
    const out = [];
    for (const f of files) {
      assertSafeRepoPath(f.path);
      const exists = (await this.readFile(ref, f.path)) !== null;
      out.push({ action: exists ? 'update' : 'create', file_path: f.path, content: f.content });
    }
    return out;
  }

  async openChange(req: OpenChangeRequest): Promise<ChangeResult> {
    assertSafeRef(req.baseBranch);
    assertKatalystBranch(req.branch, this.opts.protectedBranch);
    const commit = this.ok<{ id: string }>(
      await this.call('POST', `${this.project()}/repository/commits`, {
        branch: req.branch,
        start_branch: req.baseBranch,
        commit_message: req.commitMessage,
        actions: await this.actions(req.baseBranch, req.files),
        force: true,
      }),
      'Commit',
    );
    const mr = await this.call('POST', `${this.project()}/merge_requests`, {
      source_branch: req.branch,
      target_branch: req.baseBranch,
      title: req.draft ? `Draft: ${req.title}` : req.title,
      description: req.body,
      remove_source_branch: true,
    });
    if (mr.status === 409) {
      const list = this.ok<{ web_url: string; iid: number }[]>(
        await this.call(
          'GET',
          `${this.project()}/merge_requests?state=opened&source_branch=${encodeURIComponent(req.branch)}`,
        ),
        'Buscar MR',
      );
      const existing = list[0];
      if (!existing) throw new GitProviderError('No se pudo abrir el merge request', 409);
      return { branch: req.branch, commit: commit.id, url: existing.web_url, number: existing.iid };
    }
    const created = this.ok<{ web_url: string; iid: number }>(mr, 'Merge request');
    return { branch: req.branch, commit: commit.id, url: created.web_url, number: created.iid };
  }

  async pushToBranch(req: PushRequest): Promise<{ commit: string }> {
    assertKatalystBranch(req.branch, this.opts.protectedBranch);
    const commit = this.ok<{ id: string }>(
      await this.call('POST', `${this.project()}/repository/commits`, {
        branch: req.branch,
        commit_message: req.commitMessage,
        actions: await this.actions(req.branch, req.files),
      }),
      'Commit',
    );
    return { commit: commit.id };
  }
}
