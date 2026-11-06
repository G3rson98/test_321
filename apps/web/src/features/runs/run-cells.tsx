import { Link } from '@tanstack/react-router';
import type { RunSummary } from '@/lib/api/types';
import { formatDateTimeShort } from '@/lib/format';
import { runStateLabel, TRIGGER_LABEL } from '@/lib/labels';
import { shortId } from '@/lib/utils';
import { ProgressBar, ResultCounts } from '@/components/common/misc';
import { StatusBadge } from '@/components/common/status-badge';

export function runCounts(r: Pick<RunSummary, 'counts'>) {
  const c = r.counts;
  return {
    passed: c.pasado + c.inestable,
    failed: c.fallido + c.error_infraestructura,
    skipped: c.omitido + c.cancelado + c.bloqueado,
    done: c.total - c.pendiente - c.corriendo,
    total: c.total,
  };
}

/** Título de la corrida: suite o programación; si no, la etiqueta de la selección que entrega la API (D-054). */
export function runTitle(r: Pick<RunSummary, 'suiteName' | 'scheduleName' | 'selectionLabel'>): string {
  return r.suiteName ?? r.scheduleName ?? r.selectionLabel ?? 'Selección de casos';
}

export function RunIdLink({ run }: { run: Pick<RunSummary, 'id'> }) {
  return (
    <Link
      to="/ejecuciones/$runId"
      params={{ runId: run.id }}
      className="font-mono text-[14px] font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={(e) => e.stopPropagation()}
    >
      {shortId('run', run.id)}
    </Link>
  );
}

export function RunOrigin({ run }: { run: RunSummary }) {
  return (
    <div className="min-w-0">
      <div className="truncate">{runTitle(run)}</div>
      <div className="text-[13px] text-muted-foreground">
        {TRIGGER_LABEL[run.trigger]} · {formatDateTimeShort(run.scheduledFor ?? run.createdAt)}
      </div>
    </div>
  );
}

export function RunState({ run }: { run: Pick<RunSummary, 'status' | 'outcome'> }) {
  return <StatusBadge status={runStateLabel(run.status, run.outcome)} />;
}

export function RunCounts({ run, withTotal }: { run: RunSummary; withTotal?: boolean }) {
  const c = runCounts(run);
  return <ResultCounts passed={c.passed} failed={c.failed} skipped={c.skipped} {...(withTotal ? { total: c.total } : {})} />;
}

export function RunProgressCell({ run }: { run: RunSummary }) {
  const c = runCounts(run);
  return (
    <div className="flex flex-col gap-1.5">
      <ProgressBar value={c.done} max={c.total} label={`Progreso ${c.done} de ${c.total}`} />
      <RunCounts run={run} withTotal />
    </div>
  );
}
