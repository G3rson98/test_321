/**
 * Fábrica del proveedor de PR según configuración (plataforma pendiente ESP §12: github | gitlab; `local` para
 * desarrollo). RF-GRB-02.
 */
import type { Config } from '../../config.js';
import { getSecretProvider, type SecretProvider } from '../../lib/secrets.js';
import { apiCSettings } from '../../modules/recordings/settings.js';
import { LocalGitPrProvider } from './local.js';
import { GitHubPrProvider, GitLabPrProvider } from './rest.js';
import type { GitPrProvider } from './types.js';

export * from './types.js';
export { LocalGitPrProvider } from './local.js';
export { GitHubPrProvider, GitLabPrProvider } from './rest.js';

let override: GitPrProvider | null | undefined;

/** Sustituye el proveedor (pruebas). `null` = deshabilitado. */
export function setGitPrProvider(p: GitPrProvider | null | undefined): void {
  override = p;
}

export function createGitPrProvider(config: Config, secrets: SecretProvider = getSecretProvider()): GitPrProvider | null {
  const s = apiCSettings();
  const kind = s.GIT_PR_PROVIDER ?? config.GIT_PROVIDER;
  if (kind === 'local') {
    return s.GIT_PR_LOCAL_REPO_PATH ? new LocalGitPrProvider(s.GIT_PR_LOCAL_REPO_PATH, config.GIT_PROTECTED_BRANCH) : null;
  }
  if (kind === 'none' || !config.GIT_REPOSITORY || !config.GIT_TOKEN_REF) return null;
  const tokenRef = config.GIT_TOKEN_REF;
  const token = () => secrets.get(tokenRef);
  if (kind === 'github') {
    return new GitHubPrProvider({
      baseUrl: config.GIT_BASE_URL ?? 'https://api.github.com',
      repository: config.GIT_REPOSITORY,
      token,
      protectedBranch: config.GIT_PROTECTED_BRANCH,
    });
  }
  return new GitLabPrProvider({
    baseUrl: config.GIT_BASE_URL ?? 'https://gitlab.com/api/v4',
    repository: config.GIT_REPOSITORY,
    token,
    protectedBranch: config.GIT_PROTECTED_BRANCH,
  });
}

export function getGitPrProvider(config: Config): GitPrProvider | null {
  if (override !== undefined) return override;
  return createGitPrProvider(config);
}
