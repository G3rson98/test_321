/**
 * 22 · Configuración · TestRail (RF-TR-01). La API key NUNCA se muestra ni se envía: solo su referencia de secreto
 * (`ssm:/…`, `env:…`, `file:/…`). Probar conexión antes de guardar; proyectos se cargan tras probar.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { CircleCheck, Loader2 } from 'lucide-react';
import { SECRET_REF_REGEX, TestRailConnectionUpdateSchema } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Callout, FieldError } from '@/components/common/misc';
import { DirtyGuard } from '@/components/common/dirty-guard';
import { ErrorState } from '@/components/common/states';
import { StatusBadge } from '@/components/common/status-badge';
import { testrailApi } from '@/lib/api/endpoints';
import type { TestRailConnection, TestRailConnectionTest } from '@/lib/api/types';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { applyServerErrors, firstError } from '@/lib/form';
import { formatDateTimeShort } from '@/lib/format';
import { SYNC_RUN_LABEL } from '@/lib/labels';

const Schema = z.object({
  baseUrl: z.string().trim().url('URL inválida').refine((v) => v.startsWith('https://'), 'Usa HTTPS'),
  username: z.string().trim().min(1, 'Requerido').max(254),
  secretRef: z.string().trim().regex(SECRET_REF_REGEX, 'Referencia inválida: usa ssm:/…, env:NOMBRE o file:/…'),
  projectExternalId: z.string().regex(/^\d*$/, 'Solo números'),
  suiteExternalIds: z.string().regex(/^(\d+(\s*,\s*\d+)*)?$/, 'IDs numéricos separados por coma'),
  enabled: z.boolean(),
});
type V = z.infer<typeof Schema>;
const FIELDS = ['baseUrl', 'username', 'secretRef', 'projectExternalId', 'suiteExternalIds', 'enabled'];

function toValues(c: TestRailConnection | null): V {
  return {
    baseUrl: c?.baseUrl ?? '',
    username: c?.username ?? '',
    secretRef: c?.secretRef ?? '',
    projectExternalId: c?.projectExternalId ? String(c.projectExternalId) : '',
    suiteExternalIds: c?.suiteExternalIds.join(', ') ?? '',
    enabled: c?.enabled ?? true,
  };
}
function toBody(v: V) {
  return TestRailConnectionUpdateSchema.parse({
    baseUrl: v.baseUrl.trim(),
    username: v.username.trim(),
    secretRef: v.secretRef.trim(),
    projectExternalId: v.projectExternalId ? Number(v.projectExternalId) : null,
    suiteExternalIds: v.suiteExternalIds ? v.suiteExternalIds.split(',').map((x) => Number(x.trim())) : [],
    enabled: v.enabled,
  });
}

export function TestRailSettings() {
  const conn = useQuery({ queryKey: qk.testrail.connection(), queryFn: ({ signal }) => testrailApi.connection(signal), retry: false });
  if (conn.isLoading) return <Skeleton className="h-80" />;
  const missing = conn.isError && isApiError(conn.error) && conn.error.status === 404;
  if (conn.isError && !missing) return <ErrorState error={conn.error} onRetry={() => void conn.refetch()} />;
  return <ConnectionForm key={conn.data?.version ?? 'nueva'} conn={conn.data ?? null} />;
}

function ConnectionForm({ conn }: { conn: TestRailConnection | null }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<TestRailConnectionTest | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const form = useForm({
    defaultValues: toValues(conn),
    validators: { onChange: Schema },
    onSubmit: async ({ value, formApi }) => {
      setSummary(null);
      try {
        const out = await testrailApi.saveConnection({ ...toBody(value), ...(conn ? { version: conn.version } : {}) });
        qc.setQueryData(qk.testrail.connection(), out);
        toast.success('Conexión guardada.');
        formApi.reset(toValues(out));
      } catch (e) {
        if (isApiError(e) && e.code === 'VERSION_CONFLICT') setSummary('La configuración cambió desde que la abriste. Recarga antes de guardar.');
        else {
          const left = applyServerErrors(form as never, e, FIELDS);
          if (left.length || !(isApiError(e) && e.details?.issues?.length)) setSummary(left[0] ?? errorMessage(e));
        }
      }
    },
  });
  const test = useMutation({
    mutationFn: () => testrailApi.testConnection(toBody(form.state.values)),
    onSuccess: setResult,
    onError: (e) => setResult({ ok: false, errorCode: isApiError(e) ? e.code : null, message: errorMessage(e), testrailVersion: null, projects: [], latencyMs: null }),
  });
  const field = (name: keyof V, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <form.Field name={name}>
      {(f) => {
        const err = f.state.meta.isTouched || form.state.submissionAttempts > 0 ? firstError(f.state.meta.errors) : null;
        return (
          <div className="space-y-2">
            <Label htmlFor={`tr-${name}`}>{label}</Label>
            <Input id={`tr-${name}`} value={String(f.state.value)} onChange={(e) => f.handleChange(e.target.value as never)} onBlur={f.handleBlur} aria-invalid={!!err} {...props} />
            <FieldError message={err} />
          </div>
        );
      }}
    </form.Field>
  );
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Subscribe selector={(s) => s.isDirty}>{(d) => <DirtyGuard when={d} />}</form.Subscribe>
      <CardSection title="Conexión" meta={conn ? `Última sincronización ${formatDateTimeShort(conn.lastSyncAt)}` : undefined}>
        <div className="grid max-w-[632px] gap-4">
          {field('baseUrl', 'URL', { placeholder: 'https://empresa.testrail.io' })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field('username', 'Usuario de servicio')}
            {field('secretRef', 'API key · referencia del secreto', { placeholder: 'ssm:/katalyst/testrail/api-key', className: 'font-mono text-[13px]' })}
          </div>
          <p className="-mt-2 text-[12.5px] text-muted-foreground">La API key no se muestra ni viaja por el panel: se guarda en el gestor de secretos y aquí solo se indica su referencia.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.Field name="projectExternalId">
              {(f) =>
                result?.ok && result.projects.length ? (
                  <div className="space-y-2">
                    <Label htmlFor="tr-project">Proyecto</Label>
                    <Select value={f.state.value || undefined} onValueChange={f.handleChange}>
                      <SelectTrigger id="tr-project">
                        <SelectValue placeholder="Elige el proyecto" />
                      </SelectTrigger>
                      <SelectContent>
                        {result.projects.map((p) => (
                          <SelectItem key={p.externalId} value={String(p.externalId)}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="tr-projectExternalId">Proyecto (ID)</Label>
                    <Input id="tr-projectExternalId" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} inputMode="numeric" placeholder="Prueba la conexión para elegirlo" />
                    <FieldError message={firstError(f.state.meta.errors)} />
                  </div>
                )
              }
            </form.Field>
            {field('suiteExternalIds', 'Suite (IDs)', { placeholder: '12', inputMode: 'numeric' })}
          </div>
          <form.Field name="enabled">
            {(f) => (
              <label className="flex items-center gap-3 text-[15px]">
                <Switch checked={f.state.value} onCheckedChange={f.handleChange} /> Conexión habilitada
              </label>
            )}
          </form.Field>
          {conn ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              Estado de la última sincronización: <StatusBadge status={SYNC_RUN_LABEL[conn.lastSyncStatus]} />
            </div>
          ) : (
            <Callout tone="info">Aún no hay una conexión configurada.</Callout>
          )}
          {result ? (
            <Callout tone={result.ok ? 'info' : 'danger'} title={result.ok ? 'Conexión correcta' : 'La conexión falló'}>
              {result.message}
              {result.testrailVersion ? ` · TestRail ${result.testrailVersion}` : ''}
              {result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ''}
            </Callout>
          ) : null}
          {summary ? <Callout tone="danger">{summary}</Callout> : null}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? <Loader2 className="animate-spin" /> : <CircleCheck />} Probar conexión
            </Button>
            <form.Subscribe selector={(s) => [s.isSubmitting, s.canSubmit] as const}>
              {([sub, can]) => (
                <Button type="submit" disabled={sub || !can}>
                  {sub ? <Loader2 className="animate-spin" /> : null} Guardar
                </Button>
              )}
            </form.Subscribe>
          </div>
        </div>
      </CardSection>
    </form>
  );
}
