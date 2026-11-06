import { describe, expect, it } from 'vitest';
import {
  applyTextRules,
  isPlaceholder,
  isSensitiveName,
  knownSecretRule,
  normalizeName,
  REDACTED,
  redactedFor,
  sanitizeErrorMessage,
  sanitizeHeaders,
  sanitizeHtml,
  sanitizeJson,
  sanitizeText,
  sanitizeUrl,
  summarizeFindings,
  verifySanitized,
} from '../src/sanitize/index.js';

// Valores sintéticos (nunca reales). RNF-SEG-01.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYS1hdXRvIiwiZXhwIjoxfQ.c2lnbmF0dXJlLXNpbnRldGljYQ';
const CANARY = 'KATALYST_CANARY_TOKEN_7f3a';
const AWS_ID = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const EMAIL = 'qa.persona@empresa-ejemplo.com';
const GH = 'ghp_' + 'a'.repeat(36);

function noLeak(value: string, ...secrets: string[]) {
  for (const s of secrets) expect(value).not.toContain(s);
}

describe('RNF-SEG-02 sanitizeText', () => {
  it('enmascara JWT, Bearer, Basic, cookies, AWS, correos, canarios, tokens de proveedores, claves privadas', () => {
    const input = [
      `Authorization: Bearer ${JWT}`,
      `token suelto ${JWT}`,
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'Cookie: session=abc123; other=def',
      'Set-Cookie: sid=xyz; HttpOnly',
      `aws key ${AWS_ID}`,
      `aws_secret_access_key=${AWS_SECRET}`,
      `contacto ${EMAIL}`,
      `canario ${CANARY}`,
      `github ${GH}`,
      'slack xoxb-1234567890-abcdefghij',
      'anthropic sk-ant-abcdefghijklmnopqrstuvwx',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----',
      'url https://usuario:clave@host.ejemplo/ruta',
      'password=Sup3rS3creta! y "apiKey": "abc-123" y token: xyz789',
    ].join('\n');
    const { value, findings } = sanitizeText(input);
    noLeak(
      value,
      JWT,
      CANARY,
      AWS_ID,
      AWS_SECRET,
      EMAIL,
      GH,
      'Sup3rS3creta!',
      'abc-123',
      'xyz789',
      'dXNlcjpwYXNzd29yZA',
      'session=abc123',
      'MIIBOgIBAAJBAK',
      'usuario:clave',
    );
    const kinds = new Set(findings.map((f) => f.kind));
    for (const k of [
      'bearer',
      'jwt',
      'basic_auth',
      'cookie',
      'aws_access_key',
      'aws_secret_key',
      'email',
      'canary',
      'provider_token',
      'private_key',
      'url_credentials',
      'secret_assignment',
    ]) {
      expect(kinds.has(k as never)).toBe(true);
    }
    expect(value).toContain('Bearer [REDACTED:bearer]');
    expect(value).toContain(redactedFor('canary'));
  });

  it('es idempotente y el resultado pasa la verificación', () => {
    const input = `Authorization: Bearer ${JWT}\npassword: "x1y2z3"\n${EMAIL} ${CANARY}\nCookie: a=b`;
    const once = sanitizeText(input).value;
    const twice = sanitizeText(once);
    expect(twice.value).toBe(once);
    expect(twice.findings).toEqual([]);
    expect(verifySanitized(once).ok).toBe(true);
  });

  it('no altera texto inocuo ni valores nulos/booleanos', () => {
    const s = 'Órdenes de carga: 42 filas; typeOperation=distribution; token=null; secret=true; foto@2x.png';
    expect(sanitizeText(s).value).toBe(s);
    expect(sanitizeText('password=').value).toBe('password=');
  });

  it('secretos conocidos se enmascaran literalmente (contraseña del usuario de prueba)', () => {
    const r = sanitizeText('login con Qa#Pass2026 falló', { knownSecrets: ['Qa#Pass2026', 'abc'] });
    expect(r.value).toBe('login con [REDACTED:known_secret] falló');
    expect(knownSecretRule([])).toBeNull();
    expect(knownSecretRule(['ab'])).toBeNull();
  });

  it('sanitizeErrorMessage trunca', () => {
    expect(sanitizeErrorMessage('a'.repeat(100), 10)).toHaveLength(10);
    expect(sanitizeErrorMessage(`fallo ${EMAIL}`)).toBe('fallo [REDACTED:email]');
  });

  it('detección sin mutar', () => {
    const r = applyTextRules(`x ${JWT}`, 't', { mutate: false });
    expect(r.value).toContain(JWT);
    expect(r.findings[0]).toMatchObject({ kind: 'jwt', location: 't', count: 1 });
  });
});

describe('RNF-SEG-02 nombres sensibles', () => {
  it.each([
    'password',
    'X-Api-Key',
    'access_token',
    'id_token',
    'sessionId',
    'Set-Cookie',
    'clientSecret',
    'storageState',
    'X-Amz-Signature',
    'sig',
    'code',
    'otp',
  ])('%s es sensible', (n) => expect(isSensitiveName(n)).toBe(true));
  it.each(['statusCode', 'typeOperation', 'name', 'zipCode', 'tokenType', 'author', 'barcode', ''])(
    '%s no es sensible',
    (n) => expect(isSensitiveName(n)).toBe(false),
  );
  it('normaliza y reconoce marcadores', () => {
    expect(normalizeName('X-Amz_Security-Token')).toBe('xamzsecuritytoken');
    expect(isPlaceholder('[REDACTED]')).toBe(true);
    expect(isPlaceholder('"[REDACTED:jwt]"')).toBe(true);
    expect(isPlaceholder('REDACTED')).toBe(false);
  });
});

describe('RNF-SEG-02 sanitizeUrl', () => {
  it('query y fragmento sensibles, credenciales embebidas, tokens en valores y ruta', () => {
    const u = `https://user:pw@cbc.deltax.la/loadOrder/${EMAIL}?typeOperation=distribution&access_token=${JWT}&q=${encodeURIComponent(EMAIL)}#id_token=${JWT}&state=ok`;
    const { value, findings } = sanitizeUrl(u);
    noLeak(value, JWT, 'user:pw', EMAIL, encodeURIComponent(EMAIL));
    expect(value).toContain('typeOperation=distribution');
    expect(value).toContain('access_token=%5BREDACTED%5D');
    expect(findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['url_credentials', 'sensitive_query', 'email']),
    );
    expect(verifySanitized(value).ok).toBe(true);
  });
  it('URLs relativas y fragmentos sin pares', () => {
    expect(sanitizeUrl('/api/x?token=abc&page=2').value).toBe('/api/x?token=%5BREDACTED%5D&page=2');
    expect(sanitizeUrl('api/x?page=2').value).toBe('api/x?page=2');
    expect(sanitizeUrl(`https://h.la/p#${CANARY}`).value).not.toContain(CANARY);
    expect(sanitizeUrl('https://h.la/p#seccion').value).toBe('https://h.la/p#seccion');
    expect(sanitizeUrl('https://h.la/%E0%A4%A').value).toContain('h.la');
    expect(sanitizeUrl('http://[::1').value).toBe('http://[::1');
  });
  it('X-Amz-Signature en URL firmada', () => {
    const v = sanitizeUrl(
      'https://bucket.s3.amazonaws.com/k?X-Amz-Credential=AKIA&X-Amz-Signature=abcdef&X-Amz-Expires=300',
    ).value;
    expect(v).toContain('X-Amz-Signature=%5BREDACTED%5D');
    expect(v).toContain('X-Amz-Expires=300');
  });
});

describe('RNF-SEG-02 sanitizeJson (profundo)', () => {
  it('enmascara claves sensibles, encabezados {name,value}, cadenas y URLs anidadas', () => {
    const input = {
      user: { email: EMAIL, password: 'p4ss', profile: { nested: [{ apiKey: 'k', note: `see ${CANARY}` }] } },
      cookies: [{ name: 'sid', value: 'abc' }],
      origins: [{ origin: 'https://cbc.deltax.la', localStorage: [{ name: 'idToken', value: JWT }] }],
      request: {
        url: `https://fmsapi.deltax.la/x?token=${JWT}`,
        headers: [
          { name: 'Authorization', value: `Bearer ${JWT}` },
          { name: 'Accept', value: 'json' },
        ],
      },
      count: 3,
      ok: true,
      empty: null,
      blankPassword: '',
    };
    const { value, findings, complete } = sanitizeJson(input);
    const s = JSON.stringify(value);
    noLeak(s, JWT, CANARY, EMAIL, 'p4ss');
    expect(complete).toBe(true);
    expect((value as typeof input).user.password).toBe(REDACTED);
    expect((value as typeof input).cookies).toBe(REDACTED);
    expect((value as typeof input).request.headers[1]!.value).toBe('json');
    expect((value as typeof input).count).toBe(3);
    expect((value as typeof input).blankPassword).toBe('');
    expect(findings.length).toBeGreaterThan(3);
    expect(verifySanitized(value).ok).toBe(true);
  });
  it('ciclos, profundidad excedida y claves extra', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(sanitizeJson(a).value).toMatchObject({ self: '[CIRCULAR]' });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    const r = sanitizeJson(deep, { maxDepth: 5 });
    expect(r.complete).toBe(false);
    expect(r.findings.some((f) => f.kind === 'depth_exceeded')).toBe(true);
    expect(sanitizeJson({ rut: '123' }, { extraSensitiveKeys: ['RUT'] }).value).toEqual({ rut: REDACTED });
    expect(sanitizeJson('texto ' + EMAIL).value).toBe('texto [REDACTED:email]');
    expect(sanitizeJson(42).value).toBe(42);
  });
});

describe('RNF-SEG-02 sanitizeHeaders', () => {
  it('enmascara encabezados sensibles y sanitiza el resto', () => {
    const { value, findings } = sanitizeHeaders({
      Authorization: `Bearer ${JWT}`,
      'set-cookie': ['a=1', 'b=2'],
      'X-Trace': `id ${EMAIL}`,
      'content-length': 42,
      'x-csrf-token': '',
      'x-optional': undefined,
      Accept: ['text/html', 'application/json'],
    });
    expect(value.Authorization).toBe(REDACTED);
    expect(value['set-cookie']).toEqual([REDACTED, REDACTED]);
    expect(value['X-Trace']).toBe('id [REDACTED:email]');
    expect(value['content-length']).toBe(42);
    expect(value['x-csrf-token']).toBe(REDACTED);
    expect(value['x-optional']).toBeUndefined();
    expect(value.Accept).toEqual(['text/html', 'application/json']);
    expect(findings.filter((f) => f.kind === 'sensitive_header').map((f) => f.location)).toEqual([
      'authorization',
      'set-cookie',
    ]);
  });
});

describe('RNF-SEG-02 sanitizeHtml (atributos/inputs/DOM)', () => {
  it('vacía inputs y textarea, enmascara atributos y meta sensibles, URLs y texto', () => {
    const html = `<!doctype html><html><head><meta name="csrf-token" content="tok123"><meta name="viewport" content="width=device-width"></head>
<body data-user="${EMAIL}">
<form action="/login?token=abc"><input type="text" name="user" value="${EMAIL}"><input type='password' value='Secreta1'><input type="hidden" value=bare>
<textarea name="n">${CANARY}</textarea><select><option value="x">X</option></select>
<a href="https://h.la/cb#access_token=${JWT}">link</a><img src="/img.png"><div data-token="t0k" title="ok">Hola ${EMAIL} ${JWT}</div>
<script>window.__s = { "password": "p1" };</script><br/></form></body></html>`;
    const { value, findings } = sanitizeHtml(html);
    noLeak(value, EMAIL, 'Secreta1', 'tok123', CANARY, JWT, 't0k', '"p1"', 'token=abc', 'value=bare');
    expect(value).toContain('name="viewport" content="width=device-width"');
    expect(value).toContain('<img src="/img.png">');
    expect(value).toContain('title="ok"');
    expect(findings.some((f) => f.kind === 'input_value')).toBe(true);
    expect(verifySanitized(value).ok).toBe(true);
  });
  it('texto sin etiquetas', () => {
    expect(sanitizeHtml(`solo ${EMAIL}`).value).toBe('solo [REDACTED:email]');
  });
});

describe('RNF-SEG-02 verifySanitized bloquea publicación con hallazgos', () => {
  it('ensayo de canarios: token, cookie, dato personal y secreto canario sembrados', () => {
    const seeded = `{"trace":"Bearer ${JWT}","cookie":"sid=1","user":"${EMAIL}","note":"${CANARY}","nested":{"url":"https://x.la/?token=abc"}}`;
    const r = verifySanitized(seeded);
    expect(r.ok).toBe(false);
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds).toEqual(
      new Set(['bearer', 'jwt', 'sensitive_key', 'email', 'canary', 'sensitive_query', 'secret_assignment']),
    );
    // El resumen nunca contiene valores
    const summary = summarizeFindings(r.findings);
    noLeak(summary, JWT, EMAIL, CANARY);
    expect(summary).toMatch(/jwt×1/);
  });
  it('texto, HTML con input y objetos', () => {
    expect(verifySanitized('todo bien').ok).toBe(true);
    expect(verifySanitized('<input value="algo">').findings[0]!.kind).toBe('input_value');
    expect(verifySanitized({ a: [{ password: 'x' }] }).findings[0]).toMatchObject({
      kind: 'sensitive_key',
      location: 'a[0].password',
    });
    expect(verifySanitized({ storageState: { cookies: [] } }).ok).toBe(false);
    expect(verifySanitized({ password: REDACTED, n: null, x: 1 }).ok).toBe(true);
    expect(verifySanitized('{no es json').ok).toBe(true);
    const cyc: Record<string, unknown> = {};
    cyc.c = cyc;
    expect(verifySanitized(cyc).ok).toBe(true);
    expect(verifySanitized({ u: 'https://x.la/?token=%5BREDACTED%5D' }).ok).toBe(true);
    expect(verifySanitized('known Qa#2026', { knownSecrets: ['Qa#2026'] }).findings[0]!.kind).toBe('known_secret');
  });
});
