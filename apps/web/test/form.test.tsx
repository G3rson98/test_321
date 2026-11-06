/**
 * Formularios (ESP §17.4): primer error por campo, errores 422 del servidor en sus campos y resumen de los no
 * asignados, limpieza al editar, estado dirty y guarda de navegación (DirtyGuard) con cambios sin guardar.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from '@tanstack/react-form';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';
import { ApiError } from '@/lib/api/client';
import { applyServerErrors, clearServerError, firstError } from '@/lib/form';
import { DirtyGuard } from '@/components/common/dirty-guard';

afterEach(cleanup);

const validation = (issues: { path: (string | number)[]; message: string }[]) =>
  new ApiError({
    status: 422,
    code: 'VALIDATION_FAILED',
    message: 'Datos inválidos',
    details: { issues: issues.map((i) => ({ ...i, code: 'custom' })) },
  });

describe('firstError', () => {
  it('toma el primer string o issue con message e ignora vacíos', () => {
    expect(firstError(undefined)).toBeNull();
    expect(firstError([undefined, null, ''])).toBeNull();
    expect(firstError([undefined, 'Requerido', 'otro'])).toBe('Requerido');
    expect(firstError([{ message: 'Muy corto', path: ['name'] }])).toBe('Muy corto');
    expect(firstError([{ nope: 1 }])).toBeNull();
  });
});

describe('applyServerErrors / clearServerError', () => {
  it('asigna por campo (incluye rutas anidadas) y devuelve los no asignados', () => {
    const metas: Record<string, { errorMap?: Record<string, unknown> }> = {};
    const form = {
      setFieldMeta: vi.fn((field: string, up: (p: unknown) => { errorMap?: Record<string, unknown> }) => {
        metas[field] = up(metas[field]);
      }),
    };
    const left = applyServerErrors(
      form as never,
      validation([
        { path: ['name'], message: 'Ya existe una suite con ese nombre' },
        { path: ['selector', 'tags', 1], message: 'Etiqueta desconocida' },
        { path: ['version'], message: 'Versión requerida' },
      ]),
      ['name', 'selector'],
    );
    expect(metas['name']!.errorMap!['onServer']).toBe('Ya existe una suite con ese nombre');
    expect(metas['selector']!.errorMap!['onServer']).toBe('Etiqueta desconocida');
    expect(left).toEqual(['Versión requerida']);
    clearServerError(form as never, 'name');
    expect(metas['name']!.errorMap!['onServer']).toBeUndefined();
  });

  it('errores que no son de validación no asignan nada', () => {
    const form = { setFieldMeta: vi.fn() };
    expect(applyServerErrors(form as never, new Error('x'), ['name'])).toEqual([]);
    expect(form.setFieldMeta).not.toHaveBeenCalled();
  });
});

/** Formulario real de TanStack Form con el patrón de las páginas (validación Zod + 422 del servidor). */
function SuiteLikeForm({ submit }: { submit: (v: { name: string; description: string }) => Promise<void> }) {
  const [summary, setSummary] = useState<string[]>([]);
  const form = useForm({
    defaultValues: { name: 'Regresión', description: '' },
    validators: { onChange: z.object({ name: z.string().min(3, 'Mínimo 3 caracteres'), description: z.string() }) },
    onSubmit: async ({ value }) => {
      try {
        await submit(value);
      } catch (e) {
        setSummary(applyServerErrors(form as never, e, ['name', 'description']));
      }
    },
  });
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(f) => (
          <>
            <label htmlFor="name">Nombre</label>
            <input
              id="name"
              value={f.state.value}
              onChange={(e) => {
                clearServerError(form as never, 'name');
                f.handleChange(e.target.value);
              }}
            />
            <span data-testid="name-error">{firstError(f.state.meta.errors) ?? ''}</span>
          </>
        )}
      </form.Field>
      <form.Subscribe selector={(s) => s.isDirty}>{(d) => <span data-testid="dirty">{String(d)}</span>}</form.Subscribe>
      {summary.map((m) => (
        <p key={m} role="alert">
          {m}
        </p>
      ))}
      <button type="submit">Guardar</button>
    </form>
  );
}

describe('formulario con TanStack Form', () => {
  it('detecta cambios (dirty), valida en cliente y muestra errores 422 del servidor por campo y en resumen', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => {
      throw validation([
        { path: ['name'], message: 'Ya existe una suite con ese nombre' },
        { path: ['selector'], message: 'La suite no selecciona casos' },
      ]);
    });
    render(<SuiteLikeForm submit={submit} />);
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');

    const input = screen.getByLabelText('Nombre');
    await user.clear(input);
    await user.type(input, 'ab');
    expect(screen.getByTestId('dirty')).toHaveTextContent('true');
    expect(screen.getByTestId('name-error')).toHaveTextContent('Mínimo 3 caracteres');

    await user.type(input, 'c');
    expect(screen.getByTestId('name-error')).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('name-error')).toHaveTextContent('Ya existe una suite con ese nombre'));
    expect(screen.getByRole('alert')).toHaveTextContent('La suite no selecciona casos');

    // Editar el campo limpia el error del servidor.
    await user.type(input, 'd');
    expect(screen.getByTestId('name-error')).toHaveTextContent('');
  });
});

describe('DirtyGuard', () => {
  function setup(dirty: { current: boolean }) {
    const root = createRootRoute({
      component: () => (
        <>
          <Link to={"/otra" as never}>Ir a otra</Link>
          <Outlet />
        </>
      ),
    });
    const formRoute = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: function F() {
        const [d, setD] = useState(dirty.current);
        return (
          <>
            <button type="button" onClick={() => setD(true)}>
              Editar
            </button>
            <DirtyGuard when={d} />
            <p>Formulario</p>
          </>
        );
      },
    });
    const other = createRoute({ getParentRoute: () => root, path: '/otra', component: () => <p>Otra página</p> });
    const router = createRouter({ routeTree: root.addChildren([formRoute, other]), history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(<RouterProvider router={router} />);
    return router;
  }

  it('sin cambios navega directamente', async () => {
    const user = userEvent.setup();
    setup({ current: false });
    await screen.findByText('Formulario');
    await user.click(screen.getByText('Ir a otra'));
    expect(await screen.findByText('Otra página')).toBeInTheDocument();
  });

  it('con cambios bloquea, permite volver y luego salir sin guardar', async () => {
    const user = userEvent.setup();
    const router = setup({ current: false });
    await screen.findByText('Formulario');
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    await user.click(screen.getByText('Ir a otra'));
    expect(await screen.findByText('Hay cambios sin guardar')).toBeInTheDocument();
    expect(screen.getByText('Formulario')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Volver' }));
    await waitFor(() => expect(screen.queryByText('Hay cambios sin guardar')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/');

    await user.click(screen.getByText('Ir a otra'));
    await user.click(await screen.findByRole('button', { name: 'Salir sin guardar' }));
    expect(await screen.findByText('Otra página')).toBeInTheDocument();
    await act(async () => {});
    expect(router.state.location.pathname).toBe('/otra');
  });
});
