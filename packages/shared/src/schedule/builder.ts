/**
 * Editor visual de horario → expresiones cron (RF-PRG-02, ESP §13.5).
 * - Días explícitos (0 = domingo … 6 = sábado).
 * - Modo `hora_fija`: lista de horas `HH:MM`.
 * - Modo `intervalo`: rango `start..end` INCLUSIVO con paso `everyMinutes`.
 *   L-V 08:00–18:00 c/30 → `0,30 8-17 * * 1-5` + `0 18 * * 1-5` (21 ocurrencias/día; nunca `*\/30 8-18`).
 * - Rango que cruza medianoche (start > end) exige `overnightDays` explícitos; nunca se infiere.
 * - Intervalo mínimo configurable (5 min inicial).
 */
import { minIntervalMinutes } from './validate.js';

export const DEFAULT_MIN_INTERVAL_MINUTES = 5;
export const DAY_LABELS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;

export type ScheduleEditorInput =
  | { mode: 'hora_fija'; days: number[]; times: string[] }
  | {
      mode: 'intervalo';
      days: number[];
      start: string;
      end: string;
      everyMinutes: number;
      /** Obligatorio si el rango cruza medianoche: días en que corre la parte posterior a 00:00. */
      overnightDays?: number[];
    };

export type ScheduleBuildErrorCode =
  | 'SCHEDULE_DAYS_INVALID'
  | 'SCHEDULE_TIME_INVALID'
  | 'SCHEDULE_RANGE_CROSSES_MIDNIGHT'
  | 'CRON_INTERVAL_TOO_SHORT'
  | 'SCHEDULE_NO_OCCURRENCES';

export class ScheduleBuildError extends Error {
  constructor(
    readonly code: ScheduleBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleBuildError';
  }
}

export interface BuiltSchedule {
  cronExpressions: string[];
  /** `HH:MM` informativo (schedule.window_start/window_end); null en hora fija. */
  windowStart: string | null;
  windowEnd: string | null;
  /** Descripción en español para el panel. */
  description: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(s: string): number {
  const m = HHMM.exec(s);
  if (!m) throw new ScheduleBuildError('SCHEDULE_TIME_INVALID', `Hora inválida "${s}" (formato HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHHMM(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function validateDays(days: readonly number[], label = 'days'): number[] {
  if (!Array.isArray(days) || days.length === 0) {
    throw new ScheduleBuildError('SCHEDULE_DAYS_INVALID', `Indica al menos un día (${label})`);
  }
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6)
      throw new ScheduleBuildError('SCHEDULE_DAYS_INVALID', `Día inválido ${d}`);
  }
  if (new Set(days).size !== days.length)
    throw new ScheduleBuildError('SCHEDULE_DAYS_INVALID', `Días duplicados (${label})`);
  return [...days].sort((a, b) => a - b);
}

/** Compacta enteros ordenados a un campo cron: `1-5`, `0,30`, `8-17`, `*` si cubre todo el dominio. */
export function compactField(values: readonly number[], domainMin: number, domainMax: number): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === domainMax - domainMin + 1) return '*';
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const runLen = j - i + 1;
    if (runLen >= 3) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(',');
}

/** Agrupa minutos-del-día en expresiones: horas con el mismo conjunto de minutos comparten expresión. */
function cronsForMinutes(minutesOfDay: readonly number[], days: readonly number[]): string[] {
  const byHour = new Map<number, number[]>();
  for (const mod of [...new Set(minutesOfDay)].sort((a, b) => a - b)) {
    const h = Math.floor(mod / 60);
    const arr = byHour.get(h) ?? [];
    arr.push(mod % 60);
    byHour.set(h, arr);
  }
  const bySet = new Map<string, number[]>();
  for (const [h, mins] of [...byHour.entries()].sort(([a], [b]) => a - b)) {
    const key = mins.join(',');
    const hours = bySet.get(key) ?? [];
    hours.push(h);
    bySet.set(key, hours);
  }
  const dowField = compactField(days, 0, 6);
  const out: string[] = [];
  for (const [mins, hours] of bySet) {
    out.push(`${compactField(mins.split(',').map(Number), 0, 59)} ${compactField(hours, 0, 23)} * * ${dowField}`);
  }
  return out;
}

function daysLabel(days: readonly number[]): string {
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return 'Todos los días';
  if (s.join(',') === '1,2,3,4,5') return 'Lunes a viernes';
  if (s.join(',') === '0,6') return 'Fines de semana';
  return s
    .map((d) => DAY_LABELS_ES[d])
    .join(', ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function buildCronExpressions(
  input: ScheduleEditorInput,
  opts: { minIntervalMinutes?: number } = {},
): BuiltSchedule {
  const minInterval = opts.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES;
  const days = validateDays(input.days);
  let crons: string[];
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  let description: string;

  if (input.mode === 'hora_fija') {
    if (!Array.isArray(input.times) || input.times.length === 0) {
      throw new ScheduleBuildError('SCHEDULE_TIME_INVALID', 'Indica al menos una hora');
    }
    const mins = input.times.map(parseHHMM);
    if (new Set(mins).size !== mins.length) throw new ScheduleBuildError('SCHEDULE_TIME_INVALID', 'Horas duplicadas');
    crons = cronsForMinutes(mins, days);
    description = `${daysLabel(days)} a las ${[...mins]
      .sort((a, b) => a - b)
      .map(formatHHMM)
      .join(', ')}`;
  } else {
    const start = parseHHMM(input.start);
    const end = parseHHMM(input.end);
    const every = input.everyMinutes;
    if (!Number.isInteger(every) || every < minInterval || every > 1440) {
      throw new ScheduleBuildError(
        'CRON_INTERVAL_TOO_SHORT',
        `El intervalo debe ser entero entre ${minInterval} y 1440 minutos`,
      );
    }
    windowStart = input.start;
    windowEnd = input.end;
    if (start <= end) {
      const mins: number[] = [];
      for (let t = start; t <= end; t += every) mins.push(t);
      crons = cronsForMinutes(mins, days);
      description = `${daysLabel(days)}, de ${input.start} a ${input.end} cada ${every} min`;
    } else {
      if (!input.overnightDays || input.overnightDays.length === 0) {
        throw new ScheduleBuildError(
          'SCHEDULE_RANGE_CROSSES_MIDNIGHT',
          'El rango cruza medianoche: indica explícitamente los días posteriores a 00:00 (overnightDays)',
        );
      }
      const overnight = validateDays(input.overnightDays, 'overnightDays');
      const before: number[] = [];
      const after: number[] = [];
      for (let t = start; t <= end + 1440; t += every) (t < 1440 ? before : after).push(t % 1440);
      crons = [...cronsForMinutes(before, days), ...(after.length ? cronsForMinutes(after, overnight) : [])];
      description = `${daysLabel(days)} desde ${input.start} y ${daysLabel(overnight).toLowerCase()} hasta ${input.end}, cada ${every} min`;
    }
  }

  const gap = minIntervalMinutes(crons, minInterval);
  if (gap === null) throw new ScheduleBuildError('SCHEDULE_NO_OCCURRENCES', 'La programación no produce ocurrencias');
  if (gap < minInterval) {
    throw new ScheduleBuildError(
      'CRON_INTERVAL_TOO_SHORT',
      `Hay ocurrencias separadas por ${gap} min (mínimo ${minInterval})`,
    );
  }
  return { cronExpressions: crons, windowStart, windowEnd, description };
}
