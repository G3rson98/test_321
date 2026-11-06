/**
 * Launcher `docker`: un contenedor efímero por shard con las opciones de `x-katalyst-executor`
 * (deploy/docker-compose.yml): etiquetas katalyst.role/run/shard, `--user 1000:1000`, red runner-net, rootfs de
 * solo lectura, `cap-drop ALL`, `no-new-privileges`, tmpfs para /tmp y storageState, límites CPU/RAM/PIDs/shm,
 * `log-driver none` y SIN socket Docker, sin /run/katalyst/aws ni secretos del backend (RNF-SEG-05, ESP §13.7).
 * Listado de catálogo: misma imagen con `--network none` y sin secretos (ESP §4).
 */
import path from 'node:path';
import { OUTPUT_FILES } from '../../config.js';
import type { Logger } from '../../logger.js';
import { assertSafeSegment } from '../../util/fs.js';
import { LogTailer, raceTimeout, writeControlFile } from './common.js';
import type { DockerEngine } from './docker-engine.js';
import {
  CONTAINER_PATHS,
  EXECUTOR_LABELS,
  type ExecutorExit,
  type ExecutorHandle,
  type ExecutorLaunchSpec,
  type ExecutorLauncher,
  type IsolatedRunResult,
  type IsolatedRunSpec,
  type RunningExecutor,
  type RuntimePaths,
} from './types.js';

export interface DockerLauncherOptions {
  engine: DockerEngine;
  image: string;
  imageDigest: string | null;
  network: string;
  installNetwork: string;
  cpus: number;
  memoryBytes: number;
  pidsLimit: number;
  shmBytes: number;
  tmpQuotaBytes: number;
  logger: Logger;
}

const FORBIDDEN_MOUNT_SOURCES = ['/var/run/docker.sock', '/run/docker.sock', '/run/katalyst/aws', '/run/secrets'];

/** Defensa en profundidad: ningún bind puede exponer el socket Docker ni credenciales del host. */
export function assertSafeBinds(binds: readonly string[]): void {
  for (const b of binds) {
    const source = b.split(':')[0] ?? '';
    if (FORBIDDEN_MOUNT_SOURCES.some((f) => source === f || source.startsWith(`${f}/`) || source.endsWith('docker.sock'))) {
      throw new Error('montaje prohibido para el ejecutor');
    }
  }
}

function containerRoot(subdir: string): string {
  return subdir ? CONTAINER_PATHS.repo : CONTAINER_PATHS.tests;
}

export class DockerExecutorLauncher implements ExecutorLauncher {
  readonly kind = 'docker' as const;
  constructor(private readonly o: DockerLauncherOptions) {}

  private hardening(): Record<string, unknown> {
    return {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      NanoCpus: Math.round(this.o.cpus * 1e9),
      Memory: this.o.memoryBytes,
      MemorySwap: this.o.memoryBytes,
      PidsLimit: this.o.pidsLimit,
      ShmSize: this.o.shmBytes,
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
      Privileged: false,
    };
  }

  /** Especificación de contenedor del ejecutor (expuesta para pruebas). */
  executorContainerSpec(spec: ExecutorLaunchSpec): { name: string; body: Record<string, unknown> } {
    assertSafeSegment(spec.shardId);
    const root = containerRoot(spec.testsSubdir);
    const testsDir = spec.testsSubdir ? path.posix.join(root, spec.testsSubdir) : root;
    const binds = [
      `${spec.secretsDir}:${CONTAINER_PATHS.secrets}:ro`,
      `${spec.checkoutRoot}:${root}:ro`,
      `${spec.outputDir}:${CONTAINER_PATHS.out}:rw`,
    ];
    assertSafeBinds(binds);
    const tmpMiB = Math.max(64, Math.floor(this.o.tmpQuotaBytes / (1024 * 1024)));
    const env = [
      `KATALYST_WORKER_API_URL=${spec.workerApiUrl}`,
      `KATALYST_SECRETS_DIR=${CONTAINER_PATHS.secrets}`,
      `KATALYST_STATE_DIR=${CONTAINER_PATHS.state}`,
      `KATALYST_TESTS_DIR=${testsDir}`,
      `KATALYST_OUTPUT_DIR=${CONTAINER_PATHS.out}`,
      `KATALYST_EXECUTOR_LOG_FILE=${path.posix.join(CONTAINER_PATHS.out, OUTPUT_FILES.executorLog)}`,
      `HOME=${CONTAINER_PATHS.home}`,
      `LOG_LEVEL=${spec.logLevel}`,
      `KATALYST_IMAGE=${this.o.image}`,
      ...(this.o.imageDigest ? [`KATALYST_IMAGE_DIGEST=${this.o.imageDigest}`] : []),
      'TZ=UTC',
      'NODE_ENV=production',
    ];
    return {
      name: `katalyst-shard-${spec.shardId}`,
      body: {
        Image: this.o.image,
        User: '1000:1000',
        Env: env,
        Labels: {
          [EXECUTOR_LABELS.role]: 'executor',
          [EXECUTOR_LABELS.run]: spec.runId,
          [EXECUTOR_LABELS.shard]: spec.shardId,
          [EXECUTOR_LABELS.lease]: spec.leaseId,
        },
        NetworkDisabled: false,
        HostConfig: {
          ...this.hardening(),
          NetworkMode: this.o.network,
          Binds: binds,
          Tmpfs: {
            '/tmp': `rw,nosuid,nodev,size=${tmpMiB}m`,
            [CONTAINER_PATHS.state]: 'rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=1000,gid=1000',
          },
        },
      },
    };
  }

  async launch(spec: ExecutorLaunchSpec): Promise<ExecutorHandle> {
    const { name, body } = this.executorContainerSpec(spec);
    await this.o.engine.removeContainer(name, true).catch(() => undefined);
    const id = await this.o.engine.createContainer(name, body);
    await this.o.engine.startContainer(id);
    this.o.logger.info({ runId: spec.runId, shardId: spec.shardId, containerId: id.slice(0, 12) }, 'contenedor ejecutor iniciado');
    return this.handle({ id, runId: spec.runId, shardId: spec.shardId, running: true }, spec.secretsDir, spec.outputDir);
  }

  private handle(e: RunningExecutor, secretsDir: string, outputDir: string | null): ExecutorHandle {
    const engine = this.o.engine;
    const tailer = outputDir ? new LogTailer(path.join(outputDir, OUTPUT_FILES.executorLog)) : null;
    tailer?.start();
    const exited: Promise<ExecutorExit> = engine
      .waitContainer(e.id)
      .then((r) => ({ exitCode: r.StatusCode, signal: null }))
      .catch(() => ({ exitCode: null, signal: null }))
      .then(async (r) => {
        await tailer?.stop();
        await engine.removeContainer(e.id, true).catch(() => undefined);
        return r;
      });
    return {
      id: e.id,
      runId: e.runId,
      shardId: e.shardId,
      exited,
      onLog: (l) => tailer?.onLine(l),
      stop: async (reason, graceMs) => {
        await writeControlFile(secretsDir, reason);
        await engine.killContainer(e.id, 'SIGTERM').catch(() => undefined);
        if ((await raceTimeout(exited, graceMs)) === 'timeout') {
          await engine.killContainer(e.id, 'SIGKILL').catch(() => undefined);
          await raceTimeout(exited, 5_000);
          await engine.removeContainer(e.id, true).catch(() => undefined);
        }
      },
    };
  }

  isolatedContainerSpec(spec: IsolatedRunSpec): { name: string; body: Record<string, unknown>; rt: RuntimePaths } {
    const root = spec.testsSubdir ? CONTAINER_PATHS.repo : CONTAINER_PATHS.tests;
    const rt: RuntimePaths = {
      node: 'node',
      root,
      testsDir: spec.testsSubdir ? path.posix.join(root, spec.testsSubdir) : root,
      outDir: CONTAINER_PATHS.out,
    };
    const binds = [`${spec.checkoutRoot}:${root}:${spec.writableCheckout ? 'rw' : 'ro'}`, `${spec.outputDir}:${CONTAINER_PATHS.out}:rw`];
    assertSafeBinds(binds);
    const env = Object.entries({ HOME: CONTAINER_PATHS.home, TZ: 'UTC', CI: '1', ...spec.env(rt) }).map(([k, v]) => `${k}=${v}`);
    return {
      name: `katalyst-${spec.purpose}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      rt,
      body: {
        Image: this.o.image,
        User: '1000:1000',
        Cmd: spec.command(rt),
        Env: env,
        WorkingDir: spec.cwd === 'root' ? rt.root : rt.testsDir,
        Labels: { [EXECUTOR_LABELS.role]: spec.purpose },
        HostConfig: {
          ...this.hardening(),
          NetworkMode: spec.network === 'none' ? 'none' : this.o.installNetwork,
          Binds: binds,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' },
        },
      },
    };
  }

  async runIsolated(spec: IsolatedRunSpec): Promise<IsolatedRunResult> {
    const { name, body } = this.isolatedContainerSpec(spec);
    const id = await this.o.engine.createContainer(name, body);
    try {
      await this.o.engine.startContainer(id);
      const wait = this.o.engine.waitContainer(id);
      const onAbort = () => void this.o.engine.killContainer(id, 'SIGKILL');
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      const r = await raceTimeout(wait, spec.timeoutMs);
      spec.signal?.removeEventListener('abort', onAbort);
      if (r === 'timeout') {
        await this.o.engine.killContainer(id, 'SIGKILL');
        return { exitCode: null, timedOut: true, outputTail: '' };
      }
      return { exitCode: r.StatusCode, timedOut: false, outputTail: '' };
    } finally {
      await this.o.engine.removeContainer(id, true).catch(() => undefined);
    }
  }

  async listExecutors(): Promise<RunningExecutor[]> {
    const list = await this.o.engine.listContainers([`${EXECUTOR_LABELS.role}=executor`], true);
    return list.map((c) => ({
      id: c.Id,
      runId: c.Labels[EXECUTOR_LABELS.run] ?? '',
      shardId: c.Labels[EXECUTOR_LABELS.shard] ?? '',
      running: c.State === 'running',
    }));
  }

  adopt(e: RunningExecutor, shardDir: string): ExecutorHandle | null {
    if (!e.running) return null;
    return this.handle(e, path.join(shardDir, 'secrets'), null);
  }

  async destroy(e: RunningExecutor): Promise<void> {
    await this.o.engine.removeContainer(e.id, true);
  }
}
