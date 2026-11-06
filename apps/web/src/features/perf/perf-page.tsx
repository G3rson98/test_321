/**
 * 19 · Rendimiento DXMon (RF-REN-02/03/04/05, ESP §13.8): período y ambiente en URL, p95/promedio/máx por hora o
 * día con conteo y calidad ("muestra insuficiente" sin p95 inventado), comparación con el período anterior, marcas
 * de eventos, errores HTTP/timeouts/> 29 s con hora exacta y umbrales (edición: dev). Gráfico en chunk diferido.
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { Flag, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { KpiCard, KpiGrid } from '@/components/common/kpi-card';
import { SegmentedControl } from '@/components/common/controls';
import { Callout, FieldError } from '@/components/common/misc';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-table/data-table';
import { envApi, itemsOf, perfApi } from '@/lib/api/endpoints';
import type { PerfErrorItem, PerfThreshold } from '@/lib/api/types';
import { METRIC_KIND_LABEL, selectorOf, summarizePerf, type PerfSummaryRow } from './perf-summary';
import { errorMessage, fieldErrorsFrom } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { formatDateTimeShort, formatSeconds, formatTimeSeconds, startOfLocalDay } from '@/lib/format';
import type { PerfSearch } from '@/app/search';
import type { ChartSeries } from './perf-chart';

const PerfChart = lazy(() => import('./perf-chart'));
const route = getRouteApi('/_app/rendimiento');
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const PERIOD_LABEL: Record<PerfSearch['periodo'], string> = { hoy: 'hoy', '7d': 'últimos 7 días', '30d': 'últimos 30 días' };

function range(periodo: PerfSearch['periodo'], now = new Date()) {
  const to = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const from = periodo === 'hoy' ? startOfLocalDay(now) : new Date(to.getTime() - (periodo === '7d' ? 7 : 30) * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
const shortEndpoint = (k: string) => k.replace(/^[A-Z]+ /, '');

export function PerfPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const qc = useQueryClient();
  const canThreshold = useCan('perf.thresholds.manage');
  const canMark = useCan('perf.events.write');
  const [editing, setEditing] = useState<PerfSummaryRow | null>(null);
  const [markOpen, setMarkOpen] = useState(false);

  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const envList = itemsOf(envs.data);
  const envId = search.ambiente ?? envList.find((e) => e.isProduction)?.id ?? envList[0]?.id;
  const env = envList.find((e) => e.id === envId);
  const by = (search.agrupar ?? (search.periodo === '30d' ? 'dia' : 'hora')) === 'dia' ? 'day' : 'hour';
  // El rango se fija al cambiar período/ambiente (minuto exacto) para que la clave de caché sea estable.
  const r = useMemo(() => range(search.periodo), [search.periodo, envId]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseQ = { environmentId: envId, from: r.from, to: r.to };

  const agg = useQuery({
    queryKey: qk.perf.aggregates({ ...baseQ, by, compare: search.comparar }),
    queryFn: ({ signal }) => perfApi.aggregates({ ...baseQ, by, compare: search.comparar === 'anterior' ? 'previous_period' : 'none' }, signal),
    enabled: !!envId,
    placeholderData: keepPreviousData,
  });
  // Umbrales: solo dev/admin pueden leerlos (perf.thresholds.manage); qa ve el resumen sin límite.
  const thresholds = useQuery({ queryKey: qk.perf.thresholds({ environmentId: envId }), queryFn: ({ signal }) => perfApi.thresholds({ environmentId: envId, limit: 100 }, signal), enabled: !!envId && canThreshold });
  const errors = useQuery({ queryKey: qk.perf.errors({ ...baseQ, limit: 100 }), queryFn: ({ signal }) => perfApi.errors({ ...baseQ, limit: 100 }, signal), enabled: !!envId });

  const rows = useMemo(() => summarizePerf(agg.data, thresholds.data?.items), [agg.data, thresholds.data]);
  const main = rows.filter((x) => x.key.metricKind !== 'root_current_wait').sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1))[0];
  const current = rows.find((x) => x.key.metricKind === 'root_current_wait');
  const limitOf = (x: PerfSummaryRow | undefined) => x?.threshold?.limit ?? null;
  const errItems = errors.data?.items ?? [];
  const http = errItems.filter((e) => e.kind === 'http_error');
  const over = errItems.filter((e) => e.kind === 'over_29s');
  const timeouts = errItems.filter((e) => e.kind === 'timeout');
  const byCode = Object.entries(http.reduce<Record<string, number>>((a, e) => ({ ...a, [String(e.statusCode)]: (a[String(e.statusCode)] ?? 0) + 1 }), {}))
    .map(([c, n]) => `${n}× ${c}`)
    .join(', ');

  const series: ChartSeries[] = (agg.data?.series ?? []).map((s, i) => ({
    key: `s${i}`,
    label: shortEndpoint(s.key.endpointKey),
    color: COLORS[i % COLORS.length]!,
    points: s.points,
    comparison: s.comparison,
  }));
  const noData = agg.data && agg.data.series.every((s) => s.points.length === 0);
  const insufficient = agg.data?.series.some((s) => s.points.some((p) => p.p95Status === 'muestra_insuficiente'));

  const set = (patch: Partial<PerfSearch>) => void navigate({ search: (p) => ({ ...p, ...patch }), replace: true });

  const columns = useMemo<ColumnDef<PerfSummaryRow>[]>(
    () => [
      { id: 'tipo', header: 'Medición', cell: ({ row }) => METRIC_KIND_LABEL[row.original.key.metricKind] },
      { id: 'servicio', header: 'Servicio', cell: ({ row }) => <span className="font-mono text-[13px]">{shortEndpoint(row.original.key.endpointKey)}</span> },
      { id: 'prom', header: 'Promedio', cell: ({ row }) => <span className="font-mono text-[13px]">{formatSeconds(row.original.meanMs)}</span> },
      {
        id: 'p95',
        header: () => <span title="Peor p95 por intervalo del período (el p95 del período completo no se recombina desde intervalos)">P95 (peor intervalo)</span>,
        cell: ({ row }) => {
          const x = row.original;
          if (x.p95Ms === null) return <span className="text-[13px] text-flaky">{x.p95Status === 'no_disponible' ? 'No disponible' : 'Muestra insuficiente'}</span>;
          const lim = limitOf(x);
          const over = lim !== null && x.p95Ms > lim;
          return <span className={`font-mono text-[13px] font-semibold ${over ? 'text-failed' : ''}`}>{formatSeconds(x.p95Ms)}</span>;
        },
      },
      { id: 'max', header: 'Máximo', cell: ({ row }) => <span className="font-mono text-[13px]">{formatSeconds(row.original.maxMs)}</span> },
      { id: 'n', header: 'n', cell: ({ row }) => <span className="font-mono text-[13px]" title="Respuestas completadas / iniciadas">{row.original.completed}/{row.original.started}</span> },
      { id: 'err', header: 'Errores', cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.httpErrors + row.original.timeouts}</span> },
      {
        id: 'umbral',
        header: 'Umbral p95',
        cell: ({ row }) =>
          canThreshold ? (
            <Button variant="outlineCard" size="sm" className="font-mono" onClick={() => setEditing(row.original)} aria-label={`Editar umbral de ${shortEndpoint(row.original.key.endpointKey)}`}>
              {limitOf(row.original) !== null ? formatSeconds(limitOf(row.original)).replace(',0', '') : 'Definir'} <Pencil className="size-3" />
            </Button>
          ) : (
            <span className="font-mono text-[13px]" title="Los umbrales los gestionan desarrolladores">–</span>
          ),
      },
    ],
    [canThreshold], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const errColumns: ColumnDef<PerfErrorItem>[] = [
    { id: 'hora', header: 'Hora exacta', cell: ({ row }) => <span className="font-mono text-[13px]">{search.periodo === 'hoy' ? formatTimeSeconds(row.original.ts) : formatDateTimeShort(row.original.ts)}</span> },
    { id: 'tipo', header: 'Tipo', cell: ({ row }) => ({ http_error: 'Error HTTP', network_error: 'Error de red', timeout: 'Timeout', over_29s: 'Respuesta > 29 s' })[row.original.kind] },
    { id: 'servicio', header: 'Servicio', cell: ({ row }) => <span className="font-mono text-[13px]">{shortEndpoint(row.original.endpointKey)}</span> },
    { id: 'codigo', header: 'Código', cell: ({ row }) => row.original.statusCode ?? '–' },
    { id: 'dur', header: 'Duración', cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.totalMs !== null ? formatSeconds(row.original.totalMs) : row.original.censoredAtMs !== null ? `> ${formatSeconds(row.original.censoredAtMs)}` : '–'}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Rendimiento"
        subtitle={`Mediciones DXMon · ${env?.name ?? '…'} · ${PERIOD_LABEL[search.periodo]} por ${by === 'day' ? 'día' : 'hora'}`}
        actions={
          <>
            <Select value={envId ?? ''} onValueChange={(v) => set({ ambiente: v })}>
              <SelectTrigger className="h-9 w-[150px]" aria-label="Ambiente">
                <SelectValue placeholder="Ambiente" />
              </SelectTrigger>
              <SelectContent>
                {envList.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SegmentedControl
              ariaLabel="Período"
              value={search.periodo}
              onValueChange={(periodo) => set({ periodo, agrupar: undefined })}
              options={[
                { value: 'hoy', label: 'Hoy' },
                { value: '7d', label: '7 días' },
                { value: '30d', label: '30 días' },
              ]}
            />
          </>
        }
      />

      <KpiGrid>
        <KpiCard
          label="P95 más alto"
          loading={agg.isLoading}
          tone={main?.p95Ms && limitOf(main) && main.p95Ms > limitOf(main)! ? 'failed' : 'default'}
          value={main ? (main.p95Ms !== null ? formatSeconds(main.p95Ms) : '—') : '—'}
          hint={main ? (main.p95Ms === null ? 'muestra insuficiente' : `${shortEndpoint(main.key.endpointKey)}${limitOf(main) !== null ? ` · umbral ${formatSeconds(limitOf(main)).replace(',0', '')}` : ''}`) : agg.isError ? 'No se pudo cargar' : ' '}
        />
        <KpiCard label="Espera por current" loading={agg.isLoading} tone="passed" value={current?.p95Ms != null ? formatSeconds(current.p95Ms) : '—'} hint={current ? `p95 peor intervalo · n=${current.completed}` : 'sin mediciones'} />
        <KpiCard label="Errores HTTP" loading={errors.isLoading} tone={http.length ? 'flaky' : 'default'} value={http.length} hint={[byCode, timeouts.length ? `${timeouts.length} ${timeouts.length === 1 ? 'timeout' : 'timeouts'}` : ''].filter(Boolean).join(' · ') || 'sin errores'} />
        <KpiCard label="Respuestas > 29 s" loading={errors.isLoading} tone={over.length ? 'failed' : 'default'} value={over.length} hint={over[0] ? `${formatTimeSeconds(over[0].ts)} · ${shortEndpoint(over[0].endpointKey).split('/').pop()}` : 'ninguna'} />
      </KpiGrid>

      <CardSection
        title={`p95 por ${by === 'day' ? 'día' : 'hora'} (segundos)`}
        className="mb-6"
        action={
          <div className="flex items-center gap-3">
            {search.periodo !== '30d' ? (
              <SegmentedControl ariaLabel="Agrupar" value={by === 'day' ? 'dia' : 'hora'} onValueChange={(agrupar) => set({ agrupar })} className="text-[13px]" options={[{ value: 'hora', label: 'Por hora' }, { value: 'dia', label: 'Por día' }]} />
            ) : null}
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={search.comparar === 'anterior'} onCheckedChange={(v) => set({ comparar: v === true ? 'anterior' : 'no' })} /> Comparar con período anterior
            </label>
            {canMark ? (
              <Button size="sm" variant="outlineCard" onClick={() => setMarkOpen(true)}>
                <Flag /> Marcar evento
              </Button>
            ) : null}
          </div>
        }
      >
        {agg.isLoading ? (
          <Skeleton className="h-[300px]" />
        ) : agg.isError ? (
          <ErrorState error={agg.error} onRetry={() => void agg.refetch()} />
        ) : noData ? (
          <EmptyState title="Sin mediciones en este período" description="La falta de muestras no significa que el sistema esté sano: revisa que la suite @rendimiento esté programada." />
        ) : (
          <>
            <Suspense fallback={<Skeleton className="h-[300px]" />}>
              <PerfChart series={series} thresholdMs={limitOf(main)} marks={agg.data?.marks ?? []} granularity={by} />
            </Suspense>
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              {insufficient ? 'Los huecos son intervalos con muestra insuficiente (< 20 respuestas completadas): no se calcula p95. ' : ''}
              {agg.data?.lastSampleAt ? `Última muestra: ${formatDateTimeShort(agg.data.lastSampleAt)}.` : ''}
            </p>
          </>
        )}
      </CardSection>

      <CardSection title="Por servicio" padded={false} className="mb-6">
        <DataTable caption="Rendimiento por servicio" columns={columns} data={rows} getRowId={(x) => `${x.key.endpointKey}|${x.key.source}|${x.key.metricKind}|${x.key.provenance}`} isLoading={agg.isLoading} error={agg.error} onRetry={() => void agg.refetch()} empty={{ title: 'Sin mediciones en este período' }} />
      </CardSection>

      <CardSection title="Errores, timeouts y respuestas > 29 s" padded={false}>
        <DataTable caption="Eventos puntuales" columns={errColumns} data={errItems} getRowId={(x) => x.id} isLoading={errors.isLoading} error={errors.error} onRetry={() => void errors.refetch()} empty={{ title: 'Sin errores ni respuestas lentas en el período' }} />
      </CardSection>

      {editing && envId ? (
        <ThresholdDialog
          row={editing}
          environmentId={envId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['perf'] });
          }}
        />
      ) : null}
      {markOpen && envId ? <MarkDialog environmentId={envId} onClose={() => setMarkOpen(false)} onSaved={() => { setMarkOpen(false); void qc.invalidateQueries({ queryKey: ['perf'] }); }} /> : null}
    </>
  );
}

function ThresholdDialog({ row, environmentId, onClose, onSaved }: { row: PerfSummaryRow; environmentId: string; onClose: () => void; onSaved: () => void }) {
  const list = useQuery({ queryKey: qk.perf.thresholds({ environmentId }), queryFn: ({ signal }) => perfApi.thresholds({ environmentId, limit: 100 }, signal) });
  const existing: PerfThreshold | undefined = list.data?.items.find((t) => t.id === row.threshold?.id);
  const [limit, setLimit] = useState(String((row.threshold?.limit ?? 10_000) / 1000));
  const [windowMin, setWindowMin] = useState(String(existing?.windowMin ?? 60));
  const [minSamples, setMinSamples] = useState(String(existing?.minSamples ?? 20));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body = {
        environmentId,
        seriesSelector: selectorOf(row.key),
        metric: 'p95' as const,
        limit: Math.round(Number(limit.replace(',', '.')) * 1000),
        windowMin: Number(windowMin),
        minSamples: Number(minSamples),
        enabled: true,
        label: `${shortEndpoint(row.key.endpointKey)} p95`,
      };
      return existing ? perfApi.updateThreshold(existing.id, { ...body, version: existing.version }) : perfApi.createThreshold(body);
    },
    onSuccess: () => {
      toast.success('Umbral guardado. Queda registrado en auditoría.');
      onSaved();
    },
    onError: (e) => {
      const f = fieldErrorsFrom(e);
      setErrs(f);
      if (!Object.keys(f).length) toast.error(errorMessage(e));
    },
  });
  const localErr = Number(minSamples) < 20 ? 'El mínimo para p95 es 20 muestras' : Number(windowMin) < 5 ? 'Ventana mínima 5 min' : !(Number(limit.replace(',', '.')) > 0) ? 'Indica un límite en segundos' : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Umbral p95 · {shortEndpoint(row.key.endpointKey)}</DialogTitle>
          <DialogDescription>
            Serie: <span className="font-mono">{row.key.endpointKey}</span> · {row.key.provenance} · {row.key.source}. Se alerta como máximo una vez por hora.
          </DialogDescription>
        </DialogHeader>
        {list.isLoading ? <Skeleton className="h-24" /> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="th-limit">Límite (s)</Label>
            <Input id="th-limit" value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" />
            <FieldError message={errs.limit} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="th-window">Ventana (min)</Label>
            <Input id="th-window" value={windowMin} onChange={(e) => setWindowMin(e.target.value)} inputMode="numeric" />
            <FieldError message={errs.windowMin} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="th-min">Mínimo de muestras</Label>
            <Input id="th-min" value={minSamples} onChange={(e) => setMinSamples(e.target.value)} inputMode="numeric" />
            <FieldError message={errs.minSamples} />
          </div>
        </div>
        {localErr ? <Callout tone="warning" className="text-[13px]">{localErr}</Callout> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!!localErr || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Guardar umbral
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkDialog({ environmentId, onClose, onSaved }: { environmentId: string; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState('');
  const [when, setWhen] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const save = useMutation({
    mutationFn: () => perfApi.createMark({ label: label.trim(), ts: new Date(when).toISOString(), environmentId }),
    onSuccess: () => {
      toast.success('Marca agregada.');
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar evento</DialogTitle>
          <DialogDescription>Por ejemplo, un despliegue, para comparar antes y después.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="mk-label">Descripción</Label>
          <Input id="mk-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Despliegue v4.13" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mk-when">Fecha y hora</Label>
          <Input id="mk-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!label.trim() || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Agregar marca
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
