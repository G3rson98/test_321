/**
 * Paginación por cursor (keyset) con orden estable y desempate por UUID (ESP §9, §17.3, D-020, RNF-OPT-02).
 * Uso típico con Prisma:
 *
 * ```ts
 * const sort = parseSort(query.sort, { title: 'string', createdAt: 'date' });
 * const after = decodePageCursor(query.cursor, sort);
 * const rows = await prisma.x.findMany({
 *   where: { AND: [filters, keysetWhere(sort, after)] },
 *   orderBy: keysetOrderBy(sort),
 *   take: query.limit + 1,
 * });
 * return paginate(rows, query.limit, sort);
 * ```
 * El cursor es opaco (base64url de JSON) e incluye el campo de orden: un cursor de otro orden es 422.
 */
import { z } from 'zod';
import { decodeCursor, encodeCursor, KatalystError, type Page } from '@katalyst/shared';

/**
 * Booleano de query string. `z.coerce.boolean()` de algunos DTO compartidos interpreta "false" como `true`; los
 * endpoints de API-A sobrescriben esos campos con este esquema (D-0xx).
 */
export const QueryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export type SortValueType = 'string' | 'number' | 'date';
export type SortDirection = 'asc' | 'desc';

export interface SortSpec<F extends string = string> {
  field: F;
  direction: SortDirection;
  type: SortValueType;
  /** Nombre de columna en Prisma si difiere de `field`. */
  column?: string;
}

/** Interpreta `campo` / `-campo` contra las claves permitidas del endpoint (con su tipo). */
export function parseSort<F extends string>(
  sort: string,
  allowed: Record<F, SortValueType | { type: SortValueType; column: string }>,
): SortSpec<F> {
  const desc = sort.startsWith('-');
  const field = (desc ? sort.slice(1) : sort) as F;
  const def = allowed[field] as SortValueType | { type: SortValueType; column: string } | undefined;
  if (def === undefined) throw new KatalystError('VALIDATION_FAILED', 'Orden no permitido.');
  const type: SortValueType = typeof def === 'string' ? def : def.type;
  const column = typeof def === 'string' ? undefined : def.column;
  return { field, direction: desc ? 'desc' : 'asc', type, ...(column ? { column } : {}) };
}

export interface PageCursor {
  v: string | number;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodePageCursor(cursor: string | undefined | null, sort: SortSpec): PageCursor | null {
  if (!cursor) return null;
  const raw = decodeCursor(cursor);
  if (
    !raw ||
    raw.s !== `${sort.direction === 'desc' ? '-' : ''}${sort.field}` ||
    typeof raw.id !== 'string' ||
    !UUID_RE.test(raw.id) ||
    (typeof raw.v !== 'string' && typeof raw.v !== 'number')
  ) {
    throw new KatalystError('VALIDATION_FAILED', 'Cursor inválido para este filtro u orden.');
  }
  if (sort.type === 'date' && (typeof raw.v !== 'string' || Number.isNaN(Date.parse(raw.v)))) {
    throw new KatalystError('VALIDATION_FAILED', 'Cursor inválido para este filtro u orden.');
  }
  if (sort.type === 'number' && typeof raw.v !== 'number') {
    throw new KatalystError('VALIDATION_FAILED', 'Cursor inválido para este filtro u orden.');
  }
  return { v: raw.v, id: raw.id };
}

function cursorValue(sort: SortSpec, v: string | number): string | number | Date {
  return sort.type === 'date' ? new Date(v) : v;
}

/** Fragmento `where` de Prisma: filas estrictamente posteriores al cursor en el orden (campo, id). */
export function keysetWhere(sort: SortSpec, after: PageCursor | null): Record<string, unknown> {
  if (!after) return {};
  const col = sort.column ?? sort.field;
  const op = sort.direction === 'asc' ? 'gt' : 'lt';
  const v = cursorValue(sort, after.v);
  return { OR: [{ [col]: { [op]: v } }, { [col]: v, id: { [op]: after.id } }] };
}

export function keysetOrderBy(sort: SortSpec): Record<string, SortDirection>[] {
  return [{ [sort.column ?? sort.field]: sort.direction }, { id: sort.direction }];
}

function rowValue(row: Record<string, unknown>, sort: SortSpec): string | number {
  const v = row[sort.column ?? sort.field] ?? row[sort.field];
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new TypeError(`Valor de orden ausente para ${sort.field}`);
}

export function encodePageCursor(row: { id: string }, sort: SortSpec): string {
  return encodeCursor({
    s: `${sort.direction === 'desc' ? '-' : ''}${sort.field}`,
    v: rowValue(row as Record<string, unknown>, sort),
    id: row.id,
  });
}

/**
 * Recorta `rows` (consultadas con `take: limit + 1`) a `limit` y calcula el cursor siguiente.
 * Sin `sort`, el orden es solo por `id` (cursor con `s: 'id'`).
 */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  sort: SortSpec = { field: 'id', direction: 'asc', type: 'string' },
  total?: number,
): Page<T> {
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasNext && last ? encodePageCursor(last, sort) : null,
    hasNext,
    ...(total !== undefined ? { total } : {}),
  };
}

/** Variante para resultados ya mapeados a DTO: el cursor se calcula sobre la fila original. */
export function paginateMapped<R extends { id: string }, D>(
  rows: R[],
  limit: number,
  sort: SortSpec,
  map: (row: R) => D,
  total?: number,
): Page<D> {
  const page = paginate(rows, limit, sort, total);
  return { ...page, items: page.items.map(map) };
}
