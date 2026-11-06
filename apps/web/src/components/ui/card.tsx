import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('rounded-lg border border-border bg-card text-card-foreground', className)} {...props} />;
}

/** Card con cabecera (título 15 px semibold, acción a la derecha y borde inferior) — patrón de las capturas. */
export function CardSection({
  title,
  action,
  meta,
  children,
  className,
  bodyClassName,
  padded = true,
  titleId,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
  titleId?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-card', className)} aria-labelledby={titleId}>
      <header className="flex min-h-[46px] items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <h2 id={titleId} className="truncate text-[15px] font-semibold tracking-tight">
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {meta ? <span className="font-mono text-[12px] text-muted-foreground">{meta}</span> : null}
          {action}
        </div>
      </header>
      <div className={cn(padded && 'p-5', bodyClassName)}>{children}</div>
    </section>
  );
}
