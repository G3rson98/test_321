/**
 * Arnés de pruebas de flujo: el panel completo (router + Query + shell) contra los handlers MSW (msw/node), que
 * validan cada respuesta con los schemas de @katalyst/shared (mocks/contract.ts). El SSE se sustituye por un stub:
 * su comportamiento se prueba en sse-manager.test.ts.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { handlers, mockLogin, mockLogout } from '@/mocks/handlers';
import { DEMO_USERS } from '@/mocks/fixtures';
import { setCsrfToken, setFetchImpl } from '@/lib/api/client';
import { authApi } from '@/lib/api/endpoints';
import { createQueryClient } from '@/lib/query/client';
import { TooltipProvider } from '@/components/ui/popover';
import { routeTree } from '@/app/router';

export const server = setupServer(...handlers);

/**
 * fetch de Node no acepta URLs relativas (se resuelven contra el origen de jsdom; MSW intercepta igual) ni el
 * AbortSignal de jsdom (undici exige el suyo): la cancelación se respeta antes de enviar y se prueba en
 * http-client.test.ts.
 */
export function installFetch(): void {
  setFetchImpl(((input: RequestInfo | URL, init: RequestInit = {}) => {
    const { signal, ...rest } = init;
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return globalThis.fetch(typeof input === 'string' ? new URL(input, window.location.origin) : input, rest);
  }) as typeof fetch);
}

export type DemoRole = 'qa' | 'dev' | 'admin';
/** Abre la sesión simulada y deja el token CSRF en el cliente (como hace `sessionQuery` en la app). */
export async function loginAs(role: DemoRole | null): Promise<void> {
  mockLogout();
  setCsrfToken(null);
  if (!role) return;
  const u = DEMO_USERS.find((x) => x.role === role)!;
  mockLogin(u.email);
  const me = await authApi.me();
  setCsrfToken(me.session.csrfToken);
}

export function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history, context: { queryClient }, defaultPendingMinMs: 0 });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
