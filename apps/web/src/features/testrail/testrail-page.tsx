/**
 * 20 · TestRail (RF-TR-02/07/08, ESP §13.4): estado de sincronización, casos cambiados, cola de entregas con
 * estados ESP (429 con Retry-After = pendiente/reintentando, no error terminal) y reintento administrativo
 * (reconcilia antes de reenviar, auditado).
 */
import { useMemo, useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { KpiCard, KpiGrid } from '@/components/common/kpi-card';
import { StatusBadge } from '@/components/common/status-badge';
import { Callout } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { catalogApi, testrailApi } from '@/lib/api/endpoints';
import type { Delivery } from '@/lib/api/types';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { useCursorHistory } from '@/lib/hooks';
import { formatTime } from '@/lib/format';
import { OUTBOX_OPERATION_LABEL, OUTBOX_STATUS_LABEL, SYNC_RUN_LABEL } from '@/lib/labels';
import { shortId } from '@/lib/utils';
import { usePollingFallback } from '@/lib/sse/polling';
import { FilterSelect } from '@/features/runs/runs-page';

const route = getRouteApi('/_app/testrail');

export function deliveryDetail(d: Delivery): string {
  if (d.status === 'entregada') return 'OK';
  if (d.lastHttpStatus === 429 && d.nextAttemptAt) return `HTTP 429 · reintentando a las ${formatTime(d.nextAttemptAt)}`;
  if (d.lastError) return d.lastError;
  if (d.status === 'pendiente' && d.attempts === 0) return 'Esperando fin de ejecución';
  if (d.nextAttemptAt) return `Próximo intento ${formatTime(d.nextAttemptAt)}`;
  return '–';
}

/** La API pagina por cursor sin `total`: se cuenta una página de 100 ("100+" si hay más). */
const countLabel = (p: { items: unknown[]; hasNext: boolean }) => (p.hasNext ? `${p.items.length}+` : p.items.length);

export function TestRailPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const qc = useQueryClient();
  const canSync = useCan('testrail.sync');
  const canRetry = useCan('integrations.deliveries.retry');
  const [retrying, setRetrying] = useState<Delivery | null>(null);
  const poll = usePollingFallback('list');

  const syncRuns = useQuery({ queryKey: qk.testrail.syncRuns({ limit: 1 }), queryFn: ({ signal }) => testrailApi.syncRuns({ limit: 1 }, signal), refetchInterval: poll });
  const pending = useQuery({ queryKey: qk.testrail.deliveries({ status: ['pendiente', 'en_proceso'], limit: 100 }), queryFn: ({ signal }) => testrailApi.deliveries({ status: ['pendiente', 'en_proceso'], limit: 100 }, signal) });
  const failed = useQuery({ queryKey: qk.testrail.deliveries({ status: ['requiere_intervencion', 'vencida'], limit: 100 }), queryFn: ({ signal }) => testrailApi.deliveries({ status: ['requiere_intervencion', 'vencida'], limit: 100 }, signal) });
  const q = { status: search.estado, cursor: search.cursor, limit: search.limit };
  const list = useQuery({ queryKey: qk.testrail.deliveries(q), queryFn: ({ signal }) => testrailApi.deliveries(q, signal), placeholderData: keepPreviousData, refetchInterval: poll });
  const pager = useCursorHistory(JSON.stringify({ ...search, cursor: undefined }), search.cursor, (cursor) => void navigate({ search: (p) => ({ ...p, cursor }) }));

  const last = syncRuns.data?.items[0];
  const sync = useMutation({
    mutationFn: catalogApi.sync,
    onSuccess: () => {
      toast.success('Sincronización iniciada.');
      void qc.invalidateQueries({ queryKey: ['testrail'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: (d: Delivery) => testrailApi.retryDelivery(d.id),
    onSuccess: (r) => {
      setRetrying(null);
      toast.success(r.reconciliation === 'ya_aplicada' ? 'La entrega ya estaba aplicada en TestRail; se marcó como entregada.' : 'Reintento encolado tras reconciliar con TestRail.');
      void qc.invalidateQueries({ queryKey: ['testrail'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns = useMemo<ColumnDef<Delivery>[]>(
    () => [
      { id: 'id', header: 'ID', cell: ({ row }) => <span className="font-mono text-[14px] font-medium text-primary">{shortId('delivery', row.original.id)}</span> },
      { id: 'tipo', header: 'Tipo', cell: ({ row }) => OUTBOX_OPERATION_LABEL[row.original.operation] },
      {
        id: 'ejecucion',
        header: 'Ejecución',
        cell: ({ row }) =>
          row.original.runId ? (
            <Link to="/ejecuciones/$runId" params={{ runId: row.original.runId }} className="font-mono text-[14px] hover:underline" onClick={(e) => e.stopPropagation()}>
              {shortId('run', row.original.runId)}
            </Link>
          ) : (
            '–'
          ),
      },
      { id: 'destino', header: 'Destino', cell: ({ row }) => (row.original.operation.startsWith('notification') ? 'Canal de notificación' : row.original.externalId ? `TestRail run #${row.original.externalId}` : 'TestRail') },
      { id: 'intentos', header: 'Intentos', cell: ({ row }) => row.original.attempts },
      { id: 'detalle', header: 'Detalle', cell: ({ row }) => <span className="text-[14px]">{deliveryDetail(row.original)}</span> },
      { id: 'estado', header: 'Estado', cell: ({ row }) => <StatusBadge status={OUTBOX_STATUS_LABEL[row.original.status]} /> },
      {
        id: 'accion',
        header: () => <span className="sr-only">Acción</span>,
        cell: ({ row }) =>
          canRetry && ['requiere_intervencion', 'vencida', 'pendiente'].includes(row.original.status) && row.original.attempts > 0 ? (
            <Button size="sm" variant="outlineCard" onClick={() => setRetrying(row.original)}>
              <RotateCcw /> Reintentar
            </Button>
          ) : null,
      },
    ],
    [canRetry],
  );

  return (
    <>
      <PageHeader
        title="TestRail"
        subtitle="Sincronización de casos y publicación de resultados"
        actions={
          canSync ? (
            <Button onClick={() => sync.mutate()} disabled={sync.isPending || last?.status === 'en_curso'}>
              {sync.isPending || last?.status === 'en_curso' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sincronizar ahora
            </Button>
          ) : null
        }
      />
      {last?.status === 'fallida' ? (
        <Callout tone="danger" className="mb-6" title="La última sincronización falló">
          {last.error ?? 'TestRail no respondió.'} {canSync ? '' : 'Avisa a un administrador.'}
        </Callout>
      ) : null}
      <KpiGrid>
        <KpiCard
          label="Última sincronización"
          loading={syncRuns.isLoading}
          tone={last?.status === 'fallida' ? 'failed' : last?.status === 'en_curso' ? 'running' : 'passed'}
          value={last ? (last.status === 'en_curso' ? 'En curso' : formatTime(last.finishedAt ?? last.startedAt)) : '—'}
          hint={last ? `${SYNC_RUN_LABEL[last.status].label} · ${last.stats.casesSeen} casos` : 'Nunca se sincronizó'}
        />
        <KpiCard
          label="Casos cambiados"
          loading={syncRuns.isLoading}
          tone={last && last.stats.casesNewRevision > 0 ? 'flaky' : 'default'}
          value={last ? last.stats.casesNewRevision : '—'}
          hint={last ? `${last.stats.linksRequiringReview} ${last.stats.linksRequiringReview === 1 ? 'requiere' : 'requieren'} revisión` : ' '}
          href="/catalogo"
        />
        <KpiCard label="Entregas pendientes" loading={pending.isLoading} value={pending.data ? countLabel(pending.data) : '—'} />
        <KpiCard label="Entregas con error" loading={failed.isLoading} tone={(failed.data?.items.length ?? 0) > 0 ? 'failed' : 'default'} value={failed.data ? countLabel(failed.data) : '—'} />
      </KpiGrid>
      <Card>
        <div className="flex min-h-[46px] items-center border-b border-border px-5 text-[15px] font-semibold tracking-tight">Cola de entregas</div>
        <DataTable
          caption="Cola de entregas"
          columns={columns}
          data={list.data?.items}
          getRowId={(d) => d.id}
          isLoading={list.isLoading}
          isFetching={list.isFetching && !list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          toolbar={<FilterSelect label="Estado" value={search.estado} onChange={(v) => void navigate({ search: (p) => ({ ...p, estado: v as never, cursor: undefined }), replace: true })} options={Object.entries(OUTBOX_STATUS_LABEL).map(([value, l]) => ({ value, label: l.label }))} />}
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
          empty={{ title: 'No hay entregas', description: 'Las publicaciones a TestRail y notificaciones aparecerán aquí.' }}
        />
      </Card>
      <ConfirmDialog
        open={!!retrying}
        onOpenChange={(o) => !o && setRetrying(null)}
        title="Reintentar entrega"
        description="Antes de reenviar se consulta TestRail para no duplicar resultados. La acción queda en auditoría."
        confirmLabel="Reintentar"
        pending={retry.isPending}
        onConfirm={() => retrying && retry.mutate(retrying)}
      />
    </>
  );
}
