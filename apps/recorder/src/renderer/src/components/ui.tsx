/** Componentes base con el sistema visual Katalyst (docs/ui-capturas.md §1.4–1.6). */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle, TriangleAlert, ShieldAlert, Info, CircleCheck } from 'lucide-react';

type Variant = 'primary' | 'outline' | 'ghost' | 'destructive' | 'soft';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground border border-primary shadow-xs hover:brightness-95',
  outline: 'bg-card text-foreground border border-border shadow-xs hover:bg-background',
  ghost: 'bg-transparent text-foreground border border-transparent hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground border border-destructive shadow-xs hover:brightness-95',
  soft: 'bg-primary-soft text-primary-soft-foreground border border-primary-soft hover:brightness-95',
};

export function Button({
  variant = 'outline',
  icon,
  loading,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-[15px] font-medium whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Card({
  title,
  meta,
  children,
  className = '',
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-border bg-card ${className}`}>
      {title !== undefined && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-5 py-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {meta !== undefined && <div className="font-mono text-xs text-muted-foreground">{meta}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Tone = 'passed' | 'failed' | 'flaky' | 'running' | 'skipped' | 'neutral';
const TONES: Record<Tone, string> = {
  passed: 'bg-passed-bg text-passed',
  failed: 'bg-failed-bg text-failed',
  flaky: 'bg-flaky-bg text-flaky',
  running: 'bg-running-bg text-running',
  skipped: 'bg-skipped-bg text-skipped',
  neutral: 'bg-muted text-foreground',
};

export function Badge({ tone, children, dot }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2.5 font-mono text-[10.5px] font-semibold tracking-[0.06em] uppercase ${TONES[tone]}`}
    >
      {dot && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function TagChip({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Quitar etiqueta"
        >
          ×
        </button>
      )}
    </span>
  );
}

export function Callout({
  kind,
  title,
  children,
}: {
  kind: 'error' | 'warning' | 'info' | 'success' | 'blocked';
  title?: ReactNode;
  children?: ReactNode;
}) {
  const styles = {
    error: 'border-[#ebaaaa] bg-failed-soft text-failed',
    blocked: 'border-[#ebaaaa] bg-failed-soft text-failed',
    warning: 'border-[#f1cf94] bg-flaky-bg text-flaky',
    info: 'border-[#b9d9ec] bg-running-bg text-[#0f5f8a]',
    success: 'border-[#a9d6b6] bg-passed-bg text-[#1c6e39]',
  }[kind];
  const Icon = { error: TriangleAlert, blocked: ShieldAlert, warning: TriangleAlert, info: Info, success: CircleCheck }[
    kind
  ];
  return (
    <div
      role={kind === 'error' || kind === 'blocked' ? 'alert' : 'status'}
      className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${styles}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-foreground/90">{children}</div>}
      </div>
    </div>
  );
}

export function MonoLabel({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">{children}</span>;
}

export function Logo() {
  return (
    <div className="select-none">
      <div className="flex items-baseline gap-0.5 text-[26px] leading-none font-black tracking-tight">
        <span className="text-[#ed9405]">DELTA</span>
        <span className="bg-gradient-to-br from-[#d9dadf] to-[#8b8c94] bg-clip-text text-transparent">X</span>
      </div>
      <div className="mt-1.5 font-mono text-[10px] font-medium tracking-[0.25em] text-[#83848c]">KATALYST</div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <div className="mt-2 text-[15px] text-muted-foreground">{body}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-[15px] text-muted-foreground" role="status">
      <LoaderCircle className="size-5 animate-spin text-primary" aria-hidden />
      {label}
    </div>
  );
}
