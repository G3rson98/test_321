/**
 * Listado de catálogo aislado (RF-CAT-01, ESP §4): `playwright test --list --reporter=json` REAL sobre el proyecto
 * de fixtures, sin secretos, con launcher `process`; envía manifiesto + listado a la API (credencial de servicio).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { flattenPlaywrightList } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { CatalogProcessor, MAX_LISTING_BYTES } from '../src/supervisor/catalog-processor.js';
import { IsolatedDependencyInstaller } from '../src/supervisor/dependency-installer.js';
import { CommitNotAvailableError, LocalDirCheckout, type GitCheckout } from '../src/supervisor/git-checkout.js';
import { ProcessExecutorLauncher } from '../src/supervisor/launcher/process-launcher.js';
import type { CatalogListingRequest, SupervisorApiClient } from '../src/worker-api/types.js';
import { silentLogger } from './helpers/logger.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'pw-project');

function deps(checkout: GitCheckout, posted: CatalogListingRequest[], workDir: string) {
  const launcher = new ProcessExecutorLauncher({ logger: silentLogger() });
  const api: SupervisorApiClient = {
    claim: async () => {
      throw new Error('no');
    },
    postCatalogListing: async (r) => {
      posted.push(r);
      return { ok: true, status: 'recibido' };
    },
  };
  return new CatalogProcessor({
    api,
    checkout,
    installer: new IsolatedDependencyInstaller({ launcher, mode: 'never', workDir, timeoutMs: 60_000, logger: silentLogger() }),
    launcher,
    workDir,
    timeoutMs: 60_000,
    logger: silentLogger(),
  });
}

describe('CatalogProcessor (RF-CAT-01)', () => {
  it('lista con Playwright real y envía manifiesto + listado', async () => {
    const posted: CatalogListingRequest[] = [];
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kcat-'));
    const revision = randomUUID();
    const commit = 'e'.repeat(40);
    await deps(new LocalDirCheckout(FIXTURE, silentLogger()), posted, workDir).process({ catalogRevisionId: revision, gitCommit: commit });
    expect(posted).toHaveLength(1);
    const [p] = posted as [CatalogListingRequest];
    expect(p).toMatchObject({ catalogRevisionId: revision, gitCommit: commit, error: null });
    expect((p.manifest as { tests: unknown[] }).tests).toHaveLength(7);
    const specs = flattenPlaywrightList(p.playwrightList);
    expect(specs.map((s) => s.title)).toEqual(expect.arrayContaining(['C1 Panel visible @humo', 'C6 Lento @lento']));
    expect(await fs.readdir(workDir)).toEqual([]);
  }, 60_000);

  it('commit no disponible ⇒ se informa el error sin listar', async () => {
    const posted: CatalogListingRequest[] = [];
    const checkout: GitCheckout = { prepare: async () => { throw new CommitNotAvailableError(); } };
    await deps(checkout, posted, await fs.mkdtemp(path.join(os.tmpdir(), 'kcat-'))).process({ catalogRevisionId: randomUUID(), gitCommit: 'f'.repeat(40) });
    expect(posted[0]).toMatchObject({ manifest: null, playwrightList: null, error: expect.stringContaining('commit_no_disponible') });
  });

  it('cuerpo > 16 MiB (MAX_LISTING_BYTES de la API) ⇒ error listado_demasiado_grande sin manifiesto ni listado', async () => {
    const posted: CatalogListingRequest[] = [];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kcat-big-'));
    await fs.writeFile(path.join(dir, 'katalyst.manifest.json'), JSON.stringify({ schemaVersion: 1, tests: [], pad: 'x'.repeat(MAX_LISTING_BYTES + 1) }));
    const checkout: GitCheckout = { prepare: async (commit) => ({ root: dir, testsSubdir: '', testsDir: dir, commit, commitVerified: false }) };
    await deps(checkout, posted, await fs.mkdtemp(path.join(os.tmpdir(), 'kcat-'))).process({ catalogRevisionId: randomUUID(), gitCommit: 'a'.repeat(40) });
    expect(posted).toEqual([expect.objectContaining({ manifest: null, playwrightList: null, error: 'listado_demasiado_grande' })]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
