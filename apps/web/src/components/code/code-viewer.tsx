/**
 * Visor de código (chunk diferido, ESP §17.4). Resaltado mínimo propio para TypeScript (sin dependencias pesadas).
 * El código llega sanitizado de la API; se renderiza como texto (nunca HTML).
 */
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

const KEYWORDS = new Set(['await', 'async', 'const', 'let', 'return', 'import', 'from', 'export', 'function', 'new', 'if', 'else', 'for', 'of', 'true', 'false', 'null', 'undefined', 'test', 'expect']);
const TOKEN = /(\/\/[^\n]*)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*\b)|(\b[A-Za-z_$][\w$]*\b)/g;

type Tok = { text: string; kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' };

export function tokenize(code: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: code.slice(last, i), kind: 'plain' });
    const kind: Tok['kind'] = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'number' : KEYWORDS.has(m[4] ?? '') ? 'keyword' : 'plain';
    out.push({ text: m[0], kind });
    last = i + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last), kind: 'plain' });
  return out;
}

const COLOR: Record<Tok['kind'], string> = {
  plain: '',
  comment: 'text-[#8a8a91]',
  string: 'text-[#f3c77b]',
  number: 'text-[#9ad0f5]',
  keyword: 'text-code-fg',
};

export default function CodeViewer({ code, className, maxHeight = 420, label }: { code: string; className?: string; maxHeight?: number; label?: string }) {
  const toks = useMemo(() => tokenize(code), [code]);
  return (
    <pre
      tabIndex={0}
      aria-label={label ?? 'Código del test'}
      className={cn('overflow-auto bg-code-bg px-5 py-5 font-mono text-[12.5px] leading-[19.5px] text-code-fg outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      style={{ maxHeight }}
    >
      <code>
        {toks.map((t, i) => (
          <span key={i} className={COLOR[t.kind]}>
            {t.text}
          </span>
        ))}
      </code>
    </pre>
  );
}
