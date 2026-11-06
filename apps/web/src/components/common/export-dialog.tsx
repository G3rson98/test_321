/**
 * Exportación CSV/PDF en servidor con los mismos filtros/permisos (RF-RES-04, ESP §17.3): alcance explícito
 * "página actual" o "todo el filtro"; trabajo asíncrono con archivo privado y vencimiento.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import type { ExportCreate } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from './controls';
import { Callout } from './misc';
import { exportsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { JOB_STATUS_LABEL } from '@/lib/labels';
import { usePollingFallback } from '@/lib/sse/polling';

export function ExportDialog({
  open,
  onOpenChange,
  scope,
  filters,
  cursor,
  limit,
  runId,
  allowPage = true,
  title = 'Exportar resultados',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: ExportCreate['scope'];
  filters: Record<string, unknown>;
  cursor?: string | undefined;
  limit?: number | undefined;
  runId?: string;
  allowPage?: boolean;
  title?: string;
}) {
  const [format, setFormat] = useState<'csv' | 'pdf'>('csv');
  const [extent, setExtent] = useState<'pagina' | 'completo'>(allowPage ? 'pagina' : 'completo');
  const [jobId, setJobId] = useState<string | null>(null);
  const poll = usePollingFallback('detail');
  const create = useMutation({
    mutationFn: () =>
      exportsApi.create({ format, scope, filters, extent, ...(extent === 'pagina' ? { cursor, limit } : {}), ...(runId ? { runId } : {}) } as ExportCreate),
    onSuccess: (j) => setJobId(j.id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const job = useQuery({
    queryKey: qk.exports.detail(jobId ?? ''),
    queryFn: ({ signal }) => exportsApi.get(jobId!, signal),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && ['listo', 'fallido', 'vencido'].includes(q.state.data.status) ? false : poll || 2_000),
  });
  const download = useMutation({
    mutationFn: () => exportsApi.download(jobId!),
    onSuccess: ({ url }) => {
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const j = job.data;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setJobId(null);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Se genera en el servidor con los filtros actuales y tus permisos. El archivo vence en 24 h.</DialogDescription>
        </DialogHeader>
        {!jobId ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Formato</Label>
              <SegmentedControl ariaLabel="Formato" value={format} onValueChange={setFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'pdf', label: 'PDF' }]} />
            </div>
            <div className="space-y-2">
              <Label>Alcance</Label>
              <SegmentedControl
                ariaLabel="Alcance"
                value={extent}
                onValueChange={setExtent}
                options={[
                  { value: 'pagina', label: 'Página actual', disabled: !allowPage },
                  { value: 'completo', label: 'Todo el filtro' },
                ]}
              />
            </div>
          </div>
        ) : (
          <div role="status" className="space-y-2 text-[14px]">
            <p>
              Estado: <strong>{j ? JOB_STATUS_LABEL[j.status] : 'En cola'}</strong>
              {j?.rowCount !== null && j?.rowCount !== undefined ? ` · ${j.rowCount} filas` : ''}
            </p>
            {j?.status === 'fallido' ? <Callout tone="danger">{j.error ?? 'La exportación falló.'}</Callout> : null}
          </div>
        )}
        <DialogFooter>
          {!jobId ? (
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Download />} Generar
            </Button>
          ) : (
            <Button onClick={() => download.mutate()} disabled={j?.status !== 'listo' || download.isPending}>
              {j?.status !== 'listo' ? <Loader2 className="animate-spin" /> : <Download />} Descargar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
