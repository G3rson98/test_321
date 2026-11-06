/**
 * Fallback de polling SOLO si el canal SSE cae (ESP §17.2): detalle activo 5 s, lista visible 30 s, con backoff
 * hasta 60 s; nunca con SSE sano, en pestaña oculta (refetchIntervalInBackground=false) ni en entidades terminales.
 */
import { useSelector } from '@tanstack/react-store';
import { sseStore, type SseState } from './manager';

export const POLL_BASE_MS = { detail: 5_000, list: 30_000 } as const;
export const POLL_MAX_MS = 60_000;

export function fallbackInterval(state: Pick<SseState, 'status' | 'failures'>, kind: keyof typeof POLL_BASE_MS): number | false {
  if (state.status === 'open' || state.status === 'idle' || state.status === 'connecting') return false;
  if (state.status === 'paused' || state.status === 'closed') return false;
  const exp = Math.max(0, Math.min(state.failures - 1, 4));
  return Math.min(POLL_BASE_MS[kind] * 2 ** exp, POLL_MAX_MS);
}

/** `refetchInterval` para useQuery. `active=false` (p. ej. corrida terminal) desactiva siempre. */
export function usePollingFallback(kind: keyof typeof POLL_BASE_MS, active = true): number | false {
  const state = useSelector(sseStore, (s) => s);
  if (!active) return false;
  return fallbackInterval(state, kind);
}

export function useSseStatus(): SseState['status'] {
  return useSelector(sseStore, (s) => s.status);
}
