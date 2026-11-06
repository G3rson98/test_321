/** Shell del asistente: barra lateral Katalyst + pantalla según el estado publicado por main. RNF-USA-02. */
import { Download, Link2Off, ListChecks, Link2 } from 'lucide-react';
import type { AppState } from '../../shared/ipc';
import { Button, Callout, Logo, Spinner } from './components/ui';
import { useAppState, useCommand } from './lib/bridge';
import { RecordingScreen } from './screens/Recording';
import { RecordingsScreen } from './screens/Recordings';
import { SetupScreen } from './screens/Setup';

export function App() {
  const state = useAppState();
  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Iniciando el asistente…" />
      </div>
    );
  }
  const linked = state.device.status === 'vinculado';
  return (
    <div className="flex h-full">
      <Sidebar state={state} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-5 px-8 py-8">
          {state.notice && (
            <Callout kind={state.notice.kind === 'error' ? 'error' : 'info'}>{state.notice.message}</Callout>
          )}
          {linked && <BrowserBanner state={state} />}
          {!linked ? (
            <SetupScreen state={state} />
          ) : state.recording ? (
            <RecordingScreen state={state} recording={state.recording} />
          ) : (
            <RecordingsScreen state={state} />
          )}
        </div>
      </main>
    </div>
  );
}

function Sidebar({ state }: { state: AppState }) {
  const { run, pending } = useCommand();
  const d = state.device;
  const linked = d.status === 'vinculado';
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-6 pt-6 pb-8">
        <Logo />
      </div>
      <nav className="flex-1 space-y-1 px-3">
        <div
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-[15px] ${linked ? 'bg-sidebar-accent text-primary' : ''}`}
        >
          <ListChecks className="size-4" aria-hidden /> Grabaciones
        </div>
        <div
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-[15px] ${!linked ? 'bg-sidebar-accent text-primary' : ''}`}
        >
          <Link2 className="size-4" aria-hidden /> Vínculo
        </div>
      </nav>
      <div className="space-y-3 border-t border-sidebar-border px-5 py-4 text-[13px]">
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${linked ? (d.healthy === false ? 'bg-[#e0a43a]' : 'bg-passed') : 'bg-[#6b6c75]'}`}
            aria-hidden
          />
          <span className="text-sidebar-user">
            {linked
              ? d.healthy === false
                ? 'Vinculado · sin conexión'
                : 'Vinculado · en línea'
              : d.status === 'vinculando'
                ? 'Esperando aprobación'
                : 'Sin vincular'}
          </span>
        </div>
        {state.serverUrl && (
          <div className="truncate font-mono text-[11px] text-[#95969d]" title={state.serverUrl}>
            {state.serverUrl}
          </div>
        )}
        {linked && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(() => window.katalyst.unlink())}
            className="inline-flex items-center gap-2 text-[13px] text-sidebar-foreground hover:text-sidebar-user disabled:opacity-50"
          >
            <Link2Off className="size-3.5" aria-hidden /> Desvincular este equipo
          </button>
        )}
        <div className="font-mono text-[10px] tracking-[0.15em] text-[#83848c] uppercase">
          v{state.version}
          {state.devMode ? ' · desarrollo' : ''}
        </div>
      </div>
    </aside>
  );
}

function BrowserBanner({ state }: { state: AppState }) {
  const { run, pending, error } = useCommand();
  const b = state.browser;
  if (b.status === 'instalado' || b.status === 'desconocido') return null;
  if (b.status === 'instalando')
    return (
      <Callout kind="info" title="Instalando Chromium">
        {b.message}
      </Callout>
    );
  return (
    <Callout kind="warning" title="Falta el navegador del asistente">
      <p>{b.message ?? 'Para grabar se necesita Chromium. Se descarga una sola vez (≈ 150 MB).'}</p>
      {error && <p className="mt-1 text-failed">{error}</p>}
      <div className="mt-3">
        <Button
          variant="primary"
          icon={<Download className="size-4" aria-hidden />}
          loading={pending}
          onClick={() => void run(() => window.katalyst.installBrowser())}
        >
          Instalar Chromium
        </Button>
      </div>
    </Callout>
  );
}
