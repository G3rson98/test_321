/**
 * Detalle de programación (sin captura; RF-PRG-02/03/04): próximas ejecuciones (API), ocurrencias recientes con
 * omitidas y motivo, historial de revisiones con autor.
 */
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatusBadge } from '@/components/common/status-badge';
import { KeyValue } from '@/components/common/misc';
import { ErrorState, EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-table/data-table';
import { NotFoundPage } from '@/components/layout/error-pages';
import { itemsOf, schedulesApi } from '@/lib/api/endpoints';
import type { ScheduleOccurrence, ScheduleRevision } from '@/lib/api/types';
import { isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { formatDateTimeShort, formatWeekdayDateTime } from '@/lib/format';
import { OCCURRENCE_REASON_LABEL } from '@/lib/labels';
import { shortId } from '@/lib/utils';
import { ScheduleRowActions, ScheduleToggle, useScheduleLookups } from './schedules-page';

const route = getRouteApi('/_app/programaciones/$scheduleId');

const ACTION_LABEL: Record<ScheduleRevision['action'], string> = {
  create: 'Creó',
  update: 'Editó',
  pause: 'Pausó',
  resume: 'Reanudó',
  delete: 'Borró',
  duplicate: 'Duplicó',
};

export function ScheduleDetailPage() {
  const { scheduleId } = route.useParams();
  const navigate = useNavigate();
  const canWrite = useCan('schedules.write');
  const lookups = useScheduleLookups();
  const s = useQuery({ queryKey: qk.schedules.detail(scheduleId), queryFn: ({ signal }) => schedulesApi.get(scheduleId, signal) });
  const next = useQuery({ queryKey: qk.schedules.next(scheduleId), queryFn: ({ signal }) => schedulesApi.next(scheduleId, 5, signal), enabled: !!s.data?.enabled });
  const revisions = useQuery({ queryKey: qk.schedules.revisions(scheduleId), queryFn: ({ signal }) => schedulesApi.revisions(scheduleId, signal) });
  const occ = useQuery({ queryKey: qk.schedules.occurrences(scheduleId, { limit: 25 }), queryFn: ({ signal }) => schedulesApi.occurrences(scheduleId, { limit: 25 }, signal) });

  if (s.isError && isApiError(s.error) && s.error.status === 404) return <NotFoundPage />;
  if (s.isError) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  if (s.isLoading || !s.data) return <Skeleton className="h-96" />;
  const sch = s.data;

  const occColumns: ColumnDef<ScheduleOccurrence>[] = [
    { id: 'instante', header: 'Previsto', cell: ({ row }) => <span className="font-mono text-[13px]">{formatDateTimeShort(row.original.scheduledFor)}</span> },
    {
      id: 'estado',
      header: 'Estado',
      cell: ({ row }) => <StatusBadge status={row.original.status === 'admitida' ? { label: 'Admitida', tone: 'passed' } : { label: 'Omitida', tone: 'skipped' }} />,
    },
    { id: 'motivo', header: 'Motivo', cell: ({ row }) => (row.original.reason ? OCCURRENCE_REASON_LABEL[row.original.reason] : '–') },
    {
      id: 'corrida',
      header: 'Ejecución',
      cell: ({ row }) =>
        row.original.runId ? (
          <Link to="/ejecuciones/$runId" params={{ runId: row.original.runId }} className="font-mono text-primary hover:underline">
            {shortId('run', row.original.runId)}
          </Link>
        ) : (
          '–'
        ),
    },
    { id: 'retraso', header: 'Retraso de admisión', cell: ({ row }) => (row.original.admissionDelayMs !== null ? `${(row.original.admissionDelayMs / 1000).toFixed(1).replace('.', ',')} s` : '–') },
  ];

  return (
    <>
      <PageHeader
        title={sch.name}
        subtitle={`${shortId('schedule', sch.id)} · ${lookups.targetLabel(sch)} · ${lookups.envName(sch.environmentId)} · revisión ${sch.revision}`}
        meta={
          <>
            <ScheduleToggle s={sch} />
            <span className="text-[14px]">{sch.enabled ? 'Activa' : `Pausada${sch.pausedAt ? ` el ${formatDateTimeShort(sch.pausedAt)}` : ''}`}</span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => void navigate({ to: '/programaciones' })}>
              <ArrowLeft /> Programaciones
            </Button>
            {canWrite ? (
              <Button variant="outline" onClick={() => void navigate({ to: '/programaciones/$scheduleId/editar', params: { scheduleId } })}>
                <Pencil /> Editar
              </Button>
            ) : null}
            <ScheduleRowActions s={sch} onDeleted={() => void navigate({ to: '/programaciones' })} />
          </>
        }
      />
      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <CardSection title="Horario">
          <KeyValue
            items={[
              { k: 'Descripción', v: sch.description ?? '—' },
              { k: 'Expresiones', v: sch.cronExpressions.join(' + '), mono: true },
              { k: 'Zona', v: sch.timezone, mono: true },
              { k: 'Reintentos', v: sch.retries },
              { k: 'Avisos', v: [sch.notify.onFailure ? 'fallas' : '', sch.notify.onInterruption ? 'interrupción' : ''].filter(Boolean).join(', ') || 'ninguno' },
            ]}
          />
        </CardSection>
        <CardSection title="Próximas 5 ejecuciones">
          {!sch.enabled ? (
            <p className="text-[14px] text-muted-foreground">Pausada: al reanudar no se recuperan ocurrencias pasadas.</p>
          ) : next.isLoading ? (
            <Skeleton className="h-28" />
          ) : next.isError ? (
            <ErrorState error={next.error} compact onRetry={() => void next.refetch()} />
          ) : (
            <ul className="space-y-1.5">
              {next.data?.occurrences.map((o) => (
                <li key={o.at} className="flex items-center gap-2.5">
                  <span className="size-1.5 rounded-full bg-primary-soft ring-2 ring-primary-soft" aria-hidden />
                  {formatWeekdayDateTime(o.at, sch.timezone)}
                </li>
              ))}
            </ul>
          )}
        </CardSection>
      </div>
      <CardSection title="Ocurrencias recientes" padded={false} className="mb-6">
        <DataTable caption="Ocurrencias" columns={occColumns} data={occ.data?.items} getRowId={(o) => o.id} isLoading={occ.isLoading} error={occ.error} onRetry={() => void occ.refetch()} empty={{ title: 'Aún no hubo ocurrencias' }} />
      </CardSection>
      <CardSection title="Historial de cambios" padded={false}>
        {revisions.isLoading ? (
          <Skeleton className="m-5 h-24" />
        ) : revisions.isError ? (
          <ErrorState error={revisions.error} compact onRetry={() => void revisions.refetch()} />
        ) : itemsOf(revisions.data).length === 0 ? (
          <EmptyState title="Sin cambios registrados" />
        ) : (
          <ol>
            {itemsOf(revisions.data).map((rv) => (
              <li key={rv.revision} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3 last:border-0">
                <span>
                  <span className="font-mono text-[12.5px] text-muted-foreground">rev {rv.revision}</span> · <strong className="font-medium">{rv.changedBy.displayName}</strong> {ACTION_LABEL[rv.action].toLowerCase()}
                  {Object.keys(rv.diff).length ? <span className="text-muted-foreground"> · {Object.keys(rv.diff).join(', ')}</span> : null}
                </span>
                <span className="font-mono text-[12.5px] text-muted-foreground">{formatDateTimeShort(rv.changedAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardSection>
    </>
  );
}
