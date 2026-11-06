/**
 * Aceptación ESP §13.7 (ensayo de canarios local, docs/aceptacion/seguridad.md, D-053): una traza de Playwright
 * contiene fotogramas `screencast/*.jpeg` con los píxeles de la página (canarios visibles). La sanitización de la
 * traza los elimina y conserva el resto de entradas sanitizadas; el resultado no contiene el canario textual.
 */
import { verifySanitized } from '@katalyst/shared';
import { describe, expect, it } from 'vitest';
import { sanitizeBuffer, SCREENCAST_FRAME_RE } from '../../src/executor/artifacts/sanitize-artifact.js';
import { readZip, writeZip } from '../../src/executor/artifacts/zip.js';

const CANARY = 'KATALYST_CANARY_TOKEN_aceptacion01';
// JPEG mínimo sintético (cabecera SOI/APP0 + datos opacos): representa un fotograma con píxeles.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);

describe('ESP §13.7: trazas sin píxeles no sanitizables', () => {
  it('elimina screencast/*.jpeg y sanitiza el resto de la traza', () => {
    const trace = [
      JSON.stringify({ type: 'before', callId: 'c1', params: { url: `http://127.0.0.1/canario?token=${CANARY}` } }),
      JSON.stringify({ type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-1.jpeg', timestamp: 1 }),
    ].join('\n');
    const zip = writeZip([
      { name: 'trace.trace', data: Buffer.from(trace), isDirectory: false },
      { name: 'trace.network', data: Buffer.from(JSON.stringify({ request: { headers: [{ name: 'Authorization', value: `Bearer ${CANARY}` }] } })), isDirectory: false },
      { name: 'resources/page@1-1.jpeg', data: JPEG, isDirectory: false },
      { name: 'screencast/page@1-1.jpeg', data: JPEG, isDirectory: false },
      { name: 'screencast/page@1-2.png', data: JPEG, isDirectory: false },
    ]);
    const r = sanitizeBuffer('trace.zip', 'application/zip', zip, { knownSecrets: [] });
    expect(r.ok).toBe(true);
    const names = readZip(r.data).map((e) => e.name);
    expect(names).toEqual(['trace.trace', 'trace.network', 'resources/page@1-1.jpeg']);
    expect(names.some((n) => SCREENCAST_FRAME_RE.test(n))).toBe(false);
    const text = readZip(r.data)
      .filter((e) => !e.name.endsWith('.jpeg'))
      .map((e) => e.data.toString('utf8'))
      .join('\n');
    expect(text).not.toContain(CANARY);
    expect(verifySanitized(text).ok).toBe(true);
  });
});
