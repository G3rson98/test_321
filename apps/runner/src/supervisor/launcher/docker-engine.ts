/**
 * Cliente mínimo de la API de Docker Engine por socket Unix (sin CLI ni dependencias; runner.Dockerfile).
 * Solo el supervisor tiene el socket (deploy/docker-compose.yml). Acepta especificaciones tipadas, nunca
 * comandos arbitrarios desde la cola (ARQ §2).
 */
import http from 'node:http';

export interface ContainerSummary {
  Id: string;
  Names?: string[];
  Labels: Record<string, string>;
  State: string;
}

export interface DockerEngine {
  createContainer(name: string, body: Record<string, unknown>): Promise<string>;
  startContainer(id: string): Promise<void>;
  waitContainer(id: string): Promise<{ StatusCode: number }>;
  killContainer(id: string, signal: string): Promise<void>;
  removeContainer(id: string, force: boolean): Promise<void>;
  listContainers(labelFilters: string[], all: boolean): Promise<ContainerSummary[]>;
}

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

export class HttpDockerEngine implements DockerEngine {
  constructor(
    private readonly socketPath: string,
    private readonly apiPrefix = '/v1.41',
  ) {}

  private request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: `${this.apiPrefix}${path}`,
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout de Docker Engine')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private static check(r: { status: number; text: string }, ok: number[]): void {
    if (!ok.includes(r.status)) {
      let message = `Docker Engine HTTP ${r.status}`;
      try {
        message = (JSON.parse(r.text) as { message?: string }).message ?? message;
      } catch {
        // cuerpo no JSON
      }
      throw new DockerApiError(r.status, message);
    }
  }

  async createContainer(name: string, body: Record<string, unknown>): Promise<string> {
    const r = await this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    HttpDockerEngine.check(r, [201]);
    return (JSON.parse(r.text) as { Id: string }).Id;
  }
  async startContainer(id: string): Promise<void> {
    HttpDockerEngine.check(await this.request('POST', `/containers/${encodeURIComponent(id)}/start`), [204, 304]);
  }
  async waitContainer(id: string): Promise<{ StatusCode: number }> {
    const r = await this.request('POST', `/containers/${encodeURIComponent(id)}/wait?condition=not-running`, undefined, 0);
    HttpDockerEngine.check(r, [200]);
    return JSON.parse(r.text) as { StatusCode: number };
  }
  async killContainer(id: string, signal: string): Promise<void> {
    const r = await this.request('POST', `/containers/${encodeURIComponent(id)}/kill?signal=${encodeURIComponent(signal)}`);
    HttpDockerEngine.check(r, [204, 404, 409]);
  }
  async removeContainer(id: string, force: boolean): Promise<void> {
    const r = await this.request('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}&v=true`);
    HttpDockerEngine.check(r, [204, 404, 409]);
  }
  async listContainers(labelFilters: string[], all: boolean): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labelFilters }));
    const r = await this.request('GET', `/containers/json?all=${all ? 'true' : 'false'}&filters=${filters}`);
    HttpDockerEngine.check(r, [200]);
    return JSON.parse(r.text) as ContainerSummary[];
  }
}
