/**
 * Acceso del renderer al asistente: solo `window.katalyst` (preload). El renderer no hace red ni tiene Node.
 * El estado lo publica main; aquí solo se observa (sin copias de entidades).
 */
import { useCallback, useEffect, useState } from 'react';
import type { AppState, IpcResult } from '../../../shared/ipc';

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = window.katalyst.onState((s) => {
      if (alive) setState(s);
    });
    void window.katalyst.getState().then((r) => {
      if (alive && r.ok) setState(r.data);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/** Ejecuta un comando y expone `pending`/`error` para deshabilitar botones en vuelo (sin doble clic). */
export function useCommand() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(r.error.message);
        return undefined;
      }
      return r.data;
    } catch {
      setError('No se pudo comunicar con el asistente.');
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, setError, run };
}

const TZ = 'America/La_Paz';

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-BO', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function formatRemaining(iso: string | null, now: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'vencida';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `vence en ${h} h ${m} min`;
  if (totalMin >= 1) return `vence en ${totalMin} min`;
  return `vence en ${Math.max(1, Math.floor(ms / 1000))} s`;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
