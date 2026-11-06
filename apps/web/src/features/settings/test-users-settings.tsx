/**
 * 24 · Configuración · Usuarios de prueba (RF-AMB-02/03, ESP §13.7). La contraseña nunca se ve ni se envía al
 * panel: solo la referencia del secreto (la lee únicamente el ejecutor). Producción exige solo lectura.
 */
import { useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import { SECRET_REF_REGEX } from '@katalyst/shared/schemas';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldError } from '@/components/common/misc';
import { StatusBadge } from '@/components/common/status-badge';
import { DataTable } from '@/components/data-table/data-table';
import { envApi, itemsOf } from '@/lib/api/endpoints';
import type { EnvironmentSummary, TestUser } from '@/lib/api/types';
import { errorMessage, fieldErrorsFrom } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

const route = getRouteApi('/_app/configuracion/usuarios-prueba');

export function TestUsersSettings() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const qc = useQueryClient();
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const envList = itemsOf(envs.data);
  const ids = search.ambiente ? [search.ambiente] : envList.map((e) => e.id);
  const users = useQuery({
    queryKey: [...qk.environments.users(ids.join(','))],
    queryFn: async ({ signal }) => (await Promise.all(ids.map((id) => envApi.users(id, signal)))).flatMap((x) => itemsOf(x)),
    enabled: ids.length > 0,
  });
  const [editing, setEditing] = useState<TestUser | 'nuevo' | null>(null);
  const envName = (id: string) => envList.find((e) => e.id === id)?.name ?? '—';
  const columns: ColumnDef<TestUser>[] = [
    { id: 'usuario', header: 'Usuario', cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.username}</span> },
    { id: 'ambiente', header: 'Ambiente', cell: ({ row }) => envName(row.original.environmentId) },
    { id: 'permisos', header: 'Permisos', cell: ({ row }) => (row.original.readOnly ? 'Solo lectura' : 'Lectura y escritura') },
    { id: 'pass', header: 'Contraseña', cell: ({ row }) => <span className="text-[12.5px] text-muted-foreground" title={row.original.secretRef}>Cifrada · solo la lee el ejecutor</span> },
    { id: 'estado', header: 'Estado', cell: ({ row }) => <StatusBadge status={row.original.enabled ? { label: 'Habilitado', tone: 'passed' } : { label: 'Deshabilitado', tone: 'skipped' }} /> },
  ];
  return (
    <>
      <CardSection
        title="Usuarios de prueba"
        padded={false}
        action={
          <div className="flex items-center gap-2">
            <Select value={search.ambiente ?? '__all'} onValueChange={(v) => void navigate({ search: { ambiente: v === '__all' ? undefined : v }, replace: true })}>
              <SelectTrigger className="h-8 w-[160px]" aria-label="Ambiente">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">Todos los ambientes</SelectItem>
                {envList.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setEditing('nuevo')} disabled={envList.length === 0}>
              <Plus /> Agregar
            </Button>
          </div>
        }
      >
        <DataTable caption="Usuarios de prueba" columns={columns} data={users.data} getRowId={(u) => u.id} isLoading={users.isLoading || envs.isLoading} error={users.error ?? envs.error} onRetry={() => void users.refetch()} onRowClick={setEditing} empty={{ title: 'No hay usuarios de prueba', description: 'Cada ambiente necesita al menos un usuario para ejecutar.' }} />
      </CardSection>
      {editing ? (
        <TestUserDialog
          user={editing === 'nuevo' ? null : editing}
          envs={envList}
          defaultEnv={search.ambiente}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['config', 'environments', 'users'] });
          }}
        />
      ) : null}
    </>
  );
}

function TestUserDialog({ user, envs, defaultEnv, onClose, onSaved }: { user: TestUser | null; envs: EnvironmentSummary[]; defaultEnv?: string | undefined; onClose: () => void; onSaved: () => void }) {
  const [envId, setEnvId] = useState(user?.environmentId ?? defaultEnv ?? envs[0]?.id ?? '');
  const [label, setLabel] = useState(user?.label ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [secretRef, setSecretRef] = useState(user?.secretRef ?? '');
  const [readOnly, setReadOnly] = useState(user?.readOnly ?? false);
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const env = envs.find((e) => e.id === envId);
  const local: Record<string, string> = {};
  if (!username.trim()) local.username = 'Requerido';
  if (!SECRET_REF_REGEX.test(secretRef.trim())) local.secretRef = 'Usa ssm:/…, env:NOMBRE o file:/…';
  if (env?.isProduction && !readOnly) local.readOnly = 'Producción solo admite usuarios de solo lectura';
  const save = useMutation({
    mutationFn: () => {
      const body = { label: label.trim() || username.trim(), username: username.trim(), secretRef: secretRef.trim(), readOnly, enabled, allowsConcurrency: false };
      return user ? envApi.updateUser(user.environmentId, user.id, { ...body, version: user.version }) : envApi.createUser(envId, body);
    },
    onSuccess: () => {
      toast.success('Usuario de prueba guardado.');
      onSaved();
    },
    onError: (e) => {
      const f = fieldErrorsFrom(e);
      setErrs(f);
      if (!Object.keys(f).length) toast.error(errorMessage(e));
    },
  });
  const [touched, setTouched] = useState(false);
  const show = (k: string) => errs[k] ?? (touched ? local[k] : undefined);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? `Editar ${user.username}` : 'Agregar usuario de prueba'}</DialogTitle>
          <DialogDescription>La contraseña se guarda en el gestor de secretos; aquí solo va su referencia. Para rotarla, actualiza el secreto o cambia la referencia.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Ambiente</Label>
            <Select value={envId} onValueChange={setEnvId} disabled={!!user}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {envs.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tu-user">Usuario</Label>
              <Input id="tu-user" value={username} onChange={(e) => setUsername(e.target.value)} className="font-mono text-[13px]" aria-invalid={!!show('username')} />
              <FieldError message={show('username')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tu-label">Etiqueta</Label>
              <Input id="tu-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Opcional" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tu-secret">Contraseña · referencia del secreto</Label>
            <Input id="tu-secret" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder="ssm:/katalyst/staging/qa.shipper1" className="font-mono text-[13px]" aria-invalid={!!show('secretRef')} autoComplete="off" />
            <FieldError message={show('secretRef')} />
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-3 text-[15px]">
              <Switch checked={readOnly} onCheckedChange={setReadOnly} /> Solo lectura
            </label>
            <label className="flex items-center gap-3 text-[15px]">
              <Switch checked={enabled} onCheckedChange={setEnabled} /> Habilitado
            </label>
          </div>
          <FieldError message={show('readOnly')} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              setTouched(true);
              if (Object.keys(local).length === 0) save.mutate();
            }}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
