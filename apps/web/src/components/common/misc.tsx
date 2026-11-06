import type { ReactNode } from 'react';
import { TriangleAlert, Info, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Contadores de resultado `2✓ 0✗ 0– / 4` (mono 12 px). */
export function ResultCounts({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total?: number }) {
  return (
    <span className="font-mono text-[12px] whitespace-nowrap" aria-label={`${passed} pasados, ${failed} fallidos, ${skipped} omitidos${total !== undefined ? ` de ${total}` : ''}`}>
      <span className="text-passed">{passed}✓</span> <span className="text-failed">{failed}✗</span>{' '}
      <span className="text-muted-foreground">{skipped}–</span>
      {total !== undefined ? <span className="text-muted-foreground"> / {total}</span> : null}
    </span>
  );
}

export function ProgressBar({ value, max, className, label }: { value: number; max: number; className?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label ?? 'Progreso'}
      className={cn('h-[5px] w-28 overflow-hidden rounded-full bg-muted', className)}
    >
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

type CalloutTone = 'danger' | 'warning' | 'info' | 'blocked';
const CALLOUT: Record<CalloutTone, string> = {
  danger: 'border-alert-border bg-alert-bg',
  warning: 'border-[#efd39a] bg-flaky-bg text-flaky',
  info: 'border-border bg-card',
  blocked: 'border-[#f0c4c3] bg-failed-soft',
};

export function Callout({
  tone = 'info',
  title,
  children,
  icon,
  className,
  action,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const Icon = tone === 'danger' ? TriangleAlert : tone === 'blocked' ? ShieldAlert : tone === 'warning' ? TriangleAlert : Info;
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-[14px]', CALLOUT[tone], className)}>
      <span className={cn('mt-0.5', tone === 'danger' || tone === 'blocked' ? 'text-failed' : tone === 'warning' ? 'text-flaky' : 'text-muted-foreground')}>
        {icon ?? <Icon className="size-4" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <div className={cn('font-semibold', tone === 'blocked' && 'text-failed')}>{title}</div> : null}
        {children ? <div className={cn(title ? 'mt-0.5' : '')}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** Lista clave-valor (Plan resuelto, Publicación a TestRail). */
export function KeyValue({ items }: { items: { k: ReactNode; v: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[14px]">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{it.k}</dt>
          <dd className={cn('text-right font-medium', it.mono && 'font-mono text-[13px]')}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-[13px] text-failed">
      {message}
    </p>
  );
}

export function MonoId({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[14px] font-medium text-primary', className)}>{children}</span>;
}
