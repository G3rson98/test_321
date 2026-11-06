/**
 * 11/12/13 · Nueva ejecución (RF-EJE-01/04/05/06/07, ESP §13.1, §17.2, §17.3).
 * - Selección exclusiva: suite | casos | etiquetas (nunca mezcladas en una petición).
 * - PREVIEW obligatorio (`POST /runs/preview`, con debounce y cancelación): casos y tests por separado, cobertura,
 *   bloqueados con motivo (no se descartan en silencio), advertencias de producción y destinos de TestRail.
 * - `POST /runs` con Idempotency-Key estable por intento; botón deshabilitado en vuelo; confirmación en producción.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useStore } from '@tanstack/react-form';
import { toast } from 'sonner';
import { Loader2, Play, ShieldAlert } from 'lucide-react';
import type { RunPreviewRequest } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { NumberPicker, RadioCardGroup, SegmentedControl } from '@/components/common/controls';
import { Callout, KeyValue } from '@/components/common/misc';
import { FilterChip, TagList } from '@/components/common/tag-chip';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DirtyGuard } from '@/components/common/dirty-guard';
import { EmptyState, ErrorState } from '@/components/common/states';
import { envApi, itemsOf, runsApi, suitesApi } from '@/lib/api/endpoints';
import type { RunPreview } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useDebouncedValue } from '@/lib/hooks';
import { reasonLabel } from '@/lib/labels';
import { selection } from '@/lib/stores/selection';
import { newIdempotencyKey, plural } from '@/lib/utils';
import { CasePicker } from '@/features/suites/suite-form-page';
import { TestRailTargetPicker, type TargetValue } from './testrail-target';
import { useCaseAutomation, useCasesByIds, useKnownTags } from '@/features/common/derived';

const route = getRouteApi('/_app/ejecuciones/nueva');

type Mode = 'suite' | 'casos' | 'etiquetas';
interface Values {
  mode: Mode;
  suiteId: string | null;
  caseIds: string[];
  tags: string[];
  environmentId: string | null;
  retries: number;
  excludeFlaky: boolean;
  /** Destino en TestRail (RF-TR-06): corrida nueva, existente (`trRunId`) o ninguno. */
  target: TargetValue;
}

/** Destino de TestRail del cuerpo; `null` si falta elegir la corrida existente. */
function testrailOf(t: TargetValue) {
  if (t.mode === 'ninguno') return { mode: 'ninguno' as const };
  if (t.mode === 'nueva') return { mode: 'nueva' as const };
  return t.trRunId === null ? null : { mode: 'existente' as const, trRunId: t.trRunId, closeExistingRun: t.closeExistingRun };
}

export function buildRunBody(v: Values): RunPreviewRequest | null {
  if (!v.environmentId) return null;
  const testrail = testrailOf(v.target);
  if (!testrail) return null;
  const base = { environmentId: v.environmentId, retries: v.retries, excludeFlaky: v.excludeFlaky, testrail };
  if (v.mode === 'suite') return v.suiteId ? { ...base, suiteId: v.suiteId } : null;
  if (v.mode === 'casos') return v.caseIds.length ? { ...base, caseIds: v.caseIds } : null;
  return v.tags.length ? { ...base, tags: v.tags } : null;
}

export function NewRunPage() {
  const knownTags = useKnownTags();
  const search = route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [initialCases] = useState(() => (search.caseId ? [search.caseId] : selection.get()));
  const [submitted, setSubmitted] = useState(false);
  const [confirmProd, setConfirmProd] = useState(false);

  const suites = useQuery({ queryKey: qk.suites.list({ limit: 100 }), queryFn: ({ signal }) => suitesApi.list({ limit: 100 }, signal) });
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const envList = itemsOf(envs.data).filter((e) => e.enabled);

  // "Repetir fallidos": nueva corrida con los casos de los tests fallidos (los de escritura no se repiten).
  const repeatRun = useQuery({ queryKey: qk.runs.detail(search.repetir ?? ''), queryFn: ({ signal }) => runsApi.get(search.repetir!, signal), enabled: !!search.repetir });
  const repeatResults = useQuery({
    queryKey: qk.runs.results(search.repetir ?? '', { status: 'fallido', limit: 100 }),
    queryFn: ({ signal }) => runsApi.results(search.repetir!, { status: 'fallido', limit: 100 }, signal),
    enabled: !!search.repetir,
  });

  const form = useForm({
    defaultValues: {
      mode: (search.repetir ? 'casos' : search.modo === 'casos' || initialCases.length > 0 && search.modo !== 'suite' ? 'casos' : search.modo) as Mode,
      suiteId: search.suiteId ?? null,
      caseIds: initialCases,
      tags: [] as string[],
      environmentId: null as string | null,
      retries: 0,
      excludeFlaky: false,
      target: { mode: 'nueva', trRunId: null, closeExistingRun: false } as TargetValue,
    } as Values,
  });

  // Defaults dependientes de datos remotos (sin pisar cambios del usuario).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    const s = form.state.values;
    if (!s.environmentId && envList.length) {
      const staging = envList.find((e) => !e.isProduction) ?? envList[0]!;
      form.setFieldValue('environmentId', search.repetir && repeatRun.data ? repeatRun.data.environment.id : staging.id, { dontUpdateMeta: true });
    }
    if (s.mode === 'suite' && !s.suiteId && suites.data?.items[0]) form.setFieldValue('suiteId', suites.data.items[0].id, { dontUpdateMeta: true });
    if (search.repetir && repeatResults.data) {
      const ids = Array.from(new Set(repeatResults.data.items.filter((r) => r.classification !== 'escritura').flatMap((r) => r.caseIds)));
      form.setFieldValue('caseIds', ids, { dontUpdateMeta: true });
      if (repeatRun.data) form.setFieldValue('environmentId', repeatRun.data.environment.id, { dontUpdateMeta: true });
    }
    if (envList.length && (s.mode !== 'suite' || suites.data) && (!search.repetir || (repeatResults.data && repeatRun.data))) seeded.current = true;
  }, [envList, suites.data, repeatResults.data, repeatRun.data, search.repetir, form]);

  const values = useStore(form.store, (s) => s.values);
  const firstSuite = suites.data?.items[0]?.id;
  useEffect(() => {
    if (values.mode === 'suite' && !values.suiteId && firstSuite) form.setFieldValue('suiteId', firstSuite, { dontUpdateMeta: true });
  }, [values.mode, values.suiteId, firstSuite, form]);
  const dirty = useStore(form.store, (s) => s.isDirty);
  const body = useMemo(() => buildRunBody(values), [values]);
  const debouncedBody = useDebouncedValue(body, 300);
  const bodyKey = JSON.stringify(body);
  // Idempotency-Key estable por intento: cambia solo si cambia lo que se va a ejecutar.
  const idemKey = useMemo(() => newIdempotencyKey(), [bodyKey]);

  const preview = useQuery({
    queryKey: qk.runs.preview(debouncedBody),
    queryFn: ({ signal }) => runsApi.preview(debouncedBody!, signal),
    enabled: !!debouncedBody,
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  });
  const stale = preview.isFetching || JSON.stringify(debouncedBody) !== bodyKey;
  const plan = debouncedBody ? preview.data : undefined;
  const env = envList.find((e) => e.id === values.environmentId);

  const create = useMutation({
    mutationFn: () => runsApi.create({ ...body!, ...(plan?.previewToken ? { previewToken: plan.previewToken } : {}) } as never, idemKey),
    onSuccess: (run) => {
      setSubmitted(true);
      selection.clear();
      void qc.invalidateQueries({ queryKey: ['runs', 'list'] });
      toast.success('Ejecución creada.');
      void navigate({ to: '/ejecuciones/$runId', params: { runId: run.id } });
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'ADMISSION_CONFIG_CHANGED') {
        toast.warning('La configuración cambió desde la vista previa. Revisa el plan actualizado.');
        void preview.refetch();
      } else toast.error(errorMessage(e));
    },
  });

  const canExecute = !!body && !!plan && !stale && !create.isPending && plan.counts.cases > 0;
  const onExecute = () => {
    if (env?.isProduction) setConfirmProd(true);
    else create.mutate();
  };

  return (
    <>
      <DirtyGuard when={dirty && !submitted} />
      <PageHeader
        title="Nueva ejecución"
        subtitle="La selección queda congelada al aceptar la corrida"
        actions={
          <Button variant="ghost" onClick={() => void navigate({ to: '/ejecuciones' })}>
            Cancelar
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <CardSection title="1 · Qué ejecutar">
            <form.Field name="mode">
              {(f) => (
                <SegmentedControl
                  ariaLabel="Qué ejecutar"
                  value={f.state.value === 'suite' ? 'suite' : 'casos'}
                  onValueChange={(v) => f.handleChange(v === 'suite' ? 'suite' : 'casos')}
                  options={[
                    { value: 'suite', label: 'Suite guardada' },
                    { value: 'casos', label: 'Casos / etiquetas' },
                  ]}
                />
              )}
            </form.Field>
            <div className="mt-4">
              {values.mode === 'suite' ? (
                suites.isLoading ? (
                  <Skeleton className="h-20" />
                ) : suites.isError ? (
                  <ErrorState error={suites.error} onRetry={() => void suites.refetch()} compact />
                ) : (suites.data?.items.length ?? 0) === 0 ? (
                  <EmptyState title="Aún no hay suites" action={<Button size="sm" variant="outlineCard" onClick={() => void navigate({ to: '/suites/nueva' })}>Nueva suite</Button>} />
                ) : (
                  <form.Field name="suiteId">
                    {(f) => (
                      <RadioCardGroup
                        ariaLabel="Suite"
                        value={f.state.value}
                        onValueChange={(v) => f.handleChange(v)}
                        className="sm:grid-cols-2 lg:grid-cols-3"
                        items={suites.data!.items.map((s) => ({
                          value: s.id,
                          title: <span className="font-normal">{s.name}</span>,
                          description: s.resolved ? `${s.resolved.cases} ${plural(s.resolved.cases, 'caso', 'casos')} · ${s.resolved.tests} tests` : undefined,
                        }))}
                      />
                    )}
                  </form.Field>
                )
              ) : (
                <div className="space-y-4">
                  <form.Field name="mode">
                    {(f) => (
                      <SegmentedControl
                        ariaLabel="Seleccionar por"
                        value={f.state.value === 'etiquetas' ? 'etiquetas' : 'casos'}
                        onValueChange={(v) => f.handleChange(v)}
                        className="text-[13px]"
                        options={[
                          { value: 'casos', label: 'Por casos' },
                          { value: 'etiquetas', label: 'Por etiquetas' },
                        ]}
                      />
                    )}
                  </form.Field>
                  {values.mode === 'casos' ? (
                    <form.Field name="caseIds">
                      {(f) => <SelectedCases ids={f.state.value} plan={plan} onChange={f.handleChange} />}
                    </form.Field>
                  ) : (
                    <form.Field name="tags">
                      {(f) => (
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Etiquetas (cualquiera)">
                          {knownTags.map((t) => (
                            <FilterChip key={t} tag={t} selected={f.state.value.includes(t)} onToggle={() => f.handleChange(f.state.value.includes(t) ? f.state.value.filter((x) => x !== t) : [...f.state.value, t])} />
                          ))}
                        </div>
                      )}
                    </form.Field>
                  )}
                </div>
              )}
            </div>
          </CardSection>

          <CardSection title="2 · Dónde y cómo">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2.5">
                <Label>Ambiente</Label>
                {envs.isLoading ? (
                  <Skeleton className="h-32" />
                ) : envs.isError ? (
                  <ErrorState error={envs.error} compact onRetry={() => void envs.refetch()} />
                ) : (
                  <form.Field name="environmentId">
                    {(f) => (
                      <RadioCardGroup
                        ariaLabel="Ambiente"
                        value={f.state.value}
                        onValueChange={(v) => f.handleChange(v)}
                        items={envList.map((e) => ({
                          value: e.id,
                          title: e.name,
                          // `appUrl` llega también en el resumen para qa (D-054); sin ella se rotula el tipo de ambiente.
                          description: e.appUrl ? <span className="font-mono text-[12.5px]">{e.appUrl}</span> : <span className="text-[12.5px]">{e.isProduction ? 'Producción' : 'No productivo'}</span>,
                          badge: e.isProduction ? <span className="rounded-sm bg-failed-bg px-2 py-0.5 text-[12.5px] font-medium text-failed">Solo lectura</span> : undefined,
                        }))}
                      />
                    )}
                  </form.Field>
                )}
              </div>
              <div className="space-y-6">
                <div className="space-y-2.5">
                  <Label id="retries-label">Reintentos ante falla</Label>
                  <form.Field name="retries">{(f) => <NumberPicker ariaLabel="Reintentos ante falla" values={[0, 1, 2]} value={f.state.value} onChange={f.handleChange} />}</form.Field>
                  {plan?.tests.some((t) => t.classification === 'escritura' && !t.writeIdempotencyApproved) ? (
                    <p className="text-[12.5px] text-muted-foreground">Los tests de escritura sin idempotencia aprobada no se reintentan.</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label>Navegador</Label>
                  <p className="font-mono text-[14px]">Chromium (único admitido)</p>
                </div>
                <form.Field name="excludeFlaky">
                  {(f) => (
                    <label className="flex items-center gap-2.5 text-[15px]">
                      <Checkbox checked={f.state.value} onCheckedChange={(v) => f.handleChange(v === true)} /> Excluir tests inestables
                    </label>
                  )}
                </form.Field>
                <form.Field name="target">{(f) => <TestRailTargetPicker value={f.state.value} onChange={f.handleChange} />}</form.Field>
              </div>
            </div>
          </CardSection>
        </div>

        <PlanPanel body={!!body} plan={plan} loading={preview.isLoading && !!debouncedBody} stale={!!body && stale} error={preview.error} canExecute={canExecute} pending={create.isPending} onExecute={onExecute} />
      </div>

      <ConfirmDialog
        open={confirmProd}
        onOpenChange={setConfirmProd}
        title="Ejecutar en Producción"
        description={
          plan ? (
            <>
              Vas a ejecutar {plan.counts.executableTests} {plural(plan.counts.executableTests, 'test', 'tests')} de solo lectura en Producción.
              {plan.counts.blockedCases > 0 ? ` ${plan.counts.blockedCases} ${plural(plan.counts.blockedCases, 'caso queda bloqueado', 'casos quedan bloqueados')} y se registra en el plan.` : ''}
            </>
          ) : null
        }
        confirmLabel="Ejecutar ahora"
        pending={create.isPending}
        onConfirm={() => {
          setConfirmProd(false);
          create.mutate();
        }}
      />
    </>
  );
}

function SelectedCases({ ids, plan, onChange }: { ids: string[]; plan: RunPreview | undefined; onChange: (v: string[]) => void }) {
  const known = useCasesByIds(ids);
  const automation = useCaseAutomation([...known.values()]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const all = Array.from(new Set([...ids, ...unchecked]));
  if (all.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-[14px] text-muted-foreground">Elige casos desde el catálogo o búscalos aquí (máximo 500).</p>
        <CasePicker value={ids} onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="max-h-[420px] overflow-y-auto rounded-lg border border-border" aria-label="Casos seleccionados">
        {all.map((id) => {
          const pc = plan?.cases.find((c) => c.caseId === id);
          const kc = known.get(id);
          const checked = ids.includes(id);
          return (
            <li key={id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
              <Checkbox
                aria-label={`Incluir ${pc?.ref ?? kc?.ref ?? id}`}
                checked={checked}
                onCheckedChange={(on) => {
                  setUnchecked((p) => {
                    const n = new Set(p);
                    if (on === true) n.delete(id);
                    else n.add(id);
                    return n;
                  });
                  onChange(on === true ? [...ids, id] : ids.filter((x) => x !== id));
                }}
              />
              <span className="font-mono text-[14px] text-primary">{pc?.ref ?? kc?.ref ?? '…'}</span>
              <span className="min-w-0 flex-1 truncate">{pc?.title ?? kc?.title ?? ''}</span>
              {pc && !pc.executable && checked ? (
                <span className="rounded-sm bg-blocked-bg px-1.5 text-[12px] text-blocked">Bloqueado · {pc.blockReasons.map(reasonLabel).join(', ')}</span>
              ) : null}
              <span className="hidden sm:block">
                <TagList tags={automation.get(id)?.tags} max={3} />
              </span>
            </li>
          );
        })}
      </ul>
      <details>
        <summary className="cursor-pointer text-[14px] text-primary">Agregar más casos</summary>
        <div className="mt-3">
          <CasePicker value={ids} onChange={onChange} />
        </div>
      </details>
    </div>
  );
}

function PlanPanel({
  body,
  plan,
  loading,
  stale,
  error,
  canExecute,
  pending,
  onExecute,
}: {
  body: boolean;
  plan: RunPreview | undefined;
  loading: boolean;
  stale: boolean;
  error: unknown;
  canExecute: boolean;
  pending: boolean;
  onExecute: () => void;
}) {
  const blocked = plan?.cases.filter((c) => !c.executable) ?? [];
  const blockedTests = plan?.tests.filter((t) => !t.executable) ?? [];
  const isProd = plan?.environment.isProduction ?? false;
  return (
    <aside className="h-fit xl:sticky xl:top-24" aria-label="Plan resuelto">
      <CardSection title="Plan resuelto" meta={stale && plan ? 'Actualizando plan…' : undefined}>
        {!body ? (
          <p className="text-[14px] text-muted-foreground">Elige qué ejecutar, el ambiente y el destino en TestRail para ver el plan.</p>
        ) : loading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : error && !plan ? (
          <Callout tone="danger" title="No se pudo resolver el plan">
            {errorMessage(error)}
          </Callout>
        ) : plan ? (
          <div className={stale ? 'opacity-60 transition-opacity' : ''} aria-busy={stale}>
            <KeyValue
              items={[
                { k: 'Casos', v: plan.counts.cases },
                { k: 'Tests', v: plan.counts.executableTests },
                { k: 'Cobertura', v: `${plan.counts.executableCases}/${plan.counts.cases} casos` },
                { k: 'Commit', v: `main@${plan.gitCommit.slice(0, 7)}`, mono: true },
                // La API no estima workers ni duración (no se inventan): se muestra si se abrirá navegador y a qué suites de TestRail se publicará.
                { k: 'Navegador', v: plan.willLaunchBrowser ? 'Se ejecuta' : 'No se abrirá' },
                { k: 'TestRail', v: plan.testrailTargets.length ? plan.testrailTargets.map((t) => t.name).join(', ') : '—' },
              ]}
            />
            {blocked.length > 0 || blockedTests.length > 0 ? (
              <Callout tone="blocked" className="mt-4 px-3" icon={<ShieldAlert className="size-4" />} title={`${blocked.length || blockedTests.length} ${plural(blocked.length || blockedTests.length, 'bloqueado', 'bloqueados')}${isProd ? ' en producción' : ''}`}>
                <ul className="mt-1 space-y-0.5 text-[13px]">
                  {blocked.map((c) => (
                    <li key={c.caseId}>
                      {c.ref} · {c.blockReasons.map(reasonLabel).join(', ').toLowerCase()}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {plan.warnings.filter((w) => w.code !== 'PRODUCTION').map((w) => (
              <Callout key={w.code + w.message} tone="warning" className="mt-3 px-3 text-[13px]">
                {w.message}
              </Callout>
            ))}
            {plan.blockers.map((b) => (
              <Callout key={b.code} tone="danger" className="mt-3 px-3 text-[13px]">
                {b.message}
              </Callout>
            ))}
            {!plan.willLaunchBrowser ? (
              <Callout tone="warning" className="mt-3 px-3 text-[13px]">
                Todo quedó bloqueado: la corrida terminará como “bloqueada” sin abrir el navegador y se registrará el motivo.
              </Callout>
            ) : null}
          </div>
        ) : null}
        <Button className="mt-5 w-full" disabled={!canExecute} onClick={onExecute}>
          {pending ? <Loader2 className="animate-spin" /> : <Play />} Ejecutar ahora
        </Button>
      </CardSection>
    </aside>
  );
}
