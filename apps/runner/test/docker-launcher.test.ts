/**
 * Launcher `docker` con un DockerEngine falso: opciones de `x-katalyst-executor` (etiquetas, usuario 1000:1000,
 * red runner-net, sin socket Docker, tmpfs, límites, log-driver none), cancelación SIGTERM → SIGKILL tras la gracia,
 * listado aislado sin red ni secretos. RNF-SEG-05, ESP §13.3, §13.7, ESP §4.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContainerSummary, DockerEngine } from '../src/supervisor/launcher/docker-engine.js';
import { assertSafeBinds, DockerExecutorLauncher } from '../src/supervisor/launcher/docker-launcher.js';
import { silentLogger } from './helpers/logger.js';

class FakeEngine implements DockerEngine {
  created: Array<{ name: string; body: Record<string, unknown> }> = [];
  kills: string[] = [];
  removed: string[] = [];
  private exitResolvers = new Map<string, (code: number) => void>();
  exitOn: 'SIGTERM' | 'SIGKILL' = 'SIGKILL';
  containers: ContainerSummary[] = [];
  async createContainer(name: string, body: Record<string, unknown>) {
    this.created.push({ name, body });
    return `id-${this.created.length}`;
  }
  async startContainer() {}
  waitContainer(id: string) {
    return new Promise<{ StatusCode: number }>((resolve) => this.exitResolvers.set(id, (c) => resolve({ StatusCode: c })));
  }
  async killContainer(id: string, signal: string) {
    this.kills.push(signal);
    if (signal === this.exitOn || signal === 'SIGKILL') this.exitResolvers.get(id)?.(signal === 'SIGKILL' ? 137 : 0);
  }
  async removeContainer(id: string) {
    this.removed.push(id);
  }
  async listContainers() {
    return this.containers;
  }
  exit(id: string, code: number) {
    this.exitResolvers.get(id)?.(code);
  }
}

function launcher(engine: FakeEngine) {
  return new DockerExecutorLauncher({
    engine,
    image: 'registro/katalyst-executor:1.0.0',
    imageDigest: 'sha256:abc',
    network: 'katalyst-runner-net',
    installNetwork: 'katalyst-runner-net',
    cpus: 1.5,
    memoryBytes: 2_684_354_560,
    pidsLimit: 512,
    shmBytes: 1024 ** 3,
    tmpQuotaBytes: 1024 ** 3,
    logger: silentLogger(),
  });
}

const spec = () => {
  const shardId = randomUUID();
  return {
    runId: randomUUID(),
    shardId,
    leaseId: randomUUID(),
    shardDir: `/run/katalyst/shards/${shardId}`,
    secretsDir: `/run/katalyst/shards/${shardId}/secrets`,
    checkoutRoot: `/data/runner/checkouts/${'a'.repeat(40)}`,
    testsSubdir: '',
    outputDir: `/data/runner/runs/r/${shardId}`,
    workerApiUrl: 'http://worker-gw:8081',
    logLevel: 'info',
  };
};

describe('DockerExecutorLauncher (x-katalyst-executor)', () => {
  it('crea el contenedor con aislamiento, etiquetas de correlación y sin socket Docker', async () => {
    const engine = new FakeEngine();
    const s = spec();
    const { name, body } = launcher(engine).executorContainerSpec(s);
    expect(name).toBe(`katalyst-shard-${s.shardId}`);
    expect(body).toMatchObject({
      Image: 'registro/katalyst-executor:1.0.0',
      User: '1000:1000',
      Labels: { 'katalyst.role': 'executor', 'katalyst.run': s.runId, 'katalyst.shard': s.shardId, 'katalyst.lease': s.leaseId },
    });
    const hc = body.HostConfig as Record<string, unknown>;
    expect(hc).toMatchObject({
      NetworkMode: 'katalyst-runner-net',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      NanoCpus: 1_500_000_000,
      Memory: 2_684_354_560,
      MemorySwap: 2_684_354_560,
      PidsLimit: 512,
      ShmSize: 1024 ** 3,
      LogConfig: { Type: 'none', Config: {} },
      Privileged: false,
    });
    expect(hc.Binds).toEqual([
      `${s.secretsDir}:/run/katalyst/secrets:ro`,
      `${s.checkoutRoot}:/work/tests:ro`,
      `${s.outputDir}:/work/out:rw`,
    ]);
    expect(JSON.stringify(hc.Binds)).not.toContain('docker.sock');
    expect(hc.Tmpfs).toMatchObject({ '/tmp': expect.stringContaining('size=1024m'), '/run/katalyst/state': expect.stringContaining('mode=0700') });
    const env = body.Env as string[];
    expect(env).toContain('KATALYST_WORKER_API_URL=http://worker-gw:8081');
    // Ningún secreto por variables de entorno ni argumentos.
    expect(env.join(' ')).not.toMatch(/password|leaseToken|token=/i);
    expect(body.Cmd).toBeUndefined();
  });

  it('rechaza montajes del socket Docker o credenciales del host', () => {
    expect(() => assertSafeBinds(['/var/run/docker.sock:/var/run/docker.sock'])).toThrow();
    expect(() => assertSafeBinds(['/run/katalyst/aws:/x:ro'])).toThrow();
    expect(() => assertSafeBinds(['/data/runner/runs/x:/work/out:rw'])).not.toThrow();
  });

  it('cancelación: SIGTERM y, si no termina en la gracia, SIGKILL + eliminación', async () => {
    const engine = new FakeEngine();
    engine.exitOn = 'SIGKILL';
    const h = await launcher(engine).launch(spec());
    const t0 = Date.now();
    await h.stop('cancel', 200);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(engine.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect((await h.exited).exitCode).toBe(137);
    expect(engine.removed).toContain('id-1');
  });

  it('listado aislado: red none, checkout solo lectura, sin secretos', async () => {
    const engine = new FakeEngine();
    const l = launcher(engine);
    const { body } = l.isolatedContainerSpec({
      purpose: 'listing',
      checkoutRoot: '/data/runner/checkouts/x',
      testsSubdir: 'qa-tests',
      outputDir: '/data/runner/work/l1',
      command: (rt) => [rt.node, `${rt.root}/node_modules/@playwright/test/cli.js`, 'test', '--list', '--reporter=json'],
      env: (rt) => ({ PLAYWRIGHT_JSON_OUTPUT_FILE: `${rt.outDir}/list.json` }),
      network: 'none',
      writableCheckout: false,
      cwd: 'tests',
      timeoutMs: 1000,
    });
    const hc = body.HostConfig as { NetworkMode: string; Binds: string[] };
    expect(hc.NetworkMode).toBe('none');
    expect(hc.Binds).toEqual(['/data/runner/checkouts/x:/work/repo:ro', '/data/runner/work/l1:/work/out:rw']);
    expect(body.WorkingDir).toBe('/work/repo/qa-tests');
    expect(body.Labels).toEqual({ 'katalyst.role': 'listing' });
  });

  it('retoma contenedores vivos y elimina los detenidos', async () => {
    const engine = new FakeEngine();
    engine.containers = [
      { Id: 'a', Labels: { 'katalyst.role': 'executor', 'katalyst.run': 'r1', 'katalyst.shard': 's1' }, State: 'running' },
      { Id: 'b', Labels: { 'katalyst.role': 'executor', 'katalyst.run': 'r2', 'katalyst.shard': 's2' }, State: 'exited' },
    ];
    const l = launcher(engine);
    const list = await l.listExecutors();
    expect(list).toEqual([
      { id: 'a', runId: 'r1', shardId: 's1', running: true },
      { id: 'b', runId: 'r2', shardId: 's2', running: false },
    ]);
    expect(l.adopt(list[0]!, '/run/katalyst/shards/s1')?.id).toBe('a');
    expect(l.adopt(list[1]!, '/run/katalyst/shards/s2')).toBeNull();
  });
});
