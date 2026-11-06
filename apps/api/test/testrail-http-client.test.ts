/**
 * Cliente HTTP real de TestRail contra un servidor HTTP local que imita la API v2 (ESP §8): Basic auth, paginación
 * `_links.next`, respuestas sin paginar, 429 con Retry-After, 401/403/400, timeouts, adjuntos multipart y SSRF.
 * RF-TR-01, RF-TR-02, RF-TR-08.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpGuard } from '../src/lib/http-guard.js';
import { HttpTestRailClient, parseRetryAfter, httpTestRailClientFactory } from '../src/adapters/testrail/index.js';
import { TestRailError } from '../src/adapters/testrail/types.js';
import { MemorySecretProvider } from '../src/lib/secrets.js';
import { testConfig } from './support/api-a.js';

let server: Server;
let base: string;
const seen: { url: string; auth: string | undefined; ct: string | undefined; body: string }[] = [];
let rateLimitOnce = true;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = decodeURIComponent(req.url ?? '');
    seen.push({ url, auth: req.headers.authorization, ct: req.headers['content-type'], body });
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(v));
    const ep = url.replace(/^\/index\.php\?\/api\/v2\//, '');
    if (ep.startsWith('get_projects')) return json(200, { offset: 0, limit: 250, size: 1, _links: { next: null }, projects: [{ id: 1, name: 'P' }] });
    if (ep.startsWith('get_suites/1')) return json(200, [{ id: 10, name: 'S', project_id: 1 }]);
    if (ep.startsWith('get_cases/1&suite_id=10')) {
      if (ep.includes('offset=2')) return json(200, { offset: 2, limit: 2, size: 1, _links: { next: null }, cases: [{ id: 3, title: 'c', section_id: 5, suite_id: 10 }] });
      return json(200, {
        offset: 0,
        limit: 2,
        size: 2,
        _links: { next: '/api/v2/get_cases/1&suite_id=10&limit=2&offset=2' },
        cases: [
          { id: 1, title: 'a', section_id: 5, suite_id: 10 },
          { id: 2, title: 'b', section_id: 5, suite_id: 10 },
        ],
      });
    }
    if (ep.startsWith('get_sections/1&suite_id=10')) return json(200, [{ id: 5, suite_id: 10, name: 's', parent_id: null, depth: 0, display_order: 1 }]);
    if (ep.startsWith('get_sections/1&suite_id=66')) return json(200, { _links: { next: 'https://evil.example/x' }, sections: [] });
    if (ep.startsWith('get_sections/1&suite_id=77')) return json(200, { offset: 0 });
    if (ep.startsWith('get_priorities')) {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return json(429, { error: 'API rate limit exceeded' }, { 'retry-after': '0' });
      }
      return json(200, [{ id: 1, name: 'Low' }]);
    }
    if (ep.startsWith('get_case_types')) return json(401, { error: 'Authentication failed: invalid or missing user/password or session cookie.' });
    if (ep.startsWith('add_run/1')) return json(429, { error: 'limit' }, { 'retry-after': '7' });
    if (ep.startsWith('add_run/2')) return json(200, { id: 99, name: JSON.parse(body).name, suite_id: 10, project_id: 2, is_completed: false });
    if (ep.startsWith('add_run/3')) return json(400, { error: 'Field :case_ids contains invalid case' });
    if (ep.startsWith('add_run/4')) return json(403, { error: 'No permission' });
    if (ep.startsWith('add_run/5')) return res.writeHead(200).end('no json');
    if (ep.startsWith('add_run/6')) return; // sin respuesta → timeout ambiguo
    if (ep.startsWith('get_runs/1')) return json(200, { runs: [{ id: 99, name: 'x', suite_id: 10, project_id: 1, is_completed: false }], _links: { next: null } });
    if (ep.startsWith('get_run/99')) return json(200, { id: 99, name: 'x', suite_id: 10, project_id: 1, is_completed: true });
    if (ep.startsWith('get_run/404')) return json(404, { error: 'not found' });
    if (ep.startsWith('add_results_for_cases/99')) return json(200, [{ id: 501, test_id: 7, status_id: 1 }]);
    if (ep.startsWith('get_results_for_run/99')) return json(200, { results: [{ id: 501, test_id: 7, status_id: 1, comment: 'm' }], _links: { next: null } });
    if (ep.startsWith('get_tests/99')) return json(200, { tests: [{ id: 7, case_id: 3, run_id: 99, title: 't' }], _links: { next: null } });
    if (ep.startsWith('add_attachment_to_result/501')) return json(200, { attachment_id: 'abc' });
    if (ep.startsWith('get_attachments_for_test/7')) return json(200, { attachments: [{ id: 'abc', name: 'katalyst-x.png' }], _links: { next: null } });
    if (ep.startsWith('close_run/99')) return json(200, { id: 99, name: 'x', suite_id: 10, project_id: 1, is_completed: true });
    if (ep.startsWith('get_plan/5')) return json(200, { id: 5, name: 'Plan', project_id: 1, is_completed: false, entries: [] });
    if (ep.startsWith('get_cases/1&suite_id=500')) return json(500, { error: 'boom' });
    return json(404, { error: 'unknown' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const guard = () => new HttpGuard({ policy: { allowedHosts: [], allowLoopback: true, allowedSchemes: ['http'] } });
const client = (o: Partial<ConstructorParameters<typeof HttpTestRailClient>[0]> = {}) =>
  new HttpTestRailClient({ baseUrl: `${base}/`, username: 'svc@example.test', apiKey: 'clave-sintetica', http: guard(), sleep: async () => {}, pageSize: 2, ...o });

describe('HttpTestRailClient (ESP §8)', () => {
  it('RF-TR-01 Basic auth usuario+API key, JSON y URL index.php?/api/v2', async () => {
    const projects = await client().getProjects();
    expect(projects).toEqual([{ id: 1, name: 'P' }]);
    const last = seen.at(-1)!;
    expect(last.url).toBe('/index.php?/api/v2/get_projects&limit=2');
    expect(last.auth).toBe(`Basic ${Buffer.from('svc@example.test:clave-sintetica').toString('base64')}`);
  });

  it('RF-TR-02 recorre _links.next y admite respuestas sin paginar; rechaza enlaces externos', async () => {
    const pages: number[][] = [];
    for await (const p of client().getCasesPages(1, 10)) pages.push(p.map((c) => c.id));
    expect(pages).toEqual([[1, 2], [3]]);
    const secs: number[] = [];
    for await (const p of client().getSectionsPages(1, 10)) secs.push(...p.map((s) => s.id));
    expect(secs).toEqual([5]);
    expect((await client().getSuites(1)).map((s) => s.id)).toEqual([10]);
    const bad = async () => {
      for await (const _ of client().getSectionsPages(1, 66)) void _;
    };
    await expect(bad()).rejects.toMatchObject({ kind: 'server' });
    const missing = async () => {
      for await (const _ of client().getSectionsPages(1, 77)) void _;
    };
    await expect(missing()).rejects.toMatchObject({ kind: 'server' });
  });

  it('RF-TR-08 GET reintenta 429 respetando Retry-After; POST no reintenta y expone retryAfterMs', async () => {
    rateLimitOnce = true;
    const waits: number[] = [];
    expect(await client({ sleep: async (ms) => void waits.push(ms) }).getPriorities()).toEqual([{ id: 1, name: 'Low' }]);
    expect(waits).toEqual([0]);
    const e = (await client().addRun(1, { suite_id: 10, name: 'x', include_all: false, case_ids: [1] }).catch((x: unknown) => x)) as TestRailError;
    expect(e).toBeInstanceOf(TestRailError);
    expect(e).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 7000 });
    expect(e.transient).toBe(true);
  });

  it('RF-TR-08 401/403/400 son permanentes; 5xx y no-JSON transitorios; sin respuesta = timeout ambiguo', async () => {
    await expect(client().getCaseTypes()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    const v = (await client().addRun(3, { suite_id: 10, name: 'x', include_all: false, case_ids: [] }).catch((x: unknown) => x)) as TestRailError;
    expect(v).toMatchObject({ kind: 'validation', status: 400 });
    expect(v.message).toContain('invalid case');
    expect(v.transient).toBe(false);
    await expect(client().addRun(4, { suite_id: 10, name: 'x', include_all: false, case_ids: [] })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client().addRun(5, { suite_id: 10, name: 'x', include_all: false, case_ids: [] })).rejects.toMatchObject({ kind: 'server' });
    const t = (await client({ timeoutMs: 150 }).addRun(6, { suite_id: 10, name: 'x', include_all: false, case_ids: [] }).catch((x: unknown) => x)) as TestRailError;
    expect(t).toMatchObject({ kind: 'timeout', ambiguous: true });
    const s5 = async () => {
      for await (const _ of client().getCasesPages(1, 500)) void _;
    };
    await expect(s5()).rejects.toMatchObject({ kind: 'server', status: 500 });
    await expect(client().getRun(404)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('RF-TR-04/05 add_run, resultados, tests, adjunto multipart, cierre y plan', async () => {
    const c = client();
    expect((await c.addRun(2, { suite_id: 10, name: 'QA Runner · S', include_all: false, case_ids: [3] })).id).toBe(99);
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ include_all: false, case_ids: [3] });
    expect(await c.addResultsForCases(99, [{ case_id: 3, status_id: 1, comment: 'ok', elapsed: '1s' }])).toHaveLength(1);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ results: [{ case_id: 3, status_id: 1, comment: 'ok', elapsed: '1s' }] });
    expect(await c.getResultsForRun(99)).toHaveLength(1);
    expect((await c.getTests(99))[0]!.case_id).toBe(3);
    expect((await c.getRuns(1, { suiteId: 10, createdAfter: 1 }))[0]!.id).toBe(99);
    expect(seen.at(-1)!.url).toContain('get_runs/1&suite_id=10&created_after=1');
    expect(await c.addAttachmentToResult(501, 'katalyst-x.png', 'image/png', Buffer.from('png'))).toEqual({ attachment_id: 'abc' });
    expect(seen.at(-1)!.ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.at(-1)!.body).toContain('filename="katalyst-x.png"');
    expect(await c.getAttachmentsForTest(7)).toHaveLength(1);
    expect((await c.closeRun(99)).is_completed).toBe(true);
    expect((await c.getRun(99)).is_completed).toBe(true);
    expect((await c.getPlan(5)).name).toBe('Plan');
  });

  it('RNF-SEG-03 host no permitido → error blocked; red caída → network', async () => {
    const blocked = new HttpTestRailClient({
      baseUrl: base,
      username: 'u',
      apiKey: 'k',
      http: new HttpGuard({ policy: { allowedHosts: [], allowedSchemes: ['http'] } }),
    });
    await expect(blocked.getProjects()).rejects.toMatchObject({ kind: 'blocked' });
    const down = new HttpTestRailClient({ baseUrl: 'http://127.0.0.1:1', username: 'u', apiKey: 'k', http: guard(), timeoutMs: 1000 });
    await expect(down.getProjects()).rejects.toMatchObject({ kind: 'network' });
  });

  it('fábrica HTTP resuelve la API key por referencia y parseRetryAfter acepta segundos y fecha', async () => {
    const secrets = new MemorySecretProvider({ 'env:KATALYST_SECRET__TR': 'clave-de-fabrica' });
    const f = httpTestRailClientFactory(testConfig(), secrets);
    const c = await f({ baseUrl: base, username: 'svc', secretRef: 'env:KATALYST_SECRET__TR' });
    expect(await c.getProjects()).toHaveLength(1);
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from('svc:clave-de-fabrica').toString('base64')}`);
    await expect(f({ baseUrl: base, username: 'svc', secretRef: 'env:KATALYST_SECRET__NO' })).rejects.toThrow();
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('basura')).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(0);
  });
});
