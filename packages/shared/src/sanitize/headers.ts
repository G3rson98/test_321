/**
 * Sanitización de encabezados HTTP. No basta enmascarar encabezados (RNF-SEG-02), pero es obligatorio hacerlo.
 */
import { addFinding, applyTextRules, isSensitiveName, REDACTED, type Finding } from './rules.js';
import type { SanitizeOptions } from './text.js';

const ALWAYS_SENSITIVE = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-amz-security-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-auth-token',
  'x-id-token',
  'x-access-token',
]);

export type HeaderValue = string | string[] | number | undefined;

export function sanitizeHeaders(
  headers: Record<string, HeaderValue>,
  opts: SanitizeOptions = {},
): { value: Record<string, HeaderValue>; findings: Finding[] } {
  const findings: Finding[] = [];
  const out: Record<string, HeaderValue> = {};
  for (const [name, v] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (ALWAYS_SENSITIVE.has(lower) || isSensitiveName(lower)) {
      if (v !== undefined && v !== '') addFinding(findings, 'sensitive_header', lower);
      out[name] = Array.isArray(v) ? v.map(() => REDACTED) : v === undefined ? undefined : REDACTED;
      continue;
    }
    const clean = (s: string) => {
      const r = applyTextRules(s, `header:${lower}`, { knownSecrets: opts.knownSecrets ?? [], mutate: true });
      findings.push(...r.findings);
      return r.value;
    };
    out[name] = Array.isArray(v) ? v.map(clean) : typeof v === 'string' ? clean(v) : v;
  }
  return { value: out, findings };
}
