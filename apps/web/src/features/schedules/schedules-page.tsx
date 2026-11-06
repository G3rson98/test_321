/**
 * 16 · Programaciones (RF-PRG-01/03/04): activa/pausada (confirmación del servidor, sin optimismo), objetivo,
 * ambiente, horario legible + cron + zona, próxima ocurrencia; pausar/reanudar/duplicar/borrar.
 */
import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { CirclePlay, Copy, Pause, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/popover';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { envApi, itemsOf, schedulesApi, suitesApi } from '@/lib/api/endpoints';
import type { Schedule } from '@/lib/api/types';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { useCursorHistory } from '@/lib/hooks';
import { formatDateTimeShort } from '@/lib/format';
import { shortId } from '@/lib/utils';
import { usePollingFallback } from '@/lib/sse/polling';
import { FilterSelect } from '@/features/runs/runs-page';

const route = getRouteApi('/_app/programaciones');

export function useScheduleLookups() {
  const suites = useQuery({ queryKey: qk.suites.list({ limit: 100 }), queryFn: ({ signal }) => suitesApi.list({ limit: 100 }, signal) });
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  return {
    envs: itemsOf(envs.data),
    targetLabel: (s: Schedule) => {
      const sel = s.selector;
      if (sel.kind === 'suite') return suites.data?.items.find((x) => x.id === sel.suiteId)?.name ?? 'Suite';
      if (sel.kind === 'tags') return sel.tags.join(' ');
      return `${sel.caseIds.length} casos`;
    },
    envName: (id: string) => itemsOf(envs.data).find((e) => e.id === id)?.name ?? '—',
  };
}

export function ScheduleRowActions({ s, onDeleted }: { s: Schedule; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useCan('schedules.write');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const toggle = useMutation({
    mutationFn: () => (s.enabled ? schedulesApi.pause(s.id) : schedulesApi.resume(s.id)),
    onSuccess: (x) => {
      toast.success(x.enabled ? 'Programación reanudada (sin recuperar ocurrencias pasadas).' : 'Programación pausada.');
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const dup = useMutation({
    mutationFn: () => schedulesApi.duplicate(s.id),
    onSuccess: (x) => {
      toast.success('Copia creada en pausa. Revísala antes de activarla.');
      done();
      void navigate({ to: '/programaciones/$scheduleId/editar', params: { scheduleId: x.id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () => schedulesApi.remove(s.id),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success('Programación borrada.');
      done();
      onDeleted?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!canWrite) return null;
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Tip label={s.enabled ? 'Pausar' : 'Reanudar'}>
        <Button variant="ghost" size="icon" aria-label={s.enabled ? `Pausar ${s.name}` : `Reanudar ${s.name}`} disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {s.enabled ? <Pause /> : <CirclePlay />}
        </Button>
      </Tip>
      <Tip label="Duplicar">
        <Button variant="ghost" size="icon" aria-label={`Duplicar ${s.name}`} disabled={dup.isPending} onClick={() => dup.mutate()}>
          <Copy />
        </Button>
      </Tip>
      <Tip label="Borrar">
        <Button variant="ghost" size="icon" aria-label={`Borrar ${s.name}`} onClick={() => setConfirmDelete(true)}>
          <Trash2 />
        </Button>
      </Tip>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Borrar “${s.name}”`}
        description="Se cancelan las ejecuciones aún no iniciadas de esta programación; las que están en curso no se detienen. El historial se conserva."
        confirmLabel="Borrar"
        tone="danger"
        pending={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

export function ScheduleToggle({ s }: { s: Schedule }) {
  const qc = useQueryClient();
  const canWrite = useCan('schedules.write');
  const toggle = useMutation({
    mutationFn: () => (s.enabled ? schedulesApi.pause(s.id) : schedulesApi.resume(s.id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Switch
      checked={s.enabled}
      disabled={!canWrite || toggle.isPending}
      aria-label={s.enabled ? `Pausar ${s.name}` : `Reanudar ${s.name}`}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={() => toggle.mutate()}
    />
  );
}

export function SchedulesPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const appNavigate = useNavigate();
  const canWrite = useCan('schedules.write');
  const poll = usePollingFallback('list');
  const lookups = useScheduleLookups();
  const q = { environmentId: search.ambiente, enabled: search.activa === 'si' ? 'true' : search.activa === 'no' ? 'false' : undefined, q: search.q, cursor: search.cursor, limit: search.limit };
  const pager = useCursorHistory(JSON.stringify({ ...search, cursor: undefined }), search.cursor, (cursor) => void navigate({ search: (p) => ({ ...p, cursor }) }));
  const list = useQuery({ queryKey: qk.schedules.list(q), queryFn: ({ signal }) => schedulesApi.list(q, signal), placeholderData: keepPreviousData, refetchInterval: poll });

  const columns = useMemo<ColumnDef<Schedule>[]>(
    () => [
      { id: 'activa', header: 'Activa', cell: ({ row }) => <ScheduleToggle s={row.original} /> },
      {
        id: 'nombre',
        header: 'Nombre',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="font-mono text-[12.5px] text-muted-foreground">{shortId('schedule', row.original.id)}</div>
          </div>
        ),
      },
      { id: 'objetivo', header: 'Objetivo', cell: ({ row }) => lookups.targetLabel(row.original) },
      { id: 'ambiente', header: 'Ambiente', cell: ({ row }) => lookups.envName(row.original.environmentId) },
      {
        id: 'horario',
        header: 'Horario',
        cell: ({ row }) => (
          <div>
            <div>{row.original.description ?? 'Expresiones avanzadas'}</div>
            <div className="font-mono text-[12px] text-muted-foreground">
              {row.original.cronExpressions.join(' + ')} · {row.original.timezone}
            </div>
          </div>
        ),
      },
      {
        id: 'proxima',
        header: 'Próxima',
        cell: ({ row }) => (
          <span className="font-mono text-[12.5px]">
            {row.original.enabled ? formatDateTimeShort(row.original.nextOccurrence) : <span title={row.original.pausedAt ? `Pausada el ${formatDateTimeShort(row.original.pausedAt)}` : undefined}>–</span>}
          </span>
        ),
      },
      { id: 'acciones', header: () => <span className="sr-only">Acciones</span>, cell: ({ row }) => <ScheduleRowActions s={row.original} /> },
    ],
    [lookups],
  );

  return (
    <>
      <PageHeader
        title="Programaciones"
        subtitle="Máximo una ejecución activa por programación; las ocurrencias solapadas se omiten"
        actions={
          canWrite ? (
            <Button onClick={() => void appNavigate({ to: '/programaciones/nueva' })}>
              <Plus /> Nueva programación
            </Button>
          ) : null
        }
      />
      <Card>
        <DataTable
          caption="Programaciones"
          columns={columns}
          data={list.data?.items}
          getRowId={(s) => s.id}
          isLoading={list.isLoading}
          isFetching={list.isFetching && !list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(s) => void appNavigate({ to: '/programaciones/$scheduleId', params: { scheduleId: s.id } })}
          toolbar={
            <>
              <FilterSelect label="Ambiente" value={search.ambiente} onChange={(v) => void navigate({ search: (p) => ({ ...p, ambiente: v, cursor: undefined }), replace: true })} options={lookups.envs.map((e) => ({ value: e.id, label: e.name }))} />
              <FilterSelect label="Estado" value={search.activa} onChange={(v) => void navigate({ search: (p) => ({ ...p, activa: v as 'si' | 'no' | undefined, cursor: undefined }), replace: true })} options={[{ value: 'si', label: 'Activas' }, { value: 'no', label: 'Pausadas' }]} />
            </>
          }
          pagination={{
            pageIndex: pager.pageIndex,
            hasPrev: pager.hasPrev,
            hasNext: !!list.data?.hasNext,
            onPrev: pager.prev,
            onNext: () => list.data?.nextCursor && pager.next(list.data.nextCursor),
            pageSize: search.limit as PageSize,
            onPageSizeChange: (n) => void navigate({ search: (p) => ({ ...p, limit: n, cursor: undefined }), replace: true }),
            total: list.data?.total,
          }}
          empty={{
            title: 'No hay programaciones',
            description: 'Programa una suite o una selección para que se ejecute sola por día y hora.',
            action: canWrite ? <Button size="sm" onClick={() => void appNavigate({ to: '/programaciones/nueva' })}><Plus /> Nueva programación</Button> : undefined,
          }}
        />
      </Card>
    </>
  );
}
