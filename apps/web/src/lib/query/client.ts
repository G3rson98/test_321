/**
 * Una QueryClient por aplicación autenticada con defaults explícitos (ESP §17.2):
 * catálogo/suites 60 s, configuración 300 s, listas operativas 15 s, resultados terminales 300 s, gcTime 10 min.
 * GET reintenta una vez ante red/5xx; nunca 401/403/404/409/422; 429 espera Retry-After. Mutaciones sin retry.
 */
import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '../api/client';

export const STALE = {
  catalog: 60_000,
  config: 300_000,
  operational: 15_000,
  terminal: 300_000,
} as const;
export const GC_TIME = 10 * 60_000;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.status === 429) return failureCount < 1;
    if (error.status === 0 || error.status >= 500) return failureCount < 1;
    return false;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return false;
}

export function retryDelay(_attempt: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterMs !== null) return Math.min(error.retryAfterMs, 60_000);
  return 1_000;
}

export function createQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE.operational,
        gcTime: GC_TIME,
        retry: shouldRetryQuery,
        retryDelay,
        refetchOnWindowFocus: false,
        refetchIntervalInBackground: false,
      },
      mutations: { retry: false },
    },
  });
  qc.setQueryDefaults(['catalog'], { staleTime: STALE.catalog });
  qc.setQueryDefaults(['suites'], { staleTime: STALE.catalog });
  qc.setQueryDefaults(['config'], { staleTime: STALE.config });
  qc.setQueryDefaults(['auth'], { staleTime: STALE.config });
  qc.setQueryDefaults(['session'], { staleTime: STALE.config, retry: false });
  return qc;
}
