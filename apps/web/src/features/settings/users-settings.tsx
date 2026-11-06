/**
 * 26 · Configuración · Usuarios del panel (RF-USR-01/02/03): invitar, cambiar rol con confirmación (sin optimismo,
 * auditado), deshabilitar (no borrar), impedir quitar el último admin (409 LAST_ADMIN) y tokens de API revocables
 * con alcances y vencimiento (el token se muestra UNA sola vez y no se guarda en el navegador).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { Copy, Loader2, Plus } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@katalyst/shared/rbac';
import type { PanelRole } from '@katalyst/shared/enums';
import { Button } from '@/components/ui/button';
import { CardSection } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Callout, FieldError } from '@/components/common/misc';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { StatusBadge } from '@/components/common/status-badge';
import { DataTable } from '@/components/data-table/data-table';
import { authApi, usersApi } from '@/lib/api/endpoints';
import type { ApiToken, PanelUser } from '@/lib/api/types';
import { errorMessage, fieldErrorsFrom, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useSession } from '@/lib/auth/session';
import { ROLE_LABEL } from '@/lib/labels';
import { formatDateTimeShort } from '@/lib/format';

export function UsersSettings() {
  const qc = useQueryClient();
  const me = useSession();
  const users = useQuery({ queryKey: qk.users.list({ includeDisabled: true, limit: 100 }), queryFn: ({ signal }) => usersApi.list({ includeDisabled: true, limit: 100 }, signal) });
  const [invite, setInvite] = useState(false);
  const [pending, setPending] = useState<{ user: PanelUser; role?: PanelRole; disable?: boolean } | null>(null);
  const update = useMutation({
    mutationFn: (p: { user: PanelUser; role?: PanelRole; disable?: boolean }) =>
      usersApi.update(p.user.id, { version: p.user.version, ...(p.role ? { role: p.role } : {}), ...(p.disable !== undefined ? { disabled: p.disable } : {}) }),
    onSuccess: () => {
      setPending(null);
      toast.success('Usuario actualizado. Queda registrado en auditoría.');
      void qc.invalidateQueries({ queryKey: ['config', 'users'] });
    },
    onError: (e) => {
      setPending(null);
      toast.error(isApiError(e) && e.code === 'LAST_ADMIN' ? 'No se puede quitar el último administrador activo.' : errorMessage(e));
    },
  });
  const columns: ColumnDef<PanelUser>[] = [
    { id: 'nombre', header: 'Nombre', cell: ({ row }) => row.original.name },
    { id: 'correo', header: 'Correo', cell: ({ row }) => <span className="text-[14px]">{row.original.email}</span> },
    {
      id: 'rol',
      header: 'Rol',
      cell: ({ row }) => (
        <Select value={row.original.role} disabled={!!row.original.disabledAt} onValueChange={(role) => setPending({ user: row.original, role: role as PanelRole })}>
          <SelectTrigger className="h-8 w-[170px]" aria-label={`Rol de ${row.original.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['qa', 'dev', 'admin'] as const).map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'estado',
      header: 'Estado',
      cell: ({ row }) => (
        <StatusBadge status={row.original.disabledAt ? { label: 'Deshabilitado', tone: 'skipped' } : row.original.lastLoginAt ? { label: 'Activo', tone: 'passed' } : { label: 'Invitación pendiente', tone: 'flaky' }} />
      ),
    },
    {
      id: 'accion',
      header: () => <span className="sr-only">Acciones</span>,
      cell: ({ row }) =>
        row.original.id === me?.user.id ? null : (
          <Button size="sm" variant="ghost" onClick={() => setPending({ user: row.original, disable: !row.original.disabledAt })}>
            {row.original.disabledAt ? 'Habilitar' : 'Deshabilitar'}
          </Button>
        ),
    },
  ];
  return (
    <div className="space-y-6">
      <CardSection title="Usuarios del panel" padded={false} action={<Button size="sm" onClick={() => setInvite(true)}><Plus /> Invitar</Button>}>
        <DataTable caption="Usuarios del panel" columns={columns} data={users.data?.items} getRowId={(u) => u.id} isLoading={users.isLoading} error={users.error} onRetry={() => void users.refetch()} empty={{ title: 'No hay usuarios' }} />
      </CardSection>
      <TokensCard />
      {invite ? <InviteDialog onClose={() => setInvite(false)} onSaved={() => { setInvite(false); void qc.invalidateQueries({ queryKey: ['config', 'users'] }); }} /> : null}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.role ? 'Cambiar rol' : pending?.disable ? 'Deshabilitar usuario' : 'Habilitar usuario'}
        description={
          pending?.role
            ? `${pending.user.name} pasará de ${ROLE_LABEL[pending.user.role]} a ${ROLE_LABEL[pending.role]}. Sus sesiones se actualizan con el nuevo permiso.`
            : pending?.disable
              ? `${pending?.user.name} no podrá ingresar ni usar sus tokens. Su historial se conserva.`
              : `${pending?.user.name} podrá volver a ingresar.`
        }
        confirmLabel="Confirmar"
        tone={pending?.disable ? 'danger' : 'default'}
        pending={update.isPending}
        onConfirm={() => pending && update.mutate(pending)}
      />
    </div>
  );
}

function InviteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<PanelRole>('qa');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const local = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? 'Correo inválido' : null;
  const save = useMutation({
    mutationFn: () => usersApi.create({ email: email.trim().toLowerCase(), name: name.trim(), role }),
    onSuccess: () => {
      // La API crea el usuario (no envía correo): define su contraseña con la recuperación o ingresa por SSO.
      toast.success('Usuario creado. Puede ingresar por SSO o definir su contraseña con «¿Olvidaste tu contraseña?».');
      onSaved();
    },
    onError: (e) => {
      const f = fieldErrorsFrom(e);
      if (isApiError(e) && e.code === 'EMAIL_TAKEN') f.email = 'Ya existe un usuario con ese correo.';
      setErrs(f);
      if (!Object.keys(f).length) toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitar usuario</DialogTitle>
          <DialogDescription>Recibirá un enlace para definir su contraseña (o ingresará con SSO si está configurado).</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="inv-email">Correo</Label>
          <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <FieldError message={errs.email ?? (email ? local : null)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="inv-name">Nombre</Label>
          <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} />
          <FieldError message={errs.name} />
        </div>
        <div className="space-y-2">
          <Label>Rol</Label>
          <Select value={role} onValueChange={(v) => setRole(v as PanelRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['qa', 'dev', 'admin'] as const).map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!!local || !name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Invitar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokensCard() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: qk.tokens.list(), queryFn: ({ signal }) => authApi.tokens({ limit: 100 }, signal) });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const revoke = useMutation({
    mutationFn: (t: ApiToken) => authApi.revokeToken(t.id),
    onSuccess: () => {
      setRevoking(null);
      toast.success('Token revocado.');
      void qc.invalidateQueries({ queryKey: ['config', 'tokens'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const columns: ColumnDef<ApiToken>[] = [
    { id: 'nombre', header: 'Nombre', cell: ({ row }) => row.original.name },
    { id: 'hint', header: 'Termina en', cell: ({ row }) => <span className="font-mono text-[13px]">…{row.original.hint}</span> },
    { id: 'alcances', header: 'Alcances', cell: ({ row }) => <span className="font-mono text-[12px] text-muted-foreground">{row.original.scopes.join(', ')}</span> },
    { id: 'vence', header: 'Vence', cell: ({ row }) => <span className="font-mono text-[13px]">{formatDateTimeShort(row.original.expiresAt)}</span> },
    { id: 'uso', header: 'Último uso', cell: ({ row }) => <span className="font-mono text-[13px]">{formatDateTimeShort(row.original.lastUsedAt)}</span> },
    {
      id: 'accion',
      header: () => <span className="sr-only">Acciones</span>,
      cell: ({ row }) =>
        row.original.revokedAt ? (
          <StatusBadge status={{ label: 'Revocado', tone: 'skipped' }} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setRevoking(row.original)}>
            Revocar
          </Button>
        ),
    },
  ];
  return (
    <CardSection title="Tokens de API" padded={false} action={<Button size="sm" variant="outlineCard" onClick={() => setCreating(true)}><Plus /> Crear token</Button>}>
      <DataTable caption="Tokens de API" columns={columns} data={tokens.data?.items} getRowId={(t) => t.id} isLoading={tokens.isLoading} error={tokens.error} onRetry={() => void tokens.refetch()} empty={{ title: 'No hay tokens de API' }} />
      {creating ? <CreateTokenDialog onClose={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['config', 'tokens'] }); }} /> : null}
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title="Revocar token" description="Las integraciones que lo usen dejarán de funcionar de inmediato." confirmLabel="Revocar" tone="danger" pending={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking)} />
    </CardSection>
  );
}

const SCOPE_CHOICES: Permission[] = PERMISSIONS.filter((p) => !p.startsWith('worker.'));

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [scopes, setScopes] = useState<Permission[]>(['runs.read', 'runs.create']);
  const [token, setToken] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => authApi.createToken({ name: name.trim(), scopes, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Crear token de API</DialogTitle>
          <DialogDescription>El permiso efectivo es el de tu rol intersecado con los alcances elegidos.</DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="space-y-3">
            <Callout tone="warning" title="Cópialo ahora: no se volverá a mostrar">
              Guárdalo en el gestor de secretos de la integración. Katalyst no lo conserva en el navegador.
            </Callout>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-code-bg px-3 py-2 font-mono text-[13px] text-code-fg">{token}</code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copiar token"
                onClick={() => {
                  void navigator.clipboard?.writeText(token);
                  toast.success('Token copiado.');
                }}
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => { setToken(null); onClose(); }}>Listo</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <div className="space-y-2">
                <Label htmlFor="tk-name">Nombre</Label>
                <Input id="tk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CI de qa-tests" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tk-days">Vence en (días)</Label>
                <Input id="tk-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            </div>
            <fieldset>
              <legend className="label-mono mb-2">Alcances</legend>
              <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto">
                {SCOPE_CHOICES.map((p) => (
                  <label key={p} className="flex items-center gap-2 font-mono text-[12.5px]">
                    <Checkbox checked={scopes.includes(p)} onCheckedChange={(on) => setScopes((s) => (on === true ? [...s, p] : s.filter((x) => x !== p)))} />
                    {p}
                  </label>
                ))}
              </div>
            </fieldset>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button disabled={!name.trim() || scopes.length === 0 || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="animate-spin" /> : null} Crear
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
