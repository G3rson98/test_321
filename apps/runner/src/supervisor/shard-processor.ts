/**
 * Procesa un trabajo de la cola `run-shards` (payload SOLO `{runId, shardId}`; ESP §13.3, plan §4.3):
 * 1. reserva un permiso de navegador (concurrencia global, default 1: un contenedor = un worker de Playwright);
 * 2. `POST /worker/claim` con la credencial de servicio del supervisor → lease + leaseToken + asignación;
 * 3. heartbeat de preparación (el lease no vence durante checkout/instalación);
 * 4. checkout del commit exacto + revalidación del hash del manifiesto (ESP §13.1);
 * 5. secreto del usuario de prueba vía SecretProvider → `/run/katalyst/shards/<shardId>/secrets/test-user.json`
 *    0600 (nunca argv/env); en producción solo si el usuario es de solo lectura (RF-EJE-06, doble control);
 * 6. lanza el ejecutor (docker|process) y espera; cancelación por Redis pub/sub o heartbeat < 30 s;
 * 7. si el ejecutor no pudo cerrar el shard, `POST /worker/complete` de respaldo; borra secretos y temporales.
 * RF-AMB-03, RF-EJE-03, RF-EJE-08, RNF-CON-01, RNF-SEG-01, RNF-SEG-05.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ShardJobPayloadSchema, type ResultReason, type ShardJobPayload } from '@katalyst/shared';
import type { Clock } from '../clock.js';
import { OUTPUT_FILES, SHARD_FILES } from '../config.js';
import { HeartbeatLoop } from '../heartbeat.js';
import { addKnownSecret, type Logger } from '../logger.js';
import { verifyManifestHash } from '../manifest-check.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import { CompleteMarkerSchema, type LeaseFile } from '../shard-files.js';
import { assertSafeSegment, ensureDir, rmrf, writeSecretFile } from '../util/fs.js';
import type { Semaphore } from '../util/semaphore.js';
import { RUNNER_VERSION } from '../version.js';
import { errorCode, isLeaseLost, WorkerApiError } from '../worker-api/errors.js';
import type { RunnerClaimResponse, SupervisorApiClient, WorkerApiClient } from '../worker-api/types.js';
import type { CancelRegistry } from './cancel-registry.js';
import type { DependencyInstaller } from './dependency-installer.js';
import { CheckoutError, CommitNotAllowedError, CommitNotAvailableError, type GitCheckout } from './git-checkout.js';
import type { ExecutorLauncher } from './launcher/types.js';

export type ShardJobOutcome = 'not_claimable' | 'completed' | 'interrupted' | 'cancelled' | 'lease_lost';

export interface ShardProcessorDeps {
  supervisorId: string;
  workerApiUrl: string;
  shardSecretsDir: string;
  runsDir: string;
  logLevel: string;
  image?: { image: string | null; digest: string | null };
  api: SupervisorApiClient;
  createLeaseApi: (leaseToken: string) => WorkerApiClient;
  secrets: SecretProvider;
  checkout: GitCheckout;
  installer: DependencyInstaller;
  launcher: ExecutorLauncher;
  registry: CancelRegistry;
  semaphore: Semaphore;
  clock: Clock;
  logger: Logger;
}

class PrepAbort extends Error {
  constructor(readonly kind: 'cancel' | 'lease_lost') {
    super(kind);
  }
}

/** Valor del secreto: contraseña en texto o JSON `{password}`. */
function passwordFromSecret(value: string): string {
  const t = value.trim();
  if (t.startsWith('{')) {
    try {
      const p = (JSON.parse(t) as { password?: unknown }).password;
      if (typeof p === 'string' && p) return p;
    } catch {
      // no era JSON
    }
  }
  return value;
}

export class ShardProcessor {
  constructor(private readonly d: ShardProcessorDeps) {}

  async process(raw: unknown): Promise<ShardJobOutcome> {
    const payload: ShardJobPayload = ShardJobPayloadSchema.parse(raw);
    await this.d.semaphore.acquire();
    try {
      return await this.claimAndRun(payload);
    } finally {
      this.d.semaphore.release();
    }
  }

  private async claimAndRun(payload: ShardJobPayload): Promise<ShardJobOutcome> {
    const log = this.d.logger.child({ runId: payload.runId, shardId: payload.shardId });
    let claim: RunnerClaimResponse;
    try {
      claim = await this.d.api.claim({ ...payload, workerId: `${this.d.supervisorId}/${payload.shardId}`.slice(0, 200) });
    } catch (e) {
      if (e instanceof WorkerApiError && [404, 409, 410, 422].includes(e.status)) {
        // Entrega repetida (al menos una vez) o shard ya asignado/terminado: se confirma sin ejecutar.
        log.info({ errorCode: errorCode(e) }, 'shard no asignable: trabajo confirmado sin ejecutar');
        return 'not_claimable';
      }
      throw e;
    }
    if (claim.assignment.runId !== payload.runId || claim.assignment.shardId !== payload.shardId) {
      throw new Error('La asignación recibida no corresponde al trabajo');
    }
    addKnownSecret(claim.leaseToken);
    const leaseApi = this.d.createLeaseApi(claim.leaseToken);
    const entry = this.d.registry.register(payload.runId, payload.shardId, claim.leaseId);
    const shardDir = path.join(this.d.shardSecretsDir, assertSafeSegment(payload.shardId));
    const secretsDir = path.join(shardDir, 'secrets');
    const outputDir = path.join(this.d.runsDir, assertSafeSegment(payload.runId), payload.shardId);
    const fencing = { leaseId: claim.leaseId, generation: claim.generation };
    const prepHeartbeat = new HeartbeatLoop({
      api: leaseApi,
      ...fencing,
      clock: this.d.clock,
      intervalMs: claim.heartbeatIntervalMs,
      logger: log,
      onStop: (s) =>
        s.reason === 'cancel'
          ? entry.requestCancel(this.d.clock.now(), s.cancelDeadlineAt ? Date.parse(s.cancelDeadlineAt) : null)
          : entry.markLeaseLost(),
    });
    const elog = log.child({ leaseId: claim.leaseId });
    try {
      prepHeartbeat.start();
      const checkPrep = () => {
        if (entry.leaseLost || entry.shuttingDown) throw new PrepAbort('lease_lost');
        if (entry.cancelled) throw new PrepAbort('cancel');
      };
      let failure: ResultReason | null = null;
      let co: Awaited<ReturnType<GitCheckout['prepare']>> | null = null;
      try {
        checkPrep();
        co = await this.d.checkout.prepare(claim.assignment.gitCommit, entry.signal);
        checkPrep();
        const m = await verifyManifestHash(co.testsDir, claim.assignment.manifestHash);
        if (!m.ok) {
          elog.error({ error: m.error }, 'hash del manifiesto del commit no coincide con la asignación');
          failure = 'manifiesto_invalido';
        } else {
          await this.d.installer.ensure(co, claim.assignment.runtime.playwrightVersion || null, entry.signal);
          checkPrep();
        }
      } catch (e) {
        if (e instanceof PrepAbort) throw e;
        if (entry.cancelled) throw new PrepAbort('cancel');
        if (entry.leaseLost || entry.shuttingDown) throw new PrepAbort('lease_lost');
        if (e instanceof CommitNotAvailableError) failure = 'commit_no_disponible';
        else if (e instanceof CommitNotAllowedError) failure = 'test_no_aprobado';
        else if ((e as { reason?: unknown }).reason === 'dependencia_fallida') failure = 'dependencia_fallida';
        else if (e instanceof CheckoutError) failure = 'commit_no_disponible';
        else failure = 'error_interno';
        elog.error({ err: (e as Error).message, reason: failure }, 'preparación del shard fallida');
      }
      if (failure || !co) {
        await prepHeartbeat.stop();
        await this.completeFallback(leaseApi, fencing, 'interrumpido', failure ?? 'error_interno', elog);
        return 'interrupted';
      }

      await ensureDir(shardDir);
      await ensureDir(secretsDir);
      await this.writeSecrets(claim, secretsDir, co.commitVerified, elog);
      checkPrep();
      await ensureDir(outputDir);
      await prepHeartbeat.stop();
      if (entry.leaseLost) return 'lease_lost';

      const handle = await this.d.launcher.launch({
        runId: payload.runId,
        shardId: payload.shardId,
        leaseId: claim.leaseId,
        shardDir,
        secretsDir,
        checkoutRoot: co.root,
        testsSubdir: co.testsSubdir,
        outputDir,
        workerApiUrl: this.d.workerApiUrl,
        logLevel: this.d.logLevel,
        ...(this.d.image ? { image: this.d.image } : {}),
      });
      const xlog = elog.child({ executorId: handle.id.slice(0, 16) });
      handle.onLog((line) => xlog.info({ executorLog: line.slice(0, 4000) }, 'ejecutor'));
      entry.attach(handle);
      const exit = await handle.exited;
      await entry.stopPromise;
      entry.phase = 'finalizando';
      if (entry.cancelRequestedAt !== null) {
        xlog.info({ stopMs: this.d.clock.now() - entry.cancelRequestedAt }, 'ejecutor detenido tras cancelación');
      }
      xlog.info({ exitCode: exit.exitCode, signal: exit.signal }, 'ejecutor terminó');
      const marker = await this.readMarker(outputDir);
      if (exit.exitCode === 3 || exit.exitCode === 5 || entry.shuttingDown || entry.leaseLost) return 'lease_lost';
      if (!marker?.delivered) {
        const status = entry.cancelled ? 'cancelado' : 'interrumpido';
        await this.completeFallback(leaseApi, fencing, status, entry.cancelled ? 'cancelado_por_usuario' : 'error_interno', xlog);
        return entry.cancelled ? 'cancelled' : 'interrupted';
      }
      return marker.shardStatus === 'cancelado' ? 'cancelled' : marker.shardStatus === 'interrumpido' ? 'interrupted' : 'completed';
    } catch (e) {
      if (e instanceof PrepAbort) {
        await prepHeartbeat.stop();
        if (e.kind === 'cancel') {
          await this.completeFallback(leaseApi, fencing, 'cancelado', 'cancelado_por_usuario', elog);
          return 'cancelled';
        }
        return 'lease_lost';
      }
      elog.error({ err: (e as Error).message }, 'error del supervisor procesando el shard');
      await prepHeartbeat.stop();
      if (!entry.leaseLost) await this.completeFallback(leaseApi, fencing, 'interrumpido', 'error_interno', elog);
      return 'interrupted';
    } finally {
      await prepHeartbeat.stop();
      this.d.registry.unregister(entry);
      await rmrf(shardDir);
      await rmrf(outputDir);
      await fs.rmdir(path.dirname(outputDir)).catch(() => undefined);
    }
  }

  private async writeSecrets(claim: RunnerClaimResponse, secretsDir: string, commitVerified: boolean, log: Logger): Promise<void> {
    const a = claim.assignment;
    const lease: LeaseFile = {
      schemaVersion: 1,
      runId: a.runId,
      shardId: a.shardId,
      leaseId: claim.leaseId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      heartbeatIntervalMs: claim.heartbeatIntervalMs,
      assignment: a,
      checkout: { commit: a.gitCommit, manifestHash: a.manifestHash, commitVerified },
      ...(this.d.image ? { image: this.d.image } : {}),
    };
    await writeSecretFile(path.join(secretsDir, SHARD_FILES.lease), JSON.stringify(lease), { overwrite: true });
    const ref = a.testUserRef;
    if (!ref) return;
    if (a.environment.isProduction && !ref.readOnly) {
      // Doble control (RF-EJE-06): la credencial de un usuario con escritura nunca se entrega en producción.
      log.error('usuario de prueba sin declaración de solo lectura en producción: no se monta la credencial');
      return;
    }
    const password = passwordFromSecret(await this.d.secrets.get(ref.secretRef));
    addKnownSecret(password);
    await writeSecretFile(path.join(secretsDir, SHARD_FILES.testUser), JSON.stringify({ username: ref.username, password }), {
      overwrite: true,
    });
  }

  private async readMarker(outputDir: string) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(outputDir, OUTPUT_FILES.complete), 'utf8')) as unknown;
      const parsed = CompleteMarkerSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Fin de shard enviado por el supervisor cuando el ejecutor no pudo hacerlo (idempotente en la API). */
  private async completeFallback(
    api: WorkerApiClient,
    fencing: { leaseId: string; generation: number },
    shardStatus: 'cancelado' | 'interrumpido' | 'completado',
    reason: ResultReason,
    log: Logger,
  ): Promise<void> {
    try {
      await api.complete({ ...fencing, shardStatus, reason, runtimeVersions: { node: process.versions.node, runner: RUNNER_VERSION }, evidenceIncomplete: false });
      log.warn({ shardStatus, reason }, 'fin de shard enviado por el supervisor');
    } catch (e) {
      log.error({ errorCode: errorCode(e), leaseLost: isLeaseLost(e) }, 'no se pudo enviar el fin de shard de respaldo');
    }
  }
}
