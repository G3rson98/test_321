/**
 * Fixtures sintéticos de API-C (rendimiento, alertas, grabación, IA, exportaciones). Sin datos reales ni secretos.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

export async function createEnvironment(
  prisma: PrismaClient,
  opts: { isProduction?: boolean; recordingAllowed?: boolean; name?: string } = {},
) {
  return prisma.environment.create({
    data: {
      name: opts.name ?? `staging-${randomUUID().slice(0, 8)}`,
      appUrl: 'https://staging.example.test',
      apiUrl: 'https://api.staging.example.test',
      isProduction: opts.isProduction ?? false,
      recordingAllowed: opts.recordingAllowed ?? !opts.isProduction,
      allowedHosts: [],
    },
  });
}

export async function createCase(
  prisma: PrismaClient,
  opts: { title?: string; steps?: unknown; expected?: string | null; archived?: boolean } = {},
) {
  const conn = await prisma.testRailConnection.create({
    data: { baseUrl: 'https://example.testrail.io', username: 'svc@example.test', secretRef: 'env:KATALYST_SECRET__TR' },
  });
  const project = await prisma.testRailProject.create({
    data: { connectionId: conn.id, externalId: randomInt(1, 1_000_000), name: 'Proyecto' },
  });
  const suite = await prisma.testRailSuite.create({
    data: { connectionId: conn.id, projectId: project.id, externalId: randomInt(1, 1_000_000), name: 'Suite' },
  });
  const section = await prisma.testRailSection.create({
    data: { connectionId: conn.id, suiteId: suite.id, trSectionId: randomInt(1, 1_000_000), name: 'Sección' },
  });
  return prisma.testRailCase.create({
    data: {
      connectionId: conn.id,
      trCaseId: randomInt(100_000, 9_000_000),
      sectionId: section.id,
      suiteId: suite.id,
      title: opts.title ?? 'Abrir Órdenes de carga',
      steps: (opts.steps ?? [{ content: 'Abrir /loadOrder', expected: 'Se ve la grilla' }]) as never,
      expected: opts.expected === undefined ? 'La grilla carga' : opts.expected,
      contentHash: 'a'.repeat(64),
      syncedAt: new Date(),
      archivedAt: opts.archived ? new Date() : null,
    },
  });
}

export async function createRun(
  prisma: PrismaClient,
  environmentId: string,
  opts: { status?: string; outcome?: string | null; scheduleId?: string | null; createdById?: string | null; trigger?: string } = {},
) {
  return prisma.run.create({
    data: {
      trigger: (opts.trigger ?? 'manual') as never,
      environmentId,
      status: (opts.status ?? 'terminada') as never,
      outcome: (opts.outcome === undefined ? 'pasado' : opts.outcome) as never,
      selectionSnapshot: {},
      manifestHash: 'b'.repeat(64),
      gitCommit: 'c'.repeat(40),
      scheduleId: opts.scheduleId ?? null,
      createdById: opts.createdById ?? null,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    },
  });
}

/** Repositorio git local con rama `main` y manifiesto vacío (adaptador `local`). */
export function createLocalRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'katalyst-repo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, env, stdio: 'pipe' });
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'katalyst.manifest.json'), `${JSON.stringify({ schemaVersion: 1, tests: [] }, null, 2)}\n`);
  git('add', '.');
  git('commit', '--quiet', '-m', 'init');
  return dir;
}

export function gitShow(repo: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${ref}:${path}`], { stdio: 'pipe' }).toString();
  } catch {
    return null;
  }
}

export function gitBranches(repo: string): string[] {
  return execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { stdio: 'pipe' })
    .toString()
    .split('\n')
    .filter(Boolean);
}

/** Muestra `samples.json` (schema_version 1) sintética. */
export function sample(over: Record<string, unknown> & { sample_key: string; ts: string }) {
  return {
    schema_version: 1,
    run_id: null,
    provenance: 'playwright',
    source: 'app',
    metric_kind: 'network_request',
    endpoint: 'api:/warehouse/api/warehouse/list/scheduling',
    method: 'GET',
    status_code: 200,
    ok: true,
    total_ms: 100,
    timeout: false,
    censored: false,
    over_29s: false,
    cache_mode: 'caliente',
    worker_profile: 'linux-2cpu',
    ...over,
  };
}

export function samplesFile(runId: string, samples: unknown[]) {
  return { schema_version: 1, kind: 'katalyst.perf_samples', run_id: runId, samples };
}
