/**
 * Sanitización de HTML/DOM serializado (reportes, snapshots): valores de inputs, textarea, atributos sensibles,
 * URLs en atributos y texto. Implementación por expresiones (sin DOM) para ser portable; si el resultado aún
 * contiene hallazgos, `verifySanitized` bloquea la publicación. ESP §13.7, RNF-SEG-02.
 */
import { addFinding, applyTextRules, isSensitiveName, type Finding } from './rules.js';
import type { SanitizeOptions } from './text.js';
import { sanitizeUrl } from './url.js';

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data-src', 'data-href', 'srcset']);

export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): { value: string; findings: Finding[] } {
  const findings: Finding[] = [];
  let out = html;

  // 1) <textarea>contenido</textarea> → vacío.
  out = out.replace(
    /(<textarea\b[^>]*>)([\s\S]*?)(<\/textarea>)/gi,
    (_m, open: string, body: string, close: string) => {
      if (body.trim()) addFinding(findings, 'input_value', 'textarea');
      return `${open}${close}`;
    },
  );

  // 2) Atributos dentro de etiquetas.
  out = out.replace(
    /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?(\/?)>/g,
    (m, tag: string, attrs: string | undefined, selfClose: string) => {
      if (!attrs) return m;
      const tagLower = tag.toLowerCase();
      const metaName = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '';
      const newAttrs = attrs.replace(
        /([^\s=/>]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
        (am, name: string, eq: string, _raw: string, dq?: string, sq?: string, bare?: string) => {
          const value = dq ?? sq ?? bare ?? '';
          const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
          const n = name.toLowerCase();
          if ((tagLower === 'input' || tagLower === 'option') && n === 'value') {
            if (value) addFinding(findings, 'input_value', `${tagLower}[value]`);
            return `${name}${eq}${q}${q}`;
          }
          if (tagLower === 'meta' && n === 'content' && isSensitiveName(metaName)) {
            addFinding(findings, 'sensitive_key', `meta[${metaName}]`);
            return `${name}${eq}${q}[REDACTED]${q}`;
          }
          if (isSensitiveName(n.replace(/^data-/, ''))) {
            if (value) addFinding(findings, 'sensitive_key', `${tagLower}[${n}]`);
            return `${name}${eq}${q}[REDACTED]${q}`;
          }
          if (URL_ATTRS.has(n) && value) {
            const r = sanitizeUrl(decodeEntities(value), opts);
            if (r.findings.length) {
              findings.push(...r.findings);
              return `${name}${eq}${q}${escapeAttr(r.value)}${q}`;
            }
            return am;
          }
          const r = applyTextRules(decodeEntities(value), `${tagLower}[${n}]`, {
            knownSecrets: opts.knownSecrets ?? [],
            mutate: true,
          });
          if (r.findings.length) {
            findings.push(...r.findings);
            return `${name}${eq}${q}${escapeAttr(r.value)}${q}`;
          }
          return am;
        },
      );
      return `<${tag}${newAttrs}${selfClose}>`;
    },
  );

  // 3) Texto (incluye scripts/estilos inline): reglas de texto sobre lo que queda fuera de etiquetas.
  out = out.replace(/>([^<]+)</g, (m, text: string) => {
    const r = applyTextRules(text, 'html:texto', { knownSecrets: opts.knownSecrets ?? [], mutate: true });
    if (!r.findings.length) return m;
    findings.push(...r.findings);
    return `>${r.value}<`;
  });
  // Texto antes de la primera etiqueta o sin etiquetas.
  const r = applyTextRules(out, 'html', { knownSecrets: opts.knownSecrets ?? [], mutate: true });
  findings.push(...r.findings);
  return { value: r.value, findings };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
