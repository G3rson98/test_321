import { cn } from '@/lib/utils';

export function TagChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-sm border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground', className)}>
      {tag}
    </span>
  );
}

export function TagList({ tags, max = 3 }: { tags: readonly string[] | undefined; max?: number }) {
  if (!tags || tags.length === 0) return <span className="text-muted-foreground">–</span>;
  const shown = tags.slice(0, max);
  return (
    <span className="flex flex-nowrap gap-1 whitespace-nowrap">
      {shown.map((t) => (
        <TagChip key={t} tag={t} />
      ))}
      {tags.length > max ? <span className="text-[12px] text-muted-foreground">+{tags.length - max}</span> : null}
    </span>
  );
}

/** Chip clicable de filtro (catálogo, selector de etiquetas). */
export function FilterChip({ tag, selected, onToggle }: { tag: string; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'inline-flex h-[26px] items-center rounded-sm border px-2 font-mono text-[12.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'border-primary bg-primary-soft text-primary-soft-foreground' : 'border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      {tag}
    </button>
  );
}
