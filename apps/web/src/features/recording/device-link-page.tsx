/**
 * Aprobación de dispositivo (ESP §13.6) en `/dispositivos/vincular?codigo=XXXX-XXXX` (verificationUriComplete, mismo
 * origen que el panel): el usuario confirma desde su sesión el `user_code` que muestra el asistente (vence en 5 min).
 * `GET /devices/authorizations/:userCode` + `POST /devices/approve|deny {userCode}`. Nunca se muestra ni se transmite
 * el `device_code` ni una credencial duradera.
 */
import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/common/page-header';
import { Callout } from '@/components/common/misc';
import { devicesApi } from '@/lib/api/endpoints';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatTime } from '@/lib/format';

const route = getRouteApi('/_app/dispositivos/vincular');
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const STATUS_TEXT: Record<string, string> = {
  vencida: 'El código venció (dura 5 minutos). Pide uno nuevo en el asistente.',
  aprobada: 'Este código ya fue aprobado. El asistente queda vinculado en cuanto lo confirme.',
  denegada: 'Este código fue rechazado. Inicia una nueva vinculación en el asistente.',
  consumida: 'Este código ya se usó. Si no reconoces el asistente, revócalo en Mis dispositivos.',
};
function decisionErrorText(e: unknown): string {
  if (!isApiError(e)) return errorMessage(e);
  if (e.code === 'DEVICE_CODE_EXPIRED') return STATUS_TEXT.vencida!;
  if (e.code === 'CONFLICT') return 'La solicitud ya fue resuelta (aprobada o rechazada) por otra sesión.';
  if (e.status === 404) return 'El código no existe. Revisa que coincida con el del asistente.';
  return errorMessage(e);
}

export function DeviceLinkPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const routeNavigate = route.useNavigate();
  const qc = useQueryClient();
  const [input, setInput] = useState(search.codigo ?? '');
  const [code, setCode] = useState<string | null>(search.codigo ?? null);
  const [done, setDone] = useState<'aprobada' | 'denegada' | null>(null);
  const auth = useQuery({ queryKey: qk.devices.authorization(code ?? ''), queryFn: ({ signal }) => devicesApi.authorization(code!, signal), enabled: !!code, retry: false });
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const onDecisionError = (e: unknown) => {
    // 400 vencido, 409 ya resuelta, 404 inexistente: se muestra en la página y se relee el estado.
    setDecisionError(decisionErrorText(e));
    void auth.refetch();
  };
  const approve = useMutation({
    mutationFn: () => devicesApi.approve(code!),
    onSuccess: () => {
      setDone('aprobada');
      toast.success('Asistente vinculado.');
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: onDecisionError,
  });
  const deny = useMutation({
    mutationFn: () => devicesApi.deny(code!),
    onSuccess: () => setDone('denegada'),
    onError: onDecisionError,
  });
  const normalized = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{1,4}).*$/, '$1-$2');
  const a = auth.data;
  return (
    <>
      <PageHeader title="Vincular asistente" subtitle="Confirma el código que muestra el asistente en tu equipo" />
      <CardSection title="Código del dispositivo" className="max-w-xl">
        {done ? (
          <div className="space-y-4">
            <Callout tone={done === 'aprobada' ? 'info' : 'warning'} title={done === 'aprobada' ? 'Dispositivo vinculado' : 'Solicitud rechazada'}>
              {done === 'aprobada' ? 'Ya puedes volver al caso y pulsar “Grabar”.' : 'El asistente no recibirá credenciales.'}
            </Callout>
            <Button variant="outline" onClick={() => void navigate({ to: '/asistente' })}>
              Ver mis dispositivos
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!CODE.test(normalized)) return;
                setDecisionError(null);
                setCode(normalized);
                void routeNavigate({ search: { codigo: normalized }, replace: true });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="user-code">Código</Label>
                <Input id="user-code" value={normalized} onChange={(e) => setInput(e.target.value)} placeholder="ABCD-EFGH" className="w-44 font-mono text-[16px] tracking-widest" autoComplete="off" />
              </div>
              <Button type="submit" variant="outline" disabled={!CODE.test(normalized)}>
                Buscar
              </Button>
            </form>
            {auth.isLoading ? <p className="text-[14px] text-muted-foreground">Buscando solicitud…</p> : null}
            {auth.isError ? <Callout tone="danger">{isApiError(auth.error) && auth.error.status === 404 ? 'El código no existe o ya venció. Pide uno nuevo en el asistente.' : errorMessage(auth.error)}</Callout> : null}
            {decisionError ? <Callout tone="danger">{decisionError}</Callout> : null}
            {a ? (
              a.status !== 'pendiente' ? (
                <Callout tone="warning">{STATUS_TEXT[a.status] ?? 'Este código ya no admite cambios.'}</Callout>
              ) : (
                <div className="space-y-4 rounded-lg border border-border p-4">
                  <div className="flex items-center gap-3">
                    <MonitorSmartphone className="size-5 text-muted-foreground" aria-hidden />
                    <div>
                      <div className="font-medium">
                        {a.clientName} · {a.platform}
                      </div>
                      <div className="font-mono text-[12px] text-muted-foreground">
                        v{a.clientVersion} · vence {formatTime(a.expiresAt)}
                      </div>
                    </div>
                  </div>
                  <p className="text-[14px] text-muted-foreground">Aprueba solo si iniciaste esta vinculación en tu propio equipo.</p>
                  <div className="flex gap-2">
                    <Button onClick={() => approve.mutate()} disabled={approve.isPending || deny.isPending}>
                      {approve.isPending ? <Loader2 className="animate-spin" /> : null} Aprobar
                    </Button>
                    <Button variant="ghost" onClick={() => deny.mutate()} disabled={approve.isPending || deny.isPending}>
                      Rechazar
                    </Button>
                  </div>
                </div>
              )
            ) : null}
          </div>
        )}
      </CardSection>
    </>
  );
}
