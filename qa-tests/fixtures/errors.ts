/**
 * Errores con causa clasificada y código estable (ESP §13.2: "Cada resultado lleva causa legible y código estable";
 * "Una falla de login se clasifica por causa").
 *
 * Formato del mensaje: `[<codigo>] <mensaje legible>`. El ejecutor de Katalyst extrae el código con
 * `/^\[([a-z0-9_]+)\]/` sobre `error.message` del reporte JSON de Playwright. Los mensajes nunca incluyen
 * credenciales, tokens, cuerpos de respuesta ni el nombre del usuario de prueba.
 */
export const ERROR_CODES = [
  // Configuración
  'configuracion_invalida',
  'ambiente_no_configurado',
  'politica_artefactos_insegura',
  'storage_state_ruta_insegura',
  // Autenticación (RF-AMB-03, Bloque 0)
  'auth_credenciales_no_disponibles',
  'auth_credenciales_ruta_insegura',
  'auth_formulario_no_disponible',
  'auth_credenciales_invalidas',
  'auth_desafio_mfa',
  'auth_cognito_error',
  'auth_timeout',
  'auth_current_fallido',
  'auth_identidad_no_verificable',
  'auth_identidad_inesperada',
  'auth_ambiente_inesperado',
  // Datos de prueba (ESP §10 reglas 6 y 10)
  'datos_escritura_en_produccion',
  'datos_fuera_de_prefijo',
  'datos_cleanup_fallido',
  // Rendimiento / DXMon (ESP §13.8)
  'dxmon_no_disponible',
  'dxmon_no_versionado',
  'dxmon_hash_no_coincide',
  'dxmon_api_incompatible',
  'dxmon_endpoint_no_permitido',
  'rendimiento_ciclo_excedido',
  'rendimiento_raiz_no_disponible',
  'rendimiento_salida_invalida',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class KatalystError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'KatalystError';
    this.code = code;
  }
}

/** Extrae el código estable de un mensaje de error (uso del runner / reportes). */
export function extractErrorCode(message: string): ErrorCode | undefined {
  const match = /^\[([a-z0-9_]+)\]/.exec(message);
  const code = match?.[1];
  return code && (ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : undefined;
}
