/**
 * Servicio lógico ÚNICO de ocurrencias (ESP §13.5): lo usan vista previa, admisión y reconciliación.
 * - Evaluación en zona IANA; resultado como instantes UTC.
 * - Varias expresiones: unión deduplicada por instante UTC.
 * - DST: hora local inexistente se OMITE; hora repetida solo en su PRIMERA ocurrencia (la más temprana en UTC).
 * RF-PRG-01, RF-PRG-02, RF-PRG-04, RF-PRG-05, RNF-REN-02.
 */
import { cronMatchesDate, cronMinutesOfDay, parseCron, type ParsedCron } from './cron.js';
import { assertTimeZone, formatLocal, localDateOf, localParts, wallTimeToUtc } from './tz.js';

const DAY_MS = 86_400_000;
/** Horizonte máximo de búsqueda de `nextOccurrences` (días). */
export const MAX_LOOKAHEAD_DAYS = 366 * 5;

interface Compiled {
  cron: ParsedCron;
  minutesOfDay: number[];
}

function compile(expressions: readonly string[]): Compiled[] {
  if (expressions.length === 0) throw new RangeError('Se requiere al menos una expresión cron');
  return expressions.map((e) => {
    const cron = parseCron(e);
    return { cron, minutesOfDay: cronMinutesOfDay(cron) };
  });
}

/** Itera fechas calendario (aritmética UTC pura, independiente de zona). */
function* civilDays(startYear: number, startMonth: number, startDay: number, count: number) {
  const base = Date.UTC(startYear, startMonth - 1, startDay);
  for (let i = 0; i < count; i++) {
    const d = new Date(base + i * DAY_MS);
    yield { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay() };
  }
}

/** Instantes UTC (ms) de un día local, aplicando la política DST, ordenados y sin duplicados. */
function instantsForLocalDay(
  compiled: readonly Compiled[],
  y: number,
  m: number,
  d: number,
  dow: number,
  tz: string,
): number[] {
  const minutes = new Set<number>();
  for (const c of compiled) {
    if (!cronMatchesDate(c.cron, m, d, dow)) continue;
    for (const mod of c.minutesOfDay) minutes.add(mod);
  }
  const out: number[] = [];
  for (const mod of [...minutes].sort((a, b) => a - b)) {
    const candidates = wallTimeToUtc(y, m, d, Math.floor(mod / 60), mod % 60, tz);
    if (candidates.length === 0) continue; // hora inexistente: se omite
    out.push(candidates[0]!); // hora repetida: solo la primera
  }
  return out;
}

/**
 * Ocurrencias en `[from, to)` (UTC). Usado por la reconciliación para detectar huecos por lotes.
 */
export function occurrencesBetween(expressions: readonly string[], timezone: string, from: Date, to: Date): Date[] {
  assertTimeZone(timezone);
  const compiled = compile(expressions);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!(toMs > fromMs)) return [];
  const start = localDateOf(fromMs - DAY_MS, timezone);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 3;
  const set = new Set<number>();
  for (const day of civilDays(start.year, start.month, start.day, days)) {
    for (const t of instantsForLocalDay(compiled, day.year, day.month, day.day, day.dow, timezone)) {
      if (t >= fromMs && t < toMs) set.add(t);
    }
  }
  return [...set].sort((a, b) => a - b).map((t) => new Date(t));
}

/** Próximas `count` ocurrencias estrictamente posteriores a `after` (RF-PRG-02: vista previa de 5). */
export function nextOccurrences(
  expressions: readonly string[],
  timezone: string,
  after: Date,
  count = 5,
  maxLookaheadDays = MAX_LOOKAHEAD_DAYS,
): Date[] {
  assertTimeZone(timezone);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new RangeError('count debe estar en 1..1000');
  const compiled = compile(expressions);
  const afterMs = after.getTime();
  const start = localDateOf(afterMs - DAY_MS, timezone);
  const found = new Set<number>();
  const out: number[] = [];
  for (const day of civilDays(start.year, start.month, start.day, maxLookaheadDays + 2)) {
    for (const t of instantsForLocalDay(compiled, day.year, day.month, day.day, day.dow, timezone)) {
      if (t > afterMs && !found.has(t)) {
        found.add(t);
        out.push(t);
      }
    }
    if (out.length >= count) {
      // Los días se recorren en orden; dentro del día los instantes están ordenados, pero el día previo
      // (por desplazamiento de zona) puede solaparse: ordenar antes de cortar.
      return out
        .sort((a, b) => a - b)
        .slice(0, count)
        .map((t) => new Date(t));
    }
  }
  return out.sort((a, b) => a - b).map((t) => new Date(t));
}

/** Próxima ocurrencia o `null` si no hay en el horizonte. */
export function nextOccurrence(expressions: readonly string[], timezone: string, after: Date): Date | null {
  return nextOccurrences(expressions, timezone, after, 1)[0] ?? null;
}

/**
 * ¿El instante es una ocurrencia válida de la programación? (admisión: validar `scheduled_for`).
 * Respeta la política DST: en horas repetidas solo la primera es válida.
 */
export function isScheduledInstant(expressions: readonly string[], timezone: string, instant: Date): boolean {
  assertTimeZone(timezone);
  const compiled = compile(expressions);
  const ms = instant.getTime();
  if (ms % 60_000 !== 0) return false;
  const p = localParts(ms, timezone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return instantsForLocalDay(compiled, p.year, p.month, p.day, dow, timezone).includes(ms);
}

export interface PreviewOccurrence {
  /** Instante UTC ISO. */
  at: string;
  /** Hora local `YYYY-MM-DDTHH:mm` en la zona de la programación. */
  local: string;
}

export function previewOccurrences(
  expressions: readonly string[],
  timezone: string,
  after: Date,
  count = 5,
): PreviewOccurrence[] {
  return nextOccurrences(expressions, timezone, after, count).map((d) => ({
    at: d.toISOString(),
    local: formatLocal(d.getTime(), timezone),
  }));
}

/** Cantidad de ocurrencias en un día local dado (útil para vistas y pruebas: 21 en L-V 08:00–18:00 c/30). */
export function occurrencesOnLocalDate(
  expressions: readonly string[],
  timezone: string,
  year: number,
  month: number,
  day: number,
): Date[] {
  assertTimeZone(timezone);
  const compiled = compile(expressions);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return instantsForLocalDay(compiled, year, month, day, dow, timezone).map((t) => new Date(t));
}

// ---------------------------------------------------------------------------
// Ventanas de exclusión (RF-PRG-05)
// ---------------------------------------------------------------------------

export interface ExclusionWindowLike {
  startsAt: Date;
  endsAt: Date;
}

/** Instante excluido si cae en `[startsAt, endsAt)` de alguna ventana. */
export function isExcluded(instant: Date, windows: readonly ExclusionWindowLike[]): boolean {
  const t = instant.getTime();
  return windows.some((w) => t >= w.startsAt.getTime() && t < w.endsAt.getTime());
}

// ---------------------------------------------------------------------------
// Admisión por capacidad (ESP §13.5)
// ---------------------------------------------------------------------------

/** Plazo de gracia de admisión en cola sin capacidad. */
export const ADMISSION_GRACE_MS = 60_000;

/** Vencida la gracia (instante + 60 s) sin capacidad ⇒ `omitida/sin_capacidad`; nunca ejecutar tarde. */
export function admissionExpired(scheduledFor: Date, now: Date, graceMs = ADMISSION_GRACE_MS): boolean {
  return now.getTime() > scheduledFor.getTime() + graceMs;
}
