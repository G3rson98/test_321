/**
 * Parser de cron de 5 campos (minuto hora día-mes mes día-semana). Implementación propia (D-005) para controlar la
 * política DST de ESP §13.5 sin depender del comportamiento de una librería.
 * Soporta: `*`, `?`, números, rangos `a-b`, pasos `*\/n`, `a-b/n`, `a/n`, listas, nombres (JAN..DEC, SUN..SAT),
 * domingo como 0 o 7, y macros `@yearly @annually @monthly @weekly @daily @midnight @hourly`.
 * Semántica Vixie: si día-mes y día-semana están restringidos ambos, basta con que coincida uno (OR).
 * RF-PRG-01, RF-PRG-02.
 */

export class CronParseError extends Error {
  readonly code = 'CRON_INVALID' as const;
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface ParsedCron {
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  namesOffset?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'día del mes', min: 1, max: 31 },
  { name: 'mes', min: 1, max: 12, names: MONTH_NAMES, namesOffset: 1 },
  { name: 'día de la semana', min: 0, max: 7, names: DOW_NAMES, namesOffset: 0 },
];

function parseValue(token: string, spec: FieldSpec, expr: string): number {
  const upper = token.toUpperCase();
  if (spec.names) {
    const idx = spec.names.indexOf(upper);
    if (idx >= 0) return idx + (spec.namesOffset ?? 0);
  }
  if (!/^\d+$/.test(token)) throw new CronParseError(`Valor inválido "${token}" en ${spec.name}`, expr);
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronParseError(`Valor ${n} fuera de rango en ${spec.name} (${spec.min}-${spec.max})`, expr);
  }
  return n;
}

function parseField(field: string, spec: FieldSpec, expr: string): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  if (field === '') throw new CronParseError(`Campo vacío en ${spec.name}`, expr);
  const restricted = !(field === '*' || field === '?');
  for (const part of field.split(',')) {
    if (part === '') throw new CronParseError(`Lista mal formada en ${spec.name}`, expr);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronParseError(`Paso mal formado en ${spec.name}`, expr);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronParseError(`Paso inválido "${stepPart}" en ${spec.name}`, expr);
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '?') {
      lo = spec.min;
      hi = spec.max === 7 ? 6 : spec.max;
    } else if (rangePart!.includes('-')) {
      const [a, b, more] = rangePart!.split('-');
      if (more !== undefined || a === undefined || b === undefined || a === '' || b === '') {
        throw new CronParseError(`Rango mal formado "${rangePart}" en ${spec.name}`, expr);
      }
      lo = parseValue(a, spec, expr);
      hi = parseValue(b, spec, expr);
      if (lo > hi) throw new CronParseError(`Rango invertido "${rangePart}" en ${spec.name}`, expr);
    } else {
      lo = parseValue(rangePart!, spec, expr);
      hi = stepPart !== undefined ? (spec.max === 7 ? 6 : spec.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.max === 7 && v === 7 ? 0 : v);
  }
  return { values, restricted };
}

export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string') throw new CronParseError('La expresión debe ser texto', String(expression));
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 200)
    throw new CronParseError('Expresión vacía o demasiado larga', expression);
  const expanded = trimmed.startsWith('@') ? MACROS[trimmed.toLowerCase()] : trimmed;
  if (!expanded) throw new CronParseError(`Macro no soportada "${trimmed}"`, expression);
  const parts = expanded.split(' ');
  if (parts.length !== 5) {
    throw new CronParseError(`Se esperaban 5 campos (minuto hora día mes día-semana); hay ${parts.length}`, expression);
  }
  const [mi, h, dom, mo, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!, expression));
  return {
    source: trimmed,
    minutes: [...mi!.values].sort((a, b) => a - b),
    hours: [...h!.values].sort((a, b) => a - b),
    daysOfMonth: dom!.values,
    months: mo!.values,
    daysOfWeek: dow!.values,
    domRestricted: dom!.restricted,
    dowRestricted: dow!.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** ¿Coincide la fecha calendario (local) con los campos de día/mes? `dow` 0 = domingo. */
export function cronMatchesDate(c: ParsedCron, month: number, day: number, dow: number): boolean {
  if (!c.months.has(month)) return false;
  const domOk = c.daysOfMonth.has(day);
  const dowOk = c.daysOfWeek.has(dow);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/** Minutos del día (0..1439) en que dispara la expresión. */
export function cronMinutesOfDay(c: ParsedCron): number[] {
  const out: number[] = [];
  for (const h of c.hours) for (const m of c.minutes) out.push(h * 60 + m);
  return out;
}
