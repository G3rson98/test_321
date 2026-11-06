import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeCsvFormula, toCsv } from '../src/csv/index.js';
import { canonicalJson, sha256Hex } from '../src/crypto/sha256.js';

describe('RF-RES-04 CSV con neutralización de fórmulas (ESP §17.3)', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('neutraliza %j', (v) => {
    expect(neutralizeCsvFormula(v).startsWith("'")).toBe(true);
  });
  it('no toca valores seguros y escapa comillas/separadores', () => {
    expect(neutralizeCsvFormula('Humo diario')).toBe('Humo diario');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell(' x')).toBe('" x"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(new Date('2026-11-09T12:00:00Z'))).toBe('2026-11-09T12:00:00.000Z');
  });
  it('toCsv con CRLF y BOM opcional', () => {
    const rows = [
      { n: 'C1', d: 1200 },
      { n: '=cmd', d: null },
    ];
    const cols = [
      { header: 'Caso', value: (r: (typeof rows)[number]) => r.n },
      { header: 'Duración (ms)', value: (r: (typeof rows)[number]) => r.d },
    ];
    expect(toCsv(rows, cols)).toBe("Caso,Duración (ms)\r\nC1,1200\r\n'=cmd,\r\n");
    expect(toCsv(rows, cols, { bom: true }).startsWith('﻿')).toBe(true);
  });
});

describe('RF-CAT-05 SHA-256 portable y JSON canónico', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ñandú 🚀', 'x'.repeat(100_000)])(
    'coincide con node:crypto (%#)',
    (s) => {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    },
  );
  it('acepta bytes', () => {
    const b = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'));
  });
  it('JSON canónico determinista', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: undefined, c: null }], e: 'x' })).toBe(
      '{"a":[3,{"c":null}],"b":1,"e":"x"}',
    );
    expect(canonicalJson([undefined])).toBe('[null]');
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
