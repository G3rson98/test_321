import type { RecordingStatus } from '@katalyst/shared/enums';
import { Badge } from '../components/ui';

const MAP: Record<RecordingStatus, { tone: Parameters<typeof Badge>[0]['tone']; label: string; dot?: boolean }> = {
  creada: { tone: 'neutral', label: 'Creada' },
  vinculada: { tone: 'running', label: 'Vinculada' },
  grabando: { tone: 'running', label: 'Grabando', dot: true },
  validando: { tone: 'flaky', label: 'Validando' },
  pr_abierto: { tone: 'passed', label: 'PR abierto' },
  rechazada: { tone: 'failed', label: 'Rechazada' },
  cancelada: { tone: 'skipped', label: 'Cancelada' },
  vencida: { tone: 'skipped', label: 'Vencida' },
};

export function RecordingStatusBadge({ status }: { status: RecordingStatus }) {
  const m = MAP[status];
  return (
    <Badge tone={m.tone} dot={m.dot ?? false}>
      {m.label}
    </Badge>
  );
}
