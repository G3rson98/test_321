/**
 * Verificación previa a publicar evidencia (RNF-SEG-02): devuelve hallazgos residuales sin valores.
 * Si hay hallazgos, la evidencia NO se publica (sanitization_status = `fallido`) y se muestra el motivo.
 * ESP §13.7: la prueba de aceptación siembra token, cookie, dato personal y canario y espera hallazgos.
 */
import { addFinding, applyTextRules, isPlaceholder, isSensitiveName, type Finding } from './rules.js';
import type { SanitizeOptions } from './text.js';

/**
 * Valor de query ya enmascarado seguido solo de puntuación de código (`?token=[REDACTED:x]}` al sanitizar
 * `?token=${expr}` en el código fuente que Playwright incrusta en error-context.md / reporte HTML). Sin esto la
 * verificación lo contaba como residual y bloqueaba la evidencia completa (D-053).
 */
const REDACTED_THEN_PUNCT_RE = /^\[REDACTED(?::[a-z_]+)?\][)}\]`;,.!]*$/;

export interface VerificationResult {
  ok: boolean;
  findings: Finding[];
}

function walkJson(v: unknown, path: string, findings: Finding[], opts: SanitizeOptions, seen: WeakSet<object>): void {
  if (typeof v === 'string') {
    const r = applyTextRules(v, path || '$', { knownSecrets: opts.knownSecrets ?? [], mutate: false });
    for (const f of r.findings) addFinding(findings, f.kind, path || '$', f.count);
    // Parámetros de query sensibles dentro de URLs en cadenas.
    if (/[?&#][^=\s]+=/.test(v)) {
      for (const m of v.matchAll(/[?&#]([^=&#\s"'<>]+)=([^&#\s"'<>]*)/g)) {
        if (isSensitiveName(m[1]!) && m[2] && !isPlaceholder(m[2]) && !REDACTED_THEN_PUNCT_RE.test(m[2])) {
          addFinding(findings, 'sensitive_query', `${path || '$'}:${m[1]}`);
        }
      }
    }
    return;
  }
  if (v === null || typeof v !== 'object') return;
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    v.forEach((item, i) => walkJson(item, `${path}[${i}]`, findings, opts, seen));
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (isSensitiveName(k) && typeof val === 'string' && val !== '' && !isPlaceholder(val)) {
      addFinding(findings, 'sensitive_key', p);
      continue;
    }
    if (isSensitiveName(k) && val !== null && typeof val === 'object') {
      addFinding(findings, 'sensitive_key', p);
      continue;
    }
    walkJson(val, p, findings, opts, seen);
  }
}

/** Verifica texto, HTML o JSON (objeto o cadena JSON). */
export function verifySanitized(content: unknown, opts: SanitizeOptions = {}): VerificationResult {
  const findings: Finding[] = [];
  if (typeof content === 'string') {
    let parsed: unknown = undefined;
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
    }
    if (parsed !== undefined) {
      walkJson(parsed, '', findings, opts, new WeakSet());
    } else {
      walkJson(content, 'texto', findings, opts, new WeakSet());
      // Valores de inputs en HTML.
      for (const m of content.matchAll(/<input\b[^>]*\bvalue\s*=\s*("([^"]+)"|'([^']+)')/gi)) {
        if (m[2] || m[3]) addFinding(findings, 'input_value', 'input[value]');
      }
    }
  } else {
    walkJson(content, '', findings, opts, new WeakSet());
  }
  return { ok: findings.length === 0, findings };
}

/** Resumen sin valores para mensajes/logs: `jwt×2, email×1`. */
export function summarizeFindings(findings: readonly Finding[]): string {
  const byKind = new Map<string, number>();
  for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + f.count);
  return [...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
}
