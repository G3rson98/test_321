/**
 * 03/04 · Catálogo (RF-CAT-02, RF-TR-03): filtros por sección (incluye descendientes), etiqueta (OR), estado del
 * último resultado, automatización y texto; paginación por cursor de servidor; selección por IDs entre páginas en
 * TanStack Store con barra de acciones Ejecutar / Programar / Agregar a suite.
 */
import { useEffect, useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { toast } from 'sonner';
import { CalendarClock, ChevronDown, ChevronRight, Layers, Loader2, Play, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { FilterChip, TagList } from '@/components/common/tag-chip';
import { StatusBadge } from '@/components/common/status-badge';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { catalogApi, itemsOf } from '@/lib/api/endpoints';
import type { CaseRow, Section } from '@/lib/api/types';
import { errorMessage } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useCan } from '@/lib/auth/session';
import { useCursorHistory, useDebouncedValue } from '@/lib/hooks';
import { lastResultLabel } from '@/lib/labels';
import { caseSelectionStore, selection, SELECTION_LIMIT } from '@/lib/stores/selection';
import { cn, plural } from '@/lib/utils';
import type { CatalogSearch } from '@/app/search';

const route = getRouteApi('/_app/catalogo');
export const DEFAULT_TAGS = ['@humo', '@oc', '@agendamiento', '@arranque', '@rendimiento'];

export function AutomationStatus({ row }: { row: Pick<CaseRow, 'automated' | 'linksRequiringReview' | 'flaky'> }) {
  if (!row.automated) return <span className="text-[14px] text-muted-foreground">○ Sin test</span>;
  const flaky = row.flaky?.isFlaky ? row.flaky : null;
  return (
    <div className="text-[14px] whitespace-nowrap">
      {row.linksRequiringReview > 0 ? <span className="text-flaky">⚠ Requiere revisión</span> : <span className="text-passed">● Automatizado</span>}
      {flaky ? (
        <div className="text-flaky" title="Pasó tras reintento en las últimas ejecuciones">
          Inestable {flaky.numerator}/{flaky.denominator}
        </div>
      ) : null}
    </div>
  );
}

function toQuery(s: CatalogSearch) {
  return {
    section: s.seccion,
    tag: s.etiqueta ? s.etiqueta.split(',') : undefined,
    q: s.q,
    lastResult: s.estado,
    automated: s.automatizacion === 'automatizado' ? 'true' : s.automatizacion === 'sin_test' ? 'false' : undefined,
    sort: s.sort,
    cursor: s.cursor,
    limit: s.limit,
  };
}

export function CatalogPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const appNavigate = useNavigate();
  const qc = useQueryClient();
  const canSync = useCan('testrail.sync');
  const selectedIds = useSelector(caseSelectionStore, (s) => s.ids);
  const [pendingFilter, setPendingFilter] = useState<Partial<CatalogSearch> | null>(null);
  const [q, setQ] = useState(search.q ?? '');
  const debouncedQ = useDebouncedValue(q, 300);

  const filterKey = JSON.stringify({ ...search, cursor: undefined });
  const scopeKey = JSON.stringify({ ...search, cursor: undefined, limit: undefined, sort: undefined });

  const applyFilter = (patch: Partial<CatalogSearch>, force = false) => {
    if (!force && selectedIds.size > 0) {
      setPendingFilter(patch);
      return;
    }
    if (force) selection.clear();
    void navigate({ search: (prev) => ({ ...prev, ...patch, cursor: undefined }), replace: true });
  };

  useEffect(() => {
    if ((debouncedQ || undefined) !== search.q) applyFilter({ q: debouncedQ.trim() || undefined }, selectedIds.size === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    selection.setScope(scopeKey);
  }, [scopeKey]);

  const pager = useCursorHistory(filterKey, search.cursor, (cursor) => void navigate({ search: (prev) => ({ ...prev, cursor }) }));

  const query = toQuery(search);
  const cases = useQuery({
    queryKey: qk.catalog.cases(query),
    queryFn: ({ signal }) => catalogApi.cases(query, signal),
    placeholderData: keepPreviousData,
  });
  const sections = useQuery({ queryKey: qk.catalog.sections(), queryFn: ({ signal }) => catalogApi.sections(signal) });
  const tags = useQuery({ queryKey: qk.catalog.tags(), queryFn: ({ signal }) => catalogApi.tags(signal), retry: false });
  const tagOptions = tags.data?.items ?? DEFAULT_TAGS;
  const activeTags = search.etiqueta ? search.etiqueta.split(',') : [];

  const sync = useMutation({
    mutationFn: catalogApi.sync,
    onSuccess: () => {
      toast.success('Sincronización iniciada. Te avisaremos al terminar.');
      void qc.invalidateQueries({ queryKey: ['testrail'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const rows = cases.data?.items;
  const pageIds = rows?.map((r) => r.id) ?? [];
  const onPage = pageIds.filter((id) => selectedIds.has(id)).length;
  const outside = selectedIds.size - onPage;

  const sorting: SortingState = [{ id: 'caso', desc: search.sort.startsWith('-') }];
  const columns = useMemo<ColumnDef<CaseRow>[]>(
    () => [
      {
        id: 'caso',
        header: 'Caso',
        enableSorting: true,
        enableHiding: false,
        meta: { label: 'Caso' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[14px] font-medium text-primary">{row.original.ref}</span>
              <span className="truncate">{row.original.title}</span>
            </div>
            <div className="text-[13px] text-muted-foreground">
              {row.original.sectionName ?? 'Sin sección'} · Prioridad {row.original.priority ?? '—'}
            </div>
          </div>
        ),
      },
      { id: 'etiquetas', header: 'Etiquetas', meta: { label: 'Etiquetas' }, enableSorting: false, cell: ({ row }) => <TagList tags={row.original.tags} /> },
      { id: 'automatizacion', header: 'Automatización', meta: { label: 'Automatización' }, enableSorting: false, cell: ({ row }) => <AutomationStatus row={row.original} /> },
      { id: 'ultimo', header: 'Último', meta: { label: 'Último' }, enableSorting: false, cell: ({ row }) => <StatusBadge status={lastResultLabel(row.original.lastResult?.status)} /> },
    ],
    [],
  );

  const hasFilters = !!(search.seccion || search.etiqueta || search.q || search.estado || search.automatizacion);
  const selCount = selectedIds.size;

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle="Casos sincronizados desde TestRail · Proyecto FMS DeltaX"
        actions={
          canSync ? (
            <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sincronizar
            </Button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Filtros del catálogo" className="space-y-7">
          <div>
            <label htmlFor="catalogo-q" className="label-mono mb-2 block">
              Buscar
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="catalogo-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID o título" className="pl-8" />
            </div>
          </div>

          <SectionTree
            sections={itemsOf(sections.data)}
            loading={sections.isLoading}
            active={search.seccion}
            onSelect={(id) => applyFilter({ seccion: id })}
          />

          <div>
            <div className="label-mono mb-2.5">Etiqueta</div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por etiqueta (cualquiera)">
              {tagOptions.map((t) => (
                <FilterChip
                  key={t}
                  tag={t}
                  selected={activeTags.includes(t)}
                  onToggle={() => {
                    const next = activeTags.includes(t) ? activeTags.filter((x) => x !== t) : [...activeTags, t];
                    applyFilter({ etiqueta: next.length ? next.join(',') : undefined });
                  }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="label-mono block" htmlFor="filtro-estado">
              Último resultado
            </label>
            <Select value={search.estado ?? 'todos'} onValueChange={(v) => applyFilter({ estado: v === 'todos' ? undefined : (v as CatalogSearch['estado']) })}>
              <SelectTrigger id="filtro-estado">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="pasado">Pasado</SelectItem>
                <SelectItem value="fallido">Fallido</SelectItem>
                <SelectItem value="inestable">Inestable</SelectItem>
                <SelectItem value="bloqueado">Bloqueado</SelectItem>
                <SelectItem value="sin_ejecutar">Sin ejecutar</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="label-mono block" htmlFor="filtro-auto">
              Automatización
            </label>
            <Select value={search.automatizacion ?? 'todos'} onValueChange={(v) => applyFilter({ automatizacion: v === 'todos' ? undefined : (v as CatalogSearch['automatizacion']) })}>
              <SelectTrigger id="filtro-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="automatizado">Con test</SelectItem>
                <SelectItem value="sin_test">Sin test</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={() => { setQ(''); applyFilter({ seccion: undefined, etiqueta: undefined, q: undefined, estado: undefined, automatizacion: undefined }); }}>
              <X /> Limpiar filtros
            </Button>
          ) : null}
        </aside>

        <div className="min-w-0 space-y-4">
          {selCount > 0 ? (
            <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 rounded-lg bg-primary px-5 py-2.5 text-primary-foreground" role="region" aria-label="Selección">
              <p className="text-[15px]">
                <strong className="font-semibold">{selCount}</strong> {plural(selCount, 'caso seleccionado', 'casos seleccionados')}
                {outside > 0 ? <span> · {outside} en otras páginas</span> : null}
                {selCount >= SELECTION_LIMIT ? <span> · límite de {SELECTION_LIMIT} alcanzado</span> : null}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" className="hover:bg-black/10" onClick={() => selection.clear()}>
                  <X /> Limpiar selección
                </Button>
                <Button size="sm" variant="ghost" className="bg-[#eaeaed] hover:bg-white" onClick={() => void appNavigate({ to: '/suites/nueva' })}>
                  <Layers /> Agregar a suite
                </Button>
                <Button size="sm" variant="ghost" className="bg-[#eaeaed] hover:bg-white" onClick={() => void appNavigate({ to: '/programaciones/nueva', search: { modo: 'casos' } })}>
                  <CalendarClock /> Programar
                </Button>
                <Button size="sm" className="border border-black/10 font-semibold shadow-sm" onClick={() => void appNavigate({ to: '/ejecuciones/nueva', search: { modo: 'casos' } })}>
                  <Play /> Ejecutar
                </Button>
              </div>
            </div>
          ) : null}

          <Card>
            <DataTable
              caption="Casos del catálogo"
              columns={columns}
              data={rows}
              getRowId={(r) => r.id}
              isLoading={cases.isLoading}
              isFetching={cases.isFetching && !cases.isLoading}
              error={cases.error}
              onRetry={() => void cases.refetch()}
              columnPrefsKey="catalogo"
              sorting={{
                value: sorting,
                onChange: (s) => {
                  const desc = s[0]?.desc ?? false;
                  void navigate({ search: (prev) => ({ ...prev, sort: desc ? '-trCaseId' : 'trCaseId', cursor: undefined }), replace: true });
                },
              }}
              selection={{
                selectedIds,
                label: (r) => `${r.ref} ${r.title}`,
                onToggle: (id, on) => {
                  if (!selection.toggle(id, on)) toast.warning(`Puedes seleccionar hasta ${SELECTION_LIMIT} casos por ejecución. Usa una suite o etiquetas para más.`);
                },
                onTogglePage: (ids, on) => {
                  const rejected = selection.setMany(ids, on);
                  if (rejected > 0) toast.warning(`${rejected} casos no se agregaron: límite de ${SELECTION_LIMIT}.`);
                },
              }}
              onRowClick={(r) => void appNavigate({ to: '/catalogo/$caseId', params: { caseId: r.id } })}
              pagination={{
                pageIndex: pager.pageIndex,
                hasPrev: pager.hasPrev,
                hasNext: !!cases.data?.hasNext,
                onPrev: pager.prev,
                onNext: () => cases.data?.nextCursor && pager.next(cases.data.nextCursor),
                pageSize: search.limit as PageSize,
                onPageSizeChange: (n) => void navigate({ search: (prev) => ({ ...prev, limit: n, cursor: undefined }), replace: true }),
                total: cases.data?.total,
              }}
              empty={
                hasFilters
                  ? {
                      title: 'Ningún caso coincide con los filtros',
                      action: (
                        <Button size="sm" variant="outlineCard" onClick={() => { setQ(''); applyFilter({ seccion: undefined, etiqueta: undefined, q: undefined, estado: undefined, automatizacion: undefined }); }}>
                          Limpiar filtros
                        </Button>
                      ),
                    }
                  : {
                      title: 'Aún no se sincronizó TestRail',
                      description: canSync ? 'Sincroniza para traer los casos del proyecto.' : 'Pide a un administrador que sincronice TestRail.',
                      action: canSync ? (
                        <Button size="sm" onClick={() => sync.mutate()}>
                          <RefreshCw /> Sincronizar ahora
                        </Button>
                      ) : undefined,
                    }
              }
            />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={pendingFilter !== null}
        onOpenChange={(o) => !o && setPendingFilter(null)}
        title="Cambiar el filtro limpiará la selección"
        description={`Tienes ${selCount} ${plural(selCount, 'caso seleccionado', 'casos seleccionados')}. La selección solo es válida dentro del mismo filtro.`}
        confirmLabel="Cambiar filtro"
        onConfirm={() => {
          if (pendingFilter) applyFilter(pendingFilter, true);
          setPendingFilter(null);
        }}
      />
    </>
  );
}

function SectionTree({ sections, loading, active, onSelect }: { sections: Section[]; loading: boolean; active: string | undefined; onSelect: (id: string | undefined) => void }) {
  const tops = sections.filter((s) => !s.parentId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const activeParent = sections.find((s) => s.id === active)?.parentId;
  const item = (id: string | undefined, label: string, depth: number, hasChildren = false) => {
    const isActive = active === id;
    const expanded = id ? open.has(id) || activeParent === id : false;
    return (
      <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
        {hasChildren && id ? (
          <button
            type="button"
            aria-label={expanded ? `Contraer ${label}` : `Expandir ${label}`}
            aria-expanded={expanded}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() =>
              setOpen((prev) => {
                const n = new Set(prev);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <button
          type="button"
          aria-current={isActive ? 'true' : undefined}
          onClick={() => onSelect(id)}
          className={cn('h-8 flex-1 truncate rounded-md px-2 text-left text-[15px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50', isActive && 'bg-muted font-semibold')}
        >
          {label}
        </button>
      </div>
    );
  };
  return (
    <nav aria-label="Secciones de TestRail">
      <div className="label-mono mb-2">Sección</div>
      {loading ? <p className="px-2 text-[13px] text-muted-foreground">Cargando…</p> : null}
      <div className="-ml-[18px] space-y-0.5">
        {item(undefined, 'Todas', 0)}
        {tops.map((t) => {
          const children = sections.filter((s) => s.parentId === t.id);
          const expanded = open.has(t.id) || activeParent === t.id;
          return (
            <div key={t.id}>
              {item(t.id, t.name, 0, children.length > 0)}
              {expanded ? children.map((c) => <div key={c.id}>{item(c.id, c.name.replace(`${t.name} · `, ''), 1)}</div>) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
