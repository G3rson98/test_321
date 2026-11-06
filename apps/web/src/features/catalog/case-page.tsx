/**
 * 05/06/07/08 · Detalle de caso (RF-TR-03, RF-TR-07, RF-RES-03, RF-GRB-01/03): pasos de TestRail, test(s)
 * vinculado(s) con visor diferido, historial de las últimas 20, revisión de vínculo `requiere_revision` (dev),
 * grabación con el asistente local (`?grabacion=`) y borrador con IA (dev).
 */
import { lazy, Suspense, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Play, Sparkles, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/popover';
import { PageHeader } from '@/components/common/page-header';
import { TagChip } from '@/components/common/tag-chip';
import { StatusBadge } from '@/components/common/status-badge';
import { Callout } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/common/states';
import { NotFoundPage } from '@/components/layout/error-pages';
import { catalogApi } from '@/lib/api/endpoints';
import type { AutomatedTest, CaseDetail, History } from '@/lib/api/types';
import { sectionNameMap, useCaseAutomation } from '@/features/common/derived';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { CLASSIFICATION_LABEL, lastResultLabel, RESULT_STATUS_LABEL, TEST_STATUS_LABEL } from '@/lib/labels';
import { formatDateTimeShort, formatPercent, formatSeconds } from '@/lib/format';
import { selection } from '@/lib/stores/selection';
import { cn } from '@/lib/utils';
import { RecordButton, RecordingDialog, StartRecordingDialog } from '@/features/recording/recording-dialog';
import { GenerateSheet } from './generate-sheet';

const CodeViewer = lazy(() => import('@/components/code/code-viewer'));
const route = getRouteApi('/_app/catalogo/$caseId');

export function CasePage() {
  const { caseId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const routeNavigate = route.useNavigate();
  const canGenerate = useCan('generate.create');
  const canRecord = useCan('recordings.create');
  const canRun = useCan('runs.create');
  const [startRecording, setStartRecording] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const c = useQuery({ queryKey: qk.catalog.case(caseId), queryFn: ({ signal }) => catalogApi.case(caseId, signal) });
  const sections = useQuery({ queryKey: qk.catalog.sections(), queryFn: ({ signal }) => catalogApi.sections({}, signal) });
  // Etiquetas/clasificación/flaky vienen de los tests vinculados (`GET /tests?caseId=`), no del caso de TestRail.
  const auto = useCaseAutomation(c.data ? [c.data] : []).get(caseId) ?? { tags: [], classification: null, flaky: null };
  const history = useQuery({
    queryKey: qk.catalog.caseHistory(caseId, { limit: 20 }),
    queryFn: ({ signal }) => catalogApi.caseHistory(caseId, { limit: 20 }, signal),
    enabled: c.isSuccess,
  });

  if (c.isError && isApiError(c.error) && c.error.status === 404) return <NotFoundPage />;
  if (c.isError) return <ErrorState error={c.error} onRetry={() => void c.refetch()} />;
  if (c.isLoading || !c.data) return <CaseSkeleton />;

  const kase = c.data;
  const classification = auto.classification;
  const needsReview = kase.links.some((l) => l.reviewStatus === 'requiere_revision');
  const hasTest = kase.links.length > 0;
  const highlightRecord = !hasTest || needsReview;
  const archived = !!kase.archivedAt;

  return (
    <>
      <PageHeader
        title={`${kase.ref} · ${kase.title}`}
        subtitle={`${sectionNameMap(sections.data?.items).get(kase.sectionId) ?? 'Sin sección'} · Prioridad ${kase.priority ?? '—'} · Clasificación ${classification ? CLASSIFICATION_LABEL[classification] : '-'}`}
        className="mb-6"
        actions={
          <>
            <Button variant="ghost" onClick={() => void navigate({ to: '/catalogo' })}>
              <ArrowLeft /> Catálogo
            </Button>
            {canGenerate ? (
              <Button variant="outline" onClick={() => setGenerateOpen(true)} disabled={archived}>
                <Sparkles /> Generar con IA
              </Button>
            ) : (
              <Tip label="Disponible para desarrolladores">
                <span tabIndex={0}>
                  <Button variant="outline" disabled aria-disabled>
                    <Sparkles /> Generar con IA
                  </Button>
                </span>
              </Tip>
            )}
            {canRecord ? <RecordButton highlighted={highlightRecord} disabled={archived} onClick={() => setStartRecording(true)} /> : null}
            {canRun ? (
              <Tip label={hasTest ? 'Ejecutar este caso' : 'Sin test: el plan lo mostrará bloqueado (sin automatización)'}>
                <Button
                  disabled={archived}
                  onClick={() => {
                    selection.replace([kase.id]);
                    void navigate({ to: '/ejecuciones/nueva', search: { modo: 'casos', caseId: kase.id } });
                  }}
                >
                  <Play /> Ejecutar
                </Button>
              </Tip>
            ) : null}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {auto.tags.map((t) => (
          <TagChip key={t} tag={t} className="h-[22px] text-[11px]" />
        ))}
        <StatusBadge status={lastResultLabel(kase.lastResult?.status)} />
        {needsReview ? (
          <span className="inline-flex h-[24px] items-center rounded-full bg-flaky-bg px-3 text-[12.5px] font-semibold text-flaky">Requiere revisión: cambiaron los pasos en TestRail</span>
        ) : null}
        {classification === 'escritura' ? (
          <span className="inline-flex h-[24px] items-center gap-1 rounded-full bg-blocked-bg px-3 text-[12.5px] font-semibold text-blocked">
            <ShieldAlert className="size-3.5" aria-hidden /> Escritura · bloqueado en producción
          </span>
        ) : null}
      </div>

      {archived ? (
        <Callout tone="warning" className="mb-6" title="Caso archivado">
          El caso ya no existe en TestRail. Se conserva su historial, pero no puede ejecutarse ni grabarse.
        </Callout>
      ) : null}
      {needsReview ? <ReviewCallout kase={kase} /> : null}

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <CardSection title={`Pasos en TestRail (v${kase.revision})`} padded={false}>
          {kase.steps.length === 0 ? (
            <EmptyState title="El caso no tiene pasos en TestRail" />
          ) : (
            <ol>
              {kase.steps.map((s, i) => (
                <li key={i} className="flex gap-4 border-b border-border px-5 py-3.5 last:border-0">
                  <span className="w-3 shrink-0 text-muted-foreground">{i + 1}</span>
                  <div>
                    <div>{s.content}</div>
                    {s.expected ? <div className="text-[13px] text-muted-foreground">Esperado: {s.expected}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardSection>
        <LinkedTests kase={kase} selectedTestId={search.test} onSelect={(id) => void routeNavigate({ search: (p) => ({ ...p, test: id }), replace: true })} />
      </div>

      <HistoryCard history={history.data} loading={history.isLoading} error={history.error} onRetry={() => void history.refetch()} />

      {startRecording ? (
        <StartRecordingDialog
          kase={kase}
          onClose={() => setStartRecording(false)}
          onCreated={(id) => {
            setStartRecording(false);
            void routeNavigate({ search: (p) => ({ ...p, grabacion: id }) });
          }}
        />
      ) : null}
      {search.grabacion ? (
        <RecordingDialog recordingId={search.grabacion} caseRef={kase.ref} onClose={() => void routeNavigate({ search: (p) => ({ ...p, grabacion: undefined }) })} />
      ) : null}
      {generateOpen ? <GenerateSheet kase={kase} onClose={() => setGenerateOpen(false)} /> : null}
    </>
  );
}

function ReviewCallout({ kase }: { kase: CaseDetail }) {
  const canReview = useCan('catalog.link.review');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const link = kase.links.find((l) => l.reviewStatus === 'requiere_revision')!;
  const review = useMutation({
    mutationFn: () => catalogApi.reviewLink(link.automatedTestId, kase.id, { caseRevision: kase.revision }),
    onSuccess: () => {
      toast.success('Vínculo marcado como revisado.');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Callout
      tone="warning"
      className="mb-6"
      title={`Cambiaron los pasos en TestRail (v${link.reviewedCaseRevision ?? '?'} → v${kase.revision})`}
      action={
        canReview ? (
          <Button size="sm" variant="outlineCard" onClick={() => setOpen(true)}>
            Marcar revisado
          </Button>
        ) : null
      }
    >
      Hasta que un desarrollador revise el test, este caso no puede ir a producción ni a programaciones; en staging manual se ejecuta con advertencia.
      Revisar el vínculo no aprueba código.
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Marcar vínculo como revisado"
        description={`Confirmas que "${link.title}" cubre la revisión v${kase.revision} de ${kase.ref}. Queda registrado en auditoría.`}
        confirmLabel="Marcar revisado"
        pending={review.isPending}
        onConfirm={() => review.mutate()}
      />
    </Callout>
  );
}

function LinkedTests({ kase, selectedTestId, onSelect }: { kase: CaseDetail; selectedTestId: string | undefined; onSelect: (id: string) => void }) {
  const links = kase.links;
  const activeId = links.find((l) => l.automatedTestId === selectedTestId)?.automatedTestId ?? links[0]?.automatedTestId;
  const test = useQuery({ queryKey: qk.catalog.test(activeId ?? ''), queryFn: ({ signal }) => catalogApi.test(activeId!, signal), enabled: !!activeId });

  if (links.length === 0) {
    return (
      <CardSection title="Sin test vinculado" padded={false}>
        <EmptyState title="Graba el flujo o genera un borrador con IA para automatizar este caso." className="py-16" />
      </CardSection>
    );
  }
  const t = test.data;
  return (
    <CardSection
      title={`Test vinculado · ${t?.filePath ?? '…'}`}
      meta={t?.manifestCommit ? `main@${t.manifestCommit.slice(0, 7)}` : undefined}
      padded={false}
      bodyClassName="overflow-hidden rounded-b-lg"
    >
      {links.length > 1 ? (
        <div role="tablist" aria-label="Tests vinculados" className="flex gap-1 border-b border-border bg-card px-3 pt-2">
          {links.map((l) => (
            <button
              key={l.automatedTestId}
              role="tab"
              aria-selected={l.automatedTestId === activeId}
              onClick={() => onSelect(l.automatedTestId)}
              className={cn('rounded-t-md px-3 py-1.5 text-[13px]', l.automatedTestId === activeId ? 'bg-code-bg text-code-fg' : 'text-muted-foreground hover:text-foreground')}
            >
              {l.title}
            </button>
          ))}
        </div>
      ) : null}
      {t && t.status !== 'aprobado' ? (
        <div className="border-b border-border bg-flaky-bg px-5 py-2 text-[13px] text-flaky">
          Test {TEST_STATUS_LABEL[t.status].toLowerCase()}: no se ejecuta en corridas normales.
        </div>
      ) : null}
      {test.isLoading ? (
        <Skeleton className="m-5 h-40" />
      ) : test.isError ? (
        <div className="bg-code-bg px-5 py-6 text-[13px] text-[#aaabb2]">{errorMessage(test.error)}</div>
      ) : t ? (
        <>
          <Suspense fallback={<Skeleton className="m-5 h-40" />}>
            <CodeViewer code={manifestSnippet(t)} className="min-h-[196px]" />
          </Suspense>
          {/* PENDIENTE [WEB→API-A2]: `GET /tests/:id/source` (código sanitizado del commit aprobado). */}
          <p className="border-t border-border px-5 py-2 text-[12.5px] text-muted-foreground">Metadatos del manifiesto. El código fuente completo se revisa en el repositorio de qa-tests.</p>
        </>
      ) : null}
    </CardSection>
  );
}

/** Resumen legible del test a partir del manifiesto (datos reales de `GET /tests/:id`, no código inventado). */
function manifestSnippet(t: AutomatedTest): string {
  return [
    `// ${t.filePath}${t.manifestCommit ? ` · main@${t.manifestCommit.slice(0, 7)}` : ''}`,
    `test('${t.title.replace(/'/g, "\\'")}', {`,
    `  tag: ${JSON.stringify(t.tags)},`,
    `  annotation: [`,
    `    { type: 'katalyst.stableKey', description: '${t.stableKey}' },`,
    `    { type: 'clasificacion', description: '${t.classification}' },`,
    `  ],`,
    `}${t.parameterKeys.length ? ` /* parámetros: ${t.parameterKeys.join(', ')} */` : ''});`,
    t.owner ? `// responsable: ${t.owner}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

function HistoryCard({ history, loading, error, onRetry }: { history: History | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
  const navigate = useNavigate();
  const items = [...(history?.items ?? [])].reverse();
  const max = Math.max(1, ...items.map((i) => i.durationMs ?? 0));
  return (
    <CardSection title="Historial (últimas 20)" padded={false}>
      {loading ? (
        <Skeleton className="m-5 h-12" />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} compact />
      ) : items.length === 0 ? (
        <EmptyState title="Sin ejecuciones todavía" />
      ) : (
        <>
          <div className="flex h-[88px] items-end gap-[7px] px-5 pt-5 pb-5" role="list" aria-label="Historial de resultados">
            {items.map((i) => {
              const tone = i.status === 'fallido' || i.status === 'error_infraestructura' ? 'bg-failed' : i.status === 'inestable' ? 'bg-primary' : i.status === 'pasado' ? 'bg-passed' : 'bg-border';
              const h = 22 + Math.round(((i.durationMs ?? 0) / max) * 26);
              const label = `${(RESULT_STATUS_LABEL as Record<string, { label: string }>)[i.status]?.label ?? i.status} · ${formatSeconds(i.durationMs)} · ${formatDateTimeShort(i.finishedAt)}`;
              return (
                <Tip key={i.runId} label={label}>
                  <button
                    role="listitem"
                    type="button"
                    aria-label={label}
                    onClick={() => void navigate({ to: '/ejecuciones/$runId', params: { runId: i.runId } })}
                    className={cn('min-w-0 flex-1 rounded-[2px] outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring', tone)}
                    style={{ height: h }}
                  />
                </Tip>
              );
            })}
          </div>
          <div className="flex justify-between border-t border-border px-5 py-3 text-[13px] text-muted-foreground">
            <span>Éxito {formatPercent(history?.trend.successRate)}</span>
            {history?.flaky?.isFlaky ? (
              <span className="text-flaky">
                Inestable {history.flaky.numerator}/{history.flaky.denominator}
              </span>
            ) : null}
            <span>Duración media {history?.trend.avgDurationMs ? `${Math.round(history.trend.avgDurationMs / 1000)} s` : '–'}</span>
          </div>
        </>
      )}
    </CardSection>
  );
}

function CaseSkeleton() {
  return (
    <div aria-busy className="space-y-6">
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-5 w-1/3" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <Skeleton className="h-36" />
    </div>
  );
}

