/**
 * Ejecutor de un shard (main.executor.ts). Corre dentro del contenedor Playwright (o como proceso hijo en
 * desarrollo) y SOLO habla HTTP con `KATALYST_WORKER_API_URL` usando el leaseToken (RNF-SEG-05).
 *
 * Flujo: heartbeat cada 15 s con fencing → revalidación de commit/manifiesto (ESP §13.1) → restricción de
 * producción (RF-EJE-06) → `playwright test` del checkout por grupos de reintentos (0..2; escritura sin
 * idempotencia aprobada = 0, RF-EJE-05) con el reporter de Katalyst → resultados/evidencia sanitizada →
 * muestras DXMon → `POST /worker/complete` → borrado de storageState y secretos en `finally` (RF-AMB-03).
 * Detención: cancelación (heartbeat/`proceed=false`/SIGTERM del supervisor), 409 LEASE_STALE, timeout de corrida
 * (20 min funcional / 4 min rendimiento, congelado en la asignación) o de preparación/auth (120 s).
 * RF-EJE-03, RF-EJE-08, RF-RES-01/02, RF-REN-01, RNF-CON-01, RNF-CON-03, RNF-SEG-01/02, ESP §13.3, §13.7.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CHROMIUM_NO_THROTTLE_FLAGS, type AssignedTest, type ResultReason, type RuntimeVersions } from '@katalyst/shared';
import type { Clock } from '../clock.js';
import { OUTPUT_FILES, type ExecutorConfig } from '../config.js';
import { HeartbeatLoop } from '../heartbeat.js';
import { addKnownSecret, knownSecretsList, type Logger } from '../logger.js';
import { verifyManifestHash } from '../manifest-check.js';
import { testKey, type ReporterMessage, type ReporterPlan } from '../reporter/protocol.js';
import { ControlFileSchema, LeaseFileSchema, TestUserFileSchema, type CompleteMarker, type LeaseFile } from '../shard-files.js';
import { dirSize, pathExists, rmrf, writeFileAtomic } from '../util/fs.js';
import { RUNNER_VERSION } from '../version.js';
import { isLeaseLost } from '../worker-api/errors.js';
import type { CompleteRequest, WorkerApiClient } from '../worker-api/types.js';
import { ArtifactUploader } from './artifacts/uploader.js';
import type { StopCause } from './classify.js';
import { importPerfSamples } from './perf.js';
import { PlaywrightProcess, reporterModulePath, resolvePlaywright, type PlaywrightExit, type PlaywrightInstall, type PlaywrightRunSpec } from './playwright-process.js';
import { effectiveRetries, evaluateGuards } from './production-guard.js';
import { buildPlaywrightEnv, DEFAULT_ENV_NAME, shardOutputPaths } from './qa-env.js';
import { ResultTracker } from './result-tracker.js';

export interface PlaywrightLike {
  start(): void;
  exited: Promise<PlaywrightExit>;
  stop(graceMs: number): Promise<number[]>;
}

export interface ShardExecutorDeps {
  config: ExecutorConfig;
  /** Crea el cliente con el leaseToken leído de `lease.json`. */
  createApi: (leaseToken: string) => WorkerApiClient;
  clock: Clock;
  logger: Logger;
  resolvePlaywright?: (testsDir: string) => PlaywrightInstall | null;
  spawnPlaywright?: (spec: PlaywrightRunSpec) => PlaywrightLike;
  /** PATH mínimo del proceso Playwright (debe incluir `node`). */
  basePath?: string;
}

/**
 * Códigos de salida. `abandoned` (apagado del supervisor): no se cierra el shard para que el lease venza y el
 * backend recupere los tests pendientes una vez (ESP §13.3, RNF-CON-01).
 */
export const EXIT = { ok: 0, internal: 1, interrupted: 2, leaseLost: 3, notDelivered: 4, abandoned: 5 } as const;

type ShardStatus = 'completado' | 'cancelado' | 'interrumpido';

export class ShardExecutor {
  private lease!: LeaseFile;
  private api!: WorkerApiClient;
  private tracker!: ResultTracker;
  private uploader!: ArtifactUploader;
  private heartbeat: HeartbeatLoop | null = null;
  private current: PlaywrightLike | null = null;
  private stopCause: StopCause = null;
  private stopPromise: Promise<unknown> | null = null;
  private tempQuotaExceeded = false;
  private flagsMissing = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private pw: PlaywrightInstall | null = null;

  constructor(private readonly d: ShardExecutorDeps) {}

  get cause(): StopCause {
    return this.stopCause;
  }

  /** Solicitud de detención (idempotente: la primera causa prevalece). */
  requestStop(cause: Exclude<StopCause, null>): void {
    if (this.stopCause) return;
    this.stopCause = cause;
    if (this.tracker) {
      this.tracker.stopCause = cause;
      if (cause === 'lease_lost') this.tracker.markLeaseLost();
    }
    if (cause === 'lease_lost') this.uploader?.stop();
    this.d.logger.warn({ cause }, 'deteniendo el shard');
    const proc = this.current;
    if (proc) this.stopPromise = proc.stop(this.d.config.KATALYST_PLAYWRIGHT_STOP_GRACE_MS);
  }

  /** SIGTERM/SIGINT: el supervisor deja el motivo en `control.json` antes de señalizar. */
  async onSignal(): Promise<void> {
    let stop: 'cancel' | 'shutdown' | 'revoke' = 'shutdown';
    try {
      const raw = JSON.parse(await fs.readFile(this.d.config.controlFile, 'utf8')) as unknown;
      const parsed = ControlFileSchema.safeParse(raw);
      if (parsed.success) stop = parsed.data.stop;
    } catch {
      stop = 'shutdown';
    }
    this.requestStop(stop === 'revoke' ? 'lease_lost' : stop);
  }

  private fencing() {
    return { leaseId: this.lease.leaseId, generation: this.lease.generation };
  }

  /** Con lease perdido o apagado del supervisor no se cierra el shard ni se publican más resultados. */
  private reportsToApi(): boolean {
    return this.stopCause !== 'lease_lost' && this.stopCause !== 'shutdown';
  }

  private async loadInputs(): Promise<{ testUser: { username: string; password: string } | null }> {
    const raw = JSON.parse(await fs.readFile(this.d.config.leaseFile, 'utf8')) as unknown;
    this.lease = LeaseFileSchema.parse(raw);
    addKnownSecret(this.lease.leaseToken);
    let testUser: { username: string; password: string } | null = null;
    try {
      const parsed = TestUserFileSchema.safeParse(JSON.parse(await fs.readFile(this.d.config.testUserFile, 'utf8')));
      if (parsed.success) {
        testUser = parsed.data;
        addKnownSecret(testUser.password);
        addKnownSecret(testUser.username);
      }
    } catch {
      testUser = null;
    }
    return { testUser };
  }

  async run(): Promise<number> {
    const cfg = this.d.config;
    const { testUser } = await this.loadInputs();
    const lease = this.lease;
    const a = lease.assignment;
    const log = this.d.logger.child({ runId: lease.runId, shardId: lease.shardId, leaseId: lease.leaseId });
    this.api = this.d.createApi(lease.leaseToken);
    const out = shardOutputPaths(cfg.KATALYST_OUTPUT_DIR);
    for (const dir of [out.testResults, out.perfDir, out.gateDir, out.planDir, out.sanitizedDir, out.home, cfg.KATALYST_STATE_DIR]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }

    this.tracker = new ResultTracker({
      api: this.api,
      ...this.fencing(),
      tests: a.tests,
      logger: log,
      knownSecrets: knownSecretsList,
      now: () => new Date(this.d.clock.now()),
      gateDir: out.gateDir,
      requestStop: (c) => this.requestStop(c),
      onAttachments: (items) => {
        for (const item of items) void this.uploader.enqueue(item);
      },
    });
    this.uploader = new ArtifactUploader({
      api: this.api,
      ...this.fencing(),
      policy: a.artifactPolicy,
      knownSecrets: knownSecretsList,
      sanitizedDir: out.sanitizedDir,
      logger: log,
      onLeaseLost: () => this.requestStop('lease_lost'),
    });

    this.heartbeat = new HeartbeatLoop({
      api: this.api,
      ...this.fencing(),
      clock: this.d.clock,
      intervalMs: lease.heartbeatIntervalMs,
      logger: log,
      progress: () => ({ completed: this.tracker.completed, total: this.tracker.total }),
      onStop: (s) => this.requestStop(s.reason === 'cancel' ? 'cancel' : 'lease_lost'),
      onTick: async () => {
        if (this.tempQuotaExceeded) return;
        const used = await dirSize(cfg.KATALYST_OUTPUT_DIR);
        if (used > a.artifactPolicy.maxTempBytesPerRun) {
          this.tempQuotaExceeded = true;
          this.uploader.markIncomplete();
          log.warn({ usedBytes: used }, 'cuota temporal de la corrida superada: evidencia incompleta');
        }
      },
    });
    this.heartbeat.start();

    // Timeout de corrida: límite absoluto congelado (o runMs desde el inicio, lo que ocurra antes).
    const startedAt = this.d.clock.now();
    const deadline = Math.min(Date.parse(a.timeouts.runDeadlineAt) || Number.POSITIVE_INFINITY, startedAt + a.timeouts.runMs);
    this.timers.push(setTimeout(() => this.requestStop('run_timeout'), Math.max(0, deadline - startedAt)));

    let status: ShardStatus = 'completado';
    let reason: ResultReason | null = null;
    let delivered = false;
    try {
      const pre = await this.preflight(testUser !== null, a.testUserRef);
      if (pre) {
        status = 'interrumpido';
        reason = pre;
      } else {
        const guards = evaluateGuards({
          tests: a.tests,
          isProduction: a.environment.isProduction,
          testUser: a.testUserRef && testUser ? { readOnly: a.testUserRef.readOnly } : null,
          manifest: (await verifyManifestHash(cfg.KATALYST_TESTS_DIR, a.manifestHash)).manifest,
        });
        for (const b of guards.blocked) await this.tracker.block(b.test, b.reason, b.message);
        const groups = new Map<number, AssignedTest[]>();
        for (const t of guards.allowed) {
          const r = effectiveRetries(t);
          groups.set(r, [...(groups.get(r) ?? []), t]);
        }
        let n = 0;
        for (const [retries, tests] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
          if (this.stopCause || this.tracker.setupFailed) break;
          await this.runGroup(++n, tests, retries, testUser?.username ?? a.testUserRef?.username ?? null, out, log);
        }
        await this.settlePending(guards.allowed);
      }

      if (this.stopCause === 'cancel') [status, reason] = ['cancelado', 'cancelado_por_usuario'];
      else if (this.stopCause === 'run_timeout') [status, reason] = ['interrumpido', 'timeout_corrida'];
      else if (this.stopCause === 'shutdown') [status, reason] = ['interrumpido', 'worker_perdido'];
      else if (!reason && this.tracker.pending().length > 0) [status, reason] = ['interrumpido', 'error_interno'];
      else if (!reason && this.tracker.setupFailed) reason = 'login_fallido';
      else if (!reason && this.stopCause === 'setup_timeout') reason = 'timeout_preparacion';

      if (this.reportsToApi()) {
        await this.finishEvidence(out, log);
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, 'error interno del ejecutor');
      status = 'interrumpido';
      reason = 'error_interno';
    } finally {
      for (const t of this.timers) clearTimeout(t);
      await this.uploader.drain().catch(() => undefined);
      await this.heartbeat.stop();
      if (this.reportsToApi()) {
        delivered = await this.complete(status, reason, log);
      }
      await this.writeMarker({ shardStatus: status, reason, delivered, at: new Date(this.d.clock.now()).toISOString() });
      await this.cleanup(out);
    }
    if (this.stopCause === 'lease_lost') return EXIT.leaseLost;
    if (this.stopCause === 'shutdown') return EXIT.abandoned;
    if (!delivered) return EXIT.notDelivered;
    return status === 'interrumpido' ? EXIT.interrupted : EXIT.ok;
  }

  /** Validaciones previas a lanzar navegadores. Devuelve la causa de interrupción o null. */
  private async preflight(hasUserFile: boolean, testUserRef: LeaseFile['assignment']['testUserRef']): Promise<ResultReason | null> {
    const cfg = this.d.config;
    const a = this.lease.assignment;
    const log = this.d.logger;
    if (this.lease.checkout.commit !== a.gitCommit) {
      log.error('el checkout montado no corresponde al commit asignado');
      return 'commit_no_disponible';
    }
    const m = await verifyManifestHash(cfg.KATALYST_TESTS_DIR, a.manifestHash);
    if (!m.ok) {
      log.error({ error: m.error }, 'manifiesto del checkout inválido o con hash distinto');
      return 'manifiesto_invalido';
    }
    const resolver = this.d.resolvePlaywright ?? resolvePlaywright;
    this.pw = resolver(cfg.KATALYST_TESTS_DIR);
    if (!this.pw) {
      log.error('@playwright/test no está instalado en el checkout');
      return 'dependencia_fallida';
    }
    const expected = a.runtime.playwrightVersion || cfg.KATALYST_PLAYWRIGHT_VERSION;
    if (expected && this.pw.version !== expected) {
      log.error({ expected, actual: this.pw.version }, 'versión de Playwright del checkout distinta de la congelada');
      return 'dependencia_fallida';
    }
    if (testUserRef && !hasUserFile && !(a.environment.isProduction && !testUserRef.readOnly)) {
      log.error('no se montó el archivo del usuario de prueba');
      return 'error_interno';
    }
    return null;
  }

  private async runGroup(
    n: number,
    tests: AssignedTest[],
    retries: number,
    expectedUsername: string | null,
    out: ReturnType<typeof shardOutputPaths>,
    log: Logger,
  ): Promise<void> {
    const cfg = this.d.config;
    const a = this.lease.assignment;
    const envName = a.environment.name ?? DEFAULT_ENV_NAME;
    const plan: ReporterPlan = {
      schemaVersion: 1,
      projectName: envName,
      tests: tests.map((t) => ({ stableKey: t.stableKey, parameterKey: t.parameterKey })),
      requiredChromiumFlags: [...new Set([...CHROMIUM_NO_THROTTLE_FLAGS, ...a.runtime.chromiumFlags])],
    };
    const planFile = path.join(out.planDir, `plan-${n}.json`);
    await writeFileAtomic(planFile, JSON.stringify(plan));
    const hasUserFile = await pathExists(this.d.config.testUserFile);
    const env = buildPlaywrightEnv({
      assignment: a,
      paths: {
        testsDir: cfg.KATALYST_TESTS_DIR,
        outputDir: cfg.KATALYST_OUTPUT_DIR,
        stateDir: cfg.KATALYST_STATE_DIR,
        testUserFile: hasUserFile ? this.d.config.testUserFile : null,
      },
      envName,
      retries,
      expectedUsername,
      planFile,
      browsersPath: cfg.PLAYWRIGHT_BROWSERS_PATH,
      basePath: this.d.basePath,
    });
    const args = [
      'test',
      `--reporter=${reporterModulePath()},json,html,junit`,
      '--workers=1',
      `--retries=${retries}`,
      `--timeout=${a.timeouts.testMs}`,
      `--project=${envName}`,
      '--pass-with-no-tests',
    ];
    const spawn = this.d.spawnPlaywright ?? ((spec: PlaywrightRunSpec) => new PlaywrightProcess(spec));
    const proc = spawn({
      cliPath: this.pw!.cliPath,
      cwd: cfg.KATALYST_TESTS_DIR,
      args,
      env,
      logFile: out.playwrightLog,
      onMessage: (msg) => this.onReporterMessage(msg, log),
    });
    this.current = proc;
    const watchdog = setInterval(() => {
      const since = this.tracker.setupRunningSince;
      if (since !== null && this.d.clock.now() - since > a.timeouts.setupMs) this.requestStop('setup_timeout');
    }, 1000);
    try {
      proc.start();
      log.info({ group: n, tests: tests.length, retries }, 'playwright iniciado');
      const exit = await proc.exited;
      await this.stopPromise;
      log.info({ group: n, exitCode: exit.code, signal: exit.signal }, 'playwright terminó');
    } finally {
      clearInterval(watchdog);
      this.current = null;
    }
    if (this.stopCause) await this.tracker.finalizeInFlight(this.stopCause);
    if (this.flagsMissing) {
      for (const t of tests) {
        if (!this.tracker.isFinal(t)) {
          await this.tracker.block(t, 'dependencia_fallida', 'La configuración de Playwright no aplica los flags de Chromium sin freno de temporizadores (RNF-CON-03).', 'configuracion');
        }
      }
    }
  }

  private async onReporterMessage(msg: ReporterMessage, log: Logger): Promise<void> {
    if (msg.type === 'plan' && msg.missingChromiumFlags.length > 0) {
      this.flagsMissing = true;
      log.error({ missing: msg.missingChromiumFlags }, 'flags de Chromium RNF-CON-03 ausentes: no se ejecuta el grupo');
      await this.tracker.handle(msg);
      this.current?.stop(this.d.config.KATALYST_PLAYWRIGHT_STOP_GRACE_MS).catch(() => undefined);
      return;
    }
    if (msg.type === 'error') log.warn({ message: msg.message.slice(0, 2000) }, 'error global de Playwright');
    await this.tracker.handle(msg);
  }

  /** Tests que no llegaron a correr: faltantes en el commit, login fallido o timeout de preparación. */
  private async settlePending(allowed: readonly AssignedTest[]): Promise<void> {
    if (this.stopCause === 'lease_lost' || this.stopCause === 'cancel' || this.stopCause === 'run_timeout' || this.stopCause === 'shutdown') return;
    const started = this.tracker.startedTests();
    for (const t of allowed) {
      if (this.tracker.isFinal(t) || started.has(t.runResultId)) continue;
      const key = testKey(t.stableKey, t.parameterKey);
      if (this.tracker.missing.has(key)) {
        await this.tracker.block(t, 'variante_faltante', 'El test/variante asignado no existe en el commit (anotación katalyst.stableKey).', 'configuracion');
      } else if (this.tracker.setupFailed) {
        await this.tracker.block(t, 'login_fallido', `No ejecutado: falló la autenticación. ${this.tracker.setupFailed.message}`, 'login');
      } else if (this.stopCause === 'setup_timeout') {
        await this.tracker.block(t, 'timeout_preparacion', 'No ejecutado: se agotó el timeout de preparación/autenticación.', 'login');
      }
    }
  }

  private async finishEvidence(out: ReturnType<typeof shardOutputPaths>, log: Logger): Promise<void> {
    const a = this.lease.assignment;
    if (a.kind === 'rendimiento' || (await pathExists(path.join(out.perfDir, 'samples.json')))) {
      const r = await importPerfSamples({ api: this.api, ...this.fencing(), perfDir: out.perfDir, knownSecrets: knownSecretsList(), logger: log });
      if (r.status === 'lease_perdido') this.requestStop('lease_lost');
      if (r.status === 'rechazado_sanitizacion' || r.status === 'invalido' || r.status === 'error') this.uploader.markIncomplete();
    }
    if (this.stopCause === 'lease_lost') return;
    const reports: Array<{ file: string; contentType: string }> = [
      { file: out.jsonFile, contentType: 'application/json' },
      { file: path.join(out.htmlDir, 'index.html'), contentType: 'text/html' },
    ];
    for (const r of reports) {
      if (await pathExists(r.file)) {
        await this.uploader.enqueue({ file: r.file, kind: 'reporte', contentType: r.contentType, runResultId: null, attemptNo: null, failed: true });
      }
    }
    if (a.artifactPolicy.enabledKinds.includes('log') && (await pathExists(out.playwrightLog))) {
      await this.uploader.enqueue({ file: out.playwrightLog, kind: 'log', contentType: 'text/plain', runResultId: null, attemptNo: null, failed: true });
    }
    await this.uploader.drain();
  }

  private runtimeVersions(): RuntimeVersions {
    const v: RuntimeVersions = { node: process.versions.node, runner: RUNNER_VERSION };
    if (this.pw) v.playwright = this.pw.version;
    if (this.pw?.chromiumVersion) v.chromium = this.pw.chromiumVersion;
    const image = this.lease.image?.image ?? this.d.config.KATALYST_IMAGE ?? this.lease.assignment.runtime.image;
    if (image) v.image = image;
    const digest = this.lease.image?.digest ?? this.d.config.KATALYST_IMAGE_DIGEST ?? this.lease.assignment.runtime.imageDigest;
    if (digest) v.imageDigest = digest;
    return v;
  }

  private async complete(status: ShardStatus, reason: ResultReason | null, log: Logger): Promise<boolean> {
    const req: CompleteRequest = {
      ...this.fencing(),
      shardStatus: status,
      reason,
      runtimeVersions: this.runtimeVersions(),
      evidenceIncomplete: this.uploader.evidenceIncomplete || this.tempQuotaExceeded,
    };
    try {
      await this.api.complete(req);
      log.info({ shardStatus: status, reason }, 'shard completado');
      return true;
    } catch (e) {
      if (isLeaseLost(e)) this.stopCause = this.stopCause ?? 'lease_lost';
      log.error({ shardStatus: status }, 'no se pudo enviar el fin de shard');
      return false;
    }
  }

  private async writeMarker(m: CompleteMarker): Promise<void> {
    try {
      await writeFileAtomic(path.join(this.d.config.KATALYST_OUTPUT_DIR, OUTPUT_FILES.complete), JSON.stringify(m));
    } catch {
      // directorio de salida no escribible: el supervisor enviará el fin de shard
    }
  }

  /** `finally`: storageState, perfiles, credencial (si es escribible) y evidencia cruda (RF-AMB-03, ESP §13.7). */
  private async cleanup(out: ReturnType<typeof shardOutputPaths>): Promise<void> {
    const cfg = this.d.config;
    try {
      for (const entry of await fs.readdir(cfg.KATALYST_STATE_DIR)) await rmrf(path.join(cfg.KATALYST_STATE_DIR, entry));
    } catch {
      // sin estado
    }
    await fs.rm(cfg.testUserFile, { force: true }).catch(() => undefined); // solo lectura en contenedor: lo borra el supervisor
    for (const dir of [out.testResults, path.dirname(out.jsonFile), out.sanitizedDir, out.gateDir, out.home, out.perfDir]) {
      await rmrf(dir).catch(() => undefined);
    }
  }
}
