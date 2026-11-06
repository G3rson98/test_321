/**
 * Preparación del código grabado antes de enviarlo (RF-GRB-02, ESP §10 regla 1): título con el ID del caso y las
 * etiquetas elegidas, y `page.goto` relativos al `baseURL` del ambiente (los projects de qa-tests fijan la URL por
 * ambiente; así el test no queda atado a staging). No cambia acciones ni verificaciones.
 */
import { CASE_REF_REGEX } from '@katalyst/shared/schemas';

export interface PrepareOptions {
  caseRef: string;
  title: string;
  tags: readonly string[];
  /** URL de la app del ambiente usada al grabar; los goto de ese origen se vuelven relativos. */
  appUrl: string | null;
}

function escapeSingleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

/** `C1501 Título @tag1 @tag2`, sin duplicar el ID ni etiquetas ya presentes en el título. */
export function buildTestTitle(caseRef: string, title: string, tags: readonly string[]): string {
  if (!CASE_REF_REGEX.test(caseRef)) throw new Error('caseRef inválido');
  let t = title.replace(/\s+/g, ' ').trim();
  const refs: string[] = t.match(/\bC[1-9]\d*\b/g) ?? [];
  if (!refs.includes(caseRef)) t = `${caseRef} ${t}`;
  const present = new Set((t.match(/@[A-Za-z0-9][\w-]*/g) ?? []).map((x) => x.toLowerCase()));
  const extra = [...new Set(tags)].filter((tag) => !present.has(tag.toLowerCase()));
  return [t, ...extra].join(' ').trim();
}

/** Reemplaza el título del primer `test('…', …)` generado por codegen. */
export function setFirstTestTitle(code: string, fullTitle: string): string {
  const re = /(\btest\s*\(\s*)(['"`])((?:\\.|(?!\2).)*)\2/;
  if (!re.test(code)) return code;
  return code.replace(re, (_m, pre: string) => `${pre}'${escapeSingleQuoted(fullTitle)}'`);
}

/** `page.goto('https://staging.example/loadOrder')` → `page.goto('/loadOrder')` cuando coincide el origen. */
export function relativizeGotos(code: string, appUrl: string | null): string {
  if (!appUrl) return code;
  let origin: string;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    return code;
  }
  return code.replace(/(\.goto\(\s*)(['"`])([^'"`]+)\2/g, (m, pre: string, q: string, raw: string) => {
    try {
      const u = new URL(raw);
      if (u.origin !== origin) return m;
      return `${pre}${q}${u.pathname}${u.search}${u.hash}${q}`;
    } catch {
      return m;
    }
  });
}

export function prepareCodeForSubmit(code: string, opts: PrepareOptions): string {
  const normalized = code.replace(/\r\n?/g, '\n');
  const titled = setFirstTestTitle(normalized, buildTestTitle(opts.caseRef, opts.title, opts.tags));
  const relative = relativizeGotos(titled, opts.appUrl);
  return relative.endsWith('\n') ? relative : `${relative}\n`;
}
