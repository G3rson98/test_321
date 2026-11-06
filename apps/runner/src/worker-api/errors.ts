/**
 * Errores de la API de worker. `{ error: { code, message, requestId } }` (D-009). El fencing devuelve 409
 * `LEASE_STALE`/`LEASE_EXPIRED`: el ejecutor debe detenerse sin reintentar (ESP §13.3, RNF-CON-01).
 */
export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkerApiError';
  }
}

export function errorCode(e: unknown): string | null {
  return e instanceof WorkerApiError ? e.code : null;
}

/** Lease obsoleto/vencido/inexistente o token revocado: detener el ejecutor (fencing). */
export function isLeaseLost(e: unknown): boolean {
  if (!(e instanceof WorkerApiError)) return false;
  if (e.status === 409 && (e.code === 'LEASE_STALE' || e.code === 'LEASE_EXPIRED')) return true;
  if (e.status === 404 && e.code === 'LEASE_NOT_FOUND') return true;
  return e.status === 401;
}

export function isCallbackConflict(e: unknown): boolean {
  return e instanceof WorkerApiError && e.status === 409 && e.code === 'CALLBACK_CONFLICT';
}
