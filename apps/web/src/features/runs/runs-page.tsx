/**
 * 10 · Ejecuciones (RF-RES-01/04/05, RF-TR-08): filtros en URL, paginación por cursor, estado de publicación a
 * TestRail separado del estado de ejecución, exportación CSV/PDF en servidor. SSE invalida la lista; fallback de
 * polling (30 s con backoff) solo si SSE cae.
 */
import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { StatusBadge } from '@/components/common/status-badge';
import { ExportDialog } from '@/components/common/export-dialog';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { envApi, itemsOf, runsApi } from '@/lib/api/endpoints';
import type { RunSummary } from '@/lib/api/types';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { useCursorHistory } from '@/lib/hooks';
import { addDaysIso, formatDuration, zonedMidnightIso } from '@/lib/format';
import { RUN_OUTCOME_LABEL, RUN_STATUS_LABEL, SYNC_STATUS_LABEL, TRIGGER_LABEL } from '@/lib/labels';
import { usePollingFallback } from '@/lib/sse/polling';
import type { RunsSearch } from '@/app/search';
import { RunIdLink, RunOrigin, RunProgressCell, RunState } from './run-cells';

const route = getRouteApi('/_app/ejecuciones');

export function runsQuery(s: RunsSearch) {
  return {
    environmentId: s.ambiente,
    status: s.estado,
    outcome: s.resultado,
    trigger: s.origen,
    from: s.desde ? zonedMidnightIso(s.desde) : undefined,
    to: s.hasta ? zonedMidnightIso(addDaysIso(s.hasta, 1)) : undefined,
    sort: s.sort,
    cursor: s.cursor,
    limit: s.limit,
  };
}

const columns: ColumnDef<RunSummary>[] = [
  { id: 'id', header: 'ID', enableHiding: false, meta: { label: 'ID' }, cell: ({ row }) => <RunIdLink run={row.original} /> },
  { id: 'origen', header: 'Origen', meta: { label: 'Origen' }, cell: ({ row }) => <RunOrigin run={row.original} /> },
  { id: 'ambiente', header: 'Ambiente', meta: { label: 'Ambiente' }, cell: ({ row }) => row.original.environment.name },
  {
    id: 'iniciada',
    header: 'Iniciada por',
    meta: { label: 'Iniciada por' },
    cell: ({ row }) => (row.original.createdBy.kind === 'sistema' ? 'Programador' : row.original.createdBy.displayName),
  },
  { id: 'progreso', header: 'Progreso', meta: { label: 'Progreso' }, cell: ({ row }) => <RunProgressCell run={row.original} /> },
  {
    id: 'duracion',
    header: 'Duración',
    meta: { label: 'Duración' },
    cell: ({ row }) => (
      <span className="font-mono text-[13px]">
        {formatDuration(row.original.durationMs ?? (row.original.startedAt ? Date.now() - Date.parse(row.original.startedAt) : null))}
      </span>
    ),
  },
  { id: 'testrail', header: 'TestRail', meta: { label: 'TestRail' }, cell: ({ row }) => <StatusBadge status={SYNC_STATUS_LABEL[row.original.syncStatus]} /> },
  { id: 'estado', header: 'Estado', enableHiding: false, meta: { label: 'Estado' }, cell: ({ row }) => <RunState run={row.original} /> },
];

export function RunsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const appNavigate = useNavigate();
  const canRun = useCan('runs.create');
  const [exportOpen, setExportOpen] = useState(false);
  const poll = usePollingFallback('list');
  const q = useMemo(() => runsQuery(search), [search]);
  const filterKey = JSON.stringify({ ...search, cursor: undefined });
  const pager = useCursorHistory(filterKey, search.cursor, (cursor) => void navigate({ search: (p) => ({ ...p, cursor }) }));

  const runs = useQuery({ queryKey: qk.runs.list(q), queryFn: ({ signal }) => runsApi.list(q, signal), placeholderData: keepPreviousData, refetchInterval: poll });
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const set = (patch: Partial<RunsSearch>) => void navigate({ search: (p) => ({ ...p, ...patch, cursor: undefined }), replace: true });
  const hasFilters = !!(search.ambiente || search.estado || search.resultado || search.origen || search.desde || search.hasta);

  return (
    <>
      <PageHeader
        title="Ejecuciones"
        subtitle="Manuales y programadas, con su estado de publicación en TestRail"
        actions={
          <>
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Download /> Exportar CSV
            </Button>
            {canRun ? (
              <Button onClick={() => void appNavigate({ to: '/ejecuciones/nueva' })}>
                <Play /> Nueva ejecución
              </Button>
            ) : null}
          </>
        }
      />
      <Card>
        <DataTable
          caption="Ejecuciones"
          columns={columns}
          data={runs.data?.items}
          getRowId={(r) => r.id}
          isLoading={runs.isLoading}
          isFetching={runs.isFetching && !runs.isLoading}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          columnPrefsKey="ejecuciones"
          onRowClick={(r) => void appNavigate({ to: '/ejecuciones/$runId', params: { runId: r.id } })}
          toolbar={
            <>
              <FilterSelect label="Ambiente" value={search.ambiente} onChange={(v) => set({ ambiente: v })} options={itemsOf(envs.data).map((e) => ({ value: e.id, label: e.name }))} />
              <FilterSelect label="Estado" value={search.estado} onChange={(v) => set({ estado: v as RunsSearch['estado'] })} options={Object.entries(RUN_STATUS_LABEL).map(([value, l]) => ({ value, label: l.label }))} />
              <FilterSelect label="Resultado" value={search.resultado} onChange={(v) => set({ resultado: v as RunsSearch['resultado'] })} options={Object.entries(RUN_OUTCOME_LABEL).map(([value, l]) => ({ value, label: l.label }))} />
              <FilterSelect label="Origen" value={search.origen} onChange={(v) => set({ origen: v as RunsSearch['origen'] })} options={Object.entries(TRIGGER_LABEL).map(([value, label]) => ({ value, label }))} />
              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                Desde
                <Input type="date" value={search.desde ?? ''} onChange={(e) => set({ desde: e.target.value || undefined })} className="h-8 w-[150px]" />
              </label>
              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                Hasta
                <Input type="date" value={search.hasta ?? ''} onChange={(e) => set({ hasta: e.target.value || undefined })} className="h-8 w-[150px]" />
              </label>
              {hasFilters ? (
                <Button size="sm" variant="ghost" onClick={() => set({ ambiente: undefined, estado: undefined, resultado: undefined, origen: undefined, desde: undefined, hasta: undefined })}>
                  <X /> Limpiar
                </Button>
              ) : null}
            </>
          }
          pagination={{
            pageIndex: pager.pageIndex,
            hasPrev: pager.hasPrev,
            hasNext: !!runs.data?.hasNext,
            onPrev: pager.prev,
            onNext: () => runs.data?.nextCursor && pager.next(runs.data.nextCursor),
            pageSize: search.limit as PageSize,
            onPageSizeChange: (n) => set({ limit: n }),
            total: runs.data?.total,
          }}
          empty={
            hasFilters
              ? { title: 'Ninguna ejecución coincide con los filtros' }
              : {
                  title: 'Aún no hay ejecuciones',
                  action: canRun ? (
                    <Button size="sm" onClick={() => void appNavigate({ to: '/ejecuciones/nueva' })}>
                      <Play /> Nueva ejecución
                    </Button>
                  ) : undefined,
                }
          }
        />
      </Card>
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} scope="runs" filters={{ ...q, cursor: undefined, limit: undefined }} cursor={search.cursor} limit={search.limit} title="Exportar ejecuciones" />
    </>
  );
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; options: { value: string; label: string }[] }) {
  return (
    <Select value={value ?? '__all'} onValueChange={(v) => onChange(v === '__all' ? undefined : v)}>
      <SelectTrigger className="h-8 w-auto min-w-[130px]" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">{label}: todos</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

