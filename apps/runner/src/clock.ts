/**
 * Reloj inyectable (pruebas deterministas de heartbeat, timeouts y cancelación). RNF-CON-01, ESP §13.3.
 */
export interface Clock {
  now(): number;
  /** Espera `ms` o hasta que `signal` aborte (resuelve sin lanzar). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, Math.max(0, ms));
      function done(): void {
        clearTimeout(t);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};
