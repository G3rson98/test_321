/**
 * Tiempos de referencia. Separados en dos grupos (ESP §13.3): timeouts administrativos de Katalyst (test, auth,
 * corrida) y timeouts reales del frontend de FMS DeltaX (ESP §2 "Hallazgos"). Los segundos se usan para esperar
 * servicios: no se reducen para ocultar fallas conocidas ni se amplían por encima de lo que el usuario tolera.
 */

/** Timeout de test funcional (ESP §13.3). */
export const TEST_TIMEOUT_MS = 120_000;
/** Timeout de preparación/autenticación (ESP §13.3). */
export const AUTH_TIMEOUT_MS = 120_000;
/** Límite de la corrida de rendimiento: un ciclo debe completar en <= 4 min (ESP §13.3, §13.8). */
export const PERF_RUN_LIMIT_MS = 240_000;

/** El frontend corta `users/api/users/current` a los 30 s (con 3 reintentos). */
export const FRONTEND_CURRENT_TIMEOUT_MS = 30_000;
/** El frontend corta las llamadas de filtros a los 20 s. */
export const FRONTEND_FILTER_TIMEOUT_MS = 20_000;
/**
 * Lista de Agendamientos: llegó a no cargar en 60 s (hallazgo ESP §2). Se espera hasta ese límite conocido para
 * evidenciar la falla en lugar de esconderla con un timeout menor.
 */
export const SCHEDULING_LIST_TIMEOUT_MS = 60_000;
/** Servicios auxiliares de pantalla sin timeout de frontend documentado (place, i18n, notificaciones...). */
export const DEFAULT_SERVICE_TIMEOUT_MS = 30_000;
/** Respuesta "de más de 29 s" (RF-REN-05): estrictamente mayor. */
export const OVER_29S_MS = 29_000;
/** Espera de condición visual (grilla lista, encabezados) tras recibir la respuesta del servicio. */
export const UI_READY_TIMEOUT_MS = 20_000;
