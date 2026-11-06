/**
 * Adaptadores de API-C: webhooks Slack/Teams (clasificación entregada/reintentable/permanente/ambigua, SSRF, sin
 * reflejar la URL secreta), credenciales SMTP por referencia, GitHub/GitLab REST (sin endpoints de merge, token solo
 * en encabezado) y adaptador git local (nunca la rama protegida). RF-NOT-01, RF-GRB-02, ESP §13.7.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseSmtpCredentials, SlackNotifier, TeamsNotifier, type NotificationMessage } from '../src/adapters/notifier/index.js';
import { GitHubPrProvider, GitLabPrProvider, LocalGitPrProvider, GitProviderError } from '../src/adapters/git-pr/index.js';
import { costUsd, ANTHROPIC_PRICING } from '../src/adapters/ai/index.js';
import { createLocalRepo } from './support/api-c.js';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let base = '';
let handler: Handler = (_q, _b, res) => res.end();
const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const msg: NotificationMessage = { subject: 'Prueba', text: 'Texto', link: 'https://katalyst.example.test/x', facts: [{ name: 'A', value: 'B' }], severity: 'info' };
const loopback = { policy: { allowedHosts: ['127.0.0.1'], allowedSchemes: ['http' as const], allowLoopback: true }, skipDnsCheck: true, timeoutMs: 300 };
const target = (secret: string | null) => ({ kind: 'slack' as const, secret, recipients: [], smtp: null });

describe('webhooks Slack/Teams (RF-NOT-01, ESP §13.8)', () => {
  it('RF-NOT-01 clasifica 2xx/429/5xx/4xx/timeout y no refleja la URL del webhook', async () => {
    const slack = new SlackNotifier(loopback);
    const url = `${base}/services/T0/B0/SECRETO`;
    handler = (_q, _b, res) => res.writeHead(200).end('ok');
    expect((await slack.send(msg, target(url))).outcome).toBe('entregada');
    expect(JSON.parse(seen.at(-1)!.body).text).toContain('Prueba');
    handler = (_q, _b, res) => res.writeHead(429, { 'retry-after': '7' }).end();
    expect(await slack.send(msg, target(url))).toMatchObject({ outcome: 'reintentable', retryAfterMs: 7000 });
    handler = (_q, _b, res) => res.writeHead(503).end();
    expect((await slack.send(msg, target(url))).outcome).toBe('reintentable');
    handler = (_q, _b, res) => res.writeHead(404).end('no_service');
    const perm = await slack.send(msg, target(url));
    expect(perm.outcome).toBe('permanente');
    expect(perm.message).not.toContain('SECRETO');
    handler = () => undefined; // nunca responde → timeout tras enviar
    const amb = await slack.send(msg, target(url));
    expect(amb.outcome).toBe('ambigua');
    expect(amb.message).not.toContain('SECRETO');
    handler = (_q, _b, res) => res.writeHead(202).end();
    const teams = new TeamsNotifier(loopback);
    expect((await teams.send(msg, { ...target(url), kind: 'teams' })).outcome).toBe('entregada');
    expect(JSON.parse(seen.at(-1)!.body).attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('RF-NOT-01 política de destinos: host fuera de la allowlist o http → permanente sin conectar', async () => {
    const before = seen.length;
    const slack = new SlackNotifier();
    expect((await slack.send(msg, target(`${base}/x`))).outcome).toBe('permanente');
    expect((await slack.send(msg, target('http://hooks.slack.com/services/x'))).outcome).toBe('permanente');
    expect((await slack.send(msg, target(null))).outcome).toBe('permanente');
    expect(seen.length).toBe(before);
  });

  it('RF-NOT-01 credenciales SMTP desde la referencia: usuario:clave o JSON', () => {
    expect(parseSmtpCredentials('u:p:q')).toEqual({ user: 'u', pass: 'p:q' });
    expect(parseSmtpCredentials('{"user":"u","pass":"p"}')).toEqual({ user: 'u', pass: 'p' });
    expect(parseSmtpCredentials('sinseparador')).toBeNull();
  });

  it('RF-GRB-03 costo por tokens con precios del modelo', () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, ANTHROPIC_PRICING['claude-opus-5-5']!)).toBe(24);
  });
});

describe('GitPrProvider (RF-GRB-02)', () => {
  it('RF-GRB-02 GitHub: crea árbol/commit/rama y PR borrador; token solo en encabezado; nunca merge', async () => {
    seen.length = 0;
    handler = (req, _b, res) => {
      const u = req.url!;
      const json = (s: number, v: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (u.startsWith('/repos/o/r/git/ref/heads/main')) return json(200, { object: { sha: 'base' } });
      if (u === '/repos/o/r/git/commits/base') return json(200, { tree: { sha: 'tree0' } });
      if (u === '/repos/o/r/git/trees') return json(201, { sha: 'tree1' });
      if (u === '/repos/o/r/git/commits') return json(201, { sha: 'commit1' });
      if (u === '/repos/o/r/git/refs') return json(422, { message: 'Reference already exists' });
      if (u.startsWith('/repos/o/r/git/refs/heads/')) return json(200, {});
      if (u === '/repos/o/r/pulls' && req.method === 'POST') return json(201, { html_url: 'https://github.example/o/r/pull/7', number: 7 });
      if (u.startsWith('/repos/o/r/contents/')) return res.writeHead(404).end();
      return json(500, {});
    };
    const gh = new GitHubPrProvider({ baseUrl: base, repository: 'o/r', token: async () => 'ghp_sintetico', protectedBranch: 'main' });
    expect(await gh.readFile('main', 'katalyst.manifest.json')).toBeNull();
    const r = await gh.openChange({
      baseBranch: 'main',
      branch: 'katalyst/grabacion/c1-abcdef12',
      commitMessage: 'm',
      files: [{ path: 'tests/grabaciones/c1-abcdef12.spec.ts', content: 'x' }],
      title: 't',
      body: 'b',
      draft: true,
    });
    expect(r).toEqual({ branch: 'katalyst/grabacion/c1-abcdef12', commit: 'commit1', url: 'https://github.example/o/r/pull/7', number: 7 });
    expect(seen.every((s) => !s.url.includes('ghp_sintetico') && s.headers.authorization === 'Bearer ghp_sintetico')).toBe(true);
    expect(seen.some((s) => /merge/.test(s.url))).toBe(false);
    expect(JSON.parse(seen.find((s) => s.url === '/repos/o/r/pulls')!.body)).toMatchObject({ draft: true, head: 'katalyst/grabacion/c1-abcdef12', base: 'main' });
    await expect(gh.openChange({ baseBranch: 'main', branch: 'main', commitMessage: 'm', files: [], title: 't', body: 'b', draft: true })).rejects.toBeInstanceOf(GitProviderError);
    await expect(gh.readFile('main', '../etc/passwd')).rejects.toBeInstanceOf(GitProviderError);
  });

  it('RF-GRB-02 GitLab: commit con start_branch y MR "Draft:"; token en PRIVATE-TOKEN', async () => {
    seen.length = 0;
    handler = (req, _b, res) => {
      const u = req.url!;
      const json = (s: number, v: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (u.includes('/repository/files/')) return res.writeHead(404).end();
      if (u.endsWith('/repository/commits')) return json(201, { id: 'c0ffee' });
      if (u.endsWith('/merge_requests')) return json(201, { web_url: 'https://gitlab.example/g/p/-/merge_requests/3', iid: 3 });
      return json(500, {});
    };
    const gl = new GitLabPrProvider({ baseUrl: base, repository: 'g/p', token: async () => 'glpat-sintetico', protectedBranch: 'main' });
    const r = await gl.openChange({ baseBranch: 'main', branch: 'katalyst/ia/c1-11112222', commitMessage: 'm', files: [{ path: 'a.spec.ts', content: 'x' }], title: 'T', body: 'b', draft: true });
    expect(r.url).toContain('merge_requests/3');
    const commit = JSON.parse(seen.find((s) => s.url.endsWith('/repository/commits'))!.body);
    expect(commit).toMatchObject({ branch: 'katalyst/ia/c1-11112222', start_branch: 'main', actions: [{ action: 'create', file_path: 'a.spec.ts' }] });
    expect(JSON.parse(seen.find((s) => s.url.endsWith('/merge_requests'))!.body).title).toBe('Draft: T');
    expect(seen.every((s) => s.headers['private-token'] === 'glpat-sintetico')).toBe(true);
  });

  it('RF-GRB-05 adaptador local: nunca escribe la rama protegida ni rutas con traversal', async () => {
    const git = new LocalGitPrProvider(createLocalRepo(), 'main');
    await expect(git.pushToBranch({ branch: 'main', commitMessage: 'x', files: [] })).rejects.toBeInstanceOf(GitProviderError);
    await expect(
      git.openChange({ baseBranch: 'main', branch: 'katalyst/x', commitMessage: 'x', files: [{ path: '../fuera.ts', content: '' }], title: 't', body: 'b', draft: true }),
    ).rejects.toBeInstanceOf(GitProviderError);
    expect(await git.readFile('main', 'katalyst.manifest.json')).toContain('"schemaVersion": 1');
  });
});
