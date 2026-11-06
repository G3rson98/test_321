/**
 * Resultado final por test a partir de intentos, y reglas de retry/recuperación (ESP §13.3).
 * - Retries funcionales (0..2) y recuperación por infraestructura (máx. 1) son contadores distintos.
 * - Pasar tras retry funcional ⇒ `inestable`; pasar tras recuperación técnica ⇒ `pasado` con bandera de recuperación.
 * - Escritura sin idempotencia aprobada no se reintenta; escritura en curso perdida ⇒ resultado desconocido
 *   (`error_infraestructura`), sin repetición automática.
 * RF-EJE-05, RF-EJE-08, RNF-CON-01.
 */
import {
  FUNCTIONAL_ERROR_CATEGORIES,
  type AttemptKind,
  type AttemptStatus,
  type Classification,
  type ErrorCategory,
  type RunResultStatus,
} from '../enums.js';

export const MAX_INFRA_RECOVERIES = 1;

export interface AttemptLike {
  attemptNo: number;
  kind: AttemptKind;
  status: AttemptStatus;
  errorCategory?: ErrorCategory | null;
  durationMs?: number | null;
}

export interface TestPolicy {
  retries: number;
  classification: Classification;
  writeIdempotencyApproved: boolean;
}

export function isFunctionalFailure(a: Pick<AttemptLike, 'status' | 'errorCategory'>): boolean {
  if (a.status !== 'fallido') return false;
  return a.errorCategory == null || (FUNCTIONAL_ERROR_CATEGORIES as readonly string[]).includes(a.errorCategory);
}

export function retryCountOf(attempts: readonly AttemptLike[]): number {
  return attempts.filter((a) => a.kind === 'retry').length;
}

export function infraRecoveryCountOf(attempts: readonly AttemptLike[]): number {
  return attempts.filter((a) => a.kind === 'recuperacion').length;
}

/** ¿Se permite un retry funcional tras el último intento? */
export function canRetry(attempts: readonly AttemptLike[], policy: TestPolicy): boolean {
  const last = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo).at(-1);
  if (!last || !isFunctionalFailure(last)) return false;
  if (policy.classification === 'sin_clasificar') return false;
  if (policy.classification === 'escritura' && !policy.writeIdempotencyApproved) return false;
  return retryCountOf(attempts) < Math.min(Math.max(policy.retries, 0), 2);
}

/**
 * ¿Se permite recuperación por infraestructura de un test EN CURSO al perder el lease?
 * Solo lectura, una vez. Escritura en curso ⇒ nunca (resultado desconocido).
 */
export function canRecover(attempts: readonly AttemptLike[], policy: Pick<TestPolicy, 'classification'>): boolean {
  if (policy.classification !== 'lectura') return false;
  return infraRecoveryCountOf(attempts) < MAX_INFRA_RECOVERIES;
}

/** Estado del intento perdido al vencer el lease (ESP §13.3). */
export function lostAttemptOutcome(policy: Pick<TestPolicy, 'classification'>): {
  status: AttemptStatus;
  errorCategory: ErrorCategory;
} {
  return policy.classification === 'lectura'
    ? { status: 'error_infraestructura', errorCategory: 'worker_perdido' }
    : { status: 'error_infraestructura', errorCategory: 'resultado_desconocido' };
}

export interface FinalResult {
  status: RunResultStatus;
  retryCount: number;
  infraRecoveryCount: number;
  /** Suma de duraciones de intentos (tiempo de trabajo). */
  durationMs: number | null;
  recovered: boolean;
}

/** Resultado final del test según sus intentos (asume que no quedan reintentos pendientes). */
export function finalResultFromAttempts(attempts: readonly AttemptLike[]): FinalResult {
  const sorted = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const retryCount = retryCountOf(sorted);
  const infraRecoveryCount = infraRecoveryCountOf(sorted);
  const durations = sorted.map((a) => a.durationMs).filter((d): d is number => typeof d === 'number');
  const durationMs = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
  const last = sorted.at(-1);
  const base = { retryCount, infraRecoveryCount, durationMs, recovered: infraRecoveryCount > 0 };
  if (!last) return { ...base, status: 'pendiente' };
  switch (last.status) {
    case 'corriendo':
      return { ...base, status: 'corriendo' };
    case 'pasado': {
      const hadFunctionalFailure = sorted.slice(0, -1).some((a) => isFunctionalFailure(a));
      return { ...base, status: hadFunctionalFailure ? 'inestable' : 'pasado' };
    }
    case 'fallido':
      return { ...base, status: isFunctionalFailure(last) ? 'fallido' : 'error_infraestructura' };
    case 'omitido':
      return { ...base, status: 'omitido' };
    case 'cancelado':
      return { ...base, status: 'cancelado' };
    case 'error_infraestructura':
      return { ...base, status: 'error_infraestructura' };
  }
}

/** Número de reintento (1-based) en que pasó un test inestable, o null. */
export function passedOnRetryNumber(attempts: readonly AttemptLike[]): number | null {
  const sorted = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const last = sorted.at(-1);
  if (!last || last.status !== 'pasado' || last.kind !== 'retry') return null;
  return sorted.filter((a) => a.kind === 'retry').length;
}
