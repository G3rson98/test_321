/** Configuración del servidor y vínculo por flujo de dispositivo (ESP §13.6). RF-GRB-01. */
import { useState } from 'react';
import { ExternalLink, Link2, X } from 'lucide-react';
import type { AppState } from '../../../shared/ipc';
import { Button, Callout, Card, MonoLabel } from '../components/ui';
import { formatRemaining, useCommand, useNow } from '../lib/bridge';

export function SetupScreen({ state }: { state: AppState }) {
  return (
    <>
      <header>
        <h1 className="text-[30px] leading-9 font-bold tracking-[-0.03em]">Vincular el asistente</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          El asistente graba flujos en tu equipo con Playwright y envía el código a Katalyst para abrir un pull request.
        </p>
      </header>
      {state.pendingRecordingId && (
        <Callout kind="info" title="Hay una grabación esperando">
          Vincula el asistente con tu cuenta y la grabación se abrirá automáticamente.
        </Callout>
      )}
      {state.credentialStore === 'no_disponible' && (
        <Callout kind="warning" title="Sin almacén de credenciales del sistema">
          El vínculo solo durará mientras el asistente esté abierto.
        </Callout>
      )}
      <ServerCard state={state} />
      {state.serverUrl && <LinkCard state={state} />}
    </>
  );
}

function ServerCard({ state }: { state: AppState }) {
  const [value, setValue] = useState(state.serverUrl ?? '');
  const [editing, setEditing] = useState(!state.serverUrl);
  const { run, pending, error } = useCommand();
  if (!editing && state.serverUrl) {
    return (
      <Card
        title="Servidor de Katalyst"
        meta={
          <button type="button" className="text-primary hover:underline" onClick={() => setEditing(true)}>
            Cambiar
          </button>
        }
      >
        <p className="font-mono text-sm">{state.serverUrl}</p>
      </Card>
    );
  }
  return (
    <Card title="Servidor de Katalyst">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => window.katalyst.setServerUrl(value)).then((r) => {
            if (r !== undefined) setEditing(false);
          });
        }}
      >
        <label htmlFor="server" className="block text-[15px] font-medium">
          Dirección del panel
        </label>
        <input
          id="server"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://katalyst.empresa.com"
          className="h-9 w-full rounded-md border border-border bg-card px-3 text-[15px] placeholder:text-placeholder focus:ring-2 focus:ring-primary focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-[13px] text-muted-foreground">Debe empezar con https://. Te la indica tu administrador.</p>
        {error && <p className="text-sm text-failed">{error}</p>}
        <Button type="submit" variant="primary" loading={pending} disabled={!value.trim()}>
          Guardar
        </Button>
      </form>
    </Card>
  );
}

function LinkCard({ state }: { state: AppState }) {
  const { run, pending, error } = useCommand();
  const now = useNow();
  const d = state.device;
  if (d.status === 'vinculando' && d.userCode) {
    return (
      <Card title="Aprueba el vínculo en el panel" meta={formatRemaining(d.codeExpiresAt, now)}>
        <div className="space-y-5">
          <ol className="list-decimal space-y-1 pl-5 text-[15px]">
            <li>Abre el panel de Katalyst con tu usuario.</li>
            <li>Confirma que el código coincide y pulsa «Aprobar».</li>
          </ol>
          <div className="rounded-lg border border-border bg-muted px-6 py-5 text-center">
            <MonoLabel>Código de un solo uso</MonoLabel>
            <p className="mt-2 font-mono text-4xl font-semibold tracking-[0.2em]" aria-live="polite">
              {d.userCode}
            </p>
          </div>
          {error && <p className="text-sm text-failed">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<ExternalLink className="size-4" aria-hidden />}
              onClick={() => void run(() => window.katalyst.openVerification())}
            >
              Abrir el panel para aprobar
            </Button>
            <Button
              variant="ghost"
              icon={<X className="size-4" aria-hidden />}
              onClick={() => void run(() => window.katalyst.cancelLink())}
            >
              Cancelar
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            El código vence en 5 minutos. El asistente nunca recibe tu contraseña del panel.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Vincular con tu cuenta">
      <div className="space-y-4">
        <p className="text-[15px]">
          Genera un código y apruébalo desde tu sesión del panel. El asistente guarda una credencial revocable en el
          almacén de credenciales de tu sistema.
        </p>
        {d.message && <Callout kind="error">{d.message}</Callout>}
        {error && <p className="text-sm text-failed">{error}</p>}
        <Button
          variant="primary"
          icon={<Link2 className="size-4" aria-hidden />}
          loading={pending}
          onClick={() => void run(() => window.katalyst.startLink())}
        >
          Vincular asistente
        </Button>
      </div>
    </Card>
  );
}
