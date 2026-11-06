/**
 * DataTable (ESP §17.3, RNF-OPT-02): paginación por cursor de servidor con historial, selección por IDs estable entre
 * páginas, checkbox de página, conteos, teclado, y estados cargando/vacío/error/sin permiso.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSelector } from '@tanstack/react-store';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable, type PageSize } from '@/components/data-table/data-table';
import { ApiError } from '@/lib/api/client';
import { __resetCursorHistories, useCursorHistory } from '@/lib/hooks';
import { caseSelectionStore, selection, SELECTION_LIMIT } from '@/lib/stores/selection';

interface Row {
  id: string;
  title: string;
}
const ROWS: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `id-${String(i + 1).padStart(2, '0')}`, title: `Caso ${i + 1}` }));
const columns: ColumnDef<Row>[] = [{ id: 'title', header: 'Título', cell: ({ row }) => row.original.title }];

/** "Servidor" con cursor opaco (offset codificado). */
function serverPage(cursor: string | undefined, limit: number) {
  const offset = cursor ? Number(atob(cursor)) : 0;
  const items = ROWS.slice(offset, offset + limit);
  const hasNext = offset + limit < ROWS.length;
  return { items, hasNext, nextCursor: hasNext ? btoa(String(offset + limit)) : null, total: ROWS.length };
}

function Harness({ filterKey = 'f1', disabledId }: { filterKey?: string; disabledId?: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const pager = useCursorHistory(filterKey, cursor, setCursor);
  const page = serverPage(cursor, pageSize);
  const ids = useSelector(caseSelectionStore, (s) => s.ids);
  return (
    <DataTable
      caption="Casos"
      columns={columns}
      data={page.items}
      getRowId={(r) => r.id}
      empty={{ title: 'Sin casos' }}
      pagination={{
        pageIndex: pager.pageIndex,
        hasPrev: pager.hasPrev,
        hasNext: page.hasNext,
        onPrev: pager.prev,
        onNext: () => page.nextCursor && pager.next(page.nextCursor),
        pageSize,
        onPageSizeChange: setPageSize,
        total: page.total,
      }}
      selection={{
        selectedIds: ids,
        onToggle: (id, on) => selection.toggle(id, on),
        onTogglePage: (pageIds, on) => selection.setMany(pageIds, on),
        isDisabled: (r) => r.id === disabledId,
        label: (r) => r.title,
      }}
    />
  );
}

const rowTitles = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).queryAllByRole('cell')[1]?.textContent);

beforeEach(() => {
  __resetCursorHistories();
  selection.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe('DataTable · paginación por cursor y selección', () => {
  it('avanza y retrocede con cursores, mostrando página y total', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(rowTitles()[0]).toBe('Caso 1');
    expect(screen.getByText(/Página 1 · 60 en total/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(rowTitles()[0]).toBe('Caso 26');
    expect(screen.getByText(/Página 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(rowTitles()).toHaveLength(10);
    expect(rowTitles()[0]).toBe('Caso 51');
    expect(screen.getByText(/Página 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Página siguiente' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(rowTitles()[0]).toBe('Caso 26');
    expect(screen.getByText(/Página 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(rowTitles()[0]).toBe('Caso 1');
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
  });

  it('la selección por ID persiste al cambiar de página y cuenta las de otras páginas', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar Caso 2' }));
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar Caso 5' }));
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Caso 26' })).not.toBeChecked();
    expect(screen.getByText(/2 seleccionados · 2 en otras páginas/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar Caso 30' }));
    expect(screen.getByText(/3 seleccionados · 2 en otras páginas/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Caso 2' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Caso 5' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Caso 1' })).not.toBeChecked();
    expect(selection.get().sort()).toEqual(['id-02', 'id-05', 'id-30']);
  });

  it('el checkbox de encabezado selecciona/deselecciona SOLO la página visible (indeterminado si es parcial)', async () => {
    const user = userEvent.setup();
    render(<Harness disabledId="id-03" />);
    const header = () => screen.getByRole('checkbox', { name: 'Seleccionar las filas de esta página' });
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar Caso 1' }));
    expect(header()).toHaveAttribute('data-state', 'indeterminate');

    await user.click(header());
    expect(header()).toHaveAttribute('data-state', 'checked');
    // 25 filas, una deshabilitada ⇒ 24 seleccionadas
    expect(selection.get()).toHaveLength(24);
    expect(selection.get()).not.toContain('id-03');

    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(header()).toHaveAttribute('data-state', 'unchecked');
    await user.click(header());
    expect(selection.get()).toHaveLength(49);
    await user.click(header());
    expect(selection.get()).toHaveLength(24);
    expect(screen.getByText(/24 seleccionados · 24 en otras páginas/)).toBeInTheDocument();
  });

  it('teclado: Espacio selecciona la fila enfocada y ↓ mueve el foco', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const rows = screen.getAllByRole('row').slice(1);
    act(() => rows[0]!.focus());
    await user.keyboard(' ');
    expect(selection.get()).toEqual(['id-01']);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('cambiar el filtro reinicia el historial de cursores', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness filterKey="a" />);
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(screen.getByText(/Página 3/)).toBeInTheDocument();
    rerender(<Harness filterKey="b" />);
    // El cursor del padre lo reinicia la página al cambiar filtro; aquí el historial nuevo está vacío.
    await user.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(screen.getByText(/Página 1/)).toBeInTheDocument();
  });
});

describe('store de selección', () => {
  it(`respeta el límite de ${SELECTION_LIMIT} IDs y replace/clear`, () => {
    const many = Array.from({ length: SELECTION_LIMIT + 5 }, (_, i) => `x-${i}`);
    expect(selection.setMany(many, true)).toBe(5);
    expect(selection.get()).toHaveLength(SELECTION_LIMIT);
    expect(selection.toggle('extra', true)).toBe(false);
    expect(selection.toggle('x-0')).toBe(true);
    expect(selection.get()).toHaveLength(SELECTION_LIMIT - 1);
    selection.replace(many, 'scope-1');
    expect(caseSelectionStore.state.scopeKey).toBe('scope-1');
    expect(caseSelectionStore.state.ids.size).toBe(SELECTION_LIMIT);
    selection.clear();
    expect(selection.get()).toEqual([]);
  });
});

describe('DataTable · estados', () => {
  const base = { caption: 'Corridas', columns, getRowId: (r: Row) => r.id, empty: { title: 'No hay corridas', description: 'Crea una nueva ejecución' } };

  it('cargando sin datos ⇒ skeleton, sin estado vacío', () => {
    const { container } = render(<DataTable {...base} data={undefined} isLoading skeletonRows={3} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(screen.queryByText('No hay corridas')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('al paginar conserva las filas previas mientras busca (sin skeleton)', () => {
    const { rerender } = render(<DataTable {...base} data={ROWS.slice(0, 5)} />);
    rerender(<DataTable {...base} data={ROWS.slice(0, 5)} isLoading isFetching />);
    expect(rowsText()).toEqual(['Caso 1', 'Caso 2', 'Caso 3', 'Caso 4', 'Caso 5']);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('vacío ⇒ título y descripción', () => {
    render(<DataTable {...base} data={[]} />);
    expect(screen.getByText('No hay corridas')).toBeInTheDocument();
    expect(screen.getByText('Crea una nueva ejecución')).toBeInTheDocument();
  });

  it('error ⇒ mensaje, ID de solicitud y Reintentar', async () => {
    const onRetry = vi.fn();
    const error = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'Falló el servidor', requestId: 'req-77' });
    render(<DataTable {...base} data={undefined} error={error} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Falló el servidor');
    expect(screen.getByText(/req-77/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error con datos previos ⇒ conserva las filas', () => {
    const error = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
    render(<DataTable {...base} data={ROWS.slice(0, 2)} error={error} />);
    expect(rowsText()).toEqual(['Caso 1', 'Caso 2']);
  });

  it('403 ⇒ sin permiso y sin paginación', () => {
    const error = new ApiError({ status: 403, code: 'FORBIDDEN', message: 'x' });
    render(
      <DataTable
        {...base}
        data={undefined}
        error={error}
        pagination={{ pageIndex: 0, hasPrev: false, hasNext: true, onPrev: () => {}, onNext: () => {}, pageSize: 25, onPageSizeChange: () => {} }}
      />,
    );
    expect(screen.getByText('No tienes permiso para ver esta información')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('orden de servidor: el encabezado expone aria-sort y emite el cambio', async () => {
    const onChange = vi.fn();
    const sortable: ColumnDef<Row>[] = [{ id: 'title', accessorKey: 'title', header: 'Título' }];
    render(<DataTable {...base} columns={sortable} data={ROWS.slice(0, 2)} sorting={{ value: [{ id: 'title', desc: false }], onChange }} />);
    expect(screen.getByRole('columnheader', { name: /Título/ })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.setup().click(screen.getByRole('button', { name: /Título/ }));
    expect(onChange).toHaveBeenCalledWith([{ id: 'title', desc: true }]);
  });
});

function rowsText() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent);
}
