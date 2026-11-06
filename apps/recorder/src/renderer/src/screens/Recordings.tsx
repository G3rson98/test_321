/** Lista de grabaciones del usuario (GET /recordings). RF-GRB-01. */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AppState, RecordingListItem } from '../../../shared/ipc';
import { Badge, Button, Callout, Spinner, TagChip } from '../components/ui';
import { formatDateTime, formatRemaining, useCommand, useNow } from '../lib/bridge';
import { RecordingStatusBadge } from './status';

export function RecordingsScreen({ state }: { state: AppState }) {
  const [scope, setScope] = useState<'activas' | 'todas'>('activas');
  const [items, setItems] = useState<RecordingListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useCommand();
  const open = useCommand();
  const now = useNow(30_000);

  const runList = list.run;
  const load = useCallback(
    async (append?: string) => {
      const r = await runList(() => window.katalyst.listRecordings(scope, append));
      if (r) {
        setItems((prev) => (append && prev ? [...prev, ...r.items] : r.items));
        setCursor(r.nextCursor);
      }
    },
    [scope, runList],
  );

  useEffect(() => {
    void load();
  }, [load, state.device.deviceId]);

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] leading-9 font-bold tracking-[-0.03em]">Grabaciones</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Sesiones creadas desde el panel con «Grabar». Elige una para abrir Chromium en el ambiente de pruebas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border bg-card p-1" role="tablist" aria-label="Filtro">
            {(['activas', 'todas'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={scope === s}
                onClick={() => setScope(s)}
                className={`rounded-sm px-3 py-1 text-sm ${scope === s ? 'bg-primary text-primary-foreground' : 'text-foreground'}`}
              >
                {s === 'activas' ? 'Activas' : 'Todas'}
              </button>
            ))}
          </div>
          <Button
            icon={<RefreshCw className="size-4" aria-hidden />}
            loading={list.pending}
            onClick={() => void load()}
          >
            Actualizar
          </Button>
        </div>
      </header>

      {list.error && <Callout kind="error">{list.error}</Callout>}
      {open.error && <Callout kind="error">{open.error}</Callout>}

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        {items === null ? (
          <div className="p-6">
            <Spinner label="Cargando grabaciones…" />
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-[15px] text-muted-foreground">
            {scope === 'activas' ? 'No tienes grabaciones activas.' : 'Todavía no tienes grabaciones.'} En el panel,
            abre un caso y pulsa «Grabar».
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border font-mono text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
                <th className="px-5 py-2.5 font-medium">Caso</th>
                <th className="px-5 py-2.5 font-medium">Estado</th>
                <th className="px-5 py-2.5 font-medium">Etiquetas</th>
                <th className="px-5 py-2.5 font-medium">Creada</th>
                <th className="px-5 py-2.5 font-medium">Vencimiento</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 font-mono text-sm font-medium text-primary">{r.caseRef}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <RecordingStatusBadge status={r.status} />
                      {r.hasLocalCode && <Badge tone="flaky">sin enviar</Badge>}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.tags.map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{formatRemaining(r.expiresAt, now)}</td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="outline"
                      loading={open.pending}
                      onClick={() => void open.run(() => window.katalyst.openRecording(r.id))}
                    >
                      Abrir
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {cursor && (
        <div className="flex justify-center">
          <Button loading={list.pending} onClick={() => void load(cursor)}>
            Ver más
          </Button>
        </div>
      )}
    </>
  );
}
