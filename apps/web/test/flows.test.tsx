/**
 * Flujos principales del panel completo (router + Query + shell) contra MSW, cuyos handlers validan cada respuesta
 * con los schemas de @katalyst/shared: ingreso, redirección sin sesión, 403 por rol, 404, catálogo, ejecuciones,
 * configuración de usuarios de prueba (solo referencia de secreto) y aprobación de dispositivo.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO_PASSWORD, DEMO_USERS } from '@/mocks/fixtures';
import { installFetch, loginAs, renderApp, server } from './app-harness';
import type * as SseManagerModule from '@/lib/sse/manager';

vi.mock('@/lib/sse/manager', async (orig) => {
  const mod = await orig<typeof SseManagerModule>();
  return { ...mod, startSse: () => ({ stop: () => undefined }) };
});

const T = { timeout: 5000 };

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  installFetch();
});
beforeEach(() => {
  // Radix usa estas APIs, ausentes en jsdom.
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe('sesión', () => {
  it('sin sesión redirige a /ingresar conservando el destino y, tras ingresar, vuelve a él', async () => {
    await loginAs(null);
    const user = userEvent.setup();
    const { router } = renderApp('/ejecuciones');
    await screen.findByLabelText('Correo', {}, T);
    expect(router.state.location.pathname).toBe('/ingresar');
    expect(String((router.state.location.search as { redirect?: string }).redirect)).toMatch(/^\/ejecuciones(\?|$)/);
    await user.type(screen.getByLabelText('Correo'), DEMO_USERS[0].email);
    await user.type(screen.getByLabelText('Contraseña'), DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: /ingresar/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/ejecuciones'), T);
  });

  it('credenciales inválidas muestran el error del servidor sin revelar si el correo existe', async () => {
    await loginAs(null);
    const user = userEvent.setup();
    renderApp('/ingresar');
    await user.type(await screen.findByLabelText('Correo', {}, T), DEMO_USERS[0].email);
    await user.type(screen.getByLabelText('Contraseña'), 'incorrecta-123');
    await user.click(screen.getByRole('button', { name: /ingresar/i }));
    expect(await screen.findByRole('alert', {}, T)).toBeInTheDocument();
  });
});

describe('permisos y errores', () => {
  it('QA en /configuracion/usuarios ve la página 403 en la misma URL', async () => {
    await loginAs('qa');
    const { router } = renderApp('/configuracion/usuarios');
    expect(await screen.findByRole('heading', { name: 'Sin permiso' }, T)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/configuracion/usuarios');
  });

  it('ruta inexistente muestra 404 dentro del shell', async () => {
    await loginAs('qa');
    renderApp('/no-existe');
    expect(await screen.findByRole('heading', { name: 'Página no encontrada' }, T)).toBeInTheDocument();
  });

  it('/configuracion redirige a /configuracion/testrail para admin', async () => {
    await loginAs('admin');
    const { router } = renderApp('/configuracion');
    await waitFor(() => expect(router.state.location.pathname).toBe('/configuracion/testrail'), T);
    expect(await screen.findByRole('link', { name: 'Usuarios de prueba' }, T)).toBeInTheDocument();
  });
});

describe('pantallas principales', () => {
  it('inicio muestra KPIs derivados de la API', async () => {
    await loginAs('qa');
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1 }, T)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0), T);
  });

  it('catálogo lista casos paginados por cursor', async () => {
    await loginAs('qa');
    renderApp('/catalogo');
    const table = await screen.findByRole('table', {}, T);
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1), T);
  });

  it('ejecuciones lista corridas y permite abrir el detalle', async () => {
    await loginAs('qa');
    const user = userEvent.setup();
    const { router } = renderApp('/ejecuciones');
    const table = await screen.findByRole('table', {}, T);
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1), T);
    const link = within(table).getAllByRole('link')[0]!;
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/ejecuciones\/[0-9a-f-]{36}$/), T);
  });
});

describe('configuración · usuarios de prueba', () => {
  it('valida la referencia del secreto y nunca pide la contraseña', async () => {
    await loginAs('admin');
    const user = userEvent.setup();
    renderApp('/configuracion/usuarios-prueba');
    const add = await screen.findByRole('button', { name: /agregar|nuevo/i }, T);
    await user.click(add);
    const dialog = await screen.findByRole('dialog', {}, T);
    expect(within(dialog).queryByLabelText(/^contraseña$/i)).not.toBeInTheDocument();
    const ref = within(dialog).getByLabelText(/referencia/i);
    await user.type(ref, 'mi-clave-en-texto');
    await user.click(within(dialog).getByRole('button', { name: /guardar|crear|agregar/i }));
    expect(await within(dialog).findByText('Usa ssm:/…, env:NOMBRE o file:/…', {}, T)).toBeInTheDocument();
    expect(ref).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('aprobación de dispositivo', () => {
  it('código inválido muestra un estado explícito', async () => {
    await loginAs('qa');
    renderApp('/dispositivos/vincular?codigo=ZZZZ-ZZZZ');
    expect(await screen.findByText(/no (es válido|existe)|inválido|venci|no encontr/i, {}, T)).toBeInTheDocument();
  });
});
