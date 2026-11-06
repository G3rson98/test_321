/**
 * Sanitización de texto libre (mensajes de error, logs, comentarios TestRail). ESP §13.7, RNF-SEG-02.
 */
import { applyTextRules, type ApplyResult } from './rules.js';

export interface SanitizeOptions {
  /** Valores secretos conocidos a enmascarar literalmente (p. ej. contraseña del usuario de prueba). */
  knownSecrets?: readonly string[];
}

export function sanitizeText(input: string, opts: SanitizeOptions = {}, location = 'texto'): ApplyResult {
  return applyTextRules(input, location, { knownSecrets: opts.knownSecrets ?? [], mutate: true });
}

/** Trunca y sanitiza un mensaje de error para persistir/mostrar (máx. 8 KiB por defecto). */
export function sanitizeErrorMessage(input: string, maxLength = 8192, opts: SanitizeOptions = {}): string {
  const { value } = sanitizeText(input, opts);
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
