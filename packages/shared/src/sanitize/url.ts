/**
 * Sanitización de URLs: credenciales embebidas, parámetros de query/fragmento sensibles y valores con tokens/correos.
 * ESP §13.7 ("No poner tokens en URL"), RNF-SEG-02.
 */
import { addFinding, applyTextRules, isSensitiveName, REDACTED, type ApplyResult, type Finding } from './rules.js';
import type { SanitizeOptions } from './text.js';

const BASE = 'http://katalyst.invalid';

function sanitizeParams(params: URLSearchParams, findings: Finding[], where: string, opts: SanitizeOptions): boolean {
  let changed = false;
  const entries = [...params.entries()];
  const out = new URLSearchParams();
  for (const [k, v] of entries) {
    if (isSensitiveName(k)) {
      addFinding(findings, 'sensitive_query', `${where}:${k}`);
      out.append(k, REDACTED);
      changed = true;
      continue;
    }
    const r = applyTextRules(v, `${where}:${k}`, { knownSecrets: opts.knownSecrets ?? [], mutate: true });
    if (r.findings.length) {
      findings.push(...r.findings);
      changed = true;
    }
    out.append(k, r.value);
  }
  if (changed) {
    for (const k of [...params.keys()]) params.delete(k);
    for (const [k, v] of out) params.append(k, v);
  }
  return changed;
}

export function sanitizeUrl(input: string, opts: SanitizeOptions = {}): ApplyResult {
  const findings: Finding[] = [];
  let url: URL;
  let absolute = true;
  try {
    url = new URL(input);
  } catch {
    try {
      url = new URL(input, BASE);
      absolute = false;
    } catch {
      return applyTextRules(input, 'url', { knownSecrets: opts.knownSecrets ?? [], mutate: true });
    }
  }
  if (url.username || url.password) {
    addFinding(findings, 'url_credentials', 'url');
    url.username = '';
    url.password = '';
  }
  sanitizeParams(url.searchParams, findings, 'query', opts);
  if (url.hash.length > 1) {
    const frag = url.hash.slice(1);
    if (frag.includes('=')) {
      const fp = new URLSearchParams(frag);
      if (sanitizeParams(fp, findings, 'fragment', opts)) url.hash = fp.toString();
    } else {
      const r = applyTextRules(decodeURIComponentSafe(frag), 'fragment', {
        knownSecrets: opts.knownSecrets ?? [],
        mutate: true,
      });
      if (r.findings.length) {
        findings.push(...r.findings);
        url.hash = r.value;
      }
    }
  }
  // Segmentos de ruta con tokens/correos/canarios.
  const pathRes = applyTextRules(decodeURIComponentSafe(url.pathname), 'path', {
    knownSecrets: opts.knownSecrets ?? [],
    mutate: true,
  });
  if (pathRes.findings.length) {
    findings.push(...pathRes.findings);
    url.pathname = pathRes.value;
  }
  let value = url.toString();
  if (!absolute) value = value.slice(BASE.length);
  if (!absolute && !input.startsWith('/')) value = value.replace(/^\//, '');
  return { value, findings };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
