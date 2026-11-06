/**
 * Errores del asistente local con mensajes en español claros para un QA sin terminal (RNF-USA-02).
 * Nunca incluyen tokens, `storageState`, contraseñas ni valores detectados como secretos (RNF-SEG-01).
 */
export const RECORDER_ERRORS = {
  SERVER_NOT_CONFIGURED: 'Configura la dirección de Katalyst antes de continuar.',
  SERVER_URL_INVALID: 'La dirección de Katalyst debe ser https:// (http solo en modo desarrollo y en este equipo).',
  NOT_LINKED: 'El asistente no está vinculado. Vincúlalo con tu cuenta del panel.',
  CREDENTIAL_STORE_UNAVAILABLE:
    'El almacén de credenciales del sistema no está disponible; no se puede guardar el vínculo de forma segura.',
  DEVICE_CODE_EXPIRED: 'El código de vínculo venció (5 minutos). Genera uno nuevo.',
  DEVICE_ACCESS_DENIED: 'La vinculación fue rechazada desde el panel.',
  DEVICE_LINK_CANCELLED: 'Vinculación cancelada.',
  DEVICE_REVOKED: 'La credencial del asistente fue revocada o venció. Vuelve a vincularlo.',
  PRODUCTION_BLOCKED: 'No se permite grabar en producción. Pide una sesión de grabación en un ambiente de pruebas.',
  RECORDING_NOT_ALLOWED: 'Este ambiente no tiene habilitada la grabación. Consulta a un administrador.',
  ENVIRONMENT_UNKNOWN: 'No se pudo verificar el ambiente de la grabación; por seguridad no se abrirá el navegador.',
  ENVIRONMENT_URL_INSECURE: 'La dirección del ambiente no es segura (https). No se abrirá el navegador.',
  RECORDING_EXPIRED: 'La sesión de grabación venció (2 horas). Crea una nueva desde el panel.',
  RECORDING_TERMINAL: 'Esta grabación ya terminó y no admite cambios.',
  RECORDING_NOT_OPEN: 'No hay una grabación abierta.',
  INVALID_STATE: 'Esa acción no está disponible en este momento.',
  BROWSER_MISSING: 'Falta el navegador Chromium del asistente. Instálalo desde esta ventana.',
  BROWSER_INSTALL_FAILED: 'No se pudo instalar Chromium. Revisa tu conexión e inténtalo de nuevo.',
  BROWSER_LAUNCH_FAILED: 'No se pudo abrir Chromium. Cierra otras ventanas del asistente e inténtalo de nuevo.',
  CODEGEN_FAILED: 'La grabadora se cerró con un error. Puedes volver a grabar.',
  NO_CODE: 'Todavía no hay acciones grabadas.',
  VALIDATION_BLOCKED: 'La grabación no puede enviarse hasta corregir los errores indicados.',
  WARNINGS_NOT_ACKNOWLEDGED: 'Revisa y confirma las advertencias antes de enviar el PR.',
  API_ERROR: 'Katalyst respondió con un error.',
  NETWORK_ERROR: 'No se pudo conectar con Katalyst. Revisa tu conexión.',
  IPC_INVALID: 'Solicitud inválida.',
  DEEP_LINK_INVALID: 'El enlace de grabación no es válido.',
  URL_NOT_ALLOWED: 'Esa dirección no está permitida.',
  INTERNAL: 'Ocurrió un error inesperado en el asistente.',
} as const;

export type RecorderErrorCode = keyof typeof RECORDER_ERRORS;

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;
  constructor(code: RecorderErrorCode, message?: string) {
    super(message ?? RECORDER_ERRORS[code]);
    this.name = 'RecorderError';
    this.code = code;
  }
}

export function isRecorderError(e: unknown): e is RecorderError {
  return e instanceof RecorderError;
}
