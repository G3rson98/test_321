/**
 * Mis notificaciones (RF-NOT-03, Debería/bloque 3): canales y eventos que recibe el usuario, de todas o algunas
 * programaciones/umbrales (`GET/PUT /notifications/preferences`, versión optimista). Es la única actualización
 * optimista permitida (preferencia reversible, ESP §17.2); los cambios se serializan para no chocar de versión.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_EVENTS, type NotificationEvent } from '@katalyst/shared/enums';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/common/page-header';
import { Callout } from '@/components/common/misc';
import { EmptyState, ErrorState } from '@/components/common/states';
import { notificationsApi, perfApi, schedulesApi } from '@/lib/api/endpoints';
import type { NotificationPreferences } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';

export const EVENT_LABEL: Record<NotificationEvent, string> = {
  corrida_con_fallas: 'Una ejecución termina con fallas',
  corrida_interrumpida: 'Una ejecución se interrumpe',
  umbral_superado: 'Se supera un umbral de rendimiento (máx. 1 por hora)',
  sync_requiere_intervencion: 'La publicación a TestRail requiere intervención',
};
const CHANNEL_LABEL: Record<string, string> = { correo: 'Correo', slack: 'Slack', teams: 'Microsoft Teams' };

/** Preferencias propias con guardado optimista y reversión; expuesto también para Configuración › Notificaciones. */
export function useMyPreferences() {
  const qc = useQueryClient();
  const key = qk.notifications.preferences();
  const prefs = useQuery({ queryKey: key, queryFn: ({ signal }) => notificationsApi.preferences(signal) });
  const save = useMutation({
    mutationFn: (p: NotificationPreferences) =>
      notificationsApi.updatePreferences({
        channels: p.channels,
        events: p.events,
        scheduleIds: p.allSchedules ? [] : p.scheduleIds,
        allSchedules: p.allSchedules,
        thresholdIds: p.allThresholds ? [] : p.thresholdIds,
        allThresholds: p.allThresholds,
        version: p.version,
      }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<NotificationPreferences>(key);
      qc.setQueryData(key, p);
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        toast.error('Tus preferencias cambiaron en otra pestaña; se recargaron.');
        void qc.invalidateQueries({ queryKey: key });
      } else toast.error(errorMessage(e));
    },
    onSuccess: (p) => qc.setQueryData(key, p),
  });
  const toggle = <K extends 'channels' | 'events' | 'scheduleIds' | 'thresholdIds'>(k: K, v: string, on: boolean) => {
    const p = prefs.data;
    if (!p || save.isPending) return;
    const arr = p[k] as string[];
    save.mutate({ ...p, [k]: on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v) } as NotificationPreferences);
  };
  return { prefs, save, toggle };
}

export function MyPreferencesPage() {
  const { prefs, save, toggle } = useMyPreferences();
  const canThresholds = useCan('perf.thresholds.manage');
  const p = prefs.data;
  const schedules = useQuery({
    queryKey: qk.schedules.list({ limit: 100, prefs: true }),
    queryFn: ({ signal }) => schedulesApi.list({ limit: 100 }, signal),
    enabled: !!p && !p.allSchedules,
  });
  const thresholds = useQuery({
    queryKey: qk.perf.thresholds({ limit: 100, prefs: true }),
    queryFn: ({ signal }) => perfApi.thresholds({ limit: 100 }, signal),
    enabled: !!p && !p.allThresholds && canThresholds,
  });
  const busy = save.isPending;
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
                  <Checkbox checked={p.channels.includes(c)} disabled={busy} onCheckedChange={(on) => toggle('channels', c, on === true)} /> {CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
            {p.channels.length === 0 ? (
              <Callout tone="warning" className="mt-4 text-[13px]">
                Sin canales elegidos no recibirás avisos. Solo llegan por canales que un administrador haya habilitado.
              </Callout>
            ) : (
              <p className="mt-3 text-[13px] text-muted-foreground">Solo se envía por canales habilitados por un administrador.</p>
            )}
          </CardSection>
          <CardSection title="Avisarme cuando">
            <div className="space-y-2">
              {NOTIFICATION_EVENTS.map((ev) => (
                <div key={ev} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <span>{EVENT_LABEL[ev]}</span>
                  <Switch checked={p.events.includes(ev)} disabled={busy} onCheckedChange={(on) => toggle('events', ev, on)} aria-label={EVENT_LABEL[ev]} />
                </div>
              ))}
            </div>
          </CardSection>
          <CardSection title="Programaciones">
            <label className="flex items-center gap-2 text-[14px]">
              <Checkbox checked={p.allSchedules} disabled={busy} onCheckedChange={(on) => save.mutate({ ...p, allSchedules: on === true })} /> De todas las programaciones
            </label>
            {!p.allSchedules ? (
              <div className="mt-3 space-y-1.5" aria-label="Programaciones elegidas" role="group">
                {schedules.isLoading ? (
                  <Skeleton className="h-16" />
                ) : schedules.isError ? (
                  <ErrorState error={schedules.error} compact onRetry={() => void schedules.refetch()} />
                ) : (schedules.data?.items.length ?? 0) === 0 ? (
                  <EmptyState title="No hay programaciones" className="py-6" />
                ) : (
                  schedules.data!.items.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-[14px]">
                      <Checkbox checked={p.scheduleIds.includes(s.id)} disabled={busy} onCheckedChange={(on) => toggle('scheduleIds', s.id, on === true)} /> {s.name}
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </CardSection>
          <CardSection title="Umbrales de rendimiento">
            <label className="flex items-center gap-2 text-[14px]">
              <Checkbox checked={p.allThresholds} disabled={busy} onCheckedChange={(on) => save.mutate({ ...p, allThresholds: on === true })} /> De todos los umbrales
            </label>
            {!p.allThresholds ? (
              canThresholds ? (
                <div className="mt-3 space-y-1.5" role="group" aria-label="Umbrales elegidos">
                  {thresholds.isLoading ? (
                    <Skeleton className="h-16" />
                  ) : thresholds.isError ? (
                    <ErrorState error={thresholds.error} compact onRetry={() => void thresholds.refetch()} />
                  ) : (thresholds.data?.items.length ?? 0) === 0 ? (
                    <EmptyState title="No hay umbrales definidos" className="py-6" />
                  ) : (
                    thresholds.data!.items.map((t) => (
                      <label key={t.id} className="flex items-center gap-2 text-[14px]">
                        <Checkbox checked={p.thresholdIds.includes(t.id)} disabled={busy} onCheckedChange={(on) => toggle('thresholdIds', t.id, on === true)} />
                        <span className="font-mono text-[13px]">{t.label ?? t.seriesSelector.endpointKey}</span>
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-muted-foreground">
                  {p.thresholdIds.length > 0 ? `Suscrito a ${p.thresholdIds.length} umbrales. ` : ''}La lista de umbrales la gestionan desarrolladores.
                </p>
              )
            ) : null}
          </CardSection>
        </div>
      )}
    </>
  );
}
