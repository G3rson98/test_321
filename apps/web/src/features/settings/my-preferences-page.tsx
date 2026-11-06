/**
 * Mis notificaciones (RF-NOT-03, Debería/bloque 3): canales y eventos que recibe el usuario, todas o algunas
 * programaciones/umbrales. Única actualización optimista permitida (preferencia reversible, ESP §17.2).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_EVENTS } from '@katalyst/shared/enums';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { notificationsApi } from '@/lib/api/endpoints';
import type { NotificationPreferences } from '@/lib/api/types';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

const EVENT_LABEL: Record<string, string> = {
  corrida_con_fallas: 'Una ejecución termina con fallas',
  corrida_interrumpida: 'Una ejecución se interrumpe',
  umbral_superado: 'Se supera un umbral de rendimiento',
  sync_requiere_intervencion: 'La publicación a TestRail requiere intervención',
};
const CHANNEL_LABEL: Record<string, string> = { correo: 'Correo', slack: 'Slack', teams: 'Microsoft Teams' };

export function MyPreferencesPage() {
  const qc = useQueryClient();
  const key = qk.notifications.preferences();
  const prefs = useQuery({ queryKey: key, queryFn: ({ signal }) => notificationsApi.preferences(signal) });
  const save = useMutation({
    mutationFn: (p: NotificationPreferences) =>
      notificationsApi.updatePreferences({ channels: p.channels, events: p.events, scheduleIds: p.scheduleIds, allSchedules: p.allSchedules, thresholdIds: p.thresholdIds, allThresholds: p.allThresholds, version: p.version }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<NotificationPreferences>(key);
      qc.setQueryData(key, p);
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSuccess: (p) => qc.setQueryData(key, p),
  });
  const p = prefs.data;
  const toggle = <K extends 'channels' | 'events'>(k: K, v: string, on: boolean) => {
    if (!p) return;
    const arr = p[k] as string[];
    save.mutate({ ...p, [k]: on ? [...arr, v] : arr.filter((x) => x !== v) } as NotificationPreferences);
  };
  return (
    <>
      <PageHeader title="Mis notificaciones" subtitle="Elige qué avisos recibes y por qué canal" />
      {prefs.isLoading ? (
        <Skeleton className="h-64" />
      ) : prefs.isError || !p ? (
        <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />
      ) : (
        <div className="grid max-w-3xl gap-6">
          <CardSection title="Canales">
            <div className="flex flex-wrap gap-6">
              {NOTIFICATION_CHANNEL_KINDS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-[15px]">
                  <Checkbox checked={p.channels.includes(c)} onCheckedChange={(on) => toggle('channels', c, on === true)} /> {CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
          </CardSection>
          <CardSection title="Avisarme cuando">
            <div className="space-y-2">
              {NOTIFICATION_EVENTS.map((ev) => (
                <div key={ev} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <span>{EVENT_LABEL[ev]}</span>
                  <Switch checked={p.events.includes(ev)} onCheckedChange={(on) => toggle('events', ev, on)} aria-label={EVENT_LABEL[ev]} />
                </div>
              ))}
              <label className="flex items-center gap-2 pt-2 text-[14px]">
                <Checkbox checked={p.allSchedules} onCheckedChange={(on) => save.mutate({ ...p, allSchedules: on === true })} /> De todas las programaciones
              </label>
              <label className="flex items-center gap-2 text-[14px]">
                <Checkbox checked={p.allThresholds} onCheckedChange={(on) => save.mutate({ ...p, allThresholds: on === true })} /> De todos los umbrales
              </label>
            </div>
          </CardSection>
        </div>
      )}
    </>
  );
}
