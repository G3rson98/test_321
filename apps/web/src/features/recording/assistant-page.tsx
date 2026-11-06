/**
 * Asistente local de grabación (RF-GRB-01, ESP §9 bloque 2C, §13.6): disponibilidad, instalación (Windows 11),
 * dispositivos vinculados y revocación. El panel no abre Chromium de forma remota.
 */
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatusBadge } from '@/components/common/status-badge';
import { EmptyState, ErrorState } from '@/components/common/states';
import { devicesApi, itemsOf } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatDateTimeShort } from '@/lib/format';

export function AssistantPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: qk.devices.status(), queryFn: ({ signal }) => devicesApi.status(signal) });
  const devices = useQuery({ queryKey: qk.devices.list(), queryFn: ({ signal }) => devicesApi.list(signal) });
  const revoke = useMutation({
    mutationFn: devicesApi.revoke,
    onSuccess: () => {
      toast.success('Dispositivo revocado.');
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = status.data;
  return (
    <>
      <PageHeader title="Asistente de grabación" subtitle="Graba flujos en tu equipo sin terminal; las credenciales nunca salen de tu equipo" />
      <div className="grid gap-6 xl:grid-cols-2">
        <CardSection title="Estado">
          {status.isLoading ? (
            <Skeleton className="h-20" />
          ) : status.isError ? (
            <ErrorState error={status.error} compact onRetry={() => void status.refetch()} />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <StatusBadge status={s?.linked ? (s.online ? { label: 'Conectado', tone: 'passed' } : { label: 'Desconectado', tone: 'skipped' }) : { label: 'No vinculado', tone: 'flaky' }} />
                {s?.clientVersion ? <span className="font-mono text-[12.5px] text-muted-foreground">v{s.clientVersion}</span> : null}
                {s?.lastSeenAt ? <span className="text-[13px] text-muted-foreground">visto {formatDateTimeShort(s.lastSeenAt)}</span> : null}
              </div>
              <ol className="list-decimal space-y-1.5 pl-5 text-[14px]">
                <li>Instala el asistente una vez (Windows 11).</li>
                <li>Ábrelo y elige “Vincular con Katalyst”; mostrará un código de 8 caracteres.</li>
                <li>Confirma ese código en la página de vinculación.</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                {s?.installUrl ? (
                  <Button asChild variant="outline">
                    <a href={s.installUrl} rel="noreferrer noopener">
                      <Download /> Descargar instalador
                    </a>
                  </Button>
                ) : null}
                <Button asChild>
                  <Link to="/asistente/vincular">
                    <Link2 /> Vincular dispositivo
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </CardSection>
        <CardSection title="Dispositivos vinculados" padded={false}>
          {devices.isLoading ? (
            <Skeleton className="m-5 h-16" />
          ) : devices.isError ? (
            <ErrorState error={devices.error} compact onRetry={() => void devices.refetch()} />
          ) : itemsOf(devices.data).length === 0 ? (
            <EmptyState title="No tienes dispositivos vinculados" />
          ) : (
            <ul>
              {itemsOf(devices.data).map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-0">
                  <div>
                    <div>{d.name}</div>
                    <div className="font-mono text-[12px] text-muted-foreground">
                      v{d.clientVersion} · vence {formatDateTimeShort(d.expiresAt)}
                    </div>
                  </div>
                  {d.revokedAt ? (
                    <StatusBadge status={{ label: 'Revocado', tone: 'skipped' }} />
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(d.id)} disabled={revoke.isPending}>
                      Revocar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardSection>
      </div>
    </>
  );
}
