/**
 * 02 · Inicio: KPIs, alerta activa, ejecuciones recientes y próximas programaciones. Cada bloque carga/falla por
 * separado (no tumba la página). SSE actualiza "corriendo ahora" y las filas activas; sin polling con SSE sano.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { KpiCard, KpiGrid } from '@/components/common/kpi-card';
import { Callout } from '@/components/common/misc';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-table/data-table';
import { alertsApi, dashboardApi, runsApi } from '@/lib/api/endpoints';
import type { RunSummary } from '@/lib/api/types';
import { isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan, useSession } from '@/lib/auth/session';
import { formatDateTimeShort, formatLongDate, formatPercent, formatSeconds, formatTime, getDisplayTimezone, greeting } from '@/lib/format';
import { firstName } from '@/lib/utils';
import { usePollingFallback } from '@/lib/sse/polling';
import { RunCounts, RunIdLink, RunOrigin, RunState } from '@/features/runs/run-cells';

const columns: ColumnDef<RunSummary>[] = [
  { id: 'id', header: 'ID', cell: ({ row }) => <RunIdLink run={row.original} /> },
  { id: 'origen', header: 'Origen', cell: ({ row }) => <RunOrigin run={row.original} /> },
  { id: 'ambiente', header: 'Ambiente', cell: ({ row }) => row.original.environment.name },
  { id: 'resultado', header: 'Resultado', cell: ({ row }) => <RunCounts run={row.original} /> },
  { id: 'estado', header: 'Estado', cell: ({ row }) => <RunState run={row.original} /> },
];

export function HomePage() {
  const me = useSession();
  const navigate = useNavigate();
  const canRun = useCan('runs.create');
  const poll = usePollingFallback('list');
  const now = new Date();

  const summary = useQuery({ queryKey: qk.dashboard(), queryFn: ({ signal }) => dashboardApi.summary(signal), refetchInterval: poll });
  const recent = useQuery({
    queryKey: qk.runs.list({ limit: 5, sort: '-createdAt' }),
    queryFn: ({ signal }) => runsApi.list({ limit: 5, sort: '-createdAt' }, signal),
    refetchInterval: poll,
  });
  const alerts = useQuery({
    queryKey: qk.alerts.list({ status: 'activa', limit: 10 }),
    queryFn: ({ signal }) => alertsApi.list({ status: 'activa', limit: 10 }, signal),
  });

  const s = summary.data;
  const summaryMissing = summary.isError && isApiError(summary.error) && summary.error.status === 404;
  const perfAlerts = (alerts.data?.items ?? []).filter((a) => a.kind === 'umbral_rendimiento');
  const delta = s && s.successRate7d !== null && s.successRatePrev7d !== null ? Math.round((s.successRate7d - s.successRatePrev7d) * 100) : null;
  const firstAlert = perfAlerts[0];
  const p = firstAlert?.payload as { label?: string; value?: number; limit?: number; at?: string } | undefined;

  return (
    <>
      <PageHeader
        title={`${greeting(now)}, ${firstName(me?.user.name ?? '')}`}
        subtitle={`${formatLongDate(now)} · ${getDisplayTimezone()}`}
        actions={
          canRun ? (
            <Button onClick={() => void navigate({ to: '/ejecuciones/nueva' })}>
              <Play /> Nueva ejecución
            </Button>
          ) : null
        }
      />

      <KpiGrid>
        <KpiCard
          label="Éxito 7 días"
          loading={summary.isLoading}
          tone={s?.successRate7d !== null && s?.successRate7d !== undefined ? 'passed' : 'default'}
          value={s?.successRate7d !== null && s?.successRate7d !== undefined ? formatPercent(s.successRate7d) : '—'}
          hint={summary.isError ? (summaryMissing ? 'Resumen no disponible' : 'No se pudo cargar') : delta !== null ? `${delta >= 0 ? '+' : ''}${delta} pts vs semana anterior` : 'sin datos en 7 días'}
        />
        <KpiCard
          label="Ejecuciones hoy"
          loading={summary.isLoading}
          value={s ? s.runsToday : '—'}
          hint={s ? `${s.runningNow} corriendo ahora` : ' '}
          href="/ejecuciones"
        />
        <KpiCard
          label="Cobertura automatizada"
          loading={summary.isLoading}
          value={s ? `${s.coverage.automated}/${s.coverage.total}` : '—'}
          hint="casos de TestRail con test"
          href="/catalogo"
        />
        <KpiCard
          label="Alertas activas"
          loading={alerts.isLoading}
          tone={(alerts.data?.items.length ?? 0) > 0 ? 'failed' : 'default'}
          value={alerts.data ? alerts.data.items.length : '—'}
          hint={firstAlert ? `${p?.label ?? 'Umbral'} p95 > ${formatSeconds(p?.limit ?? null).replace(',0', '')}` : alerts.isError ? 'No se pudo cargar' : 'Sin alertas'}
          href="/rendimiento"
        />
      </KpiGrid>

      {firstAlert ? (
        <Callout tone="danger" className="mb-6 py-3.5 text-[15px]">
          <strong className="font-semibold">{p?.label ?? 'Rendimiento'}</strong> superó el umbral: p95 {formatSeconds(p?.value ?? null)} (umbral{' '}
          {formatSeconds(p?.limit ?? null).replace(',0', '')}) a las {formatTime(p?.at ?? firstAlert.createdAt)}.{' '}
          <Link to="/rendimiento" className="font-semibold underline">
            Ver rendimiento
          </Link>
          {perfAlerts.length > 1 ? <span className="ml-2 text-muted-foreground">· {perfAlerts.length} alertas activas</span> : null}
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CardSection
          title="Ejecuciones recientes"
          padded={false}
          action={
            <Link to="/ejecuciones" className="text-[13px] font-medium text-primary hover:underline">
              Ver todas
            </Link>
          }
        >
          <DataTable
            caption="Ejecuciones recientes"
            columns={columns}
            data={recent.data?.items}
            getRowId={(r) => r.id}
            isLoading={recent.isLoading}
            isFetching={recent.isFetching}
            error={recent.error}
            onRetry={() => void recent.refetch()}
            onRowClick={(r) => void navigate({ to: '/ejecuciones/$runId', params: { runId: r.id } })}
            skeletonRows={5}
            empty={{
              title: 'Aún no hay ejecuciones',
              description: 'Cuando ejecutes una suite o una selección de casos aparecerá aquí.',
              action: canRun ? (
                <Button size="sm" onClick={() => void navigate({ to: '/ejecuciones/nueva' })}>
                  <Play /> Nueva ejecución
                </Button>
              ) : undefined,
            }}
          />
        </CardSection>

        <CardSection
          title="Próximas programaciones"
          padded={false}
          action={
            <Link to="/programaciones" className="text-[13px] font-medium text-primary hover:underline">
              Gestionar
            </Link>
          }
        >
          {summary.isLoading ? (
            <div className="space-y-4 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : summary.isError ? (
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} compact />
          ) : (s?.upcoming.length ?? 0) === 0 ? (
            <EmptyState
              title="No hay programaciones activas"
              action={
                <Button size="sm" variant="outlineCard" onClick={() => void navigate({ to: '/programaciones/nueva' })}>
                  Nueva programación
                </Button>
              }
            />
          ) : (
            <ul>
              {s!.upcoming.map((u) => (
                <li key={`${u.scheduleId}-${u.at}`} className="border-b border-border last:border-0">
                  <Link
                    to="/programaciones/$scheduleId"
                    params={{ scheduleId: u.scheduleId }}
                    className="flex items-end justify-between gap-3 px-5 py-3.5 outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{u.name}</span>
                      <span className="font-mono text-[12.5px] text-muted-foreground">{u.environmentName}</span>
                    </span>
                    <span className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">{formatDateTimeShort(u.at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardSection>
      </div>
    </>
  );
}
