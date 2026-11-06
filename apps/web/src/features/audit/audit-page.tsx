/** 21 · Auditoría (RF-USR-02, rol admin): filtros, cursor y detalle del cambio (diff sanitizado) en panel lateral. */
import { useMemo, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { X } from 'lucide-react';
import { AUDIT_ACTIONS } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { PageHeader } from '@/components/common/page-header';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { auditApi } from '@/lib/api/endpoints';
import type { AuditEntry } from '@/lib/api/types';
import { qk } from '@/lib/query/keys';
import { useCursorHistory } from '@/lib/hooks';
import { addDaysIso, formatDateTimeFull, formatDateTimeShort, zonedMidnightIso } from '@/lib/format';
import { FilterSelect } from '@/features/runs/runs-page';

const route = getRouteApi('/_app/auditoria');

export const ACTION_LABEL: Record<string, string> = {
  'run.create': 'Inició ejecución',
  'run.cancel': 'Canceló ejecución',
  'test_case_link.review': 'Revisó vínculo de test',
  'perf_threshold.update': 'Cambió umbral',
  'perf_threshold.create': 'Creó umbral',
  'schedule.create': 'Creó programación',
  'schedule.update': 'Editó programación',
  'schedule.pause': 'Pausó programación',
  'schedule.resume': 'Reanudó programación',
  'schedule.delete': 'Borró programación',
  'schedule.duplicate': 'Duplicó programación',
  'suite.create': 'Creó suite',
  'suite.update': 'Editó suite',
  'suite.delete': 'Eliminó suite',
  'test_user.create': 'Agregó usuario de prueba',
  'test_user.update': 'Editó usuario de prueba',
  'environment.create': 'Creó ambiente',
  'environment.update': 'Editó ambiente',
  'panel_user.create': 'Invitó usuario',
  'panel_user.update': 'Editó usuario',
  'panel_user.disable': 'Deshabilitó usuario',
  'testrail.sync': 'Sincronizó TestRail',
  'testrail_connection.update': 'Cambió conexión TestRail',
  'outbox_delivery.retry': 'Reintentó entrega',
  'auth.login': 'Ingresó',
  'auth.login_failed': 'Ingreso fallido',
  'auth.logout': 'Salió',
  'api_token.create': 'Creó token de API',
  'api_token.revoke': 'Revocó token de API',
  'recording.complete': 'Envió grabación',
  'device.approve': 'Vinculó asistente',
  'notification_channel.update': 'Cambió canal de notificación',
};

export function AuditPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const q = {
    action: search.accion,
    entity: search.entidad,
    from: search.desde ? zonedMidnightIso(search.desde) : undefined,
    to: search.hasta ? zonedMidnightIso(addDaysIso(search.hasta, 1)) : undefined,
    cursor: search.cursor,
    limit: search.limit,
  };
  const list = useQuery({ queryKey: qk.audit.list(q), queryFn: ({ signal }) => auditApi.list(q, signal), placeholderData: keepPreviousData });
  const pager = useCursorHistory(JSON.stringify({ ...search, cursor: undefined }), search.cursor, (cursor) => void navigate({ search: (p) => ({ ...p, cursor }) }));
  const set = (patch: Record<string, unknown>) => void navigate({ search: (p) => ({ ...p, ...patch, cursor: undefined }), replace: true });
  const columns = useMemo<ColumnDef<AuditEntry>[]>(
    () => [
      { id: 'fecha', header: 'Fecha', cell: ({ row }) => <span className="font-mono text-[13px]">{formatDateTimeShort(row.original.createdAt)}</span> },
      { id: 'actor', header: 'Actor', cell: ({ row }) => row.original.actorDisplay },
      { id: 'accion', header: 'Acción', cell: ({ row }) => ACTION_LABEL[row.original.action] ?? row.original.action },
      { id: 'objeto', header: 'Objeto', cell: ({ row }) => <span className="text-muted-foreground">{row.original.entityId ?? row.original.entity}</span> },
    ],
    [],
  );
  const hasFilters = !!(search.accion || search.entidad || search.desde || search.hasta);
  return (
    <>
      <PageHeader title="Auditoría" subtitle="Registro de acciones en el panel" />
      <Card>
        <DataTable
          caption="Registro de auditoría"
          columns={columns}
          data={list.data?.items}
          getRowId={(a) => a.id}
          isLoading={list.isLoading}
          isFetching={list.isFetching && !list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={setOpen}
          toolbar={
            <>
              <FilterSelect label="Acción" value={search.accion} onChange={(v) => set({ accion: v })} options={AUDIT_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a] ?? a }))} />
              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                Desde <Input type="date" value={search.desde ?? ''} onChange={(e) => set({ desde: e.target.value || undefined })} className="h-8 w-[150px]" />
              </label>
              <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                Hasta <Input type="date" value={search.hasta ?? ''} onChange={(e) => set({ hasta: e.target.value || undefined })} className="h-8 w-[150px]" />
              </label>
              {hasFilters ? (
                <Button size="sm" variant="ghost" onClick={() => set({ accion: undefined, entidad: undefined, desde: undefined, hasta: undefined })}>
                  <X /> Limpiar
                </Button>
              ) : null}
            </>
          }
          pagination={{
            pageIndex: pager.pageIndex,
            hasPrev: pager.hasPrev,
            hasNext: !!list.data?.hasNext,
            onPrev: pager.prev,
            onNext: () => list.data?.nextCursor && pager.next(list.data.nextCursor),
            pageSize: search.limit as PageSize,
            onPageSizeChange: (n) => set({ limit: n }),
            total: list.data?.total,
          }}
          empty={{ title: hasFilters ? 'Ningún registro coincide con los filtros' : 'Aún no hay registros de auditoría' }}
        />
      </Card>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <SheetContent>
            <DialogTitle>{ACTION_LABEL[open.action] ?? open.action}</DialogTitle>
            <DialogDescription>
              {open.actorDisplay} · {formatDateTimeFull(open.createdAt)}
            </DialogDescription>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
              <dt className="text-muted-foreground">Acción</dt>
              <dd className="font-mono">{open.action}</dd>
              <dt className="text-muted-foreground">Entidad</dt>
              <dd>{open.entity}</dd>
              <dt className="text-muted-foreground">Objeto</dt>
              <dd>{open.entityId ?? '–'}</dd>
              <dt className="text-muted-foreground">Solicitud</dt>
              <dd className="font-mono">{open.requestId ?? '–'}</dd>
            </dl>
            <div>
              <div className="label-mono mb-2">Cambio (sanitizado)</div>
              <pre className="overflow-auto rounded-md bg-code-bg p-4 font-mono text-[12.5px] text-code-fg">{open.diff ? JSON.stringify(open.diff, null, 2) : 'Sin detalle'}</pre>
            </div>
          </SheetContent>
        ) : null}
      </Dialog>
    </>
  );
}
