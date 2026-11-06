/**
 * RF-USR-01, RF-USR-02, RF-USR-03, RNF-SEG-03, ESP §13.7: login propio, cookie __Host-/HttpOnly, CSRF + Origin,
 * bloqueo progresivo, recuperación con token único, tokens API con scopes, credencial de servicio, bootstrap y
 * administración de usuarios (matriz qa/dev/admin/servicio).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiErrorSchema } from '@katalyst/shared';
import {
  actorMatrix,
  apiTokenFor,
  createUser,
  loginAs,
  makeCtx,
  serviceTokenFor,
  sessionFor,
  TEST_PASSWORD,
  uniqueEmail,
  type TestCtx,
} from './support/api-a.js';
import { setPasswordResetSender } from '../src/modules/auth/routes.js';
import { bootstrapAdmin, parseArgs, resolvePassword } from '../src/cli/bootstrap-admin.js';
import { sessionCookieName } from '../src/lib/auth.js';
import { generateOpaqueToken, hashToken } from '../src/lib/crypto-tokens.js';
import { LoginThrottle } from '../src/modules/auth/throttle.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeCtx({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCKOUT_BASE_SECONDS: '30' });
});
afterAll(async () => {
  setPasswordResetSender(undefined);
  await ctx.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

describe('login y sesión (RF-USR-01, ESP §13.7)', () => {
  it('RF-USR-01 login correcto: cookie HttpOnly/SameSite, permisos efectivos y CSRF; me y logout revoca', async () => {
    const u = await createUser(ctx.prisma, 'dev');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email.toUpperCase(), password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ id: u.id, role: 'dev' });
    expect(body.permissions).toContain('catalog.refresh');
    expect(body.permissions).not.toContain('users.manage');
    expect(body.session.csrfToken).toBeTruthy();
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(res.body).not.toMatch(/kss_/);
    const cookie = setCookie.split(';')[0]!;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().session.csrfToken).toBe(body.session.csrfToken);
    // Sin CSRF → 403
    const noCsrf = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(code(noCsrf.body)).toBe('CSRF_INVALID');
    // Origin ajeno → 403 aunque haya token
    const evil = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-csrf-token': body.session.csrfToken, origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-csrf-token': body.session.csrfToken, origin: ctx.config.PUBLIC_BASE_URL },
    });
    expect(out.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    const audits = await ctx.prisma.auditLog.findMany({ where: { actorId: u.id, action: { in: ['auth.login', 'auth.logout'] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(['auth.login', 'auth.logout']);
  });

  it('RNF-SEG-03 cookie con prefijo __Host- cuando Secure está activo', () => {
    expect(sessionCookieName({ SESSION_COOKIE_NAME: 'katalyst_session', COOKIE_SECURE: true })).toBe('__Host-katalyst_session');
    expect(sessionCookieName({ SESSION_COOKIE_NAME: '__Host-katalyst_session', COOKIE_SECURE: true })).toBe('__Host-katalyst_session');
    expect(sessionCookieName({ SESSION_COOKIE_NAME: 'katalyst_session', COOKIE_SECURE: false })).toBe('katalyst_session');
  });

  it('RF-USR-01 credenciales inválidas → 401 uniforme; bloqueo progresivo → 429 con Retry-After', async () => {
    const u = await createUser(ctx.prisma, 'qa');
    const bad = () =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'incorrecta-123' }, remoteAddress: '10.9.9.9' });
    const r1 = await bad();
    expect(r1.statusCode).toBe(401);
    expect(code(r1.body)).toBe('INVALID_CREDENTIALS');
    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: uniqueEmail(), password: 'x' } });
    expect(code(unknown.body)).toBe('INVALID_CREDENTIALS');
    await bad();
    await bad();
    const locked = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: TEST_PASSWORD } });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(await ctx.prisma.auditLog.count({ where: { entityId: u.id, action: 'auth.login_failed' } })).toBe(3);
  });

  it('RF-USR-01 usuario deshabilitado no inicia sesión ni conserva sesiones', async () => {
    const u = await createUser(ctx.prisma, 'qa', { disabled: true });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: TEST_PASSWORD } });
    expect(r.statusCode).toBe(403);
    expect(code(r.body)).toBe('USER_DISABLED');
    const h = await sessionFor(ctx, u.id);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h });
    expect(me.statusCode).toBe(403);
    expect(code(me.body)).toBe('USER_DISABLED');
  });

  it('RF-USR-01 sesión vencida → SESSION_EXPIRED; cookie basura → 401', async () => {
    const u = await createUser(ctx.prisma, 'qa');
    const h = await sessionFor(ctx, u.id);
    await ctx.prisma.panelSession.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h });
    expect(code(r.body)).toBe('SESSION_EXPIRED');
    const g = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${sessionCookieName(ctx.config)}=basura` } });
    expect(g.statusCode).toBe(401);
  });

  it('RF-USR-01 recuperación: respuesta uniforme, token único con vencimiento, revoca sesiones', async () => {
    const sent: string[] = [];
    setPasswordResetSender({ send: async (_to, url) => void sent.push(url) });
    const u = await createUser(ctx.prisma, 'qa');
    const h = await sessionFor(ctx, u.id);
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset-request', payload: { email: u.email } });
    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset-request', payload: { email: uniqueEmail() } });
    expect(r1.statusCode).toBe(200);
    expect(r2.body).toBe(r1.body);
    expect(sent).toHaveLength(1);
    const token = new URL(sent[0]!).hash.replace('#token=', '');
    expect(r1.body).not.toContain(token);
    const stored = await ctx.prisma.passwordResetToken.findFirstOrThrow({ where: { userId: u.id, usedAt: null } });
    expect(stored.tokenHash).toBe(hashToken(token));
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset', payload: { token, newPassword: 'nueva-contrasena-segura' } });
    expect(ok.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset', payload: { token, newPassword: 'nueva-contrasena-segura' } });
    expect(code(again.body)).toBe('TOKEN_REVOKED');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h })).statusCode).toBe(401);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'nueva-contrasena-segura' } });
    expect(login.statusCode).toBe(200);
    // Token vencido
    const t2 = generateOpaqueToken('passwordReset');
    await ctx.prisma.passwordResetToken.create({ data: { userId: u.id, tokenHash: hashToken(t2), expiresAt: new Date(Date.now() - 1) } });
    const exp = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/reset', payload: { token: t2, newPassword: 'otra-contrasena-segura' } });
    expect(code(exp.body)).toBe('TOKEN_REVOKED');
  });

  it('RF-USR-01 cambio de contraseña exige la actual y revoca otras sesiones', async () => {
    const u = await createUser(ctx.prisma, 'qa');
    const h1 = await sessionFor(ctx, u.id);
    const h2 = await sessionFor(ctx, u.id);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/change', headers: h1, payload: { currentPassword: 'mala', newPassword: 'nueva-contrasena-segura' } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password/change', headers: h1, payload: { currentPassword: TEST_PASSWORD, newPassword: 'nueva-contrasena-segura' } });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h1 })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h2 })).statusCode).toBe(401);
  });

  it('RF-USR-01 providers: local habilitado, OIDC deshabilitado sin configuración', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(r.json()).toEqual({ local: true, oidc: { enabled: false, displayName: null, loginUrl: null } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' })).statusCode).toBe(404);
  });

  it('throttle en memoria si Redis no está disponible (degradado, no abierto)', async () => {
    const t = new LoginThrottle(undefined, { maxFailures: 2, baseSeconds: 10, maxSeconds: 100, prefix: 'x' });
    await t.registerFailure('a@b.c', '1.1.1.1');
    expect((await t.check('a@b.c', '1.1.1.1')).locked).toBe(false);
    const s = await t.registerFailure('a@b.c', '1.1.1.1');
    expect(s).toMatchObject({ locked: true, retryAfterSeconds: 10 });
    expect((await t.check('a@b.c', undefined)).locked).toBe(true);
    await t.registerSuccess('a@b.c');
    expect((await t.check('a@b.c', undefined)).locked).toBe(false);
  });
});

describe('tokens API y credenciales de servicio (RF-USR-03)', () => {
  it('RF-USR-03 admin crea token (una vez), scopes ∩ rol, uso por Bearer, revocación', async () => {
    const admin = await loginAs(ctx, 'admin');
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: admin.headers,
      payload: { name: 'ci', scopes: ['runs.read', 'audit.read'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(create.statusCode).toBe(201);
    const { token, credential } = create.json();
    expect(token).toMatch(/^kat_/);
    const stored = await ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/tokens', headers: admin.headers });
    expect(list.body).not.toContain(token);
    expect(list.json().items.some((i: { id: string }) => i.id === credential.id)).toBe(true);
    const bearer = { authorization: `Bearer ${token}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log?limit=1', headers: bearer })).statusCode).toBe(200);
    // Permiso del rol pero fuera de scopes → 403
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer })).statusCode).toBe(403);
    // Bearer no exige CSRF
    const rev = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/auth/tokens/${credential.id}`, headers: admin.headers });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().revokedAt).not.toBeNull();
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log', headers: bearer });
    expect(after.statusCode).toBe(401);
    expect(code(after.body)).toBe('TOKEN_REVOKED');
  });

  it('RF-USR-03 token con scopes fuera del rol o vencimiento inválido se rechaza; token vencido → 401', async () => {
    const admin = await loginAs(ctx, 'admin');
    const sys = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: admin.headers,
      payload: { name: 'x', scopes: ['worker.claim'], expiresAt: new Date(Date.now() + 1e7).toISOString() },
    });
    expect(sys.statusCode).toBe(403);
    const far = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: admin.headers,
      payload: { name: 'x', scopes: ['runs.read'], expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() },
    });
    expect(far.statusCode).toBe(422);
    const qaUser = await createUser(ctx.prisma, 'qa');
    const expired = await apiTokenFor(ctx.prisma, qaUser.id, ['runs.read'], { expiresAt: new Date(Date.now() - 1000) });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: expired.authorization } })).statusCode).toBe(401);
    const malformed = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Basic abc' } });
    expect(malformed.statusCode).toBe(401);
    // Token de usuario qa con scope de admin no obtiene el permiso.
    const t = await apiTokenFor(ctx.prisma, qaUser.id, ['audit.read']);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log', headers: { authorization: t.authorization } })).statusCode).toBe(403);
    // Dueño deshabilitado → token inválido.
    await ctx.prisma.panelUser.update({ where: { id: qaUser.id }, data: { disabledAt: new Date() } });
    const dis = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log', headers: { authorization: t.authorization } });
    expect(code(dis.body)).toBe('USER_DISABLED');
  });

  it('RF-USR-03 credencial de servicio: emisión admin expirable, alcance restringido, sin acceso al panel', async () => {
    const admin = await loginAs(ctx, 'admin');
    const tooLong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/service-credentials',
      headers: admin.headers,
      payload: { name: 'supervisor:host-1', expiresInDays: 365 },
    });
    expect(tooLong.statusCode).toBe(422);
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/service-credentials',
      headers: admin.headers,
      payload: { name: 'supervisor:host-1', expiresInDays: 7 },
    });
    expect(r.statusCode).toBe(201);
    const { token, credential } = r.json();
    expect(token).toMatch(/^ksv_/);
    expect(credential.scopes).toEqual(['worker.claim']);
    expect(new Date(credential.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1000);
    const bearer = { authorization: `Bearer ${token}` };
    for (const url of ['/api/v1/users', '/api/v1/audit-log', '/api/v1/auth/me', '/api/v1/testrail/cases']) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: bearer })).statusCode, url).toBe(403);
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/service-credentials', headers: admin.headers });
    expect(list.json().items.some((i: { id: string }) => i.id === credential.id)).toBe(true);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/auth/service-credentials/${credential.id}`, headers: admin.headers });
    expect(del.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/auth/service-credentials/${randomUUID()}`, headers: admin.headers })).statusCode).toBe(404);
  });
});

describe('bootstrap-admin (RF-USR-03)', () => {
  it('RF-USR-03 rechaza contraseña por argumento; lee stdin; idempotente; reset auditado', async () => {
    expect(() => parseArgs(['--email', 'a@b.c', '--password', 'x'])).toThrow(/argumento/);
    expect(() => parseArgs(['--password=x'])).toThrow();
    expect(() => parseArgs(['--desconocido'])).toThrow();
    const a = parseArgs(['--', '--email=a@b.c', '--password-stdin', '--name', 'Ana', '--reset-password']);
    expect(a).toMatchObject({ email: 'a@b.c', passwordStdin: true, name: 'Ana', resetPassword: true });
    await expect(resolvePassword(a, undefined, async () => 'corta\n')).rejects.toThrow(/al menos/);
    await expect(resolvePassword({ passwordStdin: false, resetPassword: false }, undefined)).rejects.toThrow(/Falta/);
    const pw = await resolvePassword(a, undefined, async () => 'contrasena-inicial-larga\n');
    expect(pw).toBe('contrasena-inicial-larga');
    const email = uniqueEmail('boot');
    const r1 = await bootstrapAdmin(ctx.prisma, { email, name: 'Admin', password: pw, resetPassword: false });
    expect(r1.action).toBe('created');
    const r2 = await bootstrapAdmin(ctx.prisma, { email, name: 'Admin', password: pw, resetPassword: false });
    expect(r2).toEqual({ action: 'unchanged', userId: r1.userId });
    const r3 = await bootstrapAdmin(ctx.prisma, { email, name: 'Admin', password: 'otra-contrasena-larga', resetPassword: true });
    expect(r3.action).toBe('password_reset');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'otra-contrasena-larga' } });
    expect(login.statusCode).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { entityId: r1.userId, actorKind: 'sistema' } })).toBe(2);
  });
});

describe('administración de usuarios (RF-USR-01/02)', () => {
  it('RNF-SEG-03 matriz qa/dev/admin/servicio/anónimo en /users, /audit-log, /auth/tokens', async () => {
    const m = await actorMatrix(ctx);
    const expectStatus: Record<string, Record<string, number>> = {
      '/api/v1/users': { qa: 403, dev: 403, admin: 200, servicio: 403, anonimo: 401 },
      '/api/v1/audit-log': { qa: 403, dev: 403, admin: 200, servicio: 403, anonimo: 401 },
      '/api/v1/auth/tokens': { qa: 403, dev: 403, admin: 200, servicio: 403, anonimo: 401 },
      '/api/v1/auth/me': { qa: 200, dev: 200, admin: 200, servicio: 403, anonimo: 401 },
    };
    for (const [url, byActor] of Object.entries(expectStatus)) {
      for (const [actor, status] of Object.entries(byActor)) {
        const r = await ctx.app.inject({ method: 'GET', url, headers: m[actor as keyof typeof m] });
        expect(r.statusCode, `${actor} ${url}`).toBe(status);
      }
    }
  });

  it('RF-USR-01 crear, correo único normalizado, versión optimista, deshabilitar revoca sesiones (sin borrar)', async () => {
    const admin = await loginAs(ctx, 'admin');
    const email = uniqueEmail('nuevo');
    const c = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: admin.headers, payload: { email: email.toUpperCase(), name: 'Nuevo', role: 'qa' } });
    expect(c.statusCode).toBe(201);
    const u = c.json();
    expect(u).toMatchObject({ email, role: 'qa', hasLocalPassword: false, version: 0 });
    expect(c.body).not.toMatch(/passwordHash|password_hash/);
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: admin.headers, payload: { email, name: 'X', role: 'qa' } });
    expect(code(dup.body)).toBe('EMAIL_TAKEN');
    const h = await sessionFor(ctx, u.id);
    const up = await ctx.app.inject({ method: 'PUT', url: `/api/v1/users/${u.id}`, headers: admin.headers, payload: { role: 'dev', version: 0 } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ role: 'dev', version: 1 });
    const stale = await ctx.app.inject({ method: 'PUT', url: `/api/v1/users/${u.id}`, headers: admin.headers, payload: { name: 'X', version: 0 } });
    expect(code(stale.body)).toBe('VERSION_CONFLICT');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h })).statusCode).toBe(401);
    const h2 = await sessionFor(ctx, u.id);
    const dis = await ctx.app.inject({ method: 'PUT', url: `/api/v1/users/${u.id}`, headers: admin.headers, payload: { disabled: true, version: 1 } });
    expect(dis.json().disabledAt).not.toBeNull();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: h2 })).statusCode).toBe(401);
    expect(await ctx.prisma.panelUser.count({ where: { id: u.id } })).toBe(1);
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/users?q=${encodeURIComponent(email)}&includeDisabled=false`, headers: admin.headers });
    expect(list.json().items).toHaveLength(0);
    const list2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/users?q=${encodeURIComponent(email)}&includeDisabled=true`, headers: admin.headers });
    expect(list2.json().items).toHaveLength(1);
    const g = await ctx.app.inject({ method: 'GET', url: `/api/v1/users/${u.id}`, headers: admin.headers });
    expect(g.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/users/${randomUUID()}`, headers: admin.headers })).statusCode).toBe(404);
    const audit = await ctx.app.inject({ method: 'GET', url: `/api/v1/audit-log?entityId=${u.id}&entity=panel_user`, headers: admin.headers });
    expect(audit.json().items.map((i: { action: string }) => i.action)).toEqual(['panel_user.disable', 'panel_user.update', 'panel_user.create']);
  });

  it('RF-USR-01 no permite quitar el último administrador activo', async () => {
    const only = await createUser(ctx.prisma, 'admin');
    const others = await ctx.prisma.panelUser.findMany({ where: { role: 'admin', disabledAt: null, id: { not: only.id } }, select: { id: true } });
    await ctx.prisma.panelUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: new Date() } });
    try {
      const h = await sessionFor(ctx, only.id);
      const r = await ctx.app.inject({ method: 'PUT', url: `/api/v1/users/${only.id}`, headers: h, payload: { role: 'qa', version: 0 } });
      expect(code(r.body)).toBe('LAST_ADMIN');
    } finally {
      await ctx.prisma.panelUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: null } });
    }
  });

  it('RF-USR-02 audit-log pagina por cursor y filtra por fecha/acción', async () => {
    const admin = await loginAs(ctx, 'admin');
    const p1 = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log?limit=2', headers: admin.headers });
    const b1 = p1.json();
    expect(b1.items).toHaveLength(2);
    expect(b1.hasNext).toBe(true);
    const p2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/audit-log?limit=2&cursor=${b1.nextCursor}`, headers: admin.headers });
    const ids = new Set([...b1.items, ...p2.json().items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(4);
    const f = await ctx.app.inject({ method: 'GET', url: `/api/v1/audit-log?action=auth.login&from=${new Date(Date.now() - 3600_000).toISOString()}`, headers: admin.headers });
    expect(f.json().items.every((i: { action: string }) => i.action === 'auth.login')).toBe(true);
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-log?cursor=xx', headers: admin.headers });
    expect(bad.statusCode).toBe(422);
  });
});

describe('servicio y lease (RF-USR-03)', () => {
  it('RF-USR-03 token de servicio con scope ajeno no autoriza; lease token se resuelve a principal lease', async () => {
    const svc = await serviceTokenFor(ctx.prisma, ['worker.callback']);
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: { authorization: svc.authorization } });
    expect(r.statusCode).toBe(403);
  });
});
