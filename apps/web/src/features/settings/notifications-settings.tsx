/**
 * 25 · Configuración · Notificaciones (RF-NOT-01/02/03). Canales con destino por referencia de secreto (webhook o
 * credencial SMTP + servidor), "Enviar prueba" y estado de la última prueba; cambios confirmados por el servidor (sin
 * optimismo). La API no tiene reglas globales: "Avisar cuando" son las preferencias del propio administrador
 * (`/notifications/preferences`, RF-NOT-03); cada usuario elige las suyas en Mis notificaciones y cada programación
 * define sus avisos (`notify`).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
import { itemsOf, notificationsApi } from '@/lib/api/endpoints';
import { EVENT_LABEL, useMyPreferences } from './my-preferences-page';
import type { NotificationChannel } from '@/lib/api/types';
import { errorMessage, fieldErrorsFrom } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatDateTimeShort } from '@/lib/format';

const CHANNEL_NAME: Record<string, string> = { slack: 'Slack', correo: 'Correo', teams: 'Microsoft Teams' };
const RULES = [
  { key: 'corrida_con_fallas', label: 'Ejecución termina con fallas' },
  { key: 'corrida_interrumpida', label: 'Ejecución interrumpida' },
  { key: 'umbral_superado', label: 'Se supera un umbral de rendimiento (máx. 1 por hora)' },
  { key: 'sync_requiere_intervencion', label: EVENT_LABEL.sync_requiere_intervencion },
] as const;
const configured = (c: NotificationChannel) => (c.kind === 'correo' ? c.smtp !== null : c.secretRef !== null);

function channelLabel(c: NotificationChannel) {
  const dest = c.kind === 'correo' ? c.recipients[0] : c.recipients[0];
  return `${CHANNEL_NAME[c.kind]}${dest ? ` · ${dest}` : ''}`;
}

export function NotificationsSettings() {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: qk.notifications.channels(), queryFn: ({ signal }) => notificationsApi.channels(signal) });
  const { prefs, save: savePrefs, toggle: togglePref } = useMyPreferences();
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
                  {configured(c) ? (c.lastTestAt ? `Última prueba ${formatDateTimeShort(c.lastTestAt)} · ${c.lastTestOk ? 'correcta' : 'falló'}` : 'Sin pruebas') : 'Sin destino configurado'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={`Configurar ${CHANNEL_NAME[c.kind]}`} onClick={() => setConfiguring(c)}>
                  <Settings2 />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Enviar prueba por ${CHANNEL_NAME[c.kind]}`} title={configured(c) ? undefined : 'Configura el destino antes de probar'} disabled={test.isPending || !configured(c)} onClick={() => test.mutate(c.kind)}>
                  <Send />
                </Button>
                <Switch checked={c.enabled} disabled={toggle.isPending || (!c.enabled && !configured(c))} onCheckedChange={() => toggle.mutate(c)} aria-label={`${c.enabled ? 'Deshabilitar' : 'Habilitar'} ${CHANNEL_NAME[c.kind]}`} />
              </div>
            </div>
          ))}
          <div className="label-mono pt-5 pb-1">Avisar cuando</div>
          <p className="pb-1 text-[12.5px] text-muted-foreground">
            Tus avisos como administrador. Cada usuario elige los suyos en{' '}
            <Link to="/preferencias" className="font-medium text-primary">
              Mis notificaciones
            </Link>{' '}
            y cada programación define si avisa al fallar.
          </p>
          {prefs.isLoading ? (
            <Skeleton className="h-36" />
          ) : prefs.isError || !prefs.data ? (
            <ErrorState error={prefs.error} compact onRetry={() => void prefs.refetch()} />
          ) : (
            RULES.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <span className="text-[15px]">{r.label}</span>
                <Switch checked={prefs.data!.events.includes(r.key)} disabled={savePrefs.isPending} onCheckedChange={(v) => togglePref('events', r.key, v)} aria-label={r.label} />
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
  const isMail = channel.kind === 'correo';
  const [secretRef, setSecretRef] = useState(channel.secretRef ?? '');
  const [recipients, setRecipients] = useState(channel.recipients.join(', '));
  const [host, setHost] = useState(channel.smtp?.host ?? '');
  const [port, setPort] = useState(String(channel.smtp?.port ?? 587));
  const [from, setFrom] = useState(channel.smtp?.from ?? '');
  const [secure, setSecure] = useState(channel.smtp?.secure ?? true);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const refErr = secretRef && !SECRET_REF_REGEX.test(secretRef.trim()) ? 'Usa ssm:/…, env:NOMBRE o file:/…' : undefined;
  const portErr = isMail && host && !(Number(port) >= 1 && Number(port) <= 65535) ? 'Puerto 1–65535' : undefined;
  const save = useMutation({
    mutationFn: () =>
      notificationsApi.updateChannel(channel.kind, {
        enabled: channel.enabled,
        secretRef: secretRef.trim() || null,
        ...(isMail
          ? {
              recipients: recipients.split(',').map((x) => x.trim()).filter(Boolean),
              smtp: host.trim() ? { host: host.trim(), port: Number(port), from: from.trim(), secure } : null,
            }
          : {}),
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
          <Label htmlFor="ch-ref">{isMail ? 'Credencial SMTP · referencia' : 'Webhook · referencia del secreto'}</Label>
          <Input id="ch-ref" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} className="font-mono text-[13px]" placeholder={isMail ? 'ssm:/katalyst/notify/smtp' : 'ssm:/katalyst/notify/slack-webhook'} autoComplete="off" />
          <FieldError message={errs.secretRef ?? refErr} />
        </div>
        {isMail ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_96px]">
              <div className="space-y-2">
                <Label htmlFor="ch-host">Servidor SMTP</Label>
                <Input id="ch-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.empresa.com" autoComplete="off" />
                <FieldError message={errs['smtp.host']} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ch-port">Puerto</Label>
                <Input id="ch-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
                <FieldError message={errs['smtp.port'] ?? portErr} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ch-from">Remitente</Label>
              <Input id="ch-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="katalyst@empresa.com" />
              <FieldError message={errs['smtp.from']} />
            </div>
            <label className="flex items-center gap-2 text-[14px]">
              <Switch checked={secure} onCheckedChange={setSecure} aria-label="Conexión TLS" /> Conexión TLS
            </label>
            <div className="space-y-2">
              <Label htmlFor="ch-rcpt">Destinatarios</Label>
              <Input id="ch-rcpt" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="qa@empresa.com, dev@empresa.com" />
              <FieldError message={errs.recipients ?? Object.entries(errs).find(([k]) => k.startsWith('recipients.'))?.[1]} />
            </div>
          </>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!!refErr || !!portErr || (isMail && !!host.trim() && !from.trim()) || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
