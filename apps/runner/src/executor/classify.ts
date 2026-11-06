/**
 * Clasificación de resultados de Playwright (ESP §13.2): falla funcional de la aplicación vs. infraestructura vs.
 * login vs. política. Usa el prefijo `[codigo]` de qa-tests/fixtures/errors.ts. Un timeout de una operación de la
 * app es FALLA DEL TEST (`timeout_aplicacion`); no poder aprovisionar el navegador es infraestructura
 * (`navegador_no_disponible`). RF-EJE-05, RF-EJE-08, RF-RES-01, RF-RES-05.
 */
import {
  FUNCTIONAL_ERROR_CATEGORIES,
  finalResultFromAttempts,
  type AttemptKind,
  type AttemptStatus,
  type ErrorCategory,
  type ResultReason,
  type RunResultStatus,
} from '@katalyst/shared';
import type { ReporterErrorInfo } from '../reporter/protocol.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Código estable `[codigo]` al inicio del mensaje (tolera el prefijo `Error: ` de Playwright). */
export function extractErrorCode(message: string | undefined): string | null {
  if (!message) return null;
  const m = /^\s*(?:[A-Za-z]*Error:\s*)?\[([a-z0-9_]+)\]/.exec(stripAnsi(message));
  return m?.[1] ?? null;
}

/** Mapa de códigos de qa-tests/fixtures/errors.ts → categoría (D-010). */
export const CODE_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  configuracion_invalida: 'configuracion',
  ambiente_no_configurado: 'configuracion',
  politica_artefactos_insegura: 'politica',
  storage_state_ruta_insegura: 'configuracion',
  auth_credenciales_no_disponibles: 'login',
  auth_credenciales_ruta_insegura: 'configuracion',
  auth_formulario_no_disponible: 'login',
  auth_credenciales_invalidas: 'login',
  auth_desafio_mfa: 'login',
  auth_cognito_error: 'login',
  auth_timeout: 'login',
  auth_current_fallido: 'login',
  auth_identidad_no_verificable: 'login',
  auth_identidad_inesperada: 'login',
  auth_ambiente_inesperado: 'login',
  datos_escritura_en_produccion: 'politica',
  datos_fuera_de_prefijo: 'politica',
  datos_cleanup_fallido: 'error_aplicacion',
  dxmon_no_disponible: 'configuracion',
  dxmon_no_versionado: 'configuracion',
  dxmon_hash_no_coincide: 'configuracion',
  dxmon_api_incompatible: 'configuracion',
  dxmon_endpoint_no_permitido: 'politica',
  rendimiento_ciclo_excedido: 'timeout_aplicacion',
  rendimiento_raiz_no_disponible: 'error_aplicacion',
  rendimiento_salida_invalida: 'infraestructura',
};

const BROWSER_UNAVAILABLE_RE =
  /browserType\.launch|Executable doesn't exist|Failed to launch|Browser closed unexpectedly|browser has been closed.*(?:crash|unexpectedly)|npx playwright install|Host system is missing dependencies/i;
const TIMEOUT_RE = /\bTimeout \d+ms exceeded|TimeoutError|\btimed out\b|Test timeout of \d+ms exceeded/i;
const ASSERTION_RE = /\bexpect\(|\bExpected\b|\bReceived\b|toBe[A-Z]?|toHave[A-Z]|toEqual|toContain|toMatch/;

export function isFunctionalCategory(c: ErrorCategory | null): boolean {
  return c !== null && (FUNCTIONAL_ERROR_CATEGORIES as readonly string[]).includes(c);
}

/** Categoría de un intento fallido / con timeout. */
export function categorizeFailure(status: 'failed' | 'timedOut', errors: readonly ReporterErrorInfo[]): ErrorCategory {
  const first = errors.find((e) => e.message || e.value);
  const message = stripAnsi(first?.message ?? first?.value ?? '');
  const code = extractErrorCode(message);
  if (code && CODE_CATEGORY[code]) return CODE_CATEGORY[code]!;
  const all = errors.map((e) => stripAnsi(`${e.message ?? ''}\n${e.stack ?? ''}`)).join('\n');
  if (BROWSER_UNAVAILABLE_RE.test(all)) return 'navegador_no_disponible';
  if (status === 'timedOut') return 'timeout_aplicacion';
  if (TIMEOUT_RE.test(message)) return 'timeout_aplicacion';
  if (ASSERTION_RE.test(message)) return 'asercion';
  return 'error_aplicacion';
}

export interface AttemptOutcome {
  attemptStatus: Exclude<AttemptStatus, 'corriendo'>;
  errorCategory: ErrorCategory | null;
  reason: ResultReason | null;
}

export type StopCause = 'cancel' | 'run_timeout' | 'setup_timeout' | 'lease_lost' | 'shutdown' | null;

/** Estado del intento a partir del resultado de Playwright. */
export function attemptOutcome(
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted',
  expectedStatus: string,
  errors: readonly ReporterErrorInfo[],
  stopCause: StopCause,
): AttemptOutcome {
  if (status === 'skipped') return { attemptStatus: 'omitido', errorCategory: null, reason: null };
  if (status === 'interrupted') {
    if (stopCause === 'cancel') return { attemptStatus: 'cancelado', errorCategory: 'cancelacion', reason: 'cancelado_por_usuario' };
    if (stopCause === 'run_timeout')
      return { attemptStatus: 'error_infraestructura', errorCategory: 'timeout_corrida', reason: 'timeout_corrida' };
    if (stopCause === 'setup_timeout')
      return { attemptStatus: 'error_infraestructura', errorCategory: 'login', reason: 'timeout_preparacion' };
    return { attemptStatus: 'error_infraestructura', errorCategory: 'infraestructura', reason: 'error_interno' };
  }
  if (status === expectedStatus) return { attemptStatus: 'pasado', errorCategory: null, reason: null };
  if (status === 'passed') {
    // `test.fail()` que pasó: comportamiento esperado no se cumplió (falla funcional).
    return { attemptStatus: 'fallido', errorCategory: 'asercion', reason: null };
  }
  const category = categorizeFailure(status, errors);
  if (isFunctionalCategory(category)) {
    return { attemptStatus: 'fallido', errorCategory: category, reason: status === 'timedOut' ? 'timeout_test' : null };
  }
  const reason: ResultReason | null =
    category === 'login'
      ? 'login_fallido'
      : category === 'navegador_no_disponible'
        ? 'dependencia_fallida'
        : extractErrorCode(errors[0]?.message) === 'datos_escritura_en_produccion'
          ? 'escritura_en_produccion'
          : null;
  return { attemptStatus: 'error_infraestructura', errorCategory: category, reason };
}

export interface RecordedAttempt {
  attemptNo: number;
  kind: AttemptKind;
  status: Exclude<AttemptStatus, 'corriendo'>;
  errorCategory: ErrorCategory | null;
  durationMs: number;
  reason: ResultReason | null;
}

/**
 * Estado final del test (no habrá más intentos). Usa `finalResultFromAttempts` de shared (inestable tras retry
 * funcional) y refina: política/configuración/login ⇒ `bloqueado` (no es falla de la app ni del runner).
 */
export function finalStatusOf(attempts: readonly RecordedAttempt[]): {
  status: Exclude<RunResultStatus, 'pendiente' | 'corriendo'>;
  reason: ResultReason | null;
} {
  const last = attempts.at(-1);
  const base = finalResultFromAttempts(attempts).status;
  const status = (base === 'pendiente' || base === 'corriendo' ? 'error_infraestructura' : base) as Exclude<
    RunResultStatus,
    'pendiente' | 'corriendo'
  >;
  if (last && last.status === 'error_infraestructura' && ['politica', 'configuracion', 'login'].includes(last.errorCategory ?? '')) {
    return { status: 'bloqueado', reason: last.reason };
  }
  return { status, reason: last?.reason ?? null };
}
