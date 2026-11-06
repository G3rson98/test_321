/**
 * DataTable reutilizable sobre TanStack Table (ESP §17.3, RNF-OPT-02):
 * - Paginación/orden/filtro de SERVIDOR por cursor con historial anterior/siguiente; tamaños 25/50/100.
 * - `getRowId` = UUID persistente; selección por conjunto de IDs estable entre páginas, con conteo total y fuera de
 *   la página; el checkbox del encabezado selecciona/deselecciona SOLO la página visible.
 * - Teclado: filas enfocables (↑/↓ mueven foco, Enter abre, Espacio selecciona); encabezados con aria-sort.
 * - Estados de carga (skeleton conservando datos previos al paginar), vacío, error con reintento y sin permiso.
 * - Visibilidad/tamaño de columnas persistidos solo en localStorage.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, Loader2, Lock } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/popover';
import { EmptyState, ErrorState } from '@/components/common/states';
import { isApiError } from '@/lib/api/client';
import { loadColumnPrefs, saveColumnPrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface CursorPagination {
  pageIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  pageSize: PageSize;
  onPageSizeChange: (n: PageSize) => void;
  total?: number | undefined;
}

export interface TableSelection<T> {
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  onTogglePage: (ids: string[], on: boolean) => void;
  isDisabled?: (row: T) => boolean;
  label?: (row: T) => string;
}

export interface DataTableProps<T> {
  /** Nombre accesible de la tabla. */
  caption: string;
  columns: ColumnDef<T, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: readonly T[] | undefined;
  getRowId: (row: T) => string;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: { title: string; description?: ReactNode; action?: ReactNode };
  pagination?: CursorPagination;
  sorting?: { value: SortingState; onChange: (s: SortingState) => void };
  selection?: TableSelection<T>;
  onRowClick?: (row: T) => void;
  columnPrefsKey?: string;
  /** Contenido extra bajo una fila (error del test, intentos). */
  renderSubRow?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  selectedRowId?: string | null;
  className?: string;
  skeletonRows?: number;
  toolbar?: ReactNode;
  hideHeader?: boolean;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    caption,
    columns,
    data,
    getRowId,
    isLoading,
    isFetching,
    error,
    onRetry,
    empty,
    pagination,
    sorting,
    selection,
    onRowClick,
    columnPrefsKey,
    renderSubRow,
    rowClassName,
    selectedRowId,
    className,
    skeletonRows = 6,
    toolbar,
    hideHeader,
  } = props;

  const initialPrefs = useMemo(() => (columnPrefsKey ? loadColumnPrefs(columnPrefsKey) : {}), [columnPrefsKey]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialPrefs.visibility ?? {});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(initialPrefs.sizing ?? {});
  useEffect(() => {
    if (columnPrefsKey) saveColumnPrefs(columnPrefsKey, { visibility: columnVisibility, sizing: columnSizing });
  }, [columnPrefsKey, columnVisibility, columnSizing]);

  const rows = useMemo(() => (data ? [...data] : []), [data]);

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selection) return columns;
    const selCol: ColumnDef<T, unknown> = {
      id: '__select',
      size: 44,
      enableHiding: false,
      enableSorting: false,
      header: ({ table }) => {
        const pageRows = table.getRowModel().rows.filter((r) => !selection.isDisabled?.(r.original));
        const ids = pageRows.map((r) => r.id);
        const checkedCount = ids.filter((id) => selection.selectedIds.has(id)).length;
        const state = ids.length > 0 && checkedCount === ids.length ? true : checkedCount > 0 ? 'indeterminate' : false;
        return (
          <Checkbox
            aria-label="Seleccionar las filas de esta página"
            checked={state}
            disabled={ids.length === 0}
            onCheckedChange={(v) => selection.onTogglePage(ids, v === true)}
            onClick={(e) => e.stopPropagation()}
          />
        );
      },
      cell: ({ row }) => {
        const disabled = selection.isDisabled?.(row.original) ?? false;
        return (
          <Checkbox
            aria-label={`Seleccionar ${selection.label?.(row.original) ?? 'fila'}`}
            checked={selection.selectedIds.has(row.id)}
            disabled={disabled}
            onCheckedChange={(v) => selection.onToggle(row.id, v === true)}
            onClick={(e) => e.stopPropagation()}
          />
        );
      },
    };
    return [selCol, ...columns];
  }, [columns, selection]);

  const table = useReactTable<T>({
    data: rows,
    columns: allColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableSortingRemoval: false,
    columnResizeMode: 'onEnd',
    enableColumnResizing: !!columnPrefsKey,
    state: { sorting: sorting?.value ?? [], columnVisibility, columnSizing },
    onSortingChange: (u) => {
      if (!sorting) return;
      sorting.onChange(typeof u === 'function' ? u(sorting.value) : u);
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
  });

  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const forbidden = isApiError(error) && error.status === 403;
  const showSkeleton = isLoading && rows.length === 0;
  const visibleLeafs = table.getVisibleLeafColumns().length;

  const pageIds = table.getRowModel().rows.map((r) => r.id);
  const selectedCount = selection?.selectedIds.size ?? 0;
  const onPage = selection ? pageIds.filter((id) => selection.selectedIds.has(id)).length : 0;

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, row: T, id: string) {
    const tr = e.currentTarget;
    if (e.target !== tr) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]') ?? []);
      const i = all.indexOf(tr);
      all[e.key === 'ArrowDown' ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'Enter' && onRowClick) {
      e.preventDefault();
      onRowClick(row);
    } else if (e.key === ' ' && selection && !selection.isDisabled?.(row)) {
      e.preventDefault();
      selection.onToggle(id, !selection.selectedIds.has(id));
    }
  }

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide() && c.id !== '__select');

  return (
    <div className={cn('w-full', className)}>
      {toolbar || columnPrefsKey ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
          {columnPrefsKey && hideable.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Columnas visibles">
                  <Columns3 /> Columnas
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Columnas</DropdownMenuLabel>
                {hideable.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onCheckedChange={(v) => c.toggleVisibility(v === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {typeof c.columnDef.meta === 'object' && c.columnDef.meta && 'label' in c.columnDef.meta
                      ? String((c.columnDef.meta as { label: string }).label)
                      : c.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      {selection && selectedCount > 0 ? (
        <p className="sr-only" aria-live="polite">
          {selectedCount} seleccionados, {selectedCount - onPage} en otras páginas
        </p>
      ) : null}

      <div className="relative w-full overflow-x-auto">
        {isFetching && rows.length > 0 ? (
          <div className="absolute top-0 right-0 left-0 z-10 h-0.5 overflow-hidden bg-primary/20" aria-hidden>
            <div className="h-full w-1/3 animate-[pulse_1s_ease-in-out_infinite] bg-primary" />
          </div>
        ) : null}
        <table className="w-full caption-bottom border-collapse text-[15px]" aria-busy={isLoading || isFetching}>
          <caption className="sr-only">{caption}</caption>
          {!hideHeader ? (
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border">
                  {hg.headers.map((h) => {
                    const sortable = !!sorting && h.column.getCanSort();
                    const dir = h.column.getIsSorted();
                    return (
                      <th
                        key={h.id}
                        scope="col"
                        aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                        style={h.column.columnDef.size && h.column.id !== '__select' && columnPrefsKey ? { width: h.getSize() } : h.column.id === '__select' ? { width: 44 } : undefined}
                        className={cn('th-mono relative h-[37px] px-5 text-left align-middle', h.column.id === '__select' && 'pr-0')}
                      >
                        {h.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={h.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {dir === 'asc' ? <ArrowUp className="size-3" /> : dir === 'desc' ? <ArrowDown className="size-3" /> : null}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                        {columnPrefsKey && h.column.getCanResize() && h.column.id !== '__select' ? (
                          <span
                            role="separator"
                            aria-hidden
                            onMouseDown={h.getResizeHandler()}
                            onTouchStart={h.getResizeHandler()}
                            className="absolute top-2 right-0 h-5 w-1 cursor-col-resize rounded bg-border opacity-0 hover:opacity-100"
                          />
                        ) : null}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
          ) : null}
          <tbody ref={bodyRef}>
            {forbidden ? (
              <tr>
                <td colSpan={visibleLeafs}>
                  <EmptyState icon={<Lock className="size-6" />} title="No tienes permiso para ver esta información" />
                </td>
              </tr>
            ) : error && rows.length === 0 ? (
              <tr>
                <td colSpan={visibleLeafs}>
                  <ErrorState error={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : showSkeleton ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-border last:border-0">
                  {Array.from({ length: visibleLeafs }).map((__, j) => (
                    <td key={j} className="h-[61px] px-5">
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleLeafs}>
                  <EmptyState title={empty.title} description={empty.description} action={empty.action} />
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const sub = renderSubRow?.(row.original);
                const isSelected = selectedRowId === row.id || selection?.selectedIds.has(row.id);
                return (
                  <FragmentRow key={row.id}>
                    <tr
                      data-row
                      tabIndex={onRowClick || selection ? 0 : undefined}
                      aria-selected={selection ? selection.selectedIds.has(row.id) : selectedRowId ? selectedRowId === row.id : undefined}
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                      onKeyDown={(e) => onRowKeyDown(e, row.original, row.id)}
                      className={cn(
                        'outline-none focus-visible:bg-muted/60',
                        !sub && 'border-b border-border last:border-0',
                        onRowClick && 'cursor-pointer hover:bg-muted/40',
                        isSelected && selectedRowId === row.id && 'bg-muted/50',
                        rowClassName?.(row.original),
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={cn('h-[61px] px-5 py-2 align-middle', cell.column.id === '__select' && 'pr-0')}
                          style={cell.column.id === '__select' ? { width: 44 } : undefined}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {sub ? (
                      <tr className="border-b border-border last:border-0">
                        <td colSpan={visibleLeafs} className="px-5 pb-3">
                          {sub}
                        </td>
                      </tr>
                    ) : null}
                  </FragmentRow>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination && !forbidden && (rows.length > 0 || pagination.hasPrev) ? (
        <nav aria-label={`Paginación de ${caption}`} className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-2.5 text-[13px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Filas por página</span>
            <Select value={String(pagination.pageSize)} onValueChange={(v) => pagination.onPageSizeChange(Number(v) as PageSize)}>
              <SelectTrigger className="h-8 w-[76px]" aria-label="Filas por página">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selection && selectedCount > 0 ? (
              <span className="ml-2">
                {selectedCount} seleccionados
                {selectedCount - onPage > 0 ? ` · ${selectedCount - onPage} en otras páginas` : ''}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isFetching ? <Loader2 className="size-4 animate-spin" aria-label="Actualizando" /> : null}
            <span>
              Página {pagination.pageIndex + 1}
              {pagination.total !== undefined ? ` · ${pagination.total.toLocaleString('es-BO')} en total` : ''}
            </span>
            <Button variant="outlineCard" size="sm" onClick={pagination.onPrev} disabled={!pagination.hasPrev || isFetching} aria-label="Página anterior">
              <ChevronLeft /> Anterior
            </Button>
            <Button variant="outlineCard" size="sm" onClick={pagination.onNext} disabled={!pagination.hasNext || isFetching} aria-label="Página siguiente">
              Siguiente <ChevronRight />
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
