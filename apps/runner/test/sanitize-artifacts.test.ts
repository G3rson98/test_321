/**
 * Ensayo de canarios (ESP §13.7): token, cookie, dato personal y secreto sembrados en JSON / HTML / ZIP (traza y
 * reporte HTML de Playwright con ZIP embebido). Tras sanitizar no queda ningún canario; lo no sanitizable
 * (binario con metadatos sensibles) NO se sube y se registra el motivo. RNF-SEG-02, RF-RES-02, RNF-SEG-01.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { verifySanitized } from '@katalyst/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { sanitizeArtifactFile, sanitizeBuffer } from '../src/executor/artifacts/sanitize-artifact.js';
import { ArtifactUploader, kindForAttachment } from '../src/executor/artifacts/uploader.js';
import { readZip, writeZip } from '../src/executor/artifacts/zip.js';
import { STAGING_POLICY } from './helpers/assignment.js';
import { FakeWorkerApi } from './helpers/fake-api.js';
import { silentLogger } from './helpers/logger.js';

const CANARY = {
  token: 'KATALYST_CANARY_TOKEN_7f3a9c',
  cookie: 'KATALYST_CANARY_COOKIE_51be',
  email: 'katalyst.canary.persona@ejemplo-cliente.com',
  secret: 'KATALYST_CANARY_SECRET_d00d',
  password: 'Contraseña-De-Prueba-91',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2lnbmF0dXJh',
};
const ALL = Object.values(CANARY);

function containsAny(buf: Buffer | string): string[] {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  return ALL.filter((c) => s.includes(c));
}

function allText(entries: ReturnType<typeof readZip>): string {
  return entries.map((e) => e.data.toString('utf8')).join('\n');
}

const opts = { knownSecrets: [CANARY.password] };

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ksan-'));
});

describe('sanitización de artefactos con canarios (ESP §13.7)', () => {
  it('JSON (reporte de Playwright): claves sensibles, Bearer, cookie, correo, canarios y contraseña conocida', () => {
    const report = {
      config: { metadata: {} },
      suites: [
        {
          specs: [
            {
              title: 'C1',
              tests: [
                {
                  results: [
                    {
                      errors: [{ message: `Falló con Authorization: Bearer ${CANARY.token} y Cookie: session=${CANARY.cookie}` }],
                      stdout: [{ text: `usuario ${CANARY.email} password=${CANARY.password}` }],
                      attachments: [{ name: 'datos', body: CANARY.secret }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      headers: [{ name: 'x-api-key', value: CANARY.secret }],
      idToken: CANARY.jwt,
    };
    const r = sanitizeBuffer('results.json', 'application/json', Buffer.from(JSON.stringify(report, null, 2)), opts);
    expect(r.ok).toBe(true);
    expect(containsAny(r.data)).toEqual([]);
    expect(verifySanitized(r.data.toString('utf8')).ok).toBe(true);
    expect(JSON.parse(r.data.toString('utf8')).suites[0].specs[0].title).toBe('C1');
  });

  it('HTML (snapshot DOM): valores de input, atributos sensibles, texto y meta', () => {
    const html = `<!doctype html><html><head><meta name="csrf-token" content="${CANARY.secret}"></head>
      <body><form><input name="email" value="${CANARY.email}"><input type="password" value="${CANARY.password}">
      <textarea>${CANARY.token}</textarea></form><div data-token="${CANARY.token}">Hola ${CANARY.email}</div>
      <a href="https://app.ejemplo.test/cb?access_token=${CANARY.token}">x</a><p>Cookie: id=${CANARY.cookie}</p></body></html>`;
    const r = sanitizeBuffer('snapshot.html', 'text/html', Buffer.from(html), opts);
    expect(r.ok).toBe(true);
    expect(containsAny(r.data)).toEqual([]);
  });

  it('ZIP de traza (trace.trace/trace.network JSONL + recursos HTML) se reescribe sin canarios', () => {
    const traceLines = [
      { type: 'context-options', options: { storageState: { cookies: [{ name: 'sid', value: CANARY.cookie }] } } },
      { type: 'action', method: 'fill', params: { selector: '#password', value: CANARY.password } },
      { type: 'log', message: `navegando con ${CANARY.email}` },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const network = JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        request: { url: `https://api.ejemplo.test/x?token=${CANARY.token}`, headers: [{ name: 'Authorization', value: `Bearer ${CANARY.jwt}` }] },
        response: { headers: [{ name: 'set-cookie', value: `sid=${CANARY.cookie}; HttpOnly` }], content: { text: CANARY.secret } },
      },
    });
    const zip = writeZip([
      { name: 'trace.trace', data: Buffer.from(traceLines), isDirectory: false },
      { name: 'trace.network', data: Buffer.from(network), isDirectory: false },
      { name: 'resources/', data: Buffer.alloc(0), isDirectory: true },
      { name: 'resources/3f2a1b.html', data: Buffer.from(`<div>${CANARY.email}</div><input value="${CANARY.password}">`), isDirectory: false },
    ]);
    expect(containsAny(allText(readZip(zip))).length).toBeGreaterThan(0);
    const r = sanitizeBuffer('trace.zip', 'application/zip', zip, opts);
    expect(r.ok).toBe(true);
    const out = readZip(r.data);
    expect(out.map((e) => e.name)).toEqual(['trace.trace', 'trace.network', 'resources/', 'resources/3f2a1b.html']);
    expect(containsAny(allText(out))).toEqual([]);
  });

  it('reporte HTML de Playwright: el ZIP base64 embebido se sanitiza y el visor (<script>) se conserva', () => {
    const inner = writeZip([
      { name: 'report.json', data: Buffer.from(JSON.stringify({ files: [{ errors: [`token=${CANARY.token} ${CANARY.email}`] }] })), isDirectory: false },
    ]);
    const viewer = '<script type="module">const token = e => e.value; window.render();</script>';
    const html = `<!DOCTYPE html><html><head>${viewer}</head><body><div id="root"></div></body></html>\n<template id="playwrightReportBase64">data:application/zip;base64,${inner.toString('base64')}</template>`;
    expect(containsAny(allText(readZip(Buffer.from(/base64,([A-Za-z0-9+/=]+)/.exec(html)![1]!, 'base64'))))).not.toEqual([]);
    const r = sanitizeBuffer('index.html', 'text/html', Buffer.from(html), opts);
    expect(r.ok).toBe(true);
    const outHtml = r.data.toString('utf8');
    expect(outHtml).toContain(viewer);
    const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(outHtml)![1]!;
    expect(containsAny(allText(readZip(Buffer.from(b64, 'base64'))))).toEqual([]);
  });

  it('binario (captura PNG) con canario en metadatos tEXt ⇒ no sanitizable; sin metadatos ⇒ publicable', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`\0\0\0\x1btEXtComment\0${CANARY.secret}\0\0`), zlib.deflateSync(Buffer.alloc(64))]);
    const bad = sanitizeBuffer('shot.png', 'image/png', png, opts);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/no puede sanitizarse/);
    const clean = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), zlib.deflateSync(Buffer.alloc(64))]);
    expect(sanitizeBuffer('shot.png', 'image/png', clean, opts).ok).toBe(true);
  });

  it('ZIP malformado o ZIP64 ⇒ fallido (evidencia no inspeccionable no se publica)', () => {
    const r = sanitizeBuffer('trace.zip', 'application/zip', Buffer.from('PK\x03\x04basura'), opts);
    expect(r.ok).toBe(false);
  });

  it('sanitizeArtifactFile borra el crudo aunque falle y escribe 0600', async () => {
    const raw = path.join(dir, 'a.json');
    await fs.writeFile(raw, JSON.stringify({ token: CANARY.token }));
    const out = path.join(dir, 'out', 'a.json');
    const r = await sanitizeArtifactFile(raw, out, 'application/json', opts);
    expect(r.status).toBe('sanitizado');
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    await expect(fs.access(raw)).rejects.toThrow();
    const raw2 = path.join(dir, 'b.zip');
    await fs.writeFile(raw2, Buffer.from('PK\x03\x04roto'));
    const r2 = await sanitizeArtifactFile(raw2, path.join(dir, 'out', 'b.zip'), 'application/zip', opts);
    expect(r2.status).toBe('fallido');
    await expect(fs.access(raw2)).rejects.toThrow();
  });
});

describe('ArtifactUploader (RF-RES-02, RNF-SEG-05, cuotas ARQ §6)', () => {
  function uploader(api: FakeWorkerApi, over: Partial<typeof STAGING_POLICY> = {}, quota?: number) {
    return new ArtifactUploader({
      api,
      leaseId: randomUUID(),
      generation: 1,
      policy: { ...STAGING_POLICY, ...over },
      knownSecrets: () => [CANARY.password],
      sanitizedDir: path.join(dir, 'sanitized'),
      logger: silentLogger(),
      onLeaseLost: () => undefined,
      ...(quota !== undefined ? { evidenceQuotaBytes: quota } : {}),
    });
  }

  it('sube solo el contenido sanitizado con checksum/tamaño y finaliza', async () => {
    const api = new FakeWorkerApi();
    const file = path.join(dir, 'results.json');
    await fs.writeFile(file, JSON.stringify({ msg: `Bearer ${CANARY.token}` }));
    const u = uploader(api);
    await u.enqueue({ file, kind: 'reporte', contentType: 'application/json', runResultId: null, attemptNo: null, failed: true });
    expect(u.records[0]?.outcome).toBe('subido');
    expect(api.uploaded).toHaveLength(1);
    expect(containsAny(api.uploaded[0]!.content)).toEqual([]);
    const req = api.ops('artifact')[0] as { sizeBytes: number; checksumSha256: string; sanitization: { status: string } };
    expect(req.sanitization.status).toBe('sanitizado');
    expect(req.sizeBytes).toBe(api.uploaded[0]!.content.length);
    expect(api.ops('finalize')).toHaveLength(1);
  });

  it('evidencia no sanitizable: se registra `fallido` con motivo, sin URL de carga, y evidencia incompleta', async () => {
    const api = new FakeWorkerApi();
    const file = path.join(dir, 'trace.zip');
    await fs.writeFile(file, Buffer.from('PK\x03\x04roto'));
    const u = uploader(api);
    await u.enqueue({ file, kind: 'traza', contentType: 'application/zip', runResultId: randomUUID(), attemptNo: 1, failed: true });
    expect(u.records[0]?.outcome).toBe('fallido_sanitizacion');
    expect(api.uploaded).toHaveLength(0);
    expect((api.ops('artifact')[0] as { sanitization: { status: string; reason: string } }).sanitization).toMatchObject({ status: 'fallido' });
    expect(u.evidenceIncomplete).toBe(true);
  });

  it('tipo deshabilitado por política (producción: traza/video) se registra sin subir', async () => {
    const api = new FakeWorkerApi();
    const file = path.join(dir, 'video.webm');
    await fs.writeFile(file, Buffer.from('webm-bytes'));
    const u = uploader(api, { enabledKinds: ['reporte', 'log'], disabledReasons: { video: 'Deshabilitado en producción' } });
    await u.enqueue({ file, kind: 'video', contentType: 'video/webm', runResultId: randomUUID(), attemptNo: 1, failed: true });
    expect(u.records[0]?.outcome).toBe('deshabilitado');
    expect(api.uploaded).toHaveLength(0);
  });

  it('cuota de evidencia: al superarla se deja de subir y se marca evidencia incompleta', async () => {
    const api = new FakeWorkerApi();
    const u = uploader(api, {}, 40);
    for (let i = 0; i < 3; i++) {
      const f = path.join(dir, `log-${i}.txt`);
      await fs.writeFile(f, 'x'.repeat(30));
      await u.enqueue({ file: f, kind: 'log', contentType: 'text/plain', runResultId: null, attemptNo: null, failed: true });
    }
    expect(u.records.map((r) => r.outcome)).toEqual(['subido', 'cuota_excedida', 'cuota_excedida']);
    expect(u.evidenceIncomplete).toBe(true);
  });

  it('capturas solo en fallas cuando la política lo indica', async () => {
    const api = new FakeWorkerApi();
    const f = path.join(dir, 'ok.png');
    await fs.writeFile(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const u = uploader(api);
    await u.enqueue({ file: f, kind: 'captura', contentType: 'image/png', runResultId: randomUUID(), attemptNo: 1, failed: false });
    expect(u.records[0]?.outcome).toBe('omitido_politica');
  });

  it('mapea adjuntos de Playwright a tipos de evidencia', () => {
    expect(kindForAttachment({ name: 'screenshot', contentType: 'image/png' })).toBe('captura');
    expect(kindForAttachment({ name: 'trace', contentType: 'application/zip' })).toBe('traza');
    expect(kindForAttachment({ name: 'video', contentType: 'video/webm' })).toBe('video');
    expect(kindForAttachment({ name: 'samples.json', contentType: 'application/json', path: '/x/samples.json' })).toBe('dxmon_samples');
  });
});
