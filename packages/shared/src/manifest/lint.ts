/**
 * Revisión estática de código de test (grabado, generado o manual) antes de aprobar (ESP §10 reglas 2, 3, 5, 11;
 * §13.6). No ejecuta código. `TODO selector`, verificaciones pendientes, `.only`/`.skip` no autorizados, esperas
 * fijas, XPath posicional, clases CSS generadas, credenciales o secretos impiden aprobar.
 * RF-GRB-05, RF-GRB-06, RNF-SEG-01.
 */
import { verifySanitized } from '../sanitize/verify.js';
import { caseRefsInTitle } from './validate.js';

export const MAX_RECORDING_BYTES = 1024 * 1024;

export type SourceIssueCode =
  | 'TOO_LARGE'
  | 'ONLY_FOUND'
  | 'SKIP_FOUND'
  | 'TODO_SELECTOR'
  | 'PENDING_VERIFICATION'
  | 'WAIT_FOR_TIMEOUT'
  | 'XPATH_POSITIONAL'
  | 'GENERATED_CSS_CLASS'
  | 'NO_ASSERTION'
  | 'NO_TEST'
  | 'TITLE_WITHOUT_CASE'
  | 'HARDCODED_CREDENTIALS'
  | 'SECRET_DETECTED';

export interface SourceIssue {
  code: SourceIssueCode;
  message: string;
  line: number | null;
}

export interface LintOptions {
  /** Permite `waitForTimeout` (solo el monitor de rendimiento, ESP §10 regla 3). */
  allowWaitForTimeout?: boolean;
  /** Permite `.skip` autorizado (p. ej. con anotación de motivo revisada). */
  allowSkip?: boolean;
  knownSecrets?: readonly string[];
}

const RULES: { code: SourceIssueCode; re: RegExp; message: string }[] = [
  { code: 'ONLY_FOUND', re: /\b(?:test|describe|it)\.only\s*\(/, message: '`.only` no autorizado' },
  { code: 'TODO_SELECTOR', re: /TODO\s*selector/i, message: 'Selector pendiente (`TODO selector`)' },
  { code: 'PENDING_VERIFICATION', re: /TODO\s*(?:verificaci[oó]n|assert|expect)/i, message: 'Verificación pendiente' },
  { code: 'XPATH_POSITIONAL', re: /(?:xpath=|\/\/)[^'"`]*\[\d+\]/, message: 'XPath por posición prohibido' },
  { code: 'GENERATED_CSS_CLASS', re: /\.css-[a-z0-9]{5,}\b/, message: 'Clase CSS generada (`css-xxxx`) prohibida' },
  {
    code: 'HARDCODED_CREDENTIALS',
    re: /\.fill\([^)]*(?:password|contrase[nñ]a)[^)]*,\s*['"`][^'"`]+['"`]/i,
    message: 'Credenciales escritas en el test',
  },
];

export function lintTestSource(code: string, opts: LintOptions = {}): { ok: boolean; issues: SourceIssue[] } {
  const issues: SourceIssue[] = [];
  if (new TextEncoder().encode(code).length > MAX_RECORDING_BYTES) {
    return { ok: false, issues: [{ code: 'TOO_LARGE', message: 'El código supera 1 MiB', line: null }] };
  }
  const lines = code.split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const r of RULES) if (r.re.test(text)) issues.push({ code: r.code, message: r.message, line: i + 1 });
    if (!opts.allowSkip && /\b(?:test|describe|it)\.skip\s*\(/.test(text)) {
      issues.push({ code: 'SKIP_FOUND', message: '`.skip` no autorizado', line: i + 1 });
    }
    if (!opts.allowWaitForTimeout && /\bwaitForTimeout\s*\(/.test(text)) {
      issues.push({
        code: 'WAIT_FOR_TIMEOUT',
        message: 'Espera fija prohibida; usar esperas por condición',
        line: i + 1,
      });
    }
  });
  const titles = [...code.matchAll(/\btest\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
  if (titles.length === 0)
    issues.push({ code: 'NO_TEST', message: 'No se encontró ninguna llamada test(...)', line: null });
  for (const t of titles) {
    if (caseRefsInTitle(t).length === 0)
      issues.push({ code: 'TITLE_WITHOUT_CASE', message: `Título sin ID de caso: "${t.slice(0, 80)}"`, line: null });
  }
  if (!/\bexpect\s*\(/.test(code))
    issues.push({ code: 'NO_ASSERTION', message: 'El test no contiene verificaciones (expect)', line: null });
  const secrets = verifySanitized(code, { knownSecrets: opts.knownSecrets ?? [] });
  if (!secrets.ok) {
    // Nunca reflejar el valor: solo el tipo de hallazgo.
    const kinds = [...new Set(secrets.findings.map((f) => f.kind))].join(', ');
    issues.push({ code: 'SECRET_DETECTED', message: `Posibles secretos o datos personales: ${kinds}`, line: null });
  }
  return { ok: issues.length === 0, issues };
}
