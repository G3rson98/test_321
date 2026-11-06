import { useEffect, useRef, useState } from 'react';

/** Valor con debounce (búsquedas: 300 ms, ESP §17.2). La cancelación la hace Query vía AbortSignal por clave. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Historial de cursores por filtro/sort (ESP §17.3): adapta `pageIndex` visual a la pila de cursores del mismo
 * filtro. Cambiar el filtro reinicia el historial. Vive en memoria (no es dato sensible ni persistente).
 */
const histories = new Map<string, (string | undefined)[]>();

export interface CursorPager {
  pageIndex: number;
  hasPrev: boolean;
  next: (nextCursor: string) => void;
  prev: () => void;
  reset: () => void;
}

export function useCursorHistory(
  filterKey: string,
  cursor: string | undefined,
  setCursor: (c: string | undefined) => void,
): CursorPager {
  const keyRef = useRef(filterKey);
  if (!histories.has(filterKey)) histories.set(filterKey, []);
  if (keyRef.current !== filterKey) {
    histories.delete(keyRef.current);
    keyRef.current = filterKey;
    histories.set(filterKey, []);
  }
  const stack = histories.get(filterKey)!;
  // Si el cursor actual no está al final de la pila (p. ej. recarga con ?cursor=), la pila conserva lo conocido.
  const pageIndex = cursor === undefined ? 0 : Math.max(1, stack.length);
  return {
    pageIndex,
    hasPrev: cursor !== undefined,
    next: (nextCursor) => {
      stack.push(cursor);
      setCursor(nextCursor);
    },
    prev: () => {
      const prevCursor = stack.pop();
      setCursor(prevCursor);
    },
    reset: () => {
      histories.set(filterKey, []);
      setCursor(undefined);
    },
  };
}

/** Solo pruebas. */
export function __resetCursorHistories(): void {
  histories.clear();
}
