/**
 * 09 · Suites (RF-CAT-03): tarjetas con último resultado, etiquetas, conteo de casos y tests, horarios. El último
 * resultado sale de `GET /runs?suiteId=&status=terminada&limit=1` y los horarios de `GET /schedules` (la suite no los trae).
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { TagChip } from '@/components/common/tag-chip';
import { StatusBadge } from '@/components/common/status-badge';
import { EmptyState, ErrorState } from '@/components/common/states';
import { runsApi, schedulesApi, suitesApi } from '@/lib/api/endpoints';
import type { Schedule, Suite } from '@/lib/api/types';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { LAST_RESULT_NONE, RUN_OUTCOME_LABEL } from '@/lib/labels';
import { plural } from '@/lib/utils';

export function SuitesPage() {
  const navigate = useNavigate();
  const canWrite = useCan('suites.write');
  const suites = useQuery({ queryKey: qk.suites.list({ limit: 100 }), queryFn: ({ signal }) => suitesApi.list({ limit: 100 }, signal) });
  const schedules = useQuery({ queryKey: qk.schedules.list({ limit: 100 }), queryFn: ({ signal }) => schedulesApi.list({ limit: 100 }, signal) });
  const schedulesOf = (id: string) => (schedules.data?.items ?? []).filter((x) => x.suiteId === id && !x.deletedAt);
  return (
    <>
      <PageHeader
        title="Suites"
        subtitle="Conjuntos guardados de casos o etiquetas"
        actions={
          canWrite ? (
            <Button onClick={() => void navigate({ to: '/suites/nueva' })}>
              <Plus /> Nueva suite
            </Button>
          ) : null
        }
      />
      {suites.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : suites.isError ? (
        <Card>
          <ErrorState error={suites.error} onRetry={() => void suites.refetch()} />
        </Card>
      ) : (suites.data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Aún no hay suites"
            description="Guarda un conjunto de casos o etiquetas para ejecutarlo o programarlo con un clic."
            action={canWrite ? <Button onClick={() => void navigate({ to: '/suites/nueva' })}><Plus /> Nueva suite</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {suites.data!.items.map((s) => (
            <SuiteCard key={s.id} suite={s} schedules={schedulesOf(s.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function SuiteCard({ suite, schedules }: { suite: Suite; schedules: Schedule[] }) {
  const lastQ = { suiteId: suite.id, status: 'terminada', limit: 1 };
  const last = useQuery({ queryKey: qk.runs.list(lastQ), queryFn: ({ signal }) => runsApi.list(lastQ, signal) });
  const lastOutcome = last.data?.items[0]?.outcome ?? null;
  const navigate = useNavigate();
  const canRun = useCan('runs.create');
  const canSchedule = useCan('schedules.write');
  const tags = suite.selector.tags ?? [];
  const cases = suite.resolved?.cases;
  const tests = suite.resolved?.tests;
  const empty = suite.resolved && suite.resolved.cases === 0;
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <Link to="/suites/$suiteId" params={{ suiteId: suite.id }} className="text-[18px] font-semibold tracking-tight outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
          {suite.name}
        </Link>
        <StatusBadge status={lastOutcome ? RUN_OUTCOME_LABEL[lastOutcome] : LAST_RESULT_NONE} />
      </div>
      <p className="mt-2 min-h-6 text-muted-foreground">{suite.description ?? ''}</p>
      <div className="mt-3 flex min-h-5 flex-wrap gap-1.5">
        {tags.map((t) => (
          <TagChip key={t} tag={t} />
        ))}
        {suite.selector.caseIds?.length ? <TagChip tag={`${suite.selector.caseIds.length} casos explícitos`} /> : null}
        {suite.selector.sectionIds?.length ? <TagChip tag={`${suite.selector.sectionIds.length} secciones`} /> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12.5px] text-muted-foreground">
        <span>
          {cases ?? '–'} {plural(cases ?? 0, 'caso', 'casos')} · {tests ?? '–'} {plural(tests ?? 0, 'test', 'tests')}
        </span>
        {schedules.map((x) => (
          <span key={x.id} className="inline-flex items-center gap-1" title={x.name}>
            <CalendarClock className="size-3" aria-hidden /> {x.description ?? x.name}
            {x.enabled ? null : ' (pausada)'}
          </span>
        ))}
      </div>
      {empty ? <p className="mt-2 text-[13px] text-flaky">El selector no resuelve casos actualmente.</p> : null}
      <div className="mt-5 flex gap-2 border-t border-border pt-4">
        {canRun ? (
          <Button size="sm" onClick={() => void navigate({ to: '/ejecuciones/nueva', search: { modo: 'suite', suiteId: suite.id } })}>
            <Play /> Ejecutar
          </Button>
        ) : null}
        {canSchedule ? (
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/programaciones/nueva', search: { suiteId: suite.id } })}>
            Programar
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
