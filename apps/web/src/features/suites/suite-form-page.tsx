/**
 * Formulario de suite (RF-CAT-03; sin captura). Selector por casos, etiquetas y secciones (unión, OR); secciones
 * incluyen descendientes. TanStack Form + Zod (SuiteCreateSchema compartido), errores de servidor por campo,
 * guarda de navegación con cambios y conflicto de versión (409) sin perder lo editado.
 */
import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, Search, Trash2, X } from 'lucide-react';
import { SuiteCreateSchema } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardSection } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { FilterChip } from '@/components/common/tag-chip';
import { Callout, FieldError } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DirtyGuard } from '@/components/common/dirty-guard';
import { ErrorState } from '@/components/common/states';
import { catalogApi, itemsOf, suitesApi } from '@/lib/api/endpoints';
import type { Suite } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { applyServerErrors, firstError } from '@/lib/form';
import { useDebouncedValue } from '@/lib/hooks';
import { selection } from '@/lib/stores/selection';
import { useCan } from '@/lib/auth/session';
import { useCasesByIds, useKnownTags } from '@/features/common/derived';

const editRoute = getRouteApi('/_app/suites/$suiteId');

const FormSchema = z
  .object({
    name: z.string().trim().min(1, 'Ponle un nombre a la suite').max(120, 'Máximo 120 caracteres'),
    description: z.string().max(2000, 'Máximo 2000 caracteres'),
    caseIds: z.array(z.string()).max(500, 'Máximo 500 casos explícitos'),
    tags: z.array(z.string()),
    sectionIds: z.array(z.string()),
    excludeFlaky: z.boolean(),
  })
  .refine((v) => v.caseIds.length + v.tags.length + v.sectionIds.length > 0, { message: 'Elige al menos un caso, una etiqueta o una sección', path: ['caseIds'] });
type FormValues = z.infer<typeof FormSchema>;

function toValues(s: Suite | null, initialCases: string[]): FormValues {
  return {
    name: s?.name ?? '',
    description: s?.description ?? '',
    caseIds: s?.selector.caseIds ?? initialCases,
    tags: s?.selector.tags ?? [],
    sectionIds: s?.selector.sectionIds ?? [],
    excludeFlaky: s?.selector.excludeFlaky ?? false,
  };
}

export function SuiteNewPage() {
  const [initial] = useState(() => selection.get());
  return <SuiteForm suite={null} initialCases={initial} />;
}

export function SuiteEditPage() {
  const { suiteId } = editRoute.useParams();
  const s = useQuery({ queryKey: qk.suites.detail(suiteId), queryFn: ({ signal }) => suitesApi.get(suiteId, signal) });
  if (s.isLoading) return <Skeleton className="h-96" />;
  if (s.isError || !s.data) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  // `key` por versión: un refetch con nueva versión no pisa el borrador (el formulario parte del snapshot).
  return <SuiteForm key={s.data.id} suite={s.data} initialCases={[]} />;
}

function SuiteForm({ suite, initialCases }: { suite: Suite | null; initialCases: string[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canWrite = useCan('suites.write');
  const [summaryErrors, setSummaryErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = SuiteCreateSchema.parse({
        name: v.name.trim(),
        description: v.description.trim() || undefined,
        selector: {
          ...(v.caseIds.length ? { caseIds: v.caseIds } : {}),
          ...(v.tags.length ? { tags: v.tags } : {}),
          ...(v.sectionIds.length ? { sectionIds: v.sectionIds } : {}),
          excludeFlaky: v.excludeFlaky,
        },
      });
      return suite ? suitesApi.update(suite.id, { ...body, version: suite.version }) : suitesApi.create(body);
    },
  });
  const remove = useMutation({
    mutationFn: () => suitesApi.remove(suite!.id),
    onSuccess: () => {
      toast.success('Suite eliminada. Las ejecuciones anteriores conservan su snapshot.');
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['suites'] });
      void navigate({ to: '/suites' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const form = useForm({
    defaultValues: toValues(suite, initialCases),
    validators: { onChange: FormSchema },
    onSubmit: async ({ value, formApi }) => {
      setSummaryErrors([]);
      try {
        const out = await save.mutateAsync(value);
        setSaved(true);
        void qc.invalidateQueries({ queryKey: ['suites'] });
        toast.success(suite ? 'Suite actualizada.' : 'Suite creada.');
        if (!suite) selection.clear();
        void navigate({ to: '/suites/$suiteId', params: { suiteId: out.id } });
        formApi.reset(toValues(out, []));
      } catch (e) {
        if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
        else {
          const left = applyServerErrors(form as never, e, ['name', 'description', 'caseIds', 'tags', 'sectionIds']);
          setSummaryErrors(left.length ? left : isApiError(e) && e.details?.issues?.length ? [] : [errorMessage(e)]);
        }
      }
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Subscribe selector={(s) => s.isDirty && !saved}>{(dirty) => <DirtyGuard when={dirty} />}</form.Subscribe>
      <PageHeader
        title={suite ? suite.name : 'Nueva suite'}
        subtitle="Las suites se resuelven al ejecutar: cambiarla no altera ejecuciones anteriores"
        actions={
          <>
            <Button variant="ghost" onClick={() => void navigate({ to: '/suites' })}>
              Cancelar
            </Button>
            {suite && canWrite ? (
              <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Eliminar
              </Button>
            ) : null}
            <form.Subscribe selector={(s) => [s.isSubmitting, s.canSubmit] as const}>
              {([submitting, can]) => (
                <Button type="submit" disabled={!canWrite || submitting || !can}>
                  {submitting ? <Loader2 className="animate-spin" /> : null} Guardar
                </Button>
              )}
            </form.Subscribe>
          </>
        }
      />

      {conflict ? (
        <Callout tone="warning" className="mb-6" title="La suite cambió desde que la abriste" action={<Button size="sm" variant="outlineCard" onClick={() => window.location.reload()}>Recargar</Button>}>
          Otra persona la modificó. Recarga para ver la versión actual; tus cambios siguen en pantalla hasta que lo hagas.
        </Callout>
      ) : null}
      {summaryErrors.length ? (
        <Callout tone="danger" className="mb-6" title="No se pudo guardar">
          <ul className="list-disc pl-4">
            {summaryErrors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <CardSection title="Datos">
            <div className="grid gap-4">
              <form.Field name="name">
                {(f) => {
                  const err = f.state.meta.isTouched || form.state.submissionAttempts > 0 ? firstError(f.state.meta.errors) : null;
                  return (
                    <div className="space-y-2">
                      <Label htmlFor="suite-name">Nombre</Label>
                      <Input id="suite-name" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} aria-invalid={!!err} aria-describedby="suite-name-err" />
                      <FieldError id="suite-name-err" message={err} />
                    </div>
                  );
                }}
              </form.Field>
              <form.Field name="description">
                {(f) => (
                  <div className="space-y-2">
                    <Label htmlFor="suite-desc">Descripción</Label>
                    <Textarea id="suite-desc" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} rows={2} />
                    <FieldError message={firstError(f.state.meta.errors)} />
                  </div>
                )}
              </form.Field>
            </div>
          </CardSection>

          <CardSection title="Qué incluye">
            <div className="space-y-6">
              <form.Field name="tags">
                {(f) => (
                  <fieldset className="space-y-2">
                    <legend className="label-mono mb-2">Etiquetas (cualquiera)</legend>
                    <TagPicker value={f.state.value} onChange={f.handleChange} />
                  </fieldset>
                )}
              </form.Field>
              <form.Field name="sectionIds">
                {(f) => (
                  <fieldset>
                    <legend className="label-mono mb-2">Secciones (incluye subsecciones)</legend>
                    <SectionPicker value={f.state.value} onChange={f.handleChange} />
                  </fieldset>
                )}
              </form.Field>
              <form.Field name="caseIds">
                {(f) => (
                  <fieldset>
                    <legend className="label-mono mb-2">Casos explícitos</legend>
                    <CasePicker value={f.state.value} onChange={f.handleChange} />
                    <FieldError message={form.state.submissionAttempts > 0 || f.state.meta.isTouched ? firstError(f.state.meta.errors) : null} />
                  </fieldset>
                )}
              </form.Field>
              <form.Field name="excludeFlaky">
                {(f) => (
                  <label className="flex items-center gap-2 text-[15px]">
                    <Checkbox checked={f.state.value} onCheckedChange={(v) => f.handleChange(v === true)} /> Excluir tests inestables al resolver
                  </label>
                )}
              </form.Field>
            </div>
          </CardSection>
        </div>

        <form.Subscribe selector={(s) => s.values}>
          {(v) => (
            <Card className="h-fit p-5 xl:sticky xl:top-24">
              <h2 className="text-[15px] font-semibold">Resumen</h2>
              <dl className="mt-4 space-y-2 text-[14px]">
                <div className="flex justify-between"><dt className="text-muted-foreground">Casos explícitos</dt><dd>{v.caseIds.length}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Etiquetas</dt><dd className="font-mono">{v.tags.join(' ') || '–'}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Secciones</dt><dd>{v.sectionIds.length}</dd></div>
                {suite?.resolved ? (
                  <div className="flex justify-between border-t border-border pt-2"><dt className="text-muted-foreground">Resuelve hoy</dt><dd>{suite.resolved.cases} casos · {suite.resolved.tests} tests</dd></div>
                ) : null}
              </dl>
              <p className="mt-4 text-[13px] text-muted-foreground">
                Casos, etiquetas y secciones se combinan (unión). La resolución final y los bloqueos se muestran en la vista previa de cada ejecución.
              </p>
            </Card>
          )}
        </form.Subscribe>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminar suite"
        description="Se elimina para ejecuciones futuras; las ejecuciones anteriores conservan su snapshot."
        confirmLabel="Eliminar"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </form>
  );
}

function TagPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const known = useKnownTags();
  const options = Array.from(new Set([...known, ...value]));
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((t) => (
        <FilterChip key={t} tag={t} selected={value.includes(t)} onToggle={() => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])} />
      ))}
    </div>
  );
}

function SectionPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const sections = useQuery({ queryKey: qk.catalog.sections(), queryFn: ({ signal }) => catalogApi.sections({}, signal) });
  const tops = itemsOf(sections.data).filter((s) => !s.parentId);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {tops.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-[15px]">
          <Checkbox checked={value.includes(s.id)} onCheckedChange={(on) => onChange(on === true ? [...value, s.id] : value.filter((x) => x !== s.id))} />
          {s.name}
        </label>
      ))}
    </div>
  );
}

/** Buscador de casos con debounce 300 ms y cancelación (la Query aborta la petición anterior). */
export function CasePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q.trim(), 300);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const results = useQuery({
    queryKey: qk.catalog.cases({ q: term, limit: 10, picker: true }),
    queryFn: ({ signal }) => catalogApi.cases({ q: term, limit: 10 }, signal),
    enabled: term.length >= 2,
  });
  const missing = useMemo(() => value.filter((id) => !labels[id]), [value, labels]);
  const known = useCasesByIds(missing);
  const labelOf = (id: string) => labels[id] ?? known.get(id)?.ref ?? id.slice(0, 8);
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por ID (C1201) o título" className="pl-8" aria-label="Buscar casos" />
      </div>
      {term.length >= 2 ? (
        <ul className="max-h-60 overflow-y-auto rounded-md border border-border bg-card" aria-busy={results.isFetching}>
          {results.isLoading ? <li className="px-3 py-2 text-[13px] text-muted-foreground">Buscando…</li> : null}
          {results.data?.items.length === 0 ? <li className="px-3 py-2 text-[13px] text-muted-foreground">Sin resultados</li> : null}
          {results.data?.items.map((c) => (
            <li key={c.id} className="border-b border-border last:border-0">
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[14px] hover:bg-muted/40">
                <Checkbox
                  checked={value.includes(c.id)}
                  onCheckedChange={(on) => {
                    setLabels((p) => ({ ...p, [c.id]: c.ref }));
                    onChange(on === true ? [...value, c.id] : value.filter((x) => x !== c.id));
                  }}
                />
                <span className="font-mono text-primary">{c.ref}</span> <span className="truncate">{c.title}</span>
                {!c.automated ? <span className="ml-auto text-[12px] text-muted-foreground">Sin test</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span key={id} className="inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-muted pr-1 pl-2 font-mono text-[12px]">
              {labelOf(id)}
              <button type="button" aria-label={`Quitar ${labelOf(id)}`} onClick={() => onChange(value.filter((x) => x !== id))} className="rounded p-0.5 hover:bg-border">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
