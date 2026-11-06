import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-8 flex flex-wrap items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-page-title font-bold text-foreground">{title}</h1>
        {subtitle ? <p className="mt-2 text-[15px] text-muted-foreground">{subtitle}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
