/**
 * 17/18 · Nueva/editar programación (RF-PRG-01/02/03): objetivo por suite, casos o etiquetas; ambiente; reintentos;
 * notificaciones; editor visual con vista previa de la API. TanStack Form, errores 422 por campo, guarda de
 * navegación y conflicto de revisión (409) sin perder cambios. Guardar no ejecuta.
 */
import { useEffect, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useStore } from '@tanstack/react-form';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { ScheduleCreate, ScheduleUpdate } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { NumberPicker, SegmentedControl } from '@/components/common/controls';
import { Callout, FieldError } from '@/components/common/misc';
import { FilterChip } from '@/components/common/tag-chip';
import { DirtyGuard } from '@/components/common/dirty-guard';
import { ErrorState } from '@/components/common/states';
import { envApi, itemsOf, schedulesApi, suitesApi } from '@/lib/api/endpoints';
import type { Schedule } from '@/lib/api/types';
import { errorMessage, fieldErrorsFrom, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { firstError } from '@/lib/form';
import { selection } from '@/lib/stores/selection';
import { useCan } from '@/lib/auth/session';
import { CasePicker } from '@/features/suites/suite-form-page';
import { DEFAULT_TAGS } from '@/features/catalog/catalog-page';
import { CronEditor, CronPreview, DEFAULT_CRON, fromEditor, toEditor, validateCron, type CronValue } from './cron-editor';

const newRoute = getRouteApi('/_app/programaciones/nueva');
const editRoute = getRouteApi('/_app/programaciones/$scheduleId/editar');

type Target = 'suite' | 'casos' | 'etiquetas';
interface Values {
  name: string;
  target: Target;
  suiteId: string;
  caseIds: string[];
  tags: string[];
  environmentId: string;
  retries: number;
  onFailure: boolean;
  onInterruption: boolean;
  cron: CronValue;
}

function fromSchedule(s: Schedule | null, init: Partial<Values> = {}): Values {
  if (!s) {
    return { name: '', target: 'suite', suiteId: '', caseIds: [], tags: [], environmentId: '', retries: 0, onFailure: true, onInterruption: true, cron: DEFAULT_CRON, ...init };
  }
  const sel = s.selector;
  return {
    name: s.name,
    target: sel.kind === 'suite' ? 'suite' : sel.kind === 'cases' ? 'casos' : 'etiquetas',
    suiteId: sel.kind === 'suite' ? sel.suiteId : '',
    caseIds: sel.kind === 'cases' ? sel.caseIds : [],
    tags: sel.kind === 'tags' ? sel.tags : [],
    environmentId: s.environmentId,
    retries: s.retries,
    onFailure: s.notify.onFailure,
    onInterruption: s.notify.onInterruption,
    cron: fromEditor(s.editor, s.timezone),
    ...init,
  };
}

function toBody(v: Values): ScheduleCreate {
  const selection = v.target === 'suite' ? { suiteId: v.suiteId } : v.target === 'casos' ? { caseIds: v.caseIds } : { tags: v.tags };
  return {
    name: v.name.trim(),
    ...selection,
    environmentId: v.environmentId,
    timezone: v.cron.timezone,
    retries: v.retries,
    enabled: true,
    notify: { onFailure: v.onFailure, onInterruption: v.onInterruption, channels: [] },
    editor: toEditor(v.cron),
  } as ScheduleCreate;
}

function validate(v: Values): Partial<Record<'name' | 'target' | 'environmentId' | 'cron', string>> {
  const e: ReturnType<typeof validate> = {};
  if (!v.name.trim()) e.name = 'Ponle un nombre a la programación';
  else if (v.name.length > 120) e.name = 'Máximo 120 caracteres';
  if (v.target === 'suite' && !v.suiteId) e.target = 'Elige una suite';
  if (v.target === 'casos' && v.caseIds.length === 0) e.target = 'Elige al menos un caso';
  if (v.target === 'casos' && v.caseIds.length > 500) e.target = 'Máximo 500 casos';
  if (v.target === 'etiquetas' && v.tags.length === 0) e.target = 'Elige al menos una etiqueta';
  if (!v.environmentId) e.environmentId = 'Elige un ambiente';
  if (Object.keys(validateCron(v.cron)).length) e.cron = 'Revisa el horario';
  return e;
}

export function ScheduleNewPage() {
  const search = newRoute.useSearch();
  const source = useQuery({ queryKey: qk.schedules.detail(search.desde ?? ''), queryFn: ({ signal }) => schedulesApi.get(search.desde!, signal), enabled: !!search.desde });
  const [initialCases] = useState(() => (search.modo === 'casos' ? selection.get() : []));
  if (search.desde && source.isLoading) return <Skeleton className="h-96" />;
  const init: Partial<Values> = source.data
    ? { name: `${source.data.name} (copia)` }
    : search.suiteId
      ? { target: 'suite', suiteId: search.suiteId }
      : search.modo === 'casos'
        ? { target: 'casos', caseIds: initialCases }
        : search.modo === 'etiquetas'
          ? { target: 'etiquetas' }
          : {};
  return <ScheduleForm schedule={null} initial={fromSchedule(source.data ?? null, init)} />;
}

export function ScheduleEditPage() {
  const { scheduleId } = editRoute.useParams();
  const s = useQuery({ queryKey: qk.schedules.detail(scheduleId), queryFn: ({ signal }) => schedulesApi.get(scheduleId, signal) });
  if (s.isLoading) return <Skeleton className="h-96" />;
  if (s.isError || !s.data) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  return <ScheduleForm key={s.data.id} schedule={s.data} initial={fromSchedule(s.data)} />;
}

function ScheduleForm({ schedule, initial }: { schedule: Schedule | null; initial: Values }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canWrite = useCan('schedules.write');
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const suites = useQuery({ queryKey: qk.suites.list({ limit: 100 }), queryFn: ({ signal }) => suitesApi.list({ limit: 100 }, signal) });
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const envList = itemsOf(envs.data).filter((e) => e.enabled);

  const save = useMutation({
    mutationFn: (v: Values) => (schedule ? schedulesApi.update(schedule.id, { ...toBody(v), revision: schedule.revision } as ScheduleUpdate) : schedulesApi.create(toBody(v))),
  });

  const form = useForm({
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      if (Object.keys(validate(value)).length) return;
      setSummary(null);
      setServerErrors({});
      try {
        const out = await save.mutateAsync(value);
        setSaved(true);
        void qc.invalidateQueries({ queryKey: ['schedules'] });
        toast.success(schedule ? 'Programación actualizada. Afecta solo ocurrencias futuras.' : 'Programación creada. No se ejecuta al guardar.');
        void navigate({ to: '/programaciones/$scheduleId', params: { scheduleId: out.id } });
      } catch (e) {
        if (isApiError(e) && (e.code === 'VERSION_CONFLICT' || e.status === 409 && e.code !== 'CONFLICT')) {
          setConflict(true);
          return;
        }
        const byField = fieldErrorsFrom(e);
        const mapped: Record<string, string> = {};
        for (const [k, m] of Object.entries(byField)) {
          if (k.startsWith('editor') || k.startsWith('cronExpressions') || k === 'timezone') mapped.cron = m;
          else if (['suiteId', 'caseIds', 'tags'].includes(k.split('.')[0]!)) mapped.target = m;
          else mapped[k.split('.')[0]!] = m;
        }
        setServerErrors(mapped);
        if (Object.keys(mapped).length === 0) setSummary(errorMessage(e));
      }
    },
  });
  const values = useStore(form.store, (s) => s.values);
  const dirty = useStore(form.store, (s) => s.isDirty);
  const attempted = useStore(form.store, (s) => s.submissionAttempts > 0);
  const errors = validate(values);
  const showErr = (k: keyof typeof errors) => serverErrors[k] ?? (attempted ? errors[k] : undefined);

  // Valores por defecto remotos sin marcar el formulario como modificado.
  const firstEnv = (envList.find((e) => !e.isProduction) ?? envList[0])?.id;
  const firstSuite = suites.data?.items[0]?.id;
  useEffect(() => {
    if (!form.state.values.environmentId && firstEnv) form.setFieldValue('environmentId', firstEnv, { dontUpdateMeta: true });
    if (form.state.values.target === 'suite' && !form.state.values.suiteId && firstSuite) form.setFieldValue('suiteId', firstSuite, { dontUpdateMeta: true });
  }, [firstEnv, firstSuite, form, values.target]);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DirtyGuard when={dirty && !saved} />
      <PageHeader
        title={schedule ? `Editar ${schedule.name}` : 'Nueva programación'}
        subtitle="Define qué, dónde y cuándo"
        actions={
          <Button variant="ghost" onClick={() => void navigate({ to: schedule ? '/programaciones/$scheduleId' : '/programaciones', params: { scheduleId: schedule?.id ?? '' } as never })}>
            Cancelar
          </Button>
        }
      />
      {conflict ? (
        <Callout tone="warning" className="mb-6" title="La programación cambió desde que la abriste" action={<Button size="sm" variant="outlineCard" onClick={() => window.location.reload()}>Recargar</Button>}>
          Otra persona guardó una nueva revisión. Recarga para ver la versión actual antes de guardar; tus cambios siguen en pantalla.
        </Callout>
      ) : null}
      {summary ? <Callout tone="danger" className="mb-6" title="No se pudo guardar">{summary}</Callout> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <CardSection title="Objetivo">
            <div className="grid gap-4 md:grid-cols-3">
              <form.Field name="name">
                {(f) => (
                  <div className="space-y-2">
                    <Label htmlFor="sch-name">Nombre</Label>
                    <Input id="sch-name" value={f.state.value} onChange={(e) => { f.handleChange(e.target.value); setServerErrors((p) => ({ ...p, name: '' })); }} onBlur={f.handleBlur} aria-invalid={!!showErr('name')} />
                    <FieldError message={showErr('name') || (f.state.meta.isTouched ? firstError([errors.name]) : null)} />
                  </div>
                )}
              </form.Field>
              <div className="space-y-2">
                <Label htmlFor="sch-target">{values.target === 'suite' ? 'Suite' : values.target === 'casos' ? 'Casos' : 'Etiquetas'}</Label>
                {values.target === 'suite' ? (
                  <form.Field name="suiteId">
                    {(f) => (
                      <Select value={f.state.value || undefined} onValueChange={f.handleChange}>
                        <SelectTrigger id="sch-target" aria-invalid={!!showErr('target')}>
                          <SelectValue placeholder="Elige una suite" />
                        </SelectTrigger>
                        <SelectContent>
                          {suites.data?.items.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </form.Field>
                ) : (
                  <p className="pt-2 text-[14px] text-muted-foreground">{values.target === 'casos' ? `${values.caseIds.length} seleccionados` : values.tags.join(' ') || 'Ninguna'}</p>
                )}
                <FieldError message={showErr('target')} />
              </div>
              <form.Field name="environmentId">
                {(f) => (
                  <div className="space-y-2">
                    <Label htmlFor="sch-env">Ambiente</Label>
                    <Select value={f.state.value || undefined} onValueChange={f.handleChange}>
                      <SelectTrigger id="sch-env">
                        <SelectValue placeholder="Elige un ambiente" />
                      </SelectTrigger>
                      <SelectContent>
                        {envList.map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.name}
                            {e.isProduction ? ' · solo lectura' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldError message={showErr('environmentId')} />
                  </div>
                )}
              </form.Field>
            </div>
            <div className="mt-5 space-y-4">
              <form.Field name="target">
                {(f) => (
                  <SegmentedControl
                    ariaLabel="Programar"
                    value={f.state.value}
                    onValueChange={f.handleChange}
                    options={[
                      { value: 'suite', label: 'Suite' },
                      { value: 'casos', label: 'Casos' },
                      { value: 'etiquetas', label: 'Etiquetas' },
                    ]}
                  />
                )}
              </form.Field>
              {values.target === 'casos' ? <form.Field name="caseIds">{(f) => <CasePicker value={f.state.value} onChange={f.handleChange} />}</form.Field> : null}
              {values.target === 'etiquetas' ? (
                <form.Field name="tags">
                  {(f) => (
                    <div className="flex flex-wrap gap-1.5">
                      {DEFAULT_TAGS.map((t) => (
                        <FilterChip key={t} tag={t} selected={f.state.value.includes(t)} onToggle={() => f.handleChange(f.state.value.includes(t) ? f.state.value.filter((x) => x !== t) : [...f.state.value, t])} />
                      ))}
                    </div>
                  )}
                </form.Field>
              ) : null}
              {envList.find((e) => e.id === values.environmentId)?.isProduction ? (
                <Callout tone="warning" className="text-[13px]">
                  En producción solo se ejecutan tests aprobados de solo lectura; los casos con revisión de pasos pendiente no pueden programarse.
                </Callout>
              ) : null}
            </div>
          </CardSection>

          <CardSection title="Horario">
            <form.Field name="cron">{(f) => <CronEditor value={f.state.value} onChange={f.handleChange} serverError={serverErrors.cron ?? null} />}</form.Field>
          </CardSection>

          <CardSection title="Ejecución y avisos">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2.5">
                <Label>Reintentos ante falla</Label>
                <form.Field name="retries">{(f) => <NumberPicker ariaLabel="Reintentos ante falla" values={[0, 1, 2]} value={f.state.value} onChange={f.handleChange} />}</form.Field>
              </div>
              <div className="space-y-3">
                <Label>Avisar cuando</Label>
                <form.Field name="onFailure">
                  {(f) => (
                    <label className="flex items-center gap-2.5 text-[15px]">
                      <Checkbox checked={f.state.value} onCheckedChange={(v) => f.handleChange(v === true)} /> Termina con fallas
                    </label>
                  )}
                </form.Field>
                <form.Field name="onInterruption">
                  {(f) => (
                    <label className="flex items-center gap-2.5 text-[15px]">
                      <Checkbox checked={f.state.value} onCheckedChange={(v) => f.handleChange(v === true)} /> Se interrumpe
                    </label>
                  )}
                </form.Field>
              </div>
            </div>
          </CardSection>
        </div>

        <aside className="h-fit xl:sticky xl:top-24">
          <CardSection title="Vista previa">
            <CronPreview value={values.cron} />
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(submitting) => (
                <Button type="submit" className="mt-6 w-full" disabled={!canWrite || submitting}>
                  {submitting ? <Loader2 className="animate-spin" /> : null} Guardar programación
                </Button>
              )}
            </form.Subscribe>
            {schedule ? <p className="mt-3 text-[12.5px] text-muted-foreground">Revisión actual: {schedule.revision}. Guardar crea una nueva revisión.</p> : null}
          </CardSection>
        </aside>
      </div>
    </form>
  );
}
