import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, Layers, ListChecks, Loader2, Search, CalendarClock, WifiOff } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { alertsApi, catalogApi, schedulesApi, suitesApi, testrailApi } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { useDebouncedValue } from '@/lib/hooks';
import { formatDateTimeShort, formatTime } from '@/lib/format';
import { useSseStatus } from '@/lib/sse/polling';
import { cn } from '@/lib/utils';

export function Topbar({ menuButton }: { menuButton?: ReactNode }) {
  const sse = useSseStatus();
  return (
    <header className="sticky top-0 z-20 flex h-topbar items-center justify-between gap-4 border-b border-border bg-card px-4 sm:px-8">
      <div className="flex min-w-0 flex-1 items-center">
        {menuButton}
        <GlobalSearch />
      </div>
      <div className="flex items-center gap-3">
        {sse === 'reconnecting' || sse === 'unavailable' ? (
          <span className="hidden items-center gap-1.5 font-mono text-[11px] text-muted-foreground sm:inline-flex" role="status">
            <WifiOff className="size-3.5" aria-hidden />
            {sse === 'reconnecting' ? 'Reconectando…' : 'Tiempo real no disponible'}
          </span>
        ) : null}
        <TestRailStatusPill />
        <NotificationBell />
      </div>
    </header>
  );
}

/** Búsqueda global: casos, suites y programaciones con debounce 300 ms y cancelación (ESP §17.2). */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebouncedValue(q.trim(), 300);
  const enabled = term.length >= 2;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cases = useQuery({
    queryKey: qk.catalog.search(term),
    queryFn: ({ signal }) => catalogApi.cases({ q: term, limit: 5 }, signal),
    enabled,
    staleTime: 30_000,
  });
  const suites = useQuery({
    queryKey: qk.suites.list({ q: term, limit: 5 }),
    queryFn: ({ signal }) => suitesApi.list({ q: term, limit: 5 }, signal),
    enabled,
  });
  const schedules = useQuery({
    queryKey: qk.schedules.list({ q: term, limit: 5 }),
    queryFn: ({ signal }) => schedulesApi.list({ q: term, limit: 5 }, signal),
    enabled,
  });
  const loading = enabled && (cases.isFetching || suites.isFetching || schedules.isFetching);
  const total = (cases.data?.items.length ?? 0) + (suites.data?.items.length ?? 0) + (schedules.data?.items.length ?? 0);

  const go = (fn: () => void) => {
    setOpen(false);
    setQ('');
    fn();
  };

  return (
    <Popover open={open && enabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-full max-w-[384px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={open && enabled}
            aria-controls="busqueda-global"
            aria-label="Buscar casos, ejecuciones..."
            placeholder="Buscar casos, ejecuciones..."
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            className="h-[38px] w-full rounded-md border border-border bg-card pr-9 pl-9 text-[15px] outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
          />
          {loading ? <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Buscando" /> : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        id="busqueda-global"
        align="start"
        className="w-[min(480px,90vw)] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {!loading && total === 0 ? (
          <p className="px-3 py-4 text-[14px] text-muted-foreground">Sin resultados para “{term}”.</p>
        ) : null}
        <ResultGroup title="Casos" icon={<ListChecks className="size-4" />}>
          {cases.data?.items.map((c) => (
            <ResultItem key={c.id} onSelect={() => go(() => void navigate({ to: '/catalogo/$caseId', params: { caseId: c.id } }))}>
              <span className="font-mono text-primary">{c.ref}</span> {c.title}
            </ResultItem>
          ))}
        </ResultGroup>
        <ResultGroup title="Suites" icon={<Layers className="size-4" />}>
          {suites.data?.items.map((s) => (
            <ResultItem key={s.id} onSelect={() => go(() => void navigate({ to: '/suites/$suiteId', params: { suiteId: s.id } }))}>
              {s.name}
            </ResultItem>
          ))}
        </ResultGroup>
        <ResultGroup title="Programaciones" icon={<CalendarClock className="size-4" />}>
          {schedules.data?.items.map((s) => (
            <ResultItem key={s.id} onSelect={() => go(() => void navigate({ to: '/programaciones/$scheduleId', params: { scheduleId: s.id } }))}>
              {s.name}
            </ResultItem>
          ))}
        </ResultGroup>
        {total > 0 ? (
          <div className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
            Para buscar ejecuciones usa los filtros de <Link to="/ejecuciones" className="text-primary" onClick={() => setOpen(false)}>Ejecuciones</Link>.
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ResultGroup({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  const arr = Array.isArray(children) ? children : children ? [children] : [];
  if (arr.length === 0) return null;
  return (
    <div className="py-1" role="group" aria-label={title}>
      <div className="flex items-center gap-2 px-3 py-1 label-mono">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function ResultItem({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="block w-full truncate rounded-sm px-3 py-1.5 text-left text-[14px] outline-none hover:bg-muted focus-visible:bg-muted">
      {children}
    </button>
  );
}

/** Indicador de TestRail: sincronizado / sincronizando / fallida / entregas pendientes (ui-capturas §2.3). */
function TestRailStatusPill() {
  const syncRuns = useQuery({
    queryKey: qk.testrail.syncRuns({ limit: 1 }),
    queryFn: ({ signal }) => testrailApi.syncRuns({ limit: 1 }, signal),
    staleTime: 60_000,
  });
  const pending = useQuery({
    queryKey: qk.testrail.deliveries({ status: ['pendiente', 'requiere_intervencion'], limit: 100 }),
    queryFn: ({ signal }) => testrailApi.deliveries({ status: ['pendiente', 'requiere_intervencion'], limit: 100 }, signal),
    staleTime: 60_000,
  });
  const last = syncRuns.data?.items[0];
  // La API no devuelve `total`: se cuenta una página de 100 y se indica "100+" si hay más.
  const pendingCount = pending.data?.items.length ?? 0;
  const pendingLabel = pending.data?.hasNext ? `${pendingCount}+` : String(pendingCount);

  let dot = 'bg-passed';
  let text = 'TestRail sin sincronizar';
  if (syncRuns.isError) {
    dot = 'bg-muted-foreground';
    text = 'TestRail · estado no disponible';
  } else if (last?.status === 'en_curso') {
    dot = 'bg-running animate-pulse';
    text = 'Sincronizando…';
  } else if (last?.status === 'fallida') {
    dot = 'bg-failed';
    text = `Sincronización fallida · ${formatTime(last.finishedAt ?? last.startedAt)}`;
  } else if (pendingCount > 0) {
    dot = 'bg-primary';
    text = `Entregas pendientes: ${pendingLabel}`;
  } else if (last) {
    text = `TestRail sincronizado · ${formatTime(last.finishedAt ?? last.startedAt)}`;
  } else if (syncRuns.isLoading) {
    dot = 'bg-border';
    text = 'TestRail…';
  }
  return (
    <Link
      to="/testrail"
      className="hidden h-[26px] items-center gap-2 rounded-full border border-border bg-[#f6f8f9] px-3 font-mono text-[12px] whitespace-nowrap outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 md:inline-flex"
      aria-label={`Estado de TestRail: ${text}`}
    >
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden />
      {text}
    </Link>
  );
}

function NotificationBell() {
  const alerts = useQuery({
    queryKey: qk.alerts.list({ status: 'activa', limit: 10 }),
    queryFn: ({ signal }) => alertsApi.list({ status: 'activa', limit: 10 }, signal),
    staleTime: 30_000,
  });
  const items = alerts.data?.items ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative rounded-md p-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={items.length > 0 ? `Notificaciones: ${items.length} alertas activas` : 'Notificaciones'}
        >
          <Bell className="size-[18px]" />
          {items.length > 0 ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-failed" aria-hidden /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-4 py-2.5 text-[14px] font-semibold">Alertas activas</div>
        {alerts.isLoading ? (
          <p className="px-4 py-4 text-[13px] text-muted-foreground">Cargando…</p>
        ) : alerts.isError ? (
          <p className="px-4 py-4 text-[13px] text-muted-foreground">No se pudieron cargar las alertas.</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted-foreground">No hay alertas activas.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map((a) => (
              <li key={a.id} className="border-b border-border px-4 py-3 text-[13px] last:border-0">
                <div className="font-medium">{alertTitle(a.kind, a.payload)}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{formatDateTimeShort(a.updatedAt)}</div>
                {a.kind === 'umbral_rendimiento' ? (
                  <Link to="/rendimiento" className="mt-1 inline-block text-primary">
                    Ver rendimiento
                  </Link>
                ) : a.runId ? (
                  <Link to="/ejecuciones/$runId" params={{ runId: a.runId }} className="mt-1 inline-block text-primary">
                    Ver ejecución
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function alertTitle(kind: string, payload: Record<string, unknown>): string {
  const label = typeof payload.label === 'string' ? payload.label : null;
  switch (kind) {
    case 'umbral_rendimiento':
      return label ? `${label} superó el umbral` : 'Umbral de rendimiento superado';
    case 'corrida_fallida':
      return label ? `${label} terminó con fallas` : 'Ejecución con fallas';
    case 'corrida_interrumpida':
      return label ? `${label} fue interrumpida` : 'Ejecución interrumpida';
    default:
      return label ?? 'Alerta de disponibilidad';
  }
}
