/**
 * Cliente HTTP real de TestRail API v2 (ESP §8): `GET|POST {base}/index.php?/api/v2/<endpoint>`, Basic auth
 * usuario + API key (leída por SecretProvider en cada construcción; nunca registrada), `Content-Type:
 * application/json`, paginación `offset/limit/_links.next` (y respuestas antiguas sin paginar), 429 con
 * `Retry-After`, timeouts y protección SSRF vía HttpGuard.
 * Los GET se reintentan ante 429 hasta `maxGetRetries` respetando Retry-After (acotado); los POST NO se reintentan
 * aquí: el publicador de outbox decide (backoff y reconciliación por marcador, ESP §13.4).
 */
import type { HttpGuard} from '../../lib/http-guard.js';
import { HttpGuardError, multipartBody, type GuardedResponse } from '../../lib/http-guard.js';
import { SsrfBlockedError } from '../../lib/ssrf.js';
import { metrics, statusClass } from '../../lib/metrics.js';
import {
  TestRailError,
  type TestRailClient,
  type TrAddRunInput,
  type TrAttachment,
  type TrCase,
  type TrCaseType,
  type TrPlan,
  type TrPriority,
  type TrProject,
  type TrResult,
  type TrResultInput,
  type TrRun,
  type TrSection,
  type TrSuite,
  type TrTest,
} from './types.js';

export interface HttpTestRailOptions {
  baseUrl: string;
  username: string;
  apiKey: string;
  http: HttpGuard;
  timeoutMs?: number;
  maxGetRetries?: number;
  /** Tope de espera por Retry-After dentro del cliente (ms). */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tamaño de página solicitado (TestRail admite hasta 250). */
  pageSize?: number;
}

const MAX_PAGES = 10_000;

function endpointLabel(endpoint: string): string {
  return endpoint.split(/[/&?]/)[0] ?? 'otro';
}

export function parseRetryAfter(v: string | string[] | undefined): number | null {
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export class HttpTestRailClient implements TestRailClient {
  private readonly base: string;
  private readonly auth: string;
  constructor(private readonly o: HttpTestRailOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${o.username}:${o.apiKey}`, 'utf8').toString('base64')}`;
  }

  private url(pathAndQuery: string): string {
    // `pathAndQuery` = `get_cases/1&suite_id=2` o `_links.next` (`/api/v2/get_cases/1&...`).
    const p = pathAndQuery.startsWith('/api/v2/') ? pathAndQuery : `/api/v2/${pathAndQuery}`;
    return `${this.base}/index.php?${p}`;
  }

  private toError(res: GuardedResponse, endpoint: string): TestRailError {
    let detail = '';
    try {
      const body = res.json<{ error?: unknown }>();
      if (typeof body.error === 'string') detail = body.error.slice(0, 300);
    } catch {
      // cuerpo no JSON
    }
    const msg = `TestRail ${endpointLabel(endpoint)} → HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    if (res.status === 401) return new TestRailError('auth', msg, 401);
    if (res.status === 403) return new TestRailError('forbidden', msg, 403);
    if (res.status === 404) return new TestRailError('not_found', msg, 404);
    if (res.status === 429) return new TestRailError('rate_limited', msg, 429, parseRetryAfter(res.headers['retry-after']) ?? 60_000);
    if (res.status === 400 || res.status === 422) return new TestRailError('validation', msg, res.status);
    return new TestRailError('server', msg, res.status);
  }

  private async send(method: 'GET' | 'POST', endpoint: string, body?: string | Buffer, contentType = 'application/json'): Promise<unknown> {
    const maxRetries = method === 'GET' ? (this.o.maxGetRetries ?? 3) : 0;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      let res: GuardedResponse;
      try {
        res = await this.o.http.request(this.url(endpoint), {
          method,
          headers: {
            authorization: this.auth,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': contentType } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          timeoutMs: this.o.timeoutMs ?? 30_000,
          maxRedirects: 0,
        });
      } catch (e) {
        metrics.testrailRequests.inc({ endpoint: endpointLabel(endpoint), status_class: 'error' });
        if (e instanceof SsrfBlockedError) throw new TestRailError('blocked', 'Host de TestRail no permitido');
        if (e instanceof HttpGuardError) {
          throw new TestRailError(
            e.code === 'timeout' ? 'timeout' : 'network',
            `TestRail ${endpointLabel(endpoint)}: ${e.code}`,
            null,
            null,
            method === 'POST' && e.ambiguous,
          );
        }
        throw new TestRailError('network', `TestRail ${endpointLabel(endpoint)}: error de red`, null, null, method === 'POST');
      }
      metrics.testrailRequests.inc({ endpoint: endpointLabel(endpoint), status_class: statusClass(res.status) });
      if (res.status >= 200 && res.status < 300) {
        if (res.body.length === 0) return {};
        try {
          return res.json();
        } catch {
          throw new TestRailError('server', `TestRail ${endpointLabel(endpoint)}: respuesta no JSON`, res.status);
        }
      }
      const err = this.toError(res, endpoint);
      if (err.kind === 'rate_limited' && attempt < maxRetries) {
        await sleep(Math.min(err.retryAfterMs ?? 1000, this.o.maxRetryAfterMs ?? 60_000));
        continue;
      }
      throw err;
    }
  }

  private get(endpoint: string): Promise<unknown> {
    return this.send('GET', endpoint);
  }

  private post(endpoint: string, body: unknown): Promise<unknown> {
    return this.send('POST', endpoint, JSON.stringify(body ?? {}));
  }

  /** Recorre páginas: objeto `{offset, limit, size, _links.next, <key>: []}` o arreglo plano (versiones antiguas). */
  private async *pages<T>(endpoint: string, key: string): AsyncIterable<T[]> {
    const limit = this.o.pageSize ?? 250;
    let next: string | null = `${endpoint}&limit=${limit}`;
    for (let n = 0; next && n < MAX_PAGES; n++) {
      const body = await this.get(next);
      if (Array.isArray(body)) {
        yield body as T[];
        return;
      }
      const obj = body as { _links?: { next?: string | null }; [k: string]: unknown };
      const items = obj[key];
      if (!Array.isArray(items)) throw new TestRailError('server', `TestRail ${endpointLabel(endpoint)}: falta "${key}"`);
      yield items as T[];
      const link = obj._links?.next ?? null;
      if (link && !link.startsWith('/api/v2/')) throw new TestRailError('server', 'Enlace de paginación inesperado');
      next = link;
    }
  }

  private async all<T>(endpoint: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages<T>(endpoint, key)) out.push(...page);
    return out;
  }

  getProjects(): Promise<TrProject[]> {
    return this.all<TrProject>('get_projects', 'projects');
  }
  async getSuites(projectId: number): Promise<TrSuite[]> {
    const body = await this.get(`get_suites/${projectId}`);
    return (Array.isArray(body) ? body : ((body as { suites?: TrSuite[] }).suites ?? [])) as TrSuite[];
  }
  getSectionsPages(projectId: number, suiteId: number): AsyncIterable<TrSection[]> {
    return this.pages<TrSection>(`get_sections/${projectId}&suite_id=${suiteId}`, 'sections');
  }
  getCasesPages(projectId: number, suiteId: number): AsyncIterable<TrCase[]> {
    return this.pages<TrCase>(`get_cases/${projectId}&suite_id=${suiteId}`, 'cases');
  }
  async getPriorities(): Promise<TrPriority[]> {
    return (await this.get('get_priorities')) as TrPriority[];
  }
  async getCaseTypes(): Promise<TrCaseType[]> {
    return (await this.get('get_case_types')) as TrCaseType[];
  }
  async addRun(projectId: number, input: TrAddRunInput): Promise<TrRun> {
    return (await this.post(`add_run/${projectId}`, input)) as TrRun;
  }
  getRuns(projectId: number, filter: { suiteId?: number; createdAfter?: number } = {}): Promise<TrRun[]> {
    const q = [
      filter.suiteId !== undefined ? `&suite_id=${filter.suiteId}` : '',
      filter.createdAfter !== undefined ? `&created_after=${Math.floor(filter.createdAfter)}` : '',
    ].join('');
    return this.all<TrRun>(`get_runs/${projectId}${q}`, 'runs');
  }
  async getRun(runId: number): Promise<TrRun> {
    return (await this.get(`get_run/${runId}`)) as TrRun;
  }
  async addResultsForCases(runId: number, results: TrResultInput[]): Promise<TrResult[]> {
    const body = await this.post(`add_results_for_cases/${runId}`, { results });
    return (Array.isArray(body) ? body : ((body as { results?: TrResult[] }).results ?? [])) as TrResult[];
  }
  getResultsForRun(runId: number): Promise<TrResult[]> {
    return this.all<TrResult>(`get_results_for_run/${runId}`, 'results');
  }
  getTests(runId: number): Promise<TrTest[]> {
    return this.all<TrTest>(`get_tests/${runId}`, 'tests');
  }
  async addAttachmentToResult(
    resultId: number,
    fileName: string,
    contentType: string,
    content: Buffer,
  ): Promise<{ attachment_id: number | string }> {
    const m = multipartBody('attachment', fileName, contentType, content);
    return (await this.send('POST', `add_attachment_to_result/${resultId}`, m.body, m.contentType)) as {
      attachment_id: number | string;
    };
  }
  getAttachmentsForTest(testId: number): Promise<TrAttachment[]> {
    return this.all<TrAttachment>(`get_attachments_for_test/${testId}`, 'attachments');
  }
  async closeRun(runId: number): Promise<TrRun> {
    return (await this.post(`close_run/${runId}`, {})) as TrRun;
  }
  async getPlan(planId: number): Promise<TrPlan> {
    return (await this.get(`get_plan/${planId}`)) as TrPlan;
  }
}
