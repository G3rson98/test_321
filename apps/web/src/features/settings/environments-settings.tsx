/**
 * 23 · Configuración · Ambientes (RF-AMB-01, RF-EJE-04/06). Alta/edición en diálogo, URLs HTTPS, concurrencia,
 * política de evidencia; marcar/desmarcar Producción exige confirmación fuerte. No se borran: se deshabilitan.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import type { ColumnDef } from '@tanstack/react-table';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import { ARTIFACT_KINDS } from '@katalyst/shared/enums';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Callout, FieldError } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { StatusBadge } from '@/components/common/status-badge';
import { DataTable } from '@/components/data-table/data-table';
import { envApi, itemsOf } from '@/lib/api/endpoints';
import type { Environment } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { applyServerErrors, firstError } from '@/lib/form';
import { ARTIFACT_KIND_LABEL } from '@/lib/labels';

const Schema = z.object({
  name: z.string().trim().min(1, 'Requerido').max(80),
  appUrl: z.string().trim().url('URL inválida').refine((v) => v.startsWith('https://'), 'Usa HTTPS'),
  apiUrl: z.string().trim().url('URL inválida').refine((v) => v.startsWith('https://'), 'Usa HTTPS'),
  maxConcurrency: z.number().int('Entero').min(1, 'Mínimo 1').max(32, 'Máximo 32'),
  isProduction: z.boolean(),
  enabled: z.boolean(),
  recordingAllowed: z.boolean(),
  enabledKinds: z.array(z.string()),
});
type V = z.infer<typeof Schema>;

export function EnvironmentsSettings() {
  const qc = useQueryClient();
  // Admin: detalle completo e incluye ambientes dados de baja (`includeDisabled`).
  const envs = useQuery({ queryKey: [...qk.environments.all, 'list-all'], queryFn: ({ signal }) => envApi.list(signal, { includeDisabled: true }) });
  const [editing, setEditing] = useState<Environment | 'nuevo' | null>(null);
  const list = itemsOf(envs.data) as Environment[];
  const columns: ColumnDef<Environment>[] = [
    { id: 'nombre', header: 'Nombre', cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { id: 'app', header: 'URL app', cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.appUrl}</span> },
    { id: 'api', header: 'URL API', cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.apiUrl}</span> },
    { id: 'conc', header: 'Concurrencia', cell: ({ row }) => row.original.maxConcurrency },
    { id: 'prod', header: 'Producción', cell: ({ row }) => <Switch checked={row.original.isProduction} disabled aria-label="Producción (editar para cambiar)" /> },
    { id: 'estado', header: 'Estado', cell: ({ row }) => <StatusBadge status={row.original.enabled ? { label: 'Habilitado', tone: 'passed' } : { label: 'Deshabilitado', tone: 'skipped' }} /> },
  ];
  return (
    <>
      <CardSection
        title="Ambientes"
        padded={false}
        action={
          <Button size="sm" onClick={() => setEditing('nuevo')}>
            <Plus /> Agregar
          </Button>
        }
      >
        <DataTable caption="Ambientes" columns={columns} data={list} getRowId={(e) => e.id} isLoading={envs.isLoading} error={envs.error} onRetry={() => void envs.refetch()} onRowClick={setEditing} empty={{ title: 'Aún no hay ambientes', description: 'Agrega staging y producción para poder ejecutar.' }} />
      </CardSection>
      {editing ? (
        <EnvironmentDialog
          env={editing === 'nuevo' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['config', 'environments'] });
          }}
        />
      ) : null}
    </>
  );
}

function EnvironmentDialog({ env, onClose, onSaved }: { env: Environment | null; onClose: () => void; onSaved: () => void }) {
  const [confirmProd, setConfirmProd] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (v: V) => {
      const policy = { ...(env?.artifactPolicy ?? { screenshotsOnFailureOnly: true, videoOnFailureOnly: true, traceOnFailureOnly: true, maxEvidenceBytesPerRun: 262144000, maxTempBytesPerRun: 1073741824, retentionDays: 30, disabledReasons: {} }), enabledKinds: v.enabledKinds as Environment['artifactPolicy']['enabledKinds'] };
      const body = { name: v.name.trim(), appUrl: v.appUrl.trim(), apiUrl: v.apiUrl.trim(), maxConcurrency: v.maxConcurrency, isProduction: v.isProduction, enabled: v.enabled, recordingAllowed: v.recordingAllowed && !v.isProduction, artifactPolicy: policy };
      return env ? envApi.update(env.id, { ...body, version: env.version }) : envApi.create({ ...body, allowedHosts: [] });
    },
  });
  const form = useForm({
    defaultValues: {
      name: env?.name ?? '',
      appUrl: env?.appUrl ?? 'https://',
      apiUrl: env?.apiUrl ?? 'https://',
      maxConcurrency: env?.maxConcurrency ?? 1,
      isProduction: env?.isProduction ?? false,
      enabled: env?.enabled ?? true,
      recordingAllowed: env?.recordingAllowed ?? false,
      enabledKinds: (env?.artifactPolicy.enabledKinds ?? ['reporte', 'log']) as string[],
    } as V,
    validators: { onChange: Schema },
    onSubmit: async ({ value }) => {
      setSummary(null);
      try {
        await save.mutateAsync(value);
        toast.success('Ambiente guardado. Queda registrado en auditoría.');
        onSaved();
      } catch (e) {
        const left = applyServerErrors(form as never, e, ['name', 'appUrl', 'apiUrl', 'maxConcurrency']);
        setSummary(isApiError(e) && e.code === 'VERSION_CONFLICT' ? 'El ambiente cambió; cierra y vuelve a abrirlo.' : left[0] ?? (isApiError(e) && e.details?.issues?.length ? null : errorMessage(e)));
      }
    },
  });
  const text = (name: 'name' | 'appUrl' | 'apiUrl', label: string) => (
    <form.Field name={name}>
      {(f) => {
        const err = f.state.meta.isTouched || form.state.submissionAttempts > 0 ? firstError(f.state.meta.errors) : null;
        return (
          <div className="space-y-2">
            <Label htmlFor={`env-${name}`}>{label}</Label>
            <Input id={`env-${name}`} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} aria-invalid={!!err} className={name !== 'name' ? 'font-mono text-[13px]' : ''} />
            <FieldError message={err} />
          </div>
        );
      }}
    </form.Field>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{env ? `Editar ${env.name}` : 'Agregar ambiente'}</DialogTitle>
          <DialogDescription>Las URLs se validan contra la lista de hosts permitidos en el servidor.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          {text('name', 'Nombre')}
          <div className="grid gap-4 sm:grid-cols-2">
            {text('appUrl', 'URL app')}
            {text('apiUrl', 'URL API')}
          </div>
          <form.Field name="maxConcurrency">
            {(f) => (
              <div className="space-y-2">
                <Label htmlFor="env-conc">Concurrencia (navegadores)</Label>
                <Input id="env-conc" type="number" min={1} max={32} value={f.state.value} onChange={(e) => f.handleChange(Number(e.target.value))} className="w-28" />
                <FieldError message={firstError(f.state.meta.errors)} />
                {f.state.value > 1 ? <p className="text-[12.5px] text-muted-foreground">La concurrencia global inicial es 1 navegador; valores mayores requieren ensayo de capacidad (RNF-OPT-05).</p> : null}
              </div>
            )}
          </form.Field>
          <div className="flex flex-wrap gap-6">
            <form.Field name="isProduction">
              {(f) => (
                <label className="flex items-center gap-3 text-[15px]">
                  <Switch checked={f.state.value} onCheckedChange={(v) => setConfirmProd(v)} /> Producción
                </label>
              )}
            </form.Field>
            <form.Field name="enabled">
              {(f) => (
                <label className="flex items-center gap-3 text-[15px]">
                  <Switch checked={f.state.value} onCheckedChange={f.handleChange} /> Habilitado
                </label>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values.isProduction}>
              {(prod) => (
                <form.Field name="recordingAllowed">
                  {(f) => (
                    <label className="flex items-center gap-3 text-[15px]">
                      <Switch checked={f.state.value && !prod} disabled={prod} onCheckedChange={f.handleChange} /> Permite grabar
                    </label>
                  )}
                </form.Field>
              )}
            </form.Subscribe>
          </div>
          <form.Field name="enabledKinds">
            {(f) => (
              <fieldset>
                <legend className="label-mono mb-2">Evidencia permitida</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {ARTIFACT_KINDS.filter((k) => !k.startsWith('dxmon')).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-[14px]">
                      <Checkbox checked={f.state.value.includes(k)} onCheckedChange={(on) => f.handleChange(on === true ? [...f.state.value, k] : f.state.value.filter((x) => x !== k))} />
                      {ARTIFACT_KIND_LABEL[k]}
                    </label>
                  ))}
                </div>
                <form.Subscribe selector={(s) => s.values.isProduction}>
                  {(prod) => (prod ? <p className="mt-2 text-[12.5px] text-muted-foreground">En producción, trazas y videos quedan deshabilitados por defecto; las capturas requieren enmascaramiento probado.</p> : null)}
                </form.Subscribe>
              </fieldset>
            )}
          </form.Field>
          {summary ? <Callout tone="danger">{summary}</Callout> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <form.Subscribe selector={(s) => [s.isSubmitting, s.canSubmit] as const}>
              {([sub, can]) => (
                <Button type="submit" disabled={sub || !can}>
                  {sub ? <Loader2 className="animate-spin" /> : null} Guardar
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={confirmProd !== null}
          onOpenChange={(o) => !o && setConfirmProd(null)}
          title={confirmProd ? 'Marcar como Producción' : 'Quitar marca de Producción'}
          description={
            confirmProd
              ? 'En Producción solo se ejecutan tests aprobados de solo lectura con usuarios de solo lectura, y no se permite grabar. ¿Continuar?'
              : 'Sin la marca de Producción se permitirán tests de escritura en este ambiente. Hazlo solo si NO es producción real.'
          }
          confirmLabel={confirmProd ? 'Marcar Producción' : 'Quitar marca'}
          tone={confirmProd ? 'default' : 'danger'}
          onConfirm={() => {
            form.setFieldValue('isProduction', !!confirmProd);
            if (confirmProd) form.setFieldValue('enabledKinds', form.state.values.enabledKinds.filter((k) => k !== 'traza' && k !== 'video'));
            setConfirmProd(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
