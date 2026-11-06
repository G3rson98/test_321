/**
 * 14/15 · Detalle de ejecución (RF-EJE-02/03, RF-RES-01/02/05, RF-TR-04/05/08, ESP §13.2–§13.4).
 * Contadores derivados de registros persistidos (servidor), nunca de mensajes SSE. Resultados por test e intento,
 * agregado por caso con cobertura, estado TestRail separado, evidencia con enlace autorizado (≤ 5 min, origen
 * separado), cancelación con confirmación sin éxito optimista, "Repetir fallidos" como NUEVA corrida.
 */
import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, ChevronRight, CircleX, Download, ExternalLink, FileText, Film, Image, Loader2, RotateCcw, ServerCrash } from 'lucide-react';
import { TERMINAL_RUN_STATUSES } from '@katalyst/shared/enums';
import { Button } from '@/components/ui/button';
import { Card, CardSection } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { KpiCard, KpiGrid } from '@/components/common/kpi-card';
import { StatusBadge } from '@/components/common/status-badge';
import { SegmentedControl } from '@/components/common/controls';
import { Callout, KeyValue, MonoId } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ExportDialog } from '@/components/common/export-dialog';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-table/data-table';
import { NotFoundPage } from '@/components/layout/error-pages';
import { itemsOf, runsApi } from '@/lib/api/endpoints';
import type { Artifact, CaseResult, RunDetail, RunResult } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { STALE } from '@/lib/query/client';
import { useCan } from '@/lib/auth/session';
import { formatDateTimeShort, formatDuration, formatSeconds } from '@/lib/format';
import {
  ARTIFACT_KIND_LABEL,
  CASE_RESULT_LABEL,
  COVERAGE_LABEL,
  ERROR_CATEGORY_LABEL,
  reasonLabel,
  RESULT_STATUS_LABEL,
  runStateLabel,
  SANITIZATION_LABEL,
  SYNC_STATUS_LABEL,
} from '@/lib/labels';
import { fallbackInterval, usePollingFallback } from '@/lib/sse/polling';
import { sseStore } from '@/lib/sse/manager';
import { useSelector } from '@tanstack/react-store';
import { cn, plural, shortId } from '@/lib/utils';
import { runTitle } from './run-cells';

const route = getRouteApi('/_app/ejecuciones/$runId');
const isTerminal = (s: string) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);

export function RunDetailPage() {
  const { runId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const appNavigate = useNavigate();
  const qc = useQueryClient();
  const canCancel = useCan('runs.cancel');
  const canRun = useCan('runs.create');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [stopUnconfirmed, setStopUnconfirmed] = useState(false);

  const sse = useSelector(sseStore, (x) => x);
  const run = useQuery({
    queryKey: qk.runs.detail(runId),
    queryFn: ({ signal }) => runsApi.get(runId, signal),
    staleTime: (q) => (q.state.data && isTerminal(q.state.data.status) ? STALE.terminal : STALE.operational),
    // Fallback de polling (5 s con backoff) solo si SSE cae; nunca en terminal.
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : fallbackInterval(sse, 'detail')),
  });
  const active = !!run.data && !isTerminal(run.data.status);

  const cancel = useMutation({
    mutationFn: () => runsApi.cancel(runId),
    onSuccess: (r) => {
      setConfirmCancel(false);
      setStopUnconfirmed(!r.stopConfirmed);
      qc.setQueryData(qk.runs.detail(runId), (prev: RunDetail | undefined) => (prev ? { ...prev, ...r.run } : prev));
      toast.success('Cancelación solicitada. Esperando confirmación del servidor.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (run.isError && isApiError(run.error) && run.error.status === 404) return <NotFoundPage />;
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  if (run.isLoading || !run.data) return <DetailSkeleton />;

  const r = run.data;
  const c = r.counts;
  const by = r.createdBy.kind === 'sistema' ? 'Programada por Programador' : `${r.trigger === 'api' ? 'API' : 'Manual'} por ${r.createdBy.displayName}`;
  const failedCount = c.fallido + c.error_infraestructura;

  return (
    <>
      <PageHeader
        className="mb-4"
        title={`Ejecución ${shortId('run', r.id)}`}
        subtitle={`${runTitle(r)} · ${r.environment.name} · ${by} · ${formatDateTimeShort(r.scheduledFor ?? r.createdAt)}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => void appNavigate({ to: '/ejecuciones' })}>
              <ArrowLeft /> Ejecuciones
            </Button>
            {isTerminal(r.status) ? (
              <Button variant="outline" onClick={() => setExportOpen(true)}>
                <Download /> Exportar
              </Button>
            ) : null}
            {active && canCancel ? (
              <Button variant="destructive" onClick={() => setConfirmCancel(true)} disabled={r.status === 'cancelando' || cancel.isPending}>
                {r.status === 'cancelando' ? <Loader2 className="animate-spin" /> : <CircleX />} {r.status === 'cancelando' ? 'Cancelando…' : 'Cancelar'}
              </Button>
            ) : null}
            {!active && canRun ? (
              <Button
                variant="outline"
                disabled={failedCount === 0}
                title={failedCount === 0 ? 'No hay tests fallidos para repetir' : 'Crea una nueva ejecución con los casos fallidos'}
                onClick={() => void appNavigate({ to: '/ejecuciones/nueva', search: { modo: 'casos', repetir: r.id } })}
              >
                <RotateCcw /> Repetir fallidos
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={runStateLabel(r.status, r.outcome)} />
        <span className="font-mono text-[12.5px] text-muted-foreground">
          commit {r.gitCommit.slice(0, 7)} · Chromium · reintentos {r.snapshot.retries}
          {r.durationMs !== null ? ` · ${formatDuration(r.durationMs)} de pared` : ''}
        </span>
        {r.reason ? <span className="text-[13px] text-muted-foreground">· {reasonLabel(r.reason)}</span> : null}
      </div>

      {r.status === 'cancelando' || stopUnconfirmed ? (
        <Callout tone="warning" className="mb-6">
          {r.status === 'cancelando'
            ? 'Cancelación en curso: los tests no iniciados quedarán cancelados; los resultados ya guardados se conservan.'
            : 'Aún no se pudo confirmar la detención del ejecutor. Se aisló su credencial y se registrará el resultado.'}
        </Callout>
      ) : null}
      {r.status === 'interrumpida' ? (
        <Callout tone="danger" icon={<ServerCrash className="size-4" />} className="mb-6" title="Ejecución interrumpida por un problema de infraestructura">
          No es una falla de la aplicación. {reasonLabel(r.reason)}
        </Callout>
      ) : null}

      <KpiGrid columns={5}>
        <KpiCard compact label="En cola" value={c.pendiente} />
        <KpiCard compact label="Corriendo" value={c.corriendo} />
        <KpiCard compact label="Pasados" value={c.pasado + c.inestable} tone="passed" hint={c.inestable ? `${c.inestable} ${plural(c.inestable, 'inestable', 'inestables')}` : undefined} />
        <KpiCard compact label="Fallidos" value={failedCount} tone="failed" hint={c.error_infraestructura ? `${c.error_infraestructura} de infraestructura` : undefined} />
        <KpiCard
          compact
          label="Omitidos"
          value={c.omitido + c.cancelado + c.bloqueado}
          hint={[c.bloqueado ? `${c.bloqueado} bloqueados` : '', c.cancelado ? `${c.cancelado} cancelados` : ''].filter(Boolean).join(' · ') || undefined}
        />
      </KpiGrid>

      {r.problems.application + r.problems.runner + r.problems.publication > 0 ? (
        <p className="-mt-2 mb-6 text-[13px] text-muted-foreground">
          Fallas de la aplicación: {r.problems.application} · Problemas del ejecutor: {r.problems.runner} · Problemas de publicación: {r.problems.publication}
          {r.evidenceIncomplete ? ' · Evidencia incompleta' : ''}
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <div className="flex items-center justify-between">
            <SegmentedControl
              ariaLabel="Vista de resultados"
              value={search.vista}
              onValueChange={(v) => void navigate({ search: (p) => ({ ...p, vista: v }), replace: true })}
              options={[
                { value: 'tests', label: 'Por test' },
                { value: 'casos', label: 'Por caso' },
              ]}
            />
          </div>
          {search.vista === 'casos' ? (
            <CaseResults runId={r.id} active={active} />
          ) : (
            <TestResults runId={r.id} active={active} selected={search.resultado} onSelect={(id) => void navigate({ search: (p) => ({ ...p, resultado: id }), replace: true })} />
          )}
          <SnapshotCard run={r} />
        </div>
        <div className="space-y-6">
          <EvidenceCard run={r} resultId={search.resultado} />
          <PublicationCard run={r} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancelar ejecución"
        description="Los tests no iniciados quedarán cancelados y los ejecutores se detendrán en menos de 30 s. Cancelar no revierte acciones ya realizadas en la aplicación."
        confirmLabel="Cancelar ejecución"
        tone="danger"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} scope={search.vista === 'casos' ? 'case_results' : 'run_results'} filters={{ runId: r.id }} runId={r.id} allowPage={false} title={`Exportar ${shortId('run', r.id)}`} />
    </>
  );
}

function useRunResults(runId: string, active: boolean) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const poll = usePollingFallback('detail', active);
  const q = { limit: 100, cursor };
  const results = useQuery({
    queryKey: qk.runs.results(runId, q),
    queryFn: ({ signal }) => runsApi.results(runId, q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
    staleTime: active ? STALE.operational : STALE.terminal,
  });
  return {
    results,
    pager: {
      pageIndex: history.length,
      hasPrev: history.length > 0,
      hasNext: !!results.data?.hasNext,
      onPrev: () => {
        const h = [...history];
        setCursor(h.pop());
        setHistory(h);
      },
      onNext: () => {
        if (!results.data?.nextCursor) return;
        setHistory([...history, cursor]);
        setCursor(results.data.nextCursor);
      },
    },
  };
}

/** Referencias `C123` por caseId desde `GET /runs/:id/case-results` (RunResult solo trae `caseIds`). */
function useCaseRefs(runId: string, active: boolean) {
  const poll = usePollingFallback('detail', active);
  const q = useQuery({ queryKey: qk.runs.caseResults(runId), queryFn: ({ signal }) => runsApi.caseResults(runId, { limit: 100 }, signal), refetchInterval: poll });
  return useMemo(() => new Map((q.data?.items ?? []).map((c) => [c.caseId, c.ref])), [q.data]);
}
const refsOf = (refs: Map<string, string>, r: Pick<RunResult, 'caseIds'>) => r.caseIds.map((id) => refs.get(id)).filter((x): x is string => !!x);

/** Último error sanitizado del test (está en el intento, `TestAttempt.error`). */
function LastAttemptError({ runId, resultId }: { runId: string; resultId: string }) {
  const q = useQuery({ queryKey: qk.runs.attempts(runId, resultId), queryFn: ({ signal }) => runsApi.attempts(runId, resultId, signal) });
  const last = [...(q.data?.items ?? [])].reverse().find((a) => a.error);
  return last?.error ? <>{last.error}</> : null;
}

function TestResults({ runId, active, selected, onSelect }: { runId: string; active: boolean; selected: string | undefined; onSelect: (id: string) => void }) {
  const { results, pager } = useRunResults(runId, active);
  const refs = useCaseRefs(runId, active);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const columns = useMemo<ColumnDef<RunResult>[]>(
    () => [
      { id: 'caso', header: 'Caso', cell: ({ row }) => <MonoId>{refsOf(refs, row.original).join(', ') || '–'}</MonoId> },
      { id: 'test', header: 'Test', cell: ({ row }) => <span>{row.original.title}</span> },
      {
        id: 'intentos',
        header: 'Intentos',
        cell: ({ row }) => {
          const n = row.original.retryCount + row.original.infraRecoveryCount + (row.original.status === 'pendiente' || row.original.status === 'bloqueado' ? 0 : 1);
          const open = expanded.has(row.original.id);
          return n > 0 ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted"
              aria-expanded={open}
              aria-label={`${n} intentos: ${open ? 'ocultar' : 'ver'} detalle`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((p) => {
                  const s = new Set(p);
                  if (s.has(row.original.id)) s.delete(row.original.id);
                  else s.add(row.original.id);
                  return s;
                });
              }}
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {n}
            </button>
          ) : (
            '0'
          );
        },
      },
      { id: 'duracion', header: 'Duración', cell: ({ row }) => <span className="font-mono text-[13px]">{formatSeconds(row.original.durationMs)}</span> },
      { id: 'estado', header: 'Estado', cell: ({ row }) => <StatusBadge status={RESULT_STATUS_LABEL[row.original.status]} /> },
    ],
    [expanded, refs],
  );
  const items = results.data?.items;
  const effectiveSelected = selected ?? items?.find((x) => x.status === 'fallido')?.id ?? null;
  return (
    <CardSection title="Resultados por test" padded={false}>
      <DataTable
        caption="Resultados por test"
        columns={columns}
        data={items}
        getRowId={(x) => x.id}
        isLoading={results.isLoading}
        isFetching={results.isFetching && !results.isLoading}
        error={results.error}
        onRetry={() => void results.refetch()}
        selectedRowId={effectiveSelected}
        onRowClick={(x) => onSelect(x.id)}
        empty={{ title: 'Aún no hay resultados', description: 'Aparecerán cuando el ejecutor empiece.' }}
        renderSubRow={(x) => {
          const err = x.status === 'fallido' || x.status === 'error_infraestructura' ? <LastAttemptError runId={runId} resultId={x.id} /> : x.reason ? `${reasonLabel(x.reason)}${x.reasonText ? ` — ${x.reasonText}` : ''}` : null;
          const open = expanded.has(x.id);
          if (!err && !open) return null;
          return (
            <div className="space-y-2 pl-[88px]">
              {err ? (
                <div className={cn('rounded-md px-3 py-1.5 font-mono text-[12.5px]', x.status === 'fallido' ? 'bg-failed-soft text-failed' : x.status === 'error_infraestructura' ? 'border border-dashed border-infra/50 bg-failed-bg text-infra' : 'bg-muted text-muted-foreground')}>
                  {err}
                </div>
              ) : null}
              {open ? <Attempts runId={runId} resultId={x.id} /> : null}
            </div>
          );
        }}
        pagination={results.data?.hasNext || pager.hasPrev ? { ...pager, pageSize: 100, onPageSizeChange: () => undefined } : undefined}
      />
    </CardSection>
  );
}

function Attempts({ runId, resultId }: { runId: string; resultId: string }) {
  const q = useQuery({ queryKey: qk.runs.attempts(runId, resultId), queryFn: ({ signal }) => runsApi.attempts(runId, resultId, signal) });
  if (q.isLoading) return <Skeleton className="h-8" />;
  if (q.isError) return <ErrorState error={q.error} compact onRetry={() => void q.refetch()} />;
  const items = itemsOf(q.data);
  return (
    <table className="w-full text-[13px]">
      <caption className="sr-only">Intentos</caption>
      <thead>
        <tr className="th-mono">
          <th className="py-1 text-left font-medium">Intento</th>
          <th className="py-1 text-left font-medium">Tipo</th>
          <th className="py-1 text-left font-medium">Estado</th>
          <th className="py-1 text-left font-medium">Duración</th>
          <th className="py-1 text-left font-medium">Causa</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id} className="border-t border-border">
            <td className="py-1.5">#{a.attemptNo}</td>
            <td className="py-1.5">{a.kind === 'inicial' ? 'Inicial' : a.kind === 'retry' ? 'Reintento' : 'Recuperación'}</td>
            <td className="py-1.5">{a.status}</td>
            <td className="py-1.5 font-mono">{formatSeconds(a.durationMs)}</td>
            <td className="py-1.5">
              {a.errorCategory ? (
                <span title={a.error ?? ''}>
                  {ERROR_CATEGORY_LABEL[a.errorCategory].label} <span className="text-muted-foreground">({ERROR_CATEGORY_LABEL[a.errorCategory].origin === 'app' ? 'aplicación' : ERROR_CATEGORY_LABEL[a.errorCategory].origin === 'infra' ? 'ejecutor' : ERROR_CATEGORY_LABEL[a.errorCategory].origin})</span>
                </span>
              ) : (
                '–'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaseResults({ runId, active }: { runId: string; active: boolean }) {
  const poll = usePollingFallback('detail', active);
  const q = useQuery({ queryKey: qk.runs.caseResults(runId), queryFn: ({ signal }) => runsApi.caseResults(runId, { limit: 100 }, signal), refetchInterval: poll });
  const columns = useMemo<ColumnDef<CaseResult>[]>(
    () => [
      { id: 'caso', header: 'Caso', cell: ({ row }) => <MonoId>{row.original.ref}</MonoId> },
      { id: 'titulo', header: 'Título', cell: ({ row }) => <div><div>{row.original.title}</div>{row.original.comment ? <div className="text-[13px] text-muted-foreground">{row.original.comment}</div> : null}</div> },
      { id: 'cobertura', header: 'Cobertura', cell: ({ row }) => `${COVERAGE_LABEL[row.original.coverage]} · ${row.original.contributingResults.length} ${plural(row.original.contributingResults.length, 'test', 'tests')}` },
      { id: 'trabajo', header: 'Tiempo de trabajo', cell: ({ row }) => <span className="font-mono text-[13px]">{formatSeconds(row.original.durationMs)}</span> },
      { id: 'estado', header: 'Estado', cell: ({ row }) => <StatusBadge status={CASE_RESULT_LABEL[row.original.status]} /> },
      { id: 'testrail', header: 'TestRail', cell: ({ row }) => <StatusBadge status={row.original.publishable ? SYNC_STATUS_LABEL[row.original.syncStatus] : { label: 'Sin resultado externo', tone: 'neutral' }} /> },
    ],
    [],
  );
  return (
    <CardSection title="Resultados por caso" padded={false}>
      <DataTable caption="Resultados por caso" columns={columns} data={q.data?.items} getRowId={(x) => x.id} isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} empty={{ title: 'Sin casos en esta ejecución' }} />
    </CardSection>
  );
}

const KIND_ICON: Record<string, typeof Film> = { video: Film, traza: FileText, captura: Image, reporte: FileText };

function EvidenceCard({ run, resultId }: { run: RunDetail; resultId: string | undefined }) {
  const results = useQuery({ queryKey: qk.runs.results(run.id, { limit: 100, cursor: undefined }), queryFn: ({ signal }) => runsApi.results(run.id, { limit: 100 }, signal) });
  const effective = resultId ?? results.data?.items.find((x) => x.status === 'fallido')?.id ?? null;
  const result = results.data?.items.find((x) => x.id === effective);
  const refs = useCaseRefs(run.id, false);
  const resultRefs = result ? refsOf(refs, result) : [];
  const artifacts = useQuery({
    queryKey: qk.runs.artifacts(run.id, effective),
    queryFn: ({ signal }) => runsApi.artifacts(run.id, { resultId: effective }, signal),
    enabled: !!effective,
  });
  const open = useMutation({
    mutationFn: (a: Artifact) => runsApi.artifactAccess(run.id, a.id),
    onSuccess: (acc) => {
      // Enlace firmado de corta duración en el origen separado de reportes; nunca se guarda.
      window.open(acc.url, '_blank', 'noopener,noreferrer');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = itemsOf(artifacts.data).filter((a) => ['video', 'traza', 'captura', 'reporte'].includes(a.kind));
  return (
    <CardSection title={`Evidencia${resultRefs.length ? ` (${resultRefs.join(', ')})` : ''}`} padded={false}>
      {!effective ? (
        <EmptyState title="Selecciona un resultado para ver su evidencia" className="py-8" />
      ) : artifacts.isLoading ? (
        <Skeleton className="m-5 h-24" />
      ) : artifacts.isError ? (
        <ErrorState error={artifacts.error} compact onRetry={() => void artifacts.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Sin evidencia para este resultado" className="py-8" />
      ) : (
        <ul>
          {items.map((a) => {
            const Icon = KIND_ICON[a.kind] ?? FileText;
            const ok = a.sanitizationStatus === 'sanitizado';
            return (
              <li key={a.id} className="border-b border-border last:border-0">
                <button
                  type="button"
                  disabled={!ok || open.isPending}
                  onClick={() => open.mutate(a)}
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/60 disabled:cursor-not-allowed"
                  title={ok ? 'Abrir con enlace temporal autorizado' : (a.sanitizationReason ?? SANITIZATION_LABEL[a.sanitizationStatus])}
                >
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block', !ok && 'text-muted-foreground')}>
                      {a.kind === 'video' && (result?.retryCount ?? 0) > 0 ? `Video del intento ${(result?.retryCount ?? 0) + 1}` : ARTIFACT_KIND_LABEL[a.kind]}
                    </span>
                    {!ok ? <span className="block text-[12px] text-muted-foreground">{a.sanitizationReason ?? SANITIZATION_LABEL[a.sanitizationStatus]}</span> : null}
                  </span>
                  {ok ? <ExternalLink className="size-4 text-[#84858c]" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </CardSection>
  );
}

function PublicationCard({ run }: { run: RunDetail }) {
  const targets = run.targets;
  return (
    <CardSection title="Publicación a TestRail">
      {run.syncStatus === 'no_aplica' && targets.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">Esta ejecución no publica en TestRail.</p>
      ) : (
        <div className="space-y-4">
          {(targets.length ? targets : [null]).map((t, i) => (
            <KeyValue
              key={t?.id ?? i}
              items={[
                {
                  k: 'Corrida',
                  v: t?.trRunId ? (
                    t.url ? (
                      <a href={t.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:underline">
                        #{t.trRunId} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      `#${t.trRunId}`
                    )
                  ) : (
                    '—'
                  ),
                },
                { k: 'Estado', v: <StatusBadge status={SYNC_STATUS_LABEL[t?.syncStatus ?? run.syncStatus]} /> },
                ...(t?.pendingDeliveries ? [{ k: 'Entregas pendientes', v: t.pendingDeliveries }] : []),
              ]}
            />
          ))}
          {targets.some((t) => t.lastError) ? <Callout tone="danger" className="px-3 text-[13px]">{targets.find((t) => t.lastError)?.lastError}</Callout> : null}
          {run.syncStatus === 'requiere_intervencion' ? (
            <Link to="/testrail" className="text-[13px] font-medium text-primary">
              Ver entregas en TestRail
            </Link>
          ) : null}
          <p className="text-[13px] text-muted-foreground">
            Los resultados se publican al terminar; si TestRail no responde, se reintentan sin bloquear la ejecución.
          </p>
        </div>
      )}
    </CardSection>
  );
}

function SnapshotCard({ run }: { run: RunDetail }) {
  const s = run.snapshot;
  return (
    <Card>
      <details>
        <summary className="cursor-pointer px-5 py-3.5 text-[15px] font-semibold">Plan congelado</summary>
        <div className="grid gap-x-8 gap-y-2 border-t border-border px-5 py-4 text-[14px] md:grid-cols-2">
          <KeyValue
            items={[
              { k: 'Ambiente', v: `${s.environment.name}${s.environment.isProduction ? ' (producción)' : ''}` },
              { k: 'URL', v: s.environment.appUrl, mono: true },
              { k: 'Usuario de prueba', v: s.testUser ? `${s.testUser.label}${s.testUser.readOnly ? ' · solo lectura' : ''}` : '—' },
              { k: 'Reintentos', v: s.retries },
            ]}
          />
          <KeyValue
            items={[
              { k: 'Commit', v: s.gitCommit.slice(0, 12), mono: true },
              { k: 'Manifiesto', v: s.manifestHash.slice(0, 12), mono: true },
              { k: 'Excluir inestables', v: s.excludeFlaky ? 'Sí' : 'No' },
              { k: 'Evidencia', v: s.artifactPolicy.enabledKinds.join(', ') },
            ]}
          />
        </div>
      </details>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-9 w-1/3" />
      <div className="grid grid-cols-5 gap-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
