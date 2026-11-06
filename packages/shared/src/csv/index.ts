/**
 * Exportación CSV segura (ESP §17.3): neutraliza fórmulas en celdas que comienzan con `=`, `+`, `-`, `@`, TAB o CR
 * anteponiendo un apóstrofo, y escapa comillas/separadores (RFC 4180). RF-RES-04.
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function neutralizeCsvFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export type CsvValue = string | number | boolean | Date | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else s = neutralizeCsvFormula(value);
  if (/[",\r\n;]/.test(s) || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/** Genera CSV con BOM UTF-8 opcional (Excel en español) y CRLF. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], opts: { bom?: boolean } = {}): string {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return `${opts.bom ? '﻿' : ''}${[head, ...body].join('\r\n')}\r\n`;
}
