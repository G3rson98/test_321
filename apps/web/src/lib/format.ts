/**
 * Formato de fechas, horas, duraciones y números en español (RNF-USA-01). Toda fecha se muestra en la zona
 * configurada (por defecto America/La_Paz) usando Intl; las duraciones llegan numéricas de la API (ESP §17.4).
 */
export const DEFAULT_DISPLAY_TZ = 'America/La_Paz';
const LOCALE = 'es-BO';
let displayTz = DEFAULT_DISPLAY_TZ;

export function setDisplayTimezone(tz: string | null | undefined): void {
  displayTz = tz && tz.length > 0 ? tz : DEFAULT_DISPLAY_TZ;
}
export function getDisplayTimezone(): string {
  return displayTz;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, opts: Intl.DateTimeFormatOptions, tz = displayTz): Intl.DateTimeFormat {
  const k = `${key}|${tz}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: tz });
    cache.set(k, f);
  }
  return f;
}

function parts(date: Date, opts: Intl.DateTimeFormatOptions, key: string, tz?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of dtf(key, opts, tz).formatToParts(date)) out[p.type] = p.value;
  return out;
}

function toDate(v: string | number | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const cleanMonth = (m: string | undefined) => (m ?? '').replace('.', '').toLowerCase();

/** "05 nov 21:30" (mono compacto de las capturas). */
export function formatDateTimeShort(v: string | number | Date | null | undefined, tz?: string): string {
  if (v === null || v === undefined) return '–';
  const p = parts(
    toDate(v),
    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    'dts',
    tz,
  );
  return `${p.day} ${cleanMonth(p.month)} ${p.hour}:${p.minute}`;
}

/** "Vie 06 nov 08:00" (vista previa de programación). */
export function formatWeekdayDateTime(v: string | number | Date, tz?: string): string {
  const p = parts(
    toDate(v),
    { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    'wdt',
    tz,
  );
  const wd = cap((p.weekday ?? '').replace('.', ''));
  return `${wd} ${p.day} ${cleanMonth(p.month)} ${p.hour}:${p.minute}`;
}

/** "Jueves 5 de noviembre". */
export function formatLongDate(v: string | number | Date, tz?: string): string {
  const p = parts(toDate(v), { weekday: 'long', day: 'numeric', month: 'long' }, 'long', tz);
  return `${cap(p.weekday ?? '')} ${p.day} de ${p.month}`;
}

/** "21:00". */
export function formatTime(v: string | number | Date | null | undefined, tz?: string): string {
  if (v === null || v === undefined) return '–';
  const p = parts(toDate(v), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'time', tz);
  return `${p.hour}:${p.minute}`;
}

/** "17:12:04". */
export function formatTimeSeconds(v: string | number | Date, tz?: string): string {
  const p = parts(
    toDate(v),
    { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
    'times',
    tz,
  );
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** "05/11/2026 21:30" para tooltips y auditoría detallada. */
export function formatDateTimeFull(v: string | number | Date, tz?: string): string {
  const p = parts(
    toDate(v),
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    'full',
    tz,
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Hora local (0..23) en la zona de presentación, para el saludo. */
export function localHour(v: Date = new Date(), tz?: string): number {
  const p = parts(v, { hour: '2-digit', hourCycle: 'h23' }, 'hour', tz);
  return Number(p.hour ?? '0');
}

export function greeting(now: Date = new Date(), tz?: string): string {
  const h = localHour(now, tz);
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

const num1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : int.format(n);
}

/** Duración de corrida: "1m 12s", "40s", "1h 05m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Segundos con coma decimal y espacio antes de la unidad: "11,8 s" (ui-capturas §6.3 #27). */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  return `${num1.format(ms / 1000)} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${int.format(Math.round(bytes / 1024))} KB`;
  return `${num1.format(bytes / (1024 * 1024))} MB`;
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '–';
  return `${int.format(Math.round(ratio * 100))}%`;
}

/** Inicio del día local (zona de presentación) como instante UTC. */
export function startOfLocalDay(now: Date = new Date(), tz: string = displayTz): Date {
  const p = parts(now, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, 'sod', tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - offset);
}

/** Clave de día local `YYYY-MM-DD`. */
export function localDayKey(v: string | number | Date, tz?: string): string {
  const p = parts(toDate(v), { year: 'numeric', month: '2-digit', day: '2-digit' }, 'daykey', tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Desplazamiento UTC legible de una zona: "UTC-4". */
export function utcOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at);
    const name = p.find((x) => x.type === 'timeZoneName')?.value ?? 'GMT';
    return name.replace('GMT', 'UTC') === 'UTC' ? 'UTC+0' : name.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/** Offset (min) de la zona en un instante: local − UTC. */
export function tzOffsetMinutes(at: Date, tz: string = displayTz): number {
  const p = parts(at, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, 'off', tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** "2026-11-05" (día local en la zona) → instante ISO UTC de su medianoche local. */
export function zonedMidnightIso(day: string, tz: string = displayTz): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, 12));
  const off = tzOffsetMinutes(guess, tz);
  return new Date(Date.UTC(y, m - 1, d) - off * 60_000).toISOString();
}

export function addDaysIso(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
