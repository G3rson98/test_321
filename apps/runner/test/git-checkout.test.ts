/**
 * Checkout del commit EXACTO (ESP §13.1): commit inexistente ⇒ interrumpir con causa, sin sustituir por la rama;
 * commit fuera de la rama protegida ⇒ no permitido; manifiesto revalidado por hash.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manifestHash, ManifestSchema } from '@katalyst/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyManifestHash } from '../src/manifest-check.js';
import { CHECKOUT_MARKER, CliGitCheckout, CommitNotAllowedError, CommitNotAvailableError } from '../src/supervisor/git-checkout.js';
import { pathExists } from '../src/util/fs.js';
import { silentLogger } from './helpers/logger.js';

const manifest = {
  schemaVersion: 1,
  tests: [
    {
      stableKey: '11111111-1111-4111-8111-111111111111',
      file: 'tests/a.spec.ts',
      title: 'C1 A @humo',
      cases: ['C1'],
      tags: ['@humo'],
      classification: 'lectura',
      parameterKeys: ['default'],
      writeIdempotencyApproved: false,
      owner: 'qa',
    },
  ],
};

let repo: string;
let mainSha: string;
let firstSha: string;
let featureSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.test', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.test' },
  })
    .toString()
    .trim();
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'krepo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'uploadpack.allowFilter', 'true');
  git(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await fs.mkdir(path.join(repo, 'qa-tests', 'tests'), { recursive: true });
  await fs.writeFile(path.join(repo, 'qa-tests', 'katalyst.manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(repo, 'qa-tests', 'tests', 'a.spec.ts'), '// v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'v1');
  firstSha = git(repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'qa-tests', 'tests', 'a.spec.ts'), '// v2\n');
  git(repo, 'commit', '-q', '-am', 'v2');
  mainSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature');
  await fs.writeFile(path.join(repo, 'qa-tests', 'tests', 'a.spec.ts'), '// sin aprobar\n');
  git(repo, 'commit', '-q', '-am', 'feature');
  featureSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
});

function checkout(dir: string) {
  return new CliGitCheckout({
    gitBin: 'git',
    repoUrl: `file://${repo}`,
    protectedBranch: 'main',
    testsSubdir: 'qa-tests',
    checkoutsDir: dir,
    timeoutMs: 60_000,
    logger: silentLogger(),
  });
}

describe('CliGitCheckout (ESP §13.1)', () => {
  it('prepara el commit exacto (no la punta de la rama), sin .git, con marcador y reutiliza la caché', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kco-'));
    const co = checkout(dir);
    const r = await co.prepare(firstSha);
    expect(r).toMatchObject({ commit: firstSha, commitVerified: true, testsSubdir: 'qa-tests', root: path.join(dir, firstSha) });
    expect(await fs.readFile(path.join(r.testsDir, 'tests', 'a.spec.ts'), 'utf8')).toBe('// v1\n');
    expect(await pathExists(path.join(r.root, '.git'))).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(r.root, CHECKOUT_MARKER), 'utf8')).commit).toBe(firstSha);
    const again = await co.prepare(firstSha);
    expect(again.root).toBe(r.root);
    const hash = manifestHash(ManifestSchema.parse(manifest));
    expect((await verifyManifestHash(r.testsDir, hash)).ok).toBe(true);
    expect(await verifyManifestHash(r.testsDir, 'f'.repeat(64))).toMatchObject({ ok: false, error: 'hash_no_coincide' });
    expect((await co.prepare(mainSha)).commit).toBe(mainSha);
  });

  it('commit inexistente ⇒ CommitNotAvailableError (no se sustituye por la rama)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kco-'));
    await expect(checkout(dir).prepare('0'.repeat(40))).rejects.toBeInstanceOf(CommitNotAvailableError);
    expect((await fs.readdir(dir)).filter((n) => !n.startsWith('.'))).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('commit fuera de la rama protegida ⇒ CommitNotAllowedError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kco-'));
    await expect(checkout(dir).prepare(featureSha)).rejects.toBeInstanceOf(CommitNotAllowedError);
  });

  it('SHA con formato inválido se rechaza sin invocar git', async () => {
    await expect(checkout(os.tmpdir()).prepare('main')).rejects.toThrow('SHA de commit inválido');
  });
});
