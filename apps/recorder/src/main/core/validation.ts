/**
 * Validación local previa al envío (ESP §13.6, §10 reglas 3 y 11, RNF-SEG-01). El backend vuelve a validar en
 * sandbox; esta capa evita subir código inválido y avisa al QA sin terminal (RNF-USA-02):
 * - Errores (bloquean): tamaño > 1 MiB, secretos/datos personales (`verifySanitized`, reportados SIN valores),
 *   `waitForTimeout`, `.only`/`.skip`, credenciales escritas, sin test o sin ID de caso en el título.
 * - Advertencias visibles (requieren confirmación): `TODO selector`, verificaciones pendientes, interacciones no
 *   soportadas, selectores frágiles, valores enmascarados que el desarrollador debe reemplazar por fixtures.
 */
import { RECORDING_MAX_CODE_BYTES } from '@katalyst/shared/schemas';
import { lintTestSource, type SourceIssueCode } from '@katalyst/shared/manifest';
import { isPlaceholder, isSensitiveName, sanitizeText, verifySanitized } from '@katalyst/shared/sanitize';
import type { ParseResult } from './step-parser.js';

export type Severity = 'error' | 'advertencia';

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  line: number | null;
}

export interface ValidationReport {
  ok: boolean;
  bytes: number;
  issues: ValidationIssue[];
  maskedValues: number;
}

const LINT_SEVERITY: Record<SourceIssueCode, Severity | null> = {
  TOO_LARGE: 'error',
  ONLY_FOUND: 'error',
  SKIP_FOUND: 'error',
  WAIT_FOR_TIMEOUT: 'error',
  HARDCODED_CREDENTIALS: 'error',
  NO_TEST: 'error',
  TITLE_WITHOUT_CASE: 'error',
  TODO_SELECTOR: 'advertencia',
  PENDING_VERIFICATION: 'advertencia',
  XPATH_POSITIONAL: 'advertencia',
  GENERATED_CSS_CLASS: 'advertencia',
  // Cubiertos con más detalle por el análisis de pasos y por la detección de secretos por línea.
  NO_ASSERTION: null,
  SECRET_DETECTED: null,
};

const SECRET_KIND_ES: Record<string, string> = {
  jwt: 'token JWT',
  bearer: 'token Bearer',
  basic_auth: 'credencial Basic',
  cookie: 'cookie',
  aws_access_key: 'clave AWS',
  aws_secret_key: 'clave AWS',
  private_key: 'clave privada',
  url_credentials: 'credenciales en URL',
  secret_assignment: 'secreto asignado',
  provider_token: 'token de proveedor',
  email: 'correo electrónico',
  canary: 'valor canario',
  known_secret: 'secreto conocido',
  sensitive_key: 'campo sensible',
  sensitive_query: 'parámetro sensible en URL',
  sensitive_header: 'encabezado sensible',
  input_value: 'valor de campo',
  depth_exceeded: 'estructura demasiado profunda',
};

export const MASK_PLACEHOLDER_RE = /\[REDACTED(?::[a-z_]+)?\]/g;

export function byteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

/** Hallazgos de secretos por línea, sin reflejar valores (solo tipo y línea). */
export function findSecretLines(code: string): { line: number; kinds: string[] }[] {
  const out: { line: number; kinds: string[] }[] = [];
  code.split('\n').forEach((text, i) => {
    if (!text.trim()) return;
    const r = verifySanitized(text);
    if (!r.ok) out.push({ line: i + 1, kinds: [...new Set(r.findings.map((f) => f.kind))] });
  });
  // Secretos que solo se detectan en el archivo completo (p. ej. claves privadas multilínea).
  if (out.length === 0) {
    const whole = verifySanitized(code);
    if (!whole.ok) out.push({ line: 0, kinds: [...new Set(whole.findings.map((f) => f.kind))] });
  }
  return out;
}

export function validateBeforeSubmit(
  code: string,
  ctx: { parse: ParseResult; extraPendingVerifications: number },
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const bytes = byteLength(code);
  const maskedValues = (code.match(MASK_PLACEHOLDER_RE) ?? []).length;
  if (bytes > RECORDING_MAX_CODE_BYTES) {
    issues.push({
      severity: 'error',
      code: 'TOO_LARGE',
      message: 'El código supera 1 MiB; graba un flujo más corto.',
      line: null,
    });
    return { ok: false, bytes, issues, maskedValues };
  }
  for (const s of findSecretLines(code)) {
    const kinds = s.kinds.map((k) => SECRET_KIND_ES[k] ?? k).join(', ');
    issues.push({
      severity: 'error',
      code: 'SECRET_DETECTED',
      message: `Posible dato sensible (${kinds}). No se envía: vuelve a grabar con datos de prueba o reemplázalo por marcadores.`,
      line: s.line > 0 ? s.line : null,
    });
  }
  const lint = lintTestSource(code);
  for (const i of lint.issues) {
    const sev = LINT_SEVERITY[i.code];
    if (!sev) continue;
    issues.push({ severity: sev, code: i.code, message: i.message, line: i.line });
  }
  if (ctx.parse.steps.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY', message: 'No hay acciones grabadas.', line: null });
  }
  for (const w of ctx.parse.warnings) {
    if (w.code === 'WAIT_FOR_TIMEOUT' || w.code === 'TODO_SELECTOR' || w.code === 'NO_TEST') continue; // ya reportados por lint
    issues.push({ severity: 'advertencia', code: w.code, message: w.message, line: w.line });
  }
  if (ctx.extraPendingVerifications > 0) {
    issues.push({
      severity: 'advertencia',
      code: 'REQUESTED_VERIFICATION_PENDING',
      message: `Pediste agregar ${ctx.extraPendingVerifications === 1 ? 'una verificación que aún no aparece' : `${ctx.extraPendingVerifications} verificaciones que aún no aparecen`} en el código.`,
      line: null,
    });
  }
  if (maskedValues > 0) {
    issues.push({
      severity: 'advertencia',
      code: 'MASKED_VALUES',
      message: `${maskedValues} valor(es) enmascarado(s): el desarrollador debe reemplazarlos por fixtures antes de aprobar.`,
      line: null,
    });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), bytes, issues: dedupe(issues), maskedValues };
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.severity}|${i.code}|${i.line ?? ''}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Reemplaza valores sensibles por marcadores `[REDACTED:tipo]` (no los registra). */
export function maskSensitiveValues(code: string): { code: string; masked: number } {
  const r = sanitizeText(code);
  let masked = r.findings.reduce((n, f) => n + f.count, 0);
  // Parámetros sensibles en URLs (`?token=…`), que `verifySanitized` también detecta.
  const value = r.value.replace(
    /([?&#])([^=&#\s"'`<>]+)=([^&#\s"'`<>]*)/g,
    (m, sep: string, name: string, val: string) => {
      if (!isSensitiveName(name) || !val || isPlaceholder(val)) return m;
      masked += 1;
      return `${sep}${name}=[REDACTED]`;
    },
  );
  return { code: value, masked };
}
