/**
 * Editor visual de horario (RF-PRG-02, ESP §13.5): días + hora fija o rango con intervalo, zona IANA.
 * La expresión cron y las próximas ejecuciones vienen de la API (`POST /schedules/preview`, mismo servicio que la
 * admisión, misma política DST): el panel no calcula ocurrencias por su cuenta. Horas en 24 h (RNF-USA-01).
 * L–V 08:00–18:00 c/30 min ⇒ `0,30 8-17 * * 1-5` + `0 18 * * 1-5` = 21 ocurrencias por día.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Plus, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/common/controls';
import { Callout, FieldError } from '@/components/common/misc';
import { schedulesApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useDebouncedValue } from '@/lib/hooks';
import { formatWeekdayDateTime, localDayKey, utcOffsetLabel } from '@/lib/format';
import { DAY_NAMES } from '@/lib/labels';
import { cn } from '@/lib/utils';

export interface CronValue {
  mode: 'hora_fija' | 'intervalo';
  /** 0 = domingo … 6 = sábado (contrato ScheduleEditorSchema). */
  days: number[];
  times: string[];
  start: string;
  end: string;
  everyMinutes: number;
  overnightDays: number[];
  timezone: string;
}

export const DEFAULT_CRON: CronValue = {
  mode: 'hora_fija',
  days: [1, 2, 3, 4, 5],
  times: ['08:00'],
  start: '08:00',
  end: '18:00',
  everyMinutes: 30,
  overnightDays: [],
  timezone: 'America/La_Paz',
};

export const TIMEZONES = ['America/La_Paz', 'America/Lima', 'America/Bogota', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Mexico_City', 'UTC'];
const INTERVALS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
/** Orden visual L M X J V S D (lunes primero) sobre el contrato 0 = domingo. */
const UI_DAYS: { d: number; label: string }[] = [
  { d: 1, label: 'L' },
  { d: 2, label: 'M' },
  { d: 3, label: 'X' },
  { d: 4, label: 'J' },
  { d: 5, label: 'V' },
  { d: 6, label: 'S' },
  { d: 0, label: 'D' },
];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (s: string) => (HHMM.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN);

/** Validación local de estructura antes de red (el servidor valida al final). */
export function validateCron(v: CronValue): Partial<Record<'days' | 'times' | 'start' | 'end' | 'everyMinutes' | 'overnightDays', string>> {
  const e: ReturnType<typeof validateCron> = {};
  if (v.days.length === 0) e.days = 'Elige al menos un día';
  if (v.mode === 'hora_fija') {
    if (v.times.length === 0) e.times = 'Indica al menos una hora';
    else if (v.times.some((t) => !HHMM.test(t))) e.times = 'Usa el formato 24 h HH:MM (p. ej. 08:00)';
    else if (new Set(v.times).size !== v.times.length) e.times = 'Hay horas repetidas';
  } else {
    if (!HHMM.test(v.start)) e.start = 'Formato HH:MM';
    if (!HHMM.test(v.end)) e.end = 'Formato HH:MM';
    if (v.everyMinutes < 5) e.everyMinutes = 'El intervalo mínimo es 5 min';
    if (!e.start && !e.end && toMin(v.end) === toMin(v.start)) e.end = '“Hasta” debe ser distinta de “Desde”';
    if (!e.start && !e.end && toMin(v.end) < toMin(v.start) && v.overnightDays.length === 0) {
      e.overnightDays = 'El rango cruza medianoche: indica los días posteriores a 00:00';
    }
  }
  return e;
}

export function toEditor(v: CronValue) {
  return v.mode === 'hora_fija'
    ? { mode: 'hora_fija' as const, days: [...v.days].sort(), times: v.times }
    : {
        mode: 'intervalo' as const,
        days: [...v.days].sort(),
        start: v.start,
        end: v.end,
        everyMinutes: v.everyMinutes,
        ...(toMin(v.end) < toMin(v.start) ? { overnightDays: [...v.overnightDays].sort() } : {}),
      };
}

export function fromEditor(editor: unknown, timezone: string): CronValue {
  const e = editor as Partial<CronValue> & { mode?: string } | null;
  if (!e || !e.mode) return { ...DEFAULT_CRON, timezone };
  return { ...DEFAULT_CRON, ...e, timezone, overnightDays: e.overnightDays ?? [], times: e.times ?? DEFAULT_CRON.times } as CronValue;
}

function DayPicker({ value, onChange, label, error }: { value: number[]; onChange: (v: number[]) => void; label: string; error?: string | undefined }) {
  return (
    <fieldset>
      <legend className="mb-3 text-[15px] font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {UI_DAYS.map(({ d, label: l }) => {
          const on = value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={DAY_NAMES[d]}
              onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}
              className={cn(
                'size-10 rounded-full border font-mono text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted',
              )}
            >
              {l}
            </button>
          );
        })}
      </div>
      <FieldError message={error} />
    </fieldset>
  );
}

function TimeField({ id, label, value, onChange, error }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string | undefined }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative w-[150px]">
        <Input
          id={id}
          value={value}
          inputMode="numeric"
          maxLength={5}
          placeholder="HH:MM"
          aria-invalid={!!error}
          onChange={(e) => {
            let s = e.target.value.replace(/[^\d:]/g, '');
            if (/^\d{3,4}$/.test(s)) s = `${s.slice(0, s.length - 2).padStart(2, '0')}:${s.slice(-2)}`;
            onChange(s);
          }}
          className="pr-9 font-mono"
        />
        <Clock className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
      <FieldError message={error} />
    </div>
  );
}

export function CronEditor({ value, onChange, serverError }: { value: CronValue; onChange: (v: CronValue) => void; serverError?: string | null }) {
  const errors = validateCron(value);
  const set = (patch: Partial<CronValue>) => onChange({ ...value, ...patch });
  const crossesMidnight = value.mode === 'intervalo' && HHMM.test(value.start) && HHMM.test(value.end) && toMin(value.end) < toMin(value.start);
  return (
    <div className="space-y-6">
      <DayPicker label="Días" value={value.days} onChange={(days) => set({ days })} error={errors.days} />
      <SegmentedControl
        ariaLabel="Tipo de horario"
        value={value.mode}
        onValueChange={(mode) => set({ mode })}
        options={[
          { value: 'hora_fija', label: 'Hora fija' },
          { value: 'intervalo', label: 'Rango con intervalo' },
        ]}
      />
      {value.mode === 'hora_fija' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            {value.times.map((t, i) => (
              <div key={i} className="flex items-end gap-1">
                <TimeField id={`hora-${i}`} label={i === 0 ? 'Hora' : `Hora ${i + 1}`} value={t} onChange={(nv) => set({ times: value.times.map((x, j) => (j === i ? nv : x)) })} />
                {value.times.length > 1 ? (
                  <Button variant="ghost" size="icon" aria-label={`Quitar hora ${t}`} onClick={() => set({ times: value.times.filter((_, j) => j !== i) })}>
                    <X />
                  </Button>
                ) : null}
              </div>
            ))}
            {value.times.length < 12 ? (
              <Button variant="ghost" size="sm" onClick={() => set({ times: [...value.times, '12:00'] })}>
                <Plus /> Agregar hora
              </Button>
            ) : null}
          </div>
          <FieldError message={errors.times} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-4">
            <TimeField id="desde" label="Desde" value={value.start} onChange={(start) => set({ start })} error={errors.start} />
            <TimeField id="hasta" label="Hasta" value={value.end} onChange={(end) => set({ end })} error={errors.end} />
            <div className="space-y-2">
              <Label htmlFor="cada">Cada</Label>
              <Select value={String(value.everyMinutes)} onValueChange={(v) => set({ everyMinutes: Number(v) })}>
                <SelectTrigger id="cada" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVALS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m < 60 ? `${m} min` : `${m / 60} h`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.everyMinutes} />
            </div>
          </div>
          {crossesMidnight ? (
            <DayPicker label="Días posteriores a medianoche" value={value.overnightDays} onChange={(overnightDays) => set({ overnightDays })} error={errors.overnightDays} />
          ) : null}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="zona">Zona horaria</Label>
        <Select value={value.timezone} onValueChange={(timezone) => set({ timezone })}>
          <SelectTrigger id="zona" className="w-[320px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz} ({utcOffsetLabel(tz)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {serverError ? <Callout tone="danger">{serverError}</Callout> : null}
    </div>
  );
}

/** Vista previa desde la API: expresiones cron, próximas 5 y ocurrencias por día (de 50 instantes). */
export function CronPreview({ value }: { value: CronValue }) {
  const valid = Object.keys(validateCron(value)).length === 0;
  const body = useMemo(() => (valid ? { editor: toEditor(value), timezone: value.timezone, count: 50 } : null), [valid, value]);
  const debounced = useDebouncedValue(body, 300);
  const preview = useQuery({
    queryKey: qk.schedules.preview(debounced),
    queryFn: ({ signal }) => schedulesApi.preview(debounced!, signal),
    enabled: !!debounced,
    staleTime: 30_000,
    retry: false,
  });
  const occ = preview.data?.occurrences ?? [];
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of occ) {
      const k = localDayKey(o.at, value.timezone);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m.size ? Math.max(...m.values()) : 0;
  }, [occ, value.timezone]);
  return (
    <div className="space-y-5" aria-live="polite">
      <div>
        <div className="label-mono mb-2">Expresión cron</div>
        {!valid ? (
          <p className="text-[13px] text-muted-foreground">Completa el horario para ver la expresión.</p>
        ) : preview.isLoading || (!preview.data && preview.isFetching) ? (
          <Skeleton className="h-9" />
        ) : preview.isError ? (
          <Callout tone="danger" className="px-3 text-[13px]">{errorMessage(preview.error)}</Callout>
        ) : preview.data?.issues.length ? (
          // La API responde 200 con `issues` cuando la expresión no es válida (p. ej. intervalo menor al mínimo).
          <div data-testid="cron-issues">
            <Callout tone="danger" className="px-3 text-[13px]">
              {preview.data.issues.map((i) => i.message).join(' ')}
            </Callout>
          </div>
        ) : (
          <div className="space-y-1.5" data-testid="cron-expressions">
            {preview.data?.cronExpressions.map((c) => (
              <div key={c} className="rounded-md bg-brand-ink px-3 py-2 font-mono text-[14px] text-primary">
                {c}
              </div>
            ))}
          </div>
        )}
        {preview.data?.description ? <p className="mt-2 text-[13px] text-muted-foreground">{preview.data.description}</p> : null}
      </div>
      <div>
        <div className="label-mono mb-2">Próximas 5 ejecuciones</div>
        {valid && preview.data ? (
          <ul className="space-y-1.5" data-testid="next-runs">
            {occ.slice(0, 5).map((o) => (
              <li key={o.at} className="flex items-center gap-2.5 text-[15px]">
                <span className="size-1.5 rounded-full bg-primary-soft ring-2 ring-primary-soft" aria-hidden />
                {formatWeekdayDateTime(o.at, value.timezone)}
              </li>
            ))}
            {occ.length === 0 ? <li className="text-[13px] text-muted-foreground">Sin ocurrencias próximas.</li> : null}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">–</p>
        )}
        {valid && preview.data && perDay > 0 ? (
          <p className="mt-3 text-[13px] text-muted-foreground" data-testid="per-day">
            {perDay} {perDay === 1 ? 'ejecución' : 'ejecuciones'} por día programado
          </p>
        ) : null}
      </div>
    </div>
  );
}
