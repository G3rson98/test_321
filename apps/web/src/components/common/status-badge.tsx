import { cn } from '@/lib/utils';
import type { StatusLabel, Tone } from '@/lib/labels';

const TONE: Record<Tone, string> = {
  passed: 'bg-passed-bg text-passed',
  failed: 'bg-failed-bg text-failed',
  flaky: 'bg-flaky-bg text-flaky',
  running: 'bg-running-bg text-running',
  blocked: 'bg-blocked-bg text-blocked',
  skipped: 'bg-skipped-bg text-skipped',
  neutral: 'bg-neutral-bg text-neutral',
  infra: 'bg-failed-bg text-infra outline outline-1 outline-dashed outline-infra/60',
  outline: 'bg-card text-muted-foreground border border-border',
};

export function toneText(tone: Tone): string {
  return TONE[tone].split(' ').find((c) => c.startsWith('text-')) ?? '';
}

/** Badge de estado (pill, mono 10.5 px mayúsculas). Punto pulsante en estados activos. */
export function StatusBadge({ status, className }: { status: StatusLabel; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[19px] items-center gap-1.5 rounded-full px-2.5 font-mono text-[10.5px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase',
        TONE[status.tone],
        className,
      )}
    >
      {status.live ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {status.label}
    </span>
  );
}
