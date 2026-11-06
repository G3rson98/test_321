/**
 * Sesión del panel: identidad por cookie HttpOnly (la API la emite); el cliente solo conserva en memoria el token
 * CSRF de doble envío que devuelve `/auth/me`. Logout/cambio de identidad borra Query, Store y borradores (ESP §17.1).
 */
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { can as roleCan, type Permission } from '@katalyst/shared/rbac';
import type { PanelRole } from '@katalyst/shared/enums';
import { authApi } from '../api/endpoints';
import { isApiError, resetRateLimits, setCsrfToken } from '../api/client';
import type { Me } from '../api/types';
import { qk, setQueryScope } from '../query/keys';
import { setDisplayTimezone } from '../format';
import { selection } from '../stores/selection';
import { clearSensitiveStorage } from '../prefs';
import { stopSse } from '../sse/manager';

export function applySession(me: Me | null): void {
  setCsrfToken(me?.session.csrfToken ?? null);
  setDisplayTimezone(me?.timezone);
  setQueryScope(me?.user.id ?? null, me?.user.role ?? null);
}

export const sessionQuery = queryOptions({
  queryKey: qk.session(),
  queryFn: async ({ signal }): Promise<Me | null> => {
    try {
      const me = await authApi.me(signal);
      applySession(me);
      return me;
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        applySession(null);
        return null;
      }
      throw e;
    }
  },
});

export function useSession(): Me | null {
  const { data } = useQuery(sessionQuery);
  return data ?? null;
}

export function useRole(): PanelRole | null {
  return useSession()?.user.role ?? null;
}

/**
 * ¿Puede la identidad actual? Rol (matriz de @katalyst/shared/rbac) ∩ permisos que informó el servidor.
 * Solo decide visibilidad; el servidor sigue siendo la autoridad (403).
 */
export function canSession(me: Me | null, permission: Permission): boolean {
  if (!me) return false;
  if (!roleCan(me.user.role, permission)) return false;
  return me.permissions.length === 0 || me.permissions.includes(permission);
}

export function useCan(permission: Permission): boolean {
  return canSession(useSession(), permission);
}

/** Limpia todo estado autenticado del navegador (Query, Store, borradores, SSE). */
export function clearClientState(qc: QueryClient): void {
  stopSse();
  qc.cancelQueries();
  qc.clear();
  selection.clear();
  clearSensitiveStorage();
  resetRateLimits();
  applySession(null);
}

export async function logout(qc: QueryClient): Promise<void> {
  try {
    await authApi.logout();
  } catch {
    /* aunque falle la red, el cliente se limpia */
  }
  clearClientState(qc);
  qc.setQueryData(qk.session(), null);
}
