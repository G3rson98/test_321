import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Lock, RotateCcw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage, isApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      <div className="mb-1 text-muted-foreground">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="text-[15px] font-medium">{title}</p>
      {description ? <p className="max-w-md text-[14px] text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className, compact }: { error: unknown; onRetry?: () => void; className?: string; compact?: boolean }) {
  const forbidden = isApiError(error) && error.status === 403;
  const network = isApiError(error) && error.isNetwork;
  const Icon = forbidden ? Lock : network ? WifiOff : AlertTriangle;
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-2 px-6 text-center', compact ? 'py-6' : 'py-12', className)}>
      <Icon className={cn('size-6', forbidden ? 'text-muted-foreground' : 'text-failed')} aria-hidden />
      <p className="text-[15px] font-medium">{forbidden ? 'No tienes permiso para ver esto' : 'No se pudo cargar'}</p>
      <p className="max-w-md text-[14px] text-muted-foreground">{errorMessage(error)}</p>
      {isApiError(error) && error.requestId ? (
        <p className="font-mono text-[11px] text-muted-foreground">ID de solicitud: {error.requestId}</p>
      ) : null}
      {onRetry && !forbidden ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RotateCcw /> Reintentar
        </Button>
      ) : null}
    </div>
  );
}

export function InlineError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-alert-border bg-alert-bg px-3 py-2 text-[13px]">
      <span>{errorMessage(error)}</span>
      {onRetry ? (
        <Button variant="link" onClick={onRetry} className="text-foreground underline">
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}
