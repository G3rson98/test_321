/**
 * 06 · Grabación con el asistente local (RF-GRB-01/02/06, ESP §13.6). El panel nunca recibe credenciales ni
 * `storageState`; crea la sesión, abre el asistente con `katalyst://grabar?session=<id>` y sigue su estado
 * (`GET /recordings/{id}` + SSE). Detener, verificar y enviar el PR ocurren en el asistente (la API no expone
 * órdenes remotas); el panel solo puede descartar (`POST /recordings/{id}/cancel`).
 * Si el asistente no está instalado/vinculado muestra instrucciones (Windows 11) sin prometer abrir Chromium.
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleAlert, Download, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { FilterChip } from '@/components/common/tag-chip';
import { RadioCardGroup } from '@/components/common/controls';
import { Callout } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { StatusBadge } from '@/components/common/status-badge';
import { devicesApi, envApi, itemsOf, recordingsApi } from '@/lib/api/endpoints';
import type { CaseDetail, RecordingSession } from '@/lib/api/types';
import { useCaseAutomation } from '@/features/common/derived';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { RECORDING_STATUS_LABEL } from '@/lib/labels';
import { formatTime } from '@/lib/format';
import { usePollingFallback } from '@/lib/sse/polling';
import { cn } from '@/lib/utils';

export function RecordButton({ highlighted, disabled, onClick }: { highlighted: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant={highlighted ? 'soft' : 'outline'} onClick={onClick} disabled={disabled}>
      <span aria-hidden className="size-3.5 rounded-full bg-failed" /> Grabar
    </Button>
  );
}

/** Paso previo: etiquetas elegidas (RF-GRB-02) y ambiente (solo staging/grabación permitida, RF-GRB-05). */
export function StartRecordingDialog({ kase, onClose, onCreated }: { kase: CaseDetail; onClose: () => void; onCreated: (id: string) => void }) {
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const allowed = itemsOf(envs.data).filter((e) => e.recordingAllowed && !e.isProduction && e.enabled);
  const [envId, setEnvId] = useState<string | null>(null);
  const auto = useCaseAutomation([kase]).get(kase.id);
  const [picked, setPicked] = useState<string[] | null>(null);
  const tags = picked ?? auto?.tags ?? [];
  const setTags = (f: (p: string[]) => string[]) => setPicked(f(tags));
  const effectiveEnv = envId ?? allowed[0]?.id ?? null;
  const create = useMutation({
    mutationFn: () => recordingsApi.create({ caseId: kase.id, environmentId: effectiveEnv!, tags }),
    onSuccess: (r) => {
      // El asistente se abre por protocolo con SOLO el ID de sesión (ESP §13.6); sin asistente se muestran instrucciones.
      if (r.assistant.linked) openAssistant(r.assistantLink);
      onCreated(r.recording.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Grabar {kase.ref}</DialogTitle>
          <DialogDescription>El asistente local abrirá Chromium en tu equipo. Las credenciales nunca salen de tu equipo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Ambiente</Label>
          {envs.isLoading ? (
            <p className="text-[13px] text-muted-foreground">Cargando ambientes…</p>
          ) : allowed.length === 0 ? (
            <Callout tone="warning">No hay ambientes habilitados para grabar. La grabación en producción no está permitida.</Callout>
          ) : (
            <RadioCardGroup
              ariaLabel="Ambiente de grabación"
              value={effectiveEnv}
              onValueChange={setEnvId}
              className="sm:grid-cols-2"
              items={allowed.map((e) => ({ value: e.id, title: e.name, description: 'appUrl' in e ? <span className="font-mono">{e.appUrl}</span> : undefined }))}
            />
          )}
        </div>
        <div className="space-y-2">
          <Label>Etiquetas del test</Label>
          <div className="flex flex-wrap gap-1.5">
            {Array.from(new Set([...(auto?.tags ?? []), '@humo', '@rendimiento'])).map((t) => (
              <FilterChip key={t} tag={t} selected={tags.includes(t)} onToggle={() => setTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))} />
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} disabled={!effectiveEnv || create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : null} Iniciar grabación
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RecordingDialog({ recordingId, caseRef, onClose }: { recordingId: string; caseRef: string; onClose: () => void }) {
  const qc = useQueryClient();
  const poll = usePollingFallback('detail');
  const rec = useQuery({
    queryKey: qk.recordings.detail(recordingId),
    queryFn: ({ signal }) => recordingsApi.get(recordingId, signal),
    refetchInterval: (q) => (q.state.data && ['pr_abierto', 'rechazada', 'cancelada', 'vencida'].includes(q.state.data.status) ? false : poll),
  });
  const device = useQuery({ queryKey: qk.devices.status(), queryFn: ({ signal }) => devicesApi.status(signal), refetchInterval: poll === false ? false : 15_000 });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const setData = (r: RecordingSession) => qc.setQueryData(qk.recordings.detail(recordingId), r);

  const discard = useMutation({
    mutationFn: () => recordingsApi.cancel(recordingId),
    onSuccess: (r) => {
      setData(r);
      setConfirmDiscard(false);
      toast.success('Grabación descartada.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const r = rec.data;
  const terminal = r ? ['pr_abierto', 'rechazada', 'cancelada', 'vencida'].includes(r.status) : false;
  const hasUnsent = !!r && !terminal && r.steps.length > 0;
  const pendingVerifications = useMemo(() => r?.steps.filter((s) => s.kind === 'no_soportada').length ?? 0, [r]);
  const linked = device.data?.linked ?? false;
  const online = device.data?.online ?? false;
  const link = assistantLinkFor(recordingId);

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          if (hasUnsent) setConfirmClose(true);
          else onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span aria-hidden className={cn('size-2.5 rounded-full', r?.status === 'grabando' ? 'animate-pulse bg-failed' : 'bg-failed')} />
            Grabando {caseRef}
          </DialogTitle>
          {r ? (
            <div className="flex items-center gap-2">
              <StatusBadge status={RECORDING_STATUS_LABEL[r.status]} />
              <span className="font-mono text-[11px] text-muted-foreground">vence {formatTime(r.expiresAt)}</span>
            </div>
          ) : null}
        </DialogHeader>

        {rec.isLoading ? (
          <p className="text-[14px] text-muted-foreground">Cargando la sesión de grabación…</p>
        ) : rec.isError ? (
          <Callout tone="danger">{errorMessage(rec.error)}</Callout>
        ) : !linked ? (
          <AssistantMissing installUrl={device.data?.installUrl ?? null} recordingId={recordingId} />
        ) : (
          <>
            <p className="text-[15px] text-muted-foreground">
              {r?.status === 'creada' || r?.status === 'vinculada'
                ? online
                  ? 'Esperando que el asistente abra Chromium…'
                  : 'El asistente está vinculado pero desconectado. Ábrelo en tu equipo para continuar.'
                : 'El asistente local abrió Chromium en staging. Interactúa con la app; las credenciales nunca salen de tu equipo.'}
            </p>
            <div className="max-h-56 overflow-y-auto rounded-md bg-muted px-4 py-3 font-mono text-[13px] leading-6" aria-live="polite" aria-label="Pasos capturados">
              {r && r.steps.length > 0 ? (
                r.steps.map((s, i) => (
                  <div key={i} className={cn(s.kind === 'no_soportada' && 'text-flaky')}>
                    {s.kind === 'no_soportada' ? '⚠' : '✓'} {s.description}
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground">Aún no hay pasos capturados.</div>
              )}
            </div>
            {pendingVerifications > 0 ? (
              <p className="text-[13px] text-flaky">
                {pendingVerifications} {pendingVerifications === 1 ? 'verificación pendiente' : 'verificaciones pendientes'}: el PR no supera la aprobación hasta completarlas.
              </p>
            ) : null}
            {r?.status === 'pr_abierto' && r.prUrl ? (
              <Callout tone="info" title="Pull request abierto">
                Un desarrollador debe revisarlo y fusionarlo para que el test aparezca en el catálogo.{' '}
                <a href={r.prUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-primary">
                  Ver PR <ExternalLink className="size-3.5" />
                </a>
              </Callout>
            ) : null}
            {r?.status === 'rechazada' ? (
              <Callout tone="danger" title="La grabación no superó las validaciones">
                <ul className="list-disc pl-4">
                  {r.rejectionReasons.map((x, i) => (
                    <li key={i}>
                      {x.message}
                      {x.line ? ` (línea ${x.line})` : ''}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {r?.status === 'vencida' ? <Callout tone="warning">La sesión venció (2 h). Inicia una nueva grabación.</Callout> : null}
          </>
        )}

        <DialogFooter className="pt-1">
          {!terminal ? (
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={discard.isPending}>
              <Trash2 /> Descartar
            </Button>
          ) : null}
          {linked && !terminal ? (
            <>
              <p className="mr-auto self-center text-[13px] text-muted-foreground">Detener, agregar verificaciones y enviar el PR se hacen en el asistente.</p>
              <Button asChild disabled={r?.status === 'validando'}>
                <a href={link} onClick={(e) => { e.preventDefault(); openAssistant(link); }}>
                  {r?.status === 'validando' ? <Loader2 className="animate-spin" /> : <ExternalLink />} Abrir asistente
                </a>
              </Button>
            </>
          ) : terminal ? (
            <Button variant="outline" onClick={onClose}>
              Cerrar
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Descartar grabación"
        description="Se cancelará la sesión y el asistente eliminará el estado temporal de tu equipo. No se crea ningún PR."
        confirmLabel="Descartar"
        tone="danger"
        pending={discard.isPending}
        onConfirm={() => discard.mutate()}
      />
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Hay pasos sin enviar"
        description="La sesión sigue activa en el asistente. Puedes volver a abrirla desde este caso mientras no venza."
        confirmLabel="Cerrar de todos modos"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </Dialog>
  );
}

/** Enlace del asistente: `katalyst://grabar?session=<id>` (RecordingAssistantLinkSchema, solo el ID). */
export function assistantLinkFor(recordingId: string): string {
  return `katalyst://grabar?session=${encodeURIComponent(recordingId)}`;
}
function openAssistant(link: string): void {
  window.location.assign(link);
}

function AssistantMissing({ installUrl, recordingId }: { installUrl: string | null; recordingId: string }) {
  return (
    <div className="space-y-3 text-[14px]">
      <Callout tone="warning" icon={<CircleAlert className="size-4" />} title="El asistente local no está instalado o vinculado">
        Para grabar necesitas el asistente de Katalyst en tu equipo (Windows 11). El panel no puede abrir Chromium de forma remota.
      </Callout>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Descarga e instala el asistente (una sola vez, con soporte).{' '}
          {installUrl ? (
            <a href={installUrl} className="inline-flex items-center gap-1 font-medium text-primary" rel="noreferrer noopener">
              <Download className="size-3.5" /> Descargar instalador
            </a>
          ) : null}
        </li>
        <li>Ábrelo y elige “Vincular con Katalyst”: te mostrará un código de 8 caracteres.</li>
        <li>
          Confírmalo en{' '}
          <Link to="/dispositivos/vincular" className="font-medium text-primary">
            Asistente › Vincular dispositivo
          </Link>
          .
        </li>
        <li>
          Vuelve aquí: la sesión <span className="font-mono text-[12px]">{recordingId.slice(0, 8)}</span> seguirá esperando hasta que venza.
        </li>
      </ol>
    </div>
  );
}
