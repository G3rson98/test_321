/**
 * Borrador de test con IA (RF-GRB-03, rol dev). El borrador no se ejecuta ni toca la rama principal: debe pasar
 * por PR, revisión y manifiesto validado (RF-GRB-05). Estado por SSE `generation.updated` o fallback de polling.
 */
import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Loader2, Sparkles } from 'lucide-react';
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Callout } from '@/components/common/misc';
import { generateApi } from '@/lib/api/endpoints';
import type { CaseDetail } from '@/lib/api/types';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { usePollingFallback } from '@/lib/sse/polling';

const CodeViewer = lazy(() => import('@/components/code/code-viewer'));

export function GenerateSheet({ kase, onClose }: { kase: CaseDetail; onClose: () => void }) {
  const [genId, setGenId] = useState<string | null>(null);
  const poll = usePollingFallback('detail');
  const create = useMutation({
    mutationFn: () => generateApi.create(kase.id),
    onSuccess: (g) => setGenId(g.id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const gen = useQuery({
    queryKey: qk.generation.detail(genId ?? ''),
    queryFn: ({ signal }) => generateApi.get(genId!, signal),
    enabled: !!genId,
    refetchInterval: (q) => (q.state.data && ['listo', 'fallido', 'rechazado_presupuesto'].includes(q.state.data.status) ? false : (poll || 3_000)),
  });
  const g = gen.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="max-w-2xl">
        <DialogTitle>Generar borrador con IA · {kase.ref}</DialogTitle>
        <DialogDescription>
          Se envían solo los pasos y resultados esperados del caso (sanitizados). El borrador requiere PR y revisión de un desarrollador; nunca se ejecuta automáticamente.
        </DialogDescription>
        {!genId ? (
          <Button onClick={() => create.mutate()} disabled={create.isPending} className="self-start">
            {create.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Generar borrador
          </Button>
        ) : !g || g.status === 'pendiente' || g.status === 'en_proceso' ? (
          <div className="space-y-2" role="status">
            <p className="text-[14px] text-muted-foreground">Generando borrador…</p>
            <Skeleton className="h-48" />
          </div>
        ) : g.status === 'listo' && g.result ? (
          <div className="space-y-4">
            {g.result.todos > 0 || g.result.needsHumanReview.length > 0 ? (
              <Callout tone="warning" title="Requiere revisión humana">
                <ul className="list-disc pl-4">
                  {g.result.needsHumanReview.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                  {g.result.todos > 0 ? <li>{g.result.todos} TODO pendientes en el código</li> : null}
                </ul>
              </Callout>
            ) : null}
            <Suspense fallback={<Skeleton className="h-48" />}>
              <CodeViewer code={g.result.code} className="rounded-md" label="Borrador generado" />
            </Suspense>
            <div className="flex items-center justify-between text-[12px] text-muted-foreground">
              <span className="font-mono">
                {g.provider} · {g.model} · prompt {g.promptVersion}
                {g.costUsd !== null ? ` · US$ ${g.costUsd.toFixed(3)}` : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(g.result!.code);
                  toast.success('Código copiado.');
                }}
              >
                <Copy /> Copiar
              </Button>
            </div>
          </div>
        ) : (
          <Callout tone="danger" title="No se pudo generar el borrador">
            {g.status === 'rechazado_presupuesto' ? 'Se agotó el presupuesto de IA.' : (g.error ?? 'Error del proveedor de IA.')}
          </Callout>
        )}
      </SheetContent>
    </Dialog>
  );
}
