import type { ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export type KpiTone = 'default' | 'passed' | 'failed' | 'flaky' | 'running';
const TONE: Record<KpiTone, string> = {
  default: 'text-foreground',
  passed: 'text-passed',
  failed: 'text-failed',
  flaky: 'text-flaky',
  running: 'text-running',
};

export function KpiCard({
  label,
  value,
  hint,
  tone = 'default',
  loading,
  href,
  compact,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  loading?: boolean;
  href?: LinkProps['to'];
  compact?: boolean;
}) {
  const body = (
    <div className={cn('flex h-full flex-col rounded-lg border border-border bg-card px-5', compact ? 'py-4' : 'py-6')}>
      <span className="label-mono">{label}</span>
      {loading ? (
        <Skeleton className="mt-3 h-9 w-20" />
      ) : (
        <span className={cn('mt-2 text-kpi font-bold tracking-tight tabular-nums', TONE[tone])}>{value}</span>
      )}
      {hint !== undefined ? <span className="mt-1 text-[13px] text-muted-foreground">{loading ? ' ' : hint}</span> : null}
    </div>
  );
  return href ? (
    <Link to={href} className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

export function KpiGrid({ columns = 4, children }: { columns?: 4 | 5; children: ReactNode }) {
  return <div className={cn('mb-6 grid gap-4 sm:grid-cols-2', columns === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>{children}</div>;
}
