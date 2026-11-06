/**
 * Primitivas compartidas de apps/api/src/lib (API-A): SSRF (ESP §13.7), http-guard, crypto-tokens, pagination,
 * secrets, audit, events-publish, outbox (enqueue idempotente). RNF-SEG-01, RNF-SEG-03, RF-USR-02, RF-TR-08.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  assertUrlAllowed,
  classifyIp,
  hostMatches,
  isInternalClientIp,
  resolveAndCheck,
  SsrfBlockedError,
  type SsrfPolicy,
} from '../src/lib/ssrf.js';
import { HttpGuard, HttpGuardError, multipartBody } from '../src/lib/http-guard.js';
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  needsRehash,
  randomUserCode,
  safeEqual,
  tokenKindOf,
  verifyPassword,
} from '../src/lib/crypto-tokens.js';
import { decodePageCursor, encodePageCursor, keysetWhere, paginate, parseSort } from '../src/lib/pagination.js';
import { MemorySecretProvider, RefSecretProvider, SecretUnavailableError } from '../src/lib/secrets.js';
import { recordAudit, sanitizeAuditDiff, shallowDiff } from '../src/lib/audit.js';
import { publishEvent, runInTransaction, configureEventNotifier, subscribeEvents } from '../src/lib/events-publish.js';
import { enqueueOutbox } from '../src/lib/outbox.js';
import { renderMetrics, registerMetricsCollector, metrics } from '../src/lib/metrics.js';
import { createPrisma } from '../src/db.js';
import { createRedis } from '../src/redis.js';
import { testConfig } from './support/api-a.js';

describe('ssrf (ESP §13.7)', () => {
  const policy: SsrfPolicy = { allowedHosts: ['testrail.example.com', '*.staging.example.com'] };

  it('RNF-SEG-03 clasifica metadatos, loopback, RFC1918, CGNAT, IPv6 y formas embebidas', () => {
    expect(classifyIp('169.254.169.254')).toBe('metadata');
    expect(classifyIp('169.254.10.1')).toBe('link_local');
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('10.1.2.3')).toBe('private');
    expect(classifyIp('172.20.0.1')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
    expect(classifyIp('100.64.0.1')).toBe('cgnat');
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('0.0.0.0')).toBe('unspecified');
    expect(classifyIp('224.0.0.1')).toBe('multicast');
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('::')).toBe('unspecified');
    expect(classifyIp('::ffff:169.254.169.254')).toBe('metadata');
    expect(classifyIp('::ffff:10.0.0.1')).toBe('private');
    expect(classifyIp('64:ff9b::a9fe:a9fe')).toBe('metadata');
    expect(classifyIp('fd00:ec2::254')).toBe('metadata');
    expect(classifyIp('fc00::1')).toBe('private');
    expect(classifyIp('fe80::1')).toBe('link_local');
    expect(classifyIp('2002:0a00:0001::1')).toBe('reserved');
    expect(classifyIp('2606:4700:4700::1111')).toBe('public');
    expect(classifyIp('no-ip')).toBe('reserved');
    expect(isInternalClientIp('127.0.0.1')).toBe(true);
    expect(isInternalClientIp('8.8.8.8')).toBe(false);
    expect(isInternalClientIp(undefined)).toBe(false);
  });

  it('RNF-SEG-03 allowlist de hosts y esquemas, sin credenciales en URL', () => {
    expect(hostMatches('a.staging.example.com', ['*.staging.example.com'])).toBe(true);
    expect(hostMatches('staging.example.com', ['*.staging.example.com'])).toBe(false);
    expect(assertUrlAllowed('https://testrail.example.com/index.php?/api/v2', policy).hostname).toBe('testrail.example.com');
    const bad = (u: string, p: SsrfPolicy = policy) => {
      try {
        assertUrlAllowed(u, p);
        return null;
      } catch (e) {
        return e instanceof SsrfBlockedError ? e.reason : 'other';
      }
    };
    expect(bad('http://testrail.example.com')).toBe('scheme');
    expect(bad('https://evil.example.com')).toBe('host');
    expect(bad('https://user:pw@testrail.example.com')).toBe('credentials');
    expect(bad('not a url')).toBe('invalid_url');
    expect(bad('https://169.254.169.254/latest', { allowedHosts: [] })).toBe('ip');
    expect(bad('https://[::1]/', { allowedHosts: [] })).toBe('ip');
    expect(bad('https://localhost/', { allowedHosts: [] })).toBe('ip');
    expect(bad('https://8.8.8.8:8443/', { allowedHosts: [], allowedPorts: [443] })).toBe('port');
    expect(bad('https://localhost/', { allowedHosts: [], allowLoopback: true })).toBeNull();
  });

  it('RNF-SEG-03 verifica todas las direcciones DNS; excepción registrada para staging privado, nunca metadatos', async () => {
    const lookup = (map: Record<string, string[]>) => async (h: string) =>
      (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const l = lookup({
      'pub.example.com': ['93.184.216.34'],
      'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
      'priv.staging.example.com': ['10.0.0.8'],
      'meta.staging.example.com': ['169.254.169.254'],
    });
    await expect(resolveAndCheck('pub.example.com', { allowedHosts: [] }, l)).resolves.toHaveLength(1);
    await expect(resolveAndCheck('mixed.example.com', { allowedHosts: [] }, l)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndCheck('nx.example.com', { allowedHosts: [] }, l)).rejects.toMatchObject({ reason: 'dns' });
    const withException: SsrfPolicy = { allowedHosts: [], privateAllowedHosts: ['*.staging.example.com'] };
    await expect(resolveAndCheck('priv.staging.example.com', withException, l)).resolves.toHaveLength(1);
    await expect(resolveAndCheck('meta.staging.example.com', withException, l)).rejects.toMatchObject({
      category: 'metadata',
    });
  });
});

describe('http-guard (ESP §13.7, §13.4)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redir-meta') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      } else if (req.url === '/redir-ok') {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (req.url === '/slow') {
        req.resume();
        req.on('end', () => setTimeout(() => res.end('tarde'), 500));
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(2048));
      } else if (req.url === '/echo-auth') {
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const guard = () => new HttpGuard({ policy: { allowedHosts: [], allowLoopback: true, allowedSchemes: ['http'] } });

  it('RNF-SEG-03 sigue redirecciones válidas y bloquea redirección a metadatos', async () => {
    const ok = await guard().request(`${base}/redir-ok`);
    expect(ok.status).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    await expect(guard().request(`${base}/redir-meta`)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('RNF-SEG-03 bloquea loopback si no está permitido', async () => {
    const g = new HttpGuard({ policy: { allowedHosts: [], allowedSchemes: ['http'] } });
    await expect(g.request(`${base}/ok`)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('RF-TR-08 timeout tras enviar cuerpo POST es ambiguo; GET no lo es; límite de tamaño', async () => {
    const e1 = await guard()
      .request(`${base}/slow`, { method: 'POST', body: '{}', timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(HttpGuardError);
    expect((e1 as HttpGuardError).code).toBe('timeout');
    expect((e1 as HttpGuardError).ambiguous).toBe(true);
    const e2 = await guard().request(`${base}/slow`, { timeoutMs: 100 }).catch((e: unknown) => e);
    expect((e2 as HttpGuardError).ambiguous).toBe(false);
    const e3 = await guard().request(`${base}/big`, { maxResponseBytes: 100 }).catch((e: unknown) => e);
    expect((e3 as HttpGuardError).code).toBe('too_large');
    const e4 = await guard().request('http://127.0.0.1:1/x', { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect((e4 as HttpGuardError).code).toBe('network');
  });

  it('multipart con nombre de archivo saneado', () => {
    const m = multipartBody('attachment', '../x y.png', 'image/png', Buffer.from('abc'));
    expect(m.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(m.body.toString()).toContain('filename=".._x_y.png"');
  });
});

describe('crypto-tokens (RNF-SEG-01, RF-USR-03)', () => {
  it('RF-USR-03 tokens opacos con prefijo, solo hash persistible', () => {
    const t = generateOpaqueToken('apiToken');
    expect(t).toMatch(/^kat_[A-Za-z0-9_-]{43}$/);
    expect(tokenKindOf(t)).toBe('apiToken');
    expect(tokenKindOf(generateOpaqueToken('lease'))).toBe('lease');
    expect(tokenKindOf('kat_corto')).toBeNull();
    expect(tokenKindOf('x'.repeat(100))).toBeNull();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t.slice(4));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(randomUserCode()).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('RF-USR-01 argon2id: hash/verify, rechazo de hash ajeno y longitud', async () => {
    const h = await hashPassword('una-contrasena-larga');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=1024,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$2b$10$bcrypt')).toBe(true);
    await expect(verifyPassword(h, 'una-contrasena-larga')).resolves.toBe(true);
    await expect(verifyPassword(h, 'otra')).resolves.toBe(false);
    await expect(verifyPassword(null, 'x')).resolves.toBe(false);
    await expect(verifyPassword('$2b$basura', 'x')).resolves.toBe(false);
    await expect(hashPassword('corta')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('pagination (ESP §17.3)', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    title: `t${i}`,
    createdAt: new Date(Date.UTC(2026, 0, i + 1)),
  }));

  it('RNF-OPT-02 recorta a limit, cursor opaco ligado al orden, desempate por UUID', () => {
    const sort = parseSort('-createdAt', { createdAt: 'date', title: 'string' });
    expect(sort).toMatchObject({ field: 'createdAt', direction: 'desc', type: 'date' });
    const page = paginate(rows.slice(0, 3), 2, sort);
    expect(page.items).toHaveLength(2);
    expect(page.hasNext).toBe(true);
    const c = decodePageCursor(page.nextCursor, sort);
    expect(c).toEqual({ v: rows[1]!.createdAt.toISOString(), id: rows[1]!.id });
    expect(keysetWhere(sort, c)).toEqual({
      OR: [
        { createdAt: { lt: rows[1]!.createdAt } },
        { createdAt: rows[1]!.createdAt, id: { lt: rows[1]!.id } },
      ],
    });
    expect(keysetWhere(sort, null)).toEqual({});
    expect(paginate(rows.slice(0, 2), 2, sort)).toMatchObject({ hasNext: false, nextCursor: null });
    const other = parseSort('title', { createdAt: 'date', title: 'string' });
    expect(() => decodePageCursor(page.nextCursor, other)).toThrow();
    expect(() => decodePageCursor('basura!!', sort)).toThrow();
    expect(() => parseSort('nope', { title: 'string' })).toThrow();
    const num = parseSort('n', { n: { type: 'number', column: 'tr_case_id' } });
    expect(() => decodePageCursor(encodePageCursor({ id: rows[0]!.id, title: 'x' } as never, other), num)).toThrow();
  });
});

describe('secrets (RNF-SEG-01, ESP §13.7)', () => {
  it('RNF-SEG-01 env solo con prefijo KATALYST_SECRET__, file bajo el directorio, ssm bajo el prefijo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kat-secrets-'));
    await mkdir(join(dir, 'ok'));
    await writeFile(join(dir, 'ok', 'tr'), 'valor-archivo\n');
    const outside = await mkdtemp(join(tmpdir(), 'kat-outside-'));
    await writeFile(join(outside, 'x'), 'fuera');
    await symlink(join(outside, 'x'), join(dir, 'link'));
    const p = new RefSecretProvider({
      env: { KATALYST_SECRET__TR: 'valor-env', DATABASE_URL: 'postgres://no' },
      fileDir: dir,
      ssmPrefix: '/katalyst/internal',
      ssmGet: async (n) => (n === '/katalyst/internal/tr' ? 'valor-ssm' : undefined),
    });
    await expect(p.get('env:KATALYST_SECRET__TR')).resolves.toBe('valor-env');
    await expect(p.get('env:DATABASE_URL')).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(p.get('env:KATALYST_SECRET__NADA')).rejects.toMatchObject({ reason: 'not_found' });
    await expect(p.get(`file:${dir}/ok/tr`)).resolves.toBe('valor-archivo');
    await expect(p.get(`file:${outside}/x`)).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(p.get(`file:${dir}/link`)).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(p.get('ssm:/katalyst/internal/tr')).resolves.toBe('valor-ssm');
    await expect(p.get('ssm:/otro/tr')).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(p.get('nada')).rejects.toBeInstanceOf(SecretUnavailableError);
    const e = (await p.get('env:DATABASE_URL').catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain('postgres');
    const m = new MemorySecretProvider({ 'env:KATALYST_SECRET__A': 'a' });
    await expect(m.get('env:KATALYST_SECRET__A')).resolves.toBe('a');
    await expect(m.get('env:KATALYST_SECRET__B')).rejects.toBeInstanceOf(SecretUnavailableError);
    const restricted = new RefSecretProvider({ fileDir: dir, ssmPrefix: '/k', schemes: ['ssm'] });
    await expect(restricted.get('env:KATALYST_SECRET__TR')).rejects.toMatchObject({ reason: 'forbidden' });
  });
});

describe('audit, eventos y outbox con BD real', () => {
  const config = testConfig();
  const prisma = createPrisma(config, 'api');
  const redis = createRedis(config.REDIS_URL);
  const sub = createRedis(config.REDIS_URL);
  afterAll(async () => {
    configureEventNotifier(undefined);
    await prisma.$disconnect();
    redis.disconnect();
    sub.disconnect();
  });

  it('RF-USR-02 diff sanitizado conserva referencias de secretos y enmascara valores', () => {
    const d = sanitizeAuditDiff({
      secretRef: { from: 'env:KATALYST_SECRET__A', to: 'ssm:/katalyst/internal/b' },
      password: 'hunter2hunter2',
      passwordRef: 'no-es-ref',
      note: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno',
      when: new Date('2026-01-01T00:00:00Z'),
      n: 3,
      nested: { list: [{ token: 'x' }] },
    }) as Record<string, unknown>;
    expect(d.secretRef).toEqual({ from: 'env:KATALYST_SECRET__A', to: 'ssm:/katalyst/internal/b' });
    expect(d.password).toBe('[REDACTED]');
    expect(d.passwordRef).toBe('[REDACTED]');
    expect(String(d.note)).not.toContain('eyJ');
    expect(d.when).toBe('2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(d.nested)).not.toContain('"x"');
    expect(sanitizeAuditDiff(undefined)).toBeNull();
    expect(shallowDiff({ a: 1, b: 2 }, { a: 1, b: 3 }, ['a', 'b'])).toEqual({ b: { from: 2, to: 3 } });
  });

  it('RF-USR-02 recordAudit escribe en la transacción y rechaza acciones mal formadas', async () => {
    const entityId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, { actor: 'system', action: 'testrail.sync', entity: 'prueba', entityId, diff: { a: 1 } });
    });
    const row = await prisma.auditLog.findFirst({ where: { entityId } });
    expect(row).toMatchObject({ actorKind: 'sistema', actorDisplay: 'sistema', action: 'testrail.sync' });
    await expect(recordAudit(prisma, { actor: 'system', action: 'Mal', entity: 'x' })).rejects.toThrow();
    // Rollback: la auditoría no queda si la transacción falla.
    const rolled = randomUUID();
    await prisma
      .$transaction(async (tx) => {
        await recordAudit(tx, { actor: 'system', action: 'testrail.sync', entity: 'prueba', entityId: rolled });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await prisma.auditLog.count({ where: { entityId: rolled } })).toBe(0);
  });

  it('RF-EJE-02 publishEvent persiste con seq y notifica por Redis tras commit', async () => {
    const channel = `${config.QUEUE_PREFIX}:events`;
    configureEventNotifier({ redis, channel });
    const got: { seq: number; entityId: string }[] = [];
    const stop = await subscribeEvents(sub, (n) => got.push(n), channel);
    const entityId = randomUUID();
    await runInTransaction(prisma, async (tx) => {
      await publishEvent(tx, {
        type: 'testrail.sync',
        entity: 'testrail_sync_run',
        entityId,
        version: 1,
        data: { status: 'exitosa', token: 'no-debe-persistir' },
      });
    });
    const row = await prisma.eventLog.findFirst({ where: { entityId } });
    expect(row?.seq).toBeTypeOf('bigint');
    expect(JSON.stringify(row?.data)).not.toContain('no-debe-persistir');
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got.find((g) => g.entityId === entityId)?.seq).toBe(Number(row!.seq));
    // Rollback: ni fila ni notificación.
    const rolled = randomUUID();
    await runInTransaction(prisma, async (tx) => {
      await publishEvent(tx, { type: 'testrail.sync', entity: 'testrail_sync_run', entityId: rolled, version: 1, data: {} });
      throw new Error('rollback');
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.some((g) => g.entityId === rolled)).toBe(false);
    expect(await prisma.eventLog.count({ where: { entityId: rolled } })).toBe(0);
    await stop();
  });

  it('RF-TR-08 enqueueOutbox es idempotente por dedupKey sin abortar la transacción', async () => {
    const key = `prueba:${randomUUID()}`;
    const r = await prisma.$transaction(async (tx) => {
      const a = await enqueueOutbox(tx, { operation: 'notification.alert', dedupKey: key, payload: { a: 1 } });
      const b = await enqueueOutbox(tx, { operation: 'notification.alert', dedupKey: key, payload: { a: 2 } });
      await tx.auditLog.count();
      return { a, b };
    });
    expect(r.a.created).toBe(true);
    expect(r.b).toEqual({ id: r.a.id, created: false });
    const row = await prisma.outboxDelivery.findUniqueOrThrow({ where: { id: r.a.id } });
    expect(row).toMatchObject({ status: 'pendiente', attempts: 0, payload: { a: 1 } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(23 * 3600_000);
    await expect(enqueueOutbox(prisma, { operation: 'notification.alert', dedupKey: '', payload: {} })).rejects.toThrow();
    await prisma.outboxDelivery.update({ where: { id: r.a.id }, data: { status: 'cancelada' } });
  });

  it('RNF-OBS-01 métricas: colectores con timeout y exposición Prometheus', async () => {
    registerMetricsCollector('prueba_lenta', () => new Promise((r) => setTimeout(r, 5000)));
    registerMetricsCollector('prueba_falla', async () => {
      throw new Error('x');
    });
    metrics.authFailures.inc({ reason: 'prueba' });
    const t0 = Date.now();
    const text = await renderMetrics(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(text).toContain('katalyst_auth_failures_total');
    registerMetricsCollector('prueba_lenta', async () => {});
    registerMetricsCollector('prueba_falla', async () => {});
  });
});
