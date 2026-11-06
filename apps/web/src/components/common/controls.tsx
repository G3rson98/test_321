import type { ReactNode } from 'react';
import { RadioGroup as RadioPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/** Control segmentado de opción única (11, 12, 17, 18, 19). Accesible como radiogroup. */
export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
  disabled,
}: {
  options: readonly { value: V; label: ReactNode; disabled?: boolean }[];
  value: V;
  onValueChange: (v: V) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <RadioPrimitive.Root
      aria-label={ariaLabel}
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      orientation="horizontal"
      disabled={disabled}
      className={cn('inline-flex rounded-md border border-border bg-card p-1', className)}
    >
      {options.map((o) => (
        <RadioPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className="rounded-sm px-3 py-1 text-[14px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
        >
          {o.label}
        </RadioPrimitive.Item>
      ))}
    </RadioPrimitive.Root>
  );
}

export interface RadioCardItem<V extends string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  reason?: string;
}

/** Tarjetas seleccionables (suites, ambientes): seleccionada = borde naranja + ring 2 px. */
export function RadioCardGroup<V extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  items: readonly RadioCardItem<V>[];
  value: V | null;
  onValueChange: (v: V) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <RadioPrimitive.Root
      aria-label={ariaLabel}
      value={value ?? ''}
      onValueChange={(v) => onValueChange(v as V)}
      className={cn('grid gap-3', className)}
    >
      {items.map((it) => (
        <RadioPrimitive.Item
          key={it.value}
          value={it.value}
          disabled={it.disabled}
          title={it.reason}
          className="flex min-h-[64px] flex-col items-start justify-center gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left outline-none transition-shadow hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:border-primary data-[state=checked]:ring-2 data-[state=checked]:ring-primary-ring"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="text-[15px] font-semibold">{it.title}</span>
            {it.badge}
          </span>
          {it.description ? <span className="text-[13px] text-muted-foreground">{it.description}</span> : null}
          {it.disabled && it.reason ? <span className="text-[12px] text-failed">{it.reason}</span> : null}
        </RadioPrimitive.Item>
      ))}
    </RadioPrimitive.Root>
  );
}

/** Selector numérico 0..2 (reintentos). */
export function NumberPicker({
  values,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  values: readonly number[];
  value: number;
  onChange: (v: number) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <RadioPrimitive.Root
      aria-label={ariaLabel}
      value={String(value)}
      onValueChange={(v) => onChange(Number(v))}
      orientation="horizontal"
      disabled={disabled}
      className="flex gap-2"
    >
      {values.map((v) => (
        <RadioPrimitive.Item
          key={v}
          value={String(v)}
          className="h-10 w-12 rounded-sm border border-border bg-card font-mono text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
        >
          {v}
        </RadioPrimitive.Item>
      ))}
    </RadioPrimitive.Root>
  );
}
