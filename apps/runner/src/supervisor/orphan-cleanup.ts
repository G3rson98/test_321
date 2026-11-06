/**
 * Limpieza al arrancar, ANTES de aceptar trabajo nuevo (ESP §13.7: "Después de un crash, limpiar archivos
 * huérfanos antes de aceptar trabajo nuevo"; RF-AMB-03; RNF-SEG-01). Equivale a deploy/scripts/cleanup-runner-state.sh:
 * - ejecutores detenidos o no adoptables ⇒ se eliminan; ejecutores vivos (docker) ⇒ se retoman;
 * - `/run/katalyst/shards/<id>` (secretos, storageState) sin ejecutor vivo ⇒ se borran;
 * - `/data/runner/runs/<runId>/<shardId>` sin ejecutor vivo ⇒ se borran (evidencia cruda temporal);
 * - checkouts temporales a medio preparar (`.tmp-*`) y checkouts sin uso > N días ⇒ se borran.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { rmrf } from '../util/fs.js';
import type { ExecutorHandle, ExecutorLauncher } from './launcher/types.js';

export interface CleanupReport {
  adopted: ExecutorHandle[];
  destroyedExecutors: number;
  removedShardDirs: number;
  removedRunDirs: number;
  removedCheckouts: number;
}

export interface OrphanCleanupOptions {
  launcher: ExecutorLauncher;
  shardSecretsDir: string;
  runsDir: string;
  checkoutsDir: string;
  checkoutMaxAgeDays: number;
  /** Directorio de trabajo temporal (listados/instalaciones): se vacía completo. */
  workDir?: string;
  now?: () => number;
  logger: Logger;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export async function cleanupOrphans(o: OrphanCleanupOptions): Promise<CleanupReport> {
  const now = o.now ?? Date.now;
  const report: CleanupReport = { adopted: [], destroyedExecutors: 0, removedShardDirs: 0, removedRunDirs: 0, removedCheckouts: 0 };
  const liveShards = new Set<string>();
  for (const e of await o.launcher.listExecutors()) {
    const handle = e.running ? o.launcher.adopt(e, path.join(o.shardSecretsDir, e.shardId)) : null;
    if (handle) {
      report.adopted.push(handle);
      liveShards.add(e.shardId);
      continue;
    }
    try {
      await o.launcher.destroy(e);
      report.destroyedExecutors += 1;
    } catch {
      o.logger.warn({ executorId: e.id }, 'no se pudo eliminar un ejecutor huérfano');
    }
  }
  for (const shardId of await list(o.shardSecretsDir)) {
    if (liveShards.has(shardId)) continue;
    await rmrf(path.join(o.shardSecretsDir, shardId));
    report.removedShardDirs += 1;
  }
  for (const runId of await list(o.runsDir)) {
    const runDir = path.join(o.runsDir, runId);
    const shards = await list(runDir);
    let kept = 0;
    for (const shardId of shards) {
      if (liveShards.has(shardId)) {
        kept += 1;
        continue;
      }
      await rmrf(path.join(runDir, shardId));
      report.removedRunDirs += 1;
    }
    if (kept === 0) await rmrf(runDir);
  }
  if (o.workDir) await rmrf(o.workDir);
  const maxAgeMs = o.checkoutMaxAgeDays * 86_400_000;
  for (const name of await list(o.checkoutsDir)) {
    const p = path.join(o.checkoutsDir, name);
    if (name.startsWith('.tmp-') || name.startsWith('.install-')) {
      await rmrf(p);
      report.removedCheckouts += 1;
      continue;
    }
    try {
      const st = await fs.stat(p);
      if (st.isDirectory() && now() - st.mtimeMs > maxAgeMs) {
        await rmrf(p);
        report.removedCheckouts += 1;
      }
    } catch {
      // desapareció
    }
  }
  o.logger.info(
    {
      adopted: report.adopted.length,
      destroyedExecutors: report.destroyedExecutors,
      removedShardDirs: report.removedShardDirs,
      removedRunDirs: report.removedRunDirs,
      removedCheckouts: report.removedCheckouts,
    },
    'limpieza de huérfanos completada',
  );
  return report;
}
