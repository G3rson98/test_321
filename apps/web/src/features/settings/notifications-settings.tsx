/**
 * 25 · Configuración · Notificaciones (RF-NOT-01/02). Canales con destino por referencia de secreto (webhook/SMTP),
 * "Enviar prueba" y estado de la última prueba; cambios confirmados por el servidor (sin optimismo).
 * Reglas "Avisar cuando": PENDIENTE [WEB→API-C] `GET/PUT /notifications/rules`.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Send, Settings2 } from 'lucide-react';
import { SECRET_REF_REGEX } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldError } from '@/components/common/misc';
import { ErrorState } from '@/components/common/states';
import { api } from '@/lib/api/client';
import { itemsOf, notificationsApi } from '@/lib/api/endpoints';
import type { NotificationChannel } from '@/lib/api/types';
import { errorMessage, fieldErrorsFrom } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatDateTimeShort } from '@/lib/format';

const CHANNEL_NAME: Record<string, string> = { slack: 'Slack', correo: 'Correo', teams: 'Microsoft Teams' };
type Rules = { corrida_con_fallas: boolean; corrida_interrumpida: boolean; umbral_superado: boolean };
const RULES: { key: keyof Rules; label: string }[] = [
  { key: 'corrida_con_fallas', label: 'Ejecución termina con fallas' },
  { key: 'corrida_interrumpida', label: 'Ejecución interrumpida' },
  { key: 'umbral_superado', label: 'Se supera un umbral de rendimiento (máx. 1 por hora)' },
];

function channelLabel(c: NotificationChannel) {
  const dest = c.kind === 'correo' ? c.recipients[0] : c.recipients[0];
  return `${CHANNEL_NAME[c.kind]}${dest ? ` · ${dest}` : ''}`;
}

export function NotificationsSettings() {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: qk.notifications.channels(), queryFn: ({ signal }) => notificationsApi.channels(signal) });
  const rules = useQuery({ queryKey: ['config', 'notification-rules'], queryFn: ({ signal }) => api.get<Rules>('/notifications/rules', undefined, signal), retry: false });
  const [configuring, setConfiguring] = useState<NotificationChannel | null>(null);
  const toggle = useMutation({
    mutationFn: (c: NotificationChannel) => notificationsApi.updateChannel(c.kind, { enabled: !c.enabled, version: c.version }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications.channels().slice(0, 2) }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (kind: string) => notificationsApi.testChannel(kind),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      void qc.invalidateQueries({ queryKey: qk.notifications.channels().slice(0, 2) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setRule = useMutation({
    mutationFn: (patch: Partial<Rules>) => api.put<Rules>('/notifications/rules', { ...rules.data, ...patch }),
    onSuccess: (r) => qc.setQueryData(['config', 'notification-rules'], r),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <CardSection title="Canales">
      {channels.isLoading ? (
        <Skeleton className="h-40 max-w-[536px]" />
      ) : channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : (
        <div className="max-w-[536px] space-y-2">
          {itemsOf(channels.data).map((c) => (
            <div key={c.kind} className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
              <div className="min-w-0">
                <div className="text-[15px]">{channelLabel(c)}</div>
                <div className="text-[12px] text-muted-foreground">
                  {c.secretRef || c.kind === 'correo' ? (c.lastTestAt ? `Última prueba ${formatDateTimeShort(c.lastTestAt)} · ${c.lastTestOk ? 'correcta' : 'falló'}` : 'Sin pruebas') : 'Sin destino configurado'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={`Configurar ${CHANNEL_NAME[c.kind]}`} onClick={() => setConfiguring(c)}>
                  <Settings2 />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Enviar prueba por ${CHANNEL_NAME[c.kind]}`} disabled={test.isPending} onClick={() => test.mutate(c.kind)}>
                  <Send />
                </Button>
                <Switch checked={c.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(c)} aria-label={`${c.enabled ? 'Deshabilitar' : 'Habilitar'} ${CHANNEL_NAME[c.kind]}`} />
              </div>
            </div>
          ))}
          <div className="label-mono pt-5 pb-1">Avisar cuando</div>
          {rules.isError ? (
            <p className="text-[13px] text-muted-foreground">Las reglas globales aún no están disponibles en la API; cada programación define sus avisos.</p>
          ) : (
            RULES.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <span className="text-[15px]">{r.label}</span>
                <Switch checked={!!rules.data?.[r.key]} disabled={!rules.data || setRule.isPending} onCheckedChange={(v) => setRule.mutate({ [r.key]: v })} aria-label={r.label} />
              </div>
            ))
          )}
        </div>
      )}
      {configuring ? (
        <ChannelDialog
          channel={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={() => {
            setConfiguring(null);
            void qc.invalidateQueries({ queryKey: qk.notifications.channels().slice(0, 2) });
          }}
        />
      ) : null}
    </CardSection>
  );
}

function ChannelDialog({ channel, onClose, onSaved }: { channel: NotificationChannel; onClose: () => void; onSaved: () => void }) {
  const [secretRef, setSecretRef] = useState(channel.secretRef ?? '');
  const [recipients, setRecipients] = useState(channel.recipients.join(', '));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const refErr = secretRef && !SECRET_REF_REGEX.test(secretRef.trim()) ? 'Usa ssm:/…, env:NOMBRE o file:/…' : undefined;
  const save = useMutation({
    mutationFn: () =>
      notificationsApi.updateChannel(channel.kind, {
        enabled: channel.enabled,
        secretRef: secretRef.trim() || null,
        ...(channel.kind === 'correo' ? { recipients: recipients.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
        version: channel.version,
      }),
    onSuccess: () => {
      toast.success('Canal actualizado.');
      onSaved();
    },
    onError: (e) => {
      const f = fieldErrorsFrom(e);
      setErrs(f);
      if (!Object.keys(f).length) toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configurar {CHANNEL_NAME[channel.kind]}</DialogTitle>
          <DialogDescription>El webhook o la credencial SMTP se guardan en el gestor de secretos; aquí solo se indica la referencia.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ch-ref">{channel.kind === 'correo' ? 'Credencial SMTP · referencia' : 'Webhook · referencia del secreto'}</Label>
          <Input id="ch-ref" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} className="font-mono text-[13px]" placeholder="ssm:/katalyst/notify/slack-webhook" autoComplete="off" />
          <FieldError message={errs.secretRef ?? refErr} />
        </div>
        {channel.kind === 'correo' ? (
          <div className="space-y-2">
            <Label htmlFor="ch-rcpt">Destinatarios</Label>
            <Input id="ch-rcpt" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="qa@empresa.com, dev@empresa.com" />
            <FieldError message={errs.recipients} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!!refErr || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
