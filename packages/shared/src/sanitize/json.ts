/**
 * Sanitización profunda de JSON (cuerpos, storageState, resultados de Playwright). ESP §13.7, RNF-SEG-02.
 * Claves sensibles → `[REDACTED]`; cadenas → reglas de texto/URL; ciclos y profundidad excesiva se marcan.
 */
import { addFinding, applyTextRules, isSensitiveName, REDACTED, type Finding } from './rules.js';
import type { SanitizeOptions } from './text.js';
import { sanitizeUrl } from './url.js';

export interface JsonSanitizeOptions extends SanitizeOptions {
  maxDepth?: number;
  /** Claves adicionales a enmascarar. */
  extraSensitiveKeys?: readonly string[];
}

export interface JsonSanitizeResult<T = unknown> {
  value: T;
  findings: Finding[];
  /** `false` si quedó contenido sin poder sanitizar (profundidad excedida): bloquear publicación. */
  complete: boolean;
}

const URLISH = /^(?:https?:)?\/\/|^\/[^\s]*\?/i;

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function sanitizeJson<T = unknown>(input: T, opts: JsonSanitizeOptions = {}): JsonSanitizeResult<T> {
  const maxDepth = opts.maxDepth ?? 64;
  const extra = new Set((opts.extraSensitiveKeys ?? []).map((k) => k.toLowerCase()));
  const findings: Finding[] = [];
  const seen = new WeakSet<object>();
  let complete = true;

  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === 'string') {
      const r = URLISH.test(v)
        ? sanitizeUrl(v, opts)
        : applyTextRules(v, path || '$', { knownSecrets: opts.knownSecrets ?? [], mutate: true });
      for (const f of r.findings) addFinding(findings, f.kind, path || '$', f.count);
      return r.value;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) {
      complete = false;
      addFinding(findings, 'depth_exceeded', path || '$');
      return '[TRUNCATED]';
    }
    if (seen.has(v)) return '[CIRCULAR]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((item, i) => walk(item, joinPath(path, i), depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = joinPath(path, k);
      if ((isSensitiveName(k) || extra.has(k.toLowerCase())) && val !== null && val !== undefined && val !== '') {
        addFinding(findings, 'sensitive_key', p);
        out[k] = REDACTED;
        continue;
      }
      // Encabezados en forma [{name, value}] (HAR, trazas Playwright).
      if (
        k === 'value' &&
        typeof (v as Record<string, unknown>).name === 'string' &&
        isSensitiveName((v as Record<string, string>).name!)
      ) {
        addFinding(findings, 'sensitive_header', p);
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(val, p, depth + 1);
    }
    return out;
  };

  const value = walk(input, '', 0) as T;
  return { value, findings, complete };
}
