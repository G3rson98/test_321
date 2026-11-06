import { describe, expect, it } from 'vitest';
import {
  admissionExpired,
  buildCronExpressions,
  compactField,
  CronParseError,
  cronMatchesDate,
  formatHHMM,
  formatLocal,
  isExcluded,
  isScheduledInstant,
  isValidCron,
  localParts,
  minIntervalMinutes,
  nextOccurrence,
  nextOccurrences,
  occurrencesBetween,
  occurrencesOnLocalDate,
  offsetMinutes,
  parseCron,
  parseHHMM,
  previewOccurrences,
  ScheduleBuildError,
  validateSchedule,
  wallTimeToUtc,
  assertTimeZone,
  localDateOf,
} from '../src/schedule/index.js';

const LP = 'America/La_Paz';
const NY = 'America/New_York';
const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe('RF-PRG-01 parser cron de 5 campos', () => {
  it('parsea listas, rangos, pasos y nombres', () => {
    const c = parseCron('0,30 8-17 * * MON-FRI');
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(c.domRestricted).toBe(false);
    expect(c.dowRestricted).toBe(true);
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('10-40/10 * * * *').minutes).toEqual([10, 20, 30, 40]);
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 1 jan,DEC *').months].sort((a, b) => a - b)).toEqual([1, 12]);
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('0 0 * * 5-7').daysOfWeek].sort()).toEqual([0, 5, 6]);
    expect([...parseCron('0 0 * * */2').daysOfWeek].sort()).toEqual([0, 2, 4, 6]);
    expect(parseCron('0 0 ? * *').dowRestricted).toBe(false);
    expect(parseCron('  0   12  *  *  * ').source).toBe('0 12 * * *');
  });

  it('expande macros', () => {
    expect(parseCron('@daily').hours).toEqual([0]);
    expect(parseCron('@hourly').hours.length).toBe(24);
    expect(parseCron('@weekly').daysOfWeek.has(0)).toBe(true);
    expect(parseCron('@monthly').daysOfMonth.has(1)).toBe(true);
    expect(parseCron('@yearly').months.has(1)).toBe(true);
    expect(parseCron('@annually').months.size).toBe(1);
    expect(parseCron('@midnight').minutes).toEqual([0]);
  });

  it.each([
    '',
    '* * * *',
    '0 * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '5-1 * * * *',
    '*/0 * * * *',
    '*/x * * * *',
    '1/2/3 * * * *',
    'a * * * *',
    '1-2-3 * * * *',
    '-1 * * * *',
    '1, * * * *',
    '@reboot',
    'x'.repeat(201),
  ])('CRON_INVALID para "%s"', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronParseError);
    expect(isValidCron(expr)).toBe(false);
  });

  it('rechaza entradas no textuales', () => {
    expect(() => parseCron(42 as unknown as string)).toThrow(CronParseError);
  });

  it('error expone código estable CRON_INVALID', () => {
    try {
      parseCron('bad');
    } catch (e) {
      expect((e as CronParseError).code).toBe('CRON_INVALID');
      expect((e as CronParseError).expression).toBe('bad');
    }
  });

  it('semántica Vixie: día-mes OR día-semana cuando ambos restringidos', () => {
    const both = parseCron('0 0 13 * 5');
    expect(cronMatchesDate(both, 11, 13, 1)).toBe(true); // día 13, lunes
    expect(cronMatchesDate(both, 11, 6, 5)).toBe(true); // viernes 6
    expect(cronMatchesDate(both, 11, 7, 6)).toBe(false);
    const domOnly = parseCron('0 0 13 * *');
    expect(cronMatchesDate(domOnly, 1, 13, 3)).toBe(true);
    expect(cronMatchesDate(domOnly, 1, 14, 3)).toBe(false);
    const monthOnly = parseCron('0 0 * 2 *');
    expect(cronMatchesDate(monthOnly, 3, 1, 0)).toBe(false);
    expect(cronMatchesDate(monthOnly, 2, 1, 0)).toBe(true);
  });
});

describe('RNF-USA-01 zona IANA', () => {
  it('La Paz es UTC-4 sin DST', () => {
    expect(offsetMinutes(Date.UTC(2026, 0, 15), LP)).toBe(-240);
    expect(offsetMinutes(Date.UTC(2026, 6, 15), LP)).toBe(-240);
    expect(formatLocal(Date.UTC(2026, 10, 9, 12, 0), LP)).toBe('2026-11-09T08:00');
    expect(localParts(Date.UTC(2026, 10, 9, 12, 0), LP).weekday).toBe(1);
    expect(localDateOf(Date.UTC(2026, 10, 9, 2, 0), LP)).toEqual({ year: 2026, month: 11, day: 8 });
  });

  it('zona inválida lanza TIMEZONE_INVALID', () => {
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(/TIMEZONE_INVALID/);
    expect(() => nextOccurrences(['0 8 * * *'], 'Nope/Nope', new Date(), 1)).toThrow(/TIMEZONE_INVALID/);
  });

  it('wallTimeToUtc: normal, inexistente y repetida', () => {
    expect(wallTimeToUtc(2026, 11, 9, 8, 0, LP)).toEqual([Date.UTC(2026, 10, 9, 12, 0)]);
    // 2026-03-08 02:30 no existe en Nueva York
    expect(wallTimeToUtc(2026, 3, 8, 2, 30, NY)).toEqual([]);
    // 2026-11-01 01:30 ocurre dos veces (EDT y EST)
    expect(wallTimeToUtc(2026, 11, 1, 1, 30, NY)).toEqual([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]);
  });
});

describe('RF-PRG-01 L-V 08:00–18:00 cada 30 min = 21 ocurrencias (ESP §13.5)', () => {
  const crons = ['0,30 8-17 * * 1-5', '0 18 * * 1-5'];

  it('21 ocurrencias en un lunes en America/La_Paz, incluye 18:00 y excluye 18:30', () => {
    const occ = occurrencesOnLocalDate(crons, LP, 2026, 11, 9);
    expect(occ).toHaveLength(21);
    expect(occ[0]!.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(occ.at(-1)!.toISOString()).toBe('2026-11-09T22:00:00.000Z');
    expect(iso(occ)).not.toContain('2026-11-09T22:30:00.000Z');
  });

  it('*/30 8-18 daría 22 (incluye 18:30): por eso no se usa', () => {
    const occ = occurrencesOnLocalDate(['*/30 8-18 * * 1-5'], LP, 2026, 11, 9);
    expect(occ).toHaveLength(22);
    expect(iso(occ)).toContain('2026-11-09T22:30:00.000Z');
  });

  it('sábado y domingo no tienen ocurrencias; semana completa = 105', () => {
    expect(occurrencesOnLocalDate(crons, LP, 2026, 11, 7)).toHaveLength(0);
    expect(occurrencesOnLocalDate(crons, LP, 2026, 11, 8)).toHaveLength(0);
    const week = occurrencesBetween(crons, LP, new Date('2026-11-09T04:00:00Z'), new Date('2026-11-16T04:00:00Z'));
    expect(week).toHaveLength(105);
  });

  it('el builder del editor visual genera exactamente esas expresiones', () => {
    const b = buildCronExpressions({
      mode: 'intervalo',
      days: [5, 1, 2, 3, 4],
      start: '08:00',
      end: '18:00',
      everyMinutes: 30,
    });
    expect(b.cronExpressions).toEqual(['0,30 8-17 * * 1-5', '0 18 * * 1-5']);
    expect(b.windowStart).toBe('08:00');
    expect(b.windowEnd).toBe('18:00');
    expect(b.description).toBe('Lunes a viernes, de 08:00 a 18:00 cada 30 min');
    expect(occurrencesOnLocalDate(b.cronExpressions, LP, 2026, 11, 10)).toHaveLength(21);
  });
});

describe('RF-PRG-02 dedupe de múltiples expresiones por instante UTC', () => {
  it('expresiones solapadas no duplican instantes', () => {
    const occ = occurrencesOnLocalDate(['0 8 * * *', '0 8 * * 1', '0,30 8 * * *'], LP, 2026, 11, 9);
    expect(iso(occ)).toEqual(['2026-11-09T12:00:00.000Z', '2026-11-09T12:30:00.000Z']);
    const next = nextOccurrences(['0 8 * * *', '0 8 * * *'], LP, new Date('2026-11-09T00:00:00Z'), 3);
    expect(iso(next)).toEqual(['2026-11-09T12:00:00.000Z', '2026-11-10T12:00:00.000Z', '2026-11-11T12:00:00.000Z']);
  });
});

describe('RF-PRG-02 DST (ESP §13.5): inexistente se omite, repetida solo primera', () => {
  it('hora inexistente 02:30 en salto de primavera se omite', () => {
    const occ = occurrencesOnLocalDate(['30 2 * * *'], NY, 2026, 3, 8);
    expect(occ).toHaveLength(0);
    const next = nextOccurrences(['30 2 * * *'], NY, new Date('2026-03-07T12:00:00Z'), 2);
    expect(iso(next)).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
  });

  it('hora repetida 01:30 en retroceso de otoño solo en su primera ocurrencia', () => {
    const occ = occurrencesOnLocalDate(['30 1 * * *'], NY, 2026, 11, 1);
    expect(iso(occ)).toEqual(['2026-11-01T05:30:00.000Z']);
    expect(isScheduledInstant(['30 1 * * *'], NY, new Date('2026-11-01T05:30:00Z'))).toBe(true);
    expect(isScheduledInstant(['30 1 * * *'], NY, new Date('2026-11-01T06:30:00Z'))).toBe(false);
  });

  it('cada 30 min durante el retroceso no ejecuta dos veces las 01:00/01:30', () => {
    const occ = occurrencesBetween(
      ['*/30 0-3 * * *'],
      NY,
      new Date('2026-11-01T03:00:00Z'),
      new Date('2026-11-01T10:00:00Z'),
    );
    expect(occ.map((d) => formatLocal(d.getTime(), NY))).toEqual([
      '2026-11-01T00:00',
      '2026-11-01T00:30',
      '2026-11-01T01:00',
      '2026-11-01T01:30',
      '2026-11-01T02:00',
      '2026-11-01T02:30',
      '2026-11-01T03:00',
      '2026-11-01T03:30',
    ]);
  });

  it('la vista previa usa la misma política que la admisión', () => {
    const prev = previewOccurrences(['30 1,2 * * *'], NY, new Date('2026-03-07T12:00:00Z'), 3);
    expect(prev.map((p) => p.local)).toEqual(['2026-03-08T01:30', '2026-03-09T01:30', '2026-03-09T02:30']);
    for (const p of prev) expect(isScheduledInstant(['30 1,2 * * *'], NY, new Date(p.at))).toBe(true);
  });
});

describe('RF-PRG-02 nextOccurrences(n)', () => {
  it('devuelve las próximas 5 estrictamente posteriores', () => {
    const after = new Date('2026-11-09T12:00:00Z'); // 08:00 local exacto
    const next = nextOccurrences(['0,30 8-17 * * 1-5', '0 18 * * 1-5'], LP, after, 5);
    expect(iso(next)).toEqual([
      '2026-11-09T12:30:00.000Z',
      '2026-11-09T13:00:00.000Z',
      '2026-11-09T13:30:00.000Z',
      '2026-11-09T14:00:00.000Z',
      '2026-11-09T14:30:00.000Z',
    ]);
    expect(nextOccurrence(['0 18 * * 1-5'], LP, new Date('2026-11-13T22:00:00Z'))!.toISOString()).toBe(
      '2026-11-16T22:00:00.000Z',
    );
  });

  it('cruza de viernes a lunes', () => {
    const next = nextOccurrences(['0 18 * * 1-5'], LP, new Date('2026-11-13T21:00:00Z'), 2);
    expect(iso(next)).toEqual(['2026-11-13T22:00:00.000Z', '2026-11-16T22:00:00.000Z']);
  });

  it('valida count y respeta horizonte', () => {
    expect(() => nextOccurrences(['0 8 * * *'], LP, new Date(), 0)).toThrow(RangeError);
    expect(() => nextOccurrences(['0 8 * * *'], LP, new Date(), 1001)).toThrow(RangeError);
    expect(() => nextOccurrences([], LP, new Date(), 1)).toThrow(RangeError);
    // 30 de febrero nunca ocurre
    expect(nextOccurrences(['0 0 30 2 *'], LP, new Date('2026-01-01T00:00:00Z'), 1, 400)).toEqual([]);
    expect(nextOccurrence(['0 0 30 2 *'], LP, new Date('2026-01-01T00:00:00Z'))).toBeNull();
    // 29 de febrero: próximo bisiesto
    expect(nextOccurrences(['0 0 29 2 *'], LP, new Date('2026-01-01T00:00:00Z'), 1)[0]!.toISOString()).toBe(
      '2028-02-29T04:00:00.000Z',
    );
  });

  it('occurrencesBetween con rango vacío o invertido', () => {
    const t = new Date('2026-11-09T00:00:00Z');
    expect(occurrencesBetween(['* * * * *'], LP, t, t)).toEqual([]);
    expect(occurrencesBetween(['0 8 * * *'], LP, new Date('2026-11-10T00:00:00Z'), t)).toEqual([]);
  });

  it('isScheduledInstant rechaza instantes no alineados', () => {
    expect(isScheduledInstant(['0 8 * * *'], LP, new Date('2026-11-09T12:00:30Z'))).toBe(false);
    expect(isScheduledInstant(['0 8 * * *'], LP, new Date('2026-11-09T13:00:00Z'))).toBe(false);
  });
});

describe('RF-PRG-02 builder del editor visual', () => {
  it('hora fija agrupa horas con iguales minutos', () => {
    const b = buildCronExpressions({ mode: 'hora_fija', days: [1, 3, 5], times: ['18:00', '08:00', '12:30'] });
    expect(b.cronExpressions).toEqual(['0 8,18 * * 1,3,5', '30 12 * * 1,3,5']);
    expect(b.windowStart).toBeNull();
    expect(b.description).toContain('08:00, 12:30, 18:00');
  });

  it('todos los días produce * y fines de semana se describen', () => {
    expect(
      buildCronExpressions({ mode: 'hora_fija', days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'] }).cronExpressions,
    ).toEqual(['0 9 * * *']);
    expect(buildCronExpressions({ mode: 'hora_fija', days: [6, 0], times: ['09:00'] }).description).toMatch(
      /^Fines de semana/,
    );
    expect(
      buildCronExpressions({ mode: 'hora_fija', days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'] }).description,
    ).toMatch(/^Todos los días/);
    expect(buildCronExpressions({ mode: 'hora_fija', days: [2], times: ['09:00'] }).description).toMatch(/^Martes/);
  });

  it('intervalo con paso que no divide 60 produce varias expresiones correctas', () => {
    const b = buildCronExpressions({ mode: 'intervalo', days: [1], start: '08:00', end: '10:00', everyMinutes: 45 });
    // 08:00, 08:45, 09:30
    expect(b.cronExpressions).toEqual(['0,45 8 * * 1', '30 9 * * 1']);
    expect(occurrencesOnLocalDate(b.cronExpressions, LP, 2026, 11, 9).map((d) => formatLocal(d.getTime(), LP))).toEqual(
      ['2026-11-09T08:00', '2026-11-09T08:45', '2026-11-09T09:30'],
    );
  });

  it('rango que cruza medianoche exige días explícitos', () => {
    expect(() =>
      buildCronExpressions({ mode: 'intervalo', days: [5], start: '22:00', end: '02:00', everyMinutes: 60 }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEDULE_RANGE_CROSSES_MIDNIGHT' }));
    const b = buildCronExpressions({
      mode: 'intervalo',
      days: [5],
      start: '22:00',
      end: '02:00',
      everyMinutes: 60,
      overnightDays: [6],
    });
    expect(b.cronExpressions).toEqual(['0 22,23 * * 5', '0 0-2 * * 6']);
    expect(b.description).toContain('sábado');
    const fri = occurrencesOnLocalDate(b.cronExpressions, LP, 2026, 11, 13).map((d) => formatLocal(d.getTime(), LP));
    const sat = occurrencesOnLocalDate(b.cronExpressions, LP, 2026, 11, 14).map((d) => formatLocal(d.getTime(), LP));
    expect(fri).toEqual(['2026-11-13T22:00', '2026-11-13T23:00']);
    expect(sat).toEqual(['2026-11-14T00:00', '2026-11-14T01:00', '2026-11-14T02:00']);
  });

  it('rango que cruza medianoche sin ocurrencias después de 00:00', () => {
    const b = buildCronExpressions({
      mode: 'intervalo',
      days: [5],
      start: '23:00',
      end: '00:10',
      everyMinutes: 120,
      overnightDays: [6],
    });
    expect(b.cronExpressions).toEqual(['0 23 * * 5']);
  });

  it('intervalo mínimo 5 min', () => {
    expect(() =>
      buildCronExpressions({ mode: 'intervalo', days: [1], start: '08:00', end: '09:00', everyMinutes: 4 }),
    ).toThrowError(expect.objectContaining({ code: 'CRON_INTERVAL_TOO_SHORT' }));
    expect(() =>
      buildCronExpressions({ mode: 'intervalo', days: [1], start: '08:00', end: '09:00', everyMinutes: 1.5 }),
    ).toThrow(ScheduleBuildError);
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1], times: ['08:00', '08:03'] })).toThrowError(
      expect.objectContaining({ code: 'CRON_INTERVAL_TOO_SHORT' }),
    );
    // 23:58 domingo y 00:01 lunes: 3 min a través de medianoche
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [0, 1], times: ['23:58', '00:01'] })).toThrowError(
      expect.objectContaining({ code: 'CRON_INTERVAL_TOO_SHORT' }),
    );
    expect(
      buildCronExpressions({ mode: 'intervalo', days: [1], start: '08:00', end: '09:00', everyMinutes: 5 })
        .cronExpressions,
    ).toEqual(['*/5 8 * * 1'.replace('*/5', '0,5,10,15,20,25,30,35,40,45,50,55'), '0 9 * * 1']);
    expect(
      buildCronExpressions(
        { mode: 'intervalo', days: [1], start: '08:00', end: '09:00', everyMinutes: 2 },
        { minIntervalMinutes: 1 },
      ).cronExpressions,
    ).toHaveLength(2);
  });

  it('valida días y horas', () => {
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [], times: ['08:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_DAYS_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [7], times: ['08:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_DAYS_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1, 1], times: ['08:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_DAYS_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1], times: [] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_TIME_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1], times: ['8:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_TIME_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1], times: ['24:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_TIME_INVALID' }),
    );
    expect(() => buildCronExpressions({ mode: 'hora_fija', days: [1], times: ['08:00', '08:00'] })).toThrowError(
      expect.objectContaining({ code: 'SCHEDULE_TIME_INVALID' }),
    );
    expect(() =>
      buildCronExpressions({
        mode: 'intervalo',
        days: [5],
        start: '22:00',
        end: '02:00',
        everyMinutes: 60,
        overnightDays: [9],
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEDULE_DAYS_INVALID' }));
    expect(() =>
      buildCronExpressions({ mode: 'intervalo', days: [1], start: '08:00', end: '09:00', everyMinutes: 2000 }),
    ).toThrow(ScheduleBuildError);
  });

  it('utilidades HH:MM y compactField', () => {
    expect(parseHHMM('18:30')).toBe(1110);
    expect(formatHHMM(1110)).toBe('18:30');
    expect(compactField([1, 2, 3, 4, 5], 0, 6)).toBe('1-5');
    expect(compactField([0, 30], 0, 59)).toBe('0,30');
    expect(compactField([1, 2, 5, 6, 7], 0, 23)).toBe('1,2,5-7');
    expect(compactField([...Array(24).keys()], 0, 23)).toBe('*');
  });
});

describe('RF-PRG-01 validateSchedule (422 con código estable)', () => {
  it('acepta y normaliza/deduplica', () => {
    const r = validateSchedule(['0,30 8-17 * * 1-5', '0  18 * * 1-5', '0 18 * * 1-5'], LP);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual(['0,30 8-17 * * 1-5', '0 18 * * 1-5']);
  });
  it('CRON_INVALID con índice', () => {
    const r = validateSchedule(['0 8 * * *', 'nope'], LP);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'CRON_INVALID', index: 1 });
    expect(validateSchedule([], LP).issues[0]!.code).toBe('CRON_INVALID');
    expect(validateSchedule(Array(21).fill('0 8 * * *'), LP).issues[0]!.code).toBe('CRON_INVALID');
  });
  it('TIMEZONE_INVALID', () => {
    expect(validateSchedule(['0 8 * * *'], 'Bad/Zone').issues.map((i) => i.code)).toContain('TIMEZONE_INVALID');
  });
  it('CRON_INTERVAL_TOO_SHORT con cada minuto y entre expresiones', () => {
    expect(validateSchedule(['* * * * *'], LP).issues[0]!.code).toBe('CRON_INTERVAL_TOO_SHORT');
    expect(validateSchedule(['0 8 * * *', '2 8 * * *'], LP).issues[0]!.code).toBe('CRON_INTERVAL_TOO_SHORT');
    expect(validateSchedule(['*/5 * * * *'], LP).ok).toBe(true);
    expect(validateSchedule(['*/2 * * * *'], LP, { minIntervalMinutes: 2 }).ok).toBe(true);
  });
  it('SCHEDULE_NO_OCCURRENCES', () => {
    expect(validateSchedule(['0 0 31 2 *'], LP).issues[0]!.code).toBe('SCHEDULE_NO_OCCURRENCES');
    expect(minIntervalMinutes(['0 0 31 2 *'])).toBeNull();
  });
  it('minIntervalMinutes con una sola ocurrencia en el horizonte = Infinity', () => {
    expect(minIntervalMinutes(['0 0 29 2 1'])).toBeGreaterThan(5); // OR semántica: lunes o 29-feb
    expect(minIntervalMinutes(['0 12 * * *'])).toBe(1440);
  });
});

describe('RF-PRG-05 ventanas de exclusión y RNF-REN-02 admisión', () => {
  it('isExcluded usa intervalo [inicio, fin)', () => {
    const w = [{ startsAt: new Date('2026-11-09T12:00:00Z'), endsAt: new Date('2026-11-09T13:00:00Z') }];
    expect(isExcluded(new Date('2026-11-09T12:00:00Z'), w)).toBe(true);
    expect(isExcluded(new Date('2026-11-09T12:59:59Z'), w)).toBe(true);
    expect(isExcluded(new Date('2026-11-09T13:00:00Z'), w)).toBe(false);
    expect(isExcluded(new Date('2026-11-09T11:59:59Z'), [])).toBe(false);
  });
  it('admisión vence 60 s después del instante previsto', () => {
    const t = new Date('2026-11-09T12:00:00Z');
    expect(admissionExpired(t, new Date('2026-11-09T12:01:00Z'))).toBe(false);
    expect(admissionExpired(t, new Date('2026-11-09T12:01:00.001Z'))).toBe(true);
  });
});
