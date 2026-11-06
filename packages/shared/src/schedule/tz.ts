/**
 * Conversión hora local (zona IANA) ↔ instante UTC con Intl (sin dependencias). ESP §13.5, RNF-USA-01.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = domingo. */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function assertTimeZone(tz: string): void {
  try {
    formatter(tz);
  } catch {
    throw new RangeError(`TIMEZONE_INVALID: ${tz}`);
  }
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Desplazamiento de la zona en minutos (local − UTC) para el instante dado. */
export function offsetMinutes(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const floored = Math.floor(utcMs / 1000) * 1000;
  return Math.round((asUtc - floored) / 60_000);
}

/**
 * Instantes UTC que corresponden a una hora local de pared. 0 = hora inexistente (salto DST),
 * 1 = normal, 2 = hora repetida (retroceso DST), ordenados ascendentemente.
 */
export function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number[] {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>([
    offsetMinutes(naive - 86_400_000, tz),
    offsetMinutes(naive, tz),
    offsetMinutes(naive + 86_400_000, tz),
  ]);
  const out = new Set<number>();
  for (const off of offsets) {
    const candidate = naive - off * 60_000;
    const p = localParts(candidate, tz);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      out.add(candidate);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Fecha calendario local (sin hora) del instante en la zona. */
export function localDateOf(utcMs: number, tz: string): { year: number; month: number; day: number } {
  const p = localParts(utcMs, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** Formato `YYYY-MM-DDTHH:mm` local para vistas previas. */
export function formatLocal(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
