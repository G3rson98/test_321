/**
 * Validación de programaciones (ESP §9: cron inválido → 422 CRON_INVALID; ESP §13.5: intervalo mínimo 5 min).
 * El intervalo se mide en hora de pared (independiente de DST: la política DST solo puede omitir o
 * deduplicar instantes, nunca acercarlos por debajo del intervalo de pared).
 * RF-PRG-01, RF-PRG-02.
 */
import { CronParseError, cronMatchesDate, cronMinutesOfDay, parseCron } from './cron.js';
import { isValidTimeZone } from '../schemas/common.js';

/** Horizonte de análisis: 8 años cubre bisiestos y combinaciones día-mes/día-semana. */
const ANALYSIS_DAYS = 366 * 8;
/** Fecha base fija (lunes 2024-01-01) para que el análisis sea determinista. */
const ANALYSIS_BASE = Date.UTC(2024, 0, 1);

/**
 * Menor separación (min) entre ocurrencias consecutivas de la unión de expresiones, en hora de pared,
 * incluyendo el cruce de medianoche. `null` si no hay ocurrencias o solo hay una en el horizonte.
 * Corta temprano al encontrar una separación < `stopBelow`.
 */
export function minIntervalMinutes(expressions: readonly string[], stopBelow = 1): number | null {
  const compiled = expressions.map((e) => {
    const c = parseCron(e);
    return { c, mods: cronMinutesOfDay(c) };
  });
  let prev: number | null = null;
  let min: number | null = null;
  let any = false;
  for (let i = 0; i < ANALYSIS_DAYS; i++) {
    const d = new Date(ANALYSIS_BASE + i * 86_400_000);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dow = d.getUTCDay();
    const set = new Set<number>();
    for (const { c, mods } of compiled) {
      if (cronMatchesDate(c, month, day, dow)) for (const m of mods) set.add(m);
    }
    if (set.size === 0) continue;
    any = true;
    for (const m of [...set].sort((a, b) => a - b)) {
      const abs = i * 1440 + m;
      if (prev !== null) {
        const gap = abs - prev;
        if (min === null || gap < min) min = gap;
        if (min < stopBelow) return min;
      }
      prev = abs;
    }
  }
  if (!any) return null;
  return min ?? Number.POSITIVE_INFINITY;
}

export interface ScheduleValidationIssue {
  code: 'CRON_INVALID' | 'TIMEZONE_INVALID' | 'CRON_INTERVAL_TOO_SHORT' | 'SCHEDULE_NO_OCCURRENCES';
  message: string;
  /** Índice de la expresión con problema, si aplica. */
  index?: number;
}

export interface ScheduleValidationResult {
  ok: boolean;
  issues: ScheduleValidationIssue[];
  /** Expresiones normalizadas (espacios colapsados) y deduplicadas. */
  normalized: string[];
}

export const MAX_CRON_EXPRESSIONS = 20;

export function validateSchedule(
  expressions: readonly string[],
  timezone: string,
  opts: { minIntervalMinutes?: number } = {},
): ScheduleValidationResult {
  const minInterval = opts.minIntervalMinutes ?? 5;
  const issues: ScheduleValidationIssue[] = [];
  if (!isValidTimeZone(timezone)) issues.push({ code: 'TIMEZONE_INVALID', message: `Zona IANA inválida: ${timezone}` });
  if (expressions.length === 0 || expressions.length > MAX_CRON_EXPRESSIONS) {
    issues.push({ code: 'CRON_INVALID', message: `Se requieren entre 1 y ${MAX_CRON_EXPRESSIONS} expresiones` });
    return { ok: false, issues, normalized: [] };
  }
  const normalized: string[] = [];
  expressions.forEach((e, index) => {
    try {
      const src = parseCron(e).source;
      if (!normalized.includes(src)) normalized.push(src);
    } catch (err) {
      issues.push({
        code: 'CRON_INVALID',
        message: err instanceof CronParseError ? err.message : 'Expresión inválida',
        index,
      });
    }
  });
  if (issues.some((i) => i.code === 'CRON_INVALID')) return { ok: false, issues, normalized };
  const gap = minIntervalMinutes(normalized, minInterval);
  if (gap === null) {
    issues.push({ code: 'SCHEDULE_NO_OCCURRENCES', message: 'La programación no produce ocurrencias' });
  } else if (gap < minInterval) {
    issues.push({
      code: 'CRON_INTERVAL_TOO_SHORT',
      message: `Hay ocurrencias separadas por ${gap} min; el mínimo es ${minInterval} min`,
    });
  }
  return { ok: issues.length === 0, issues, normalized };
}
