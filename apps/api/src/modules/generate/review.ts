/**
 * Revisión asistida determinista de una grabación (RF-GRB-04, ESP §10 reglas 2, 3, 7, 12; §11 Bloque 3):
 * - Elimina `waitForTimeout` injustificados (se conservan los marcados con `// katalyst-espera-justificada`).
 * - Elimina selectores generados (`.css-xxxxx`, XPath posicional) dejando `TODO selector` para revisión humana.
 * - Conserva las excepciones públicas de MUI/Inovua (no se tocan).
 * - Lista lo que necesita revisión humana. La pasada IA (si está habilitada) parte de este resultado.
 */
import { PUBLIC_SELECTOR_EXCEPTIONS } from './prompt.js';

export interface ReviewResult {
  code: string;
  changes: string[];
  needsHumanReview: string[];
}

const JUSTIFIED = /katalyst-espera-justificada/;
const GENERATED_CSS_LITERAL = /(['"`])([^'"`\n]*\.css-[a-z0-9]{5,}\b[^'"`\n]*)\1/g;
const XPATH_POSITIONAL_LITERAL = /(['"`])((?:xpath=)?\/\/[^'"`\n]*\[\d+\][^'"`\n]*)\1/g;

export function countPublicExceptions(code: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of PUBLIC_SELECTOR_EXCEPTIONS) out[e] = code.split(e).length - 1;
  return out;
}

/** ¿`after` conserva todas las excepciones públicas presentes en `before`? */
export function preservesPublicExceptions(before: string, after: string): boolean {
  const a = countPublicExceptions(before);
  const b = countPublicExceptions(after);
  return PUBLIC_SELECTOR_EXCEPTIONS.every((e) => (b[e] ?? 0) >= (a[e] ?? 0));
}

export function deterministicReview(input: string): ReviewResult {
  const changes: string[] = [];
  const needs: string[] = [];
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/\bwaitForTimeout\s*\(/.test(line)) {
      const justified = JUSTIFIED.test(line) || JUSTIFIED.test(lines[i - 1] ?? '');
      if (!justified) {
        changes.push(`Línea ${n}: eliminada espera fija (waitForTimeout); usar una espera por condición`);
        needs.push(`Línea ${n}: confirmar la condición que reemplaza a la espera fija eliminada`);
        const indent = /^\s*/.exec(line)?.[0] ?? '';
        out.push(`${indent}// TODO verificación: reemplazar la espera fija eliminada por expect(...)/waitForResponse`);
        return;
      }
    }
    let l = line;
    l = l.replace(GENERATED_CSS_LITERAL, (_m, q: string) => {
      changes.push(`Línea ${n}: eliminado selector con clase CSS generada`);
      needs.push(`Línea ${n}: definir selector estable (getByTestId/getByRole) en un Page Object`);
      return `${q}TODO selector${q} /* TODO selector: selector generado eliminado */`;
    });
    l = l.replace(XPATH_POSITIONAL_LITERAL, (_m, q: string) => {
      changes.push(`Línea ${n}: eliminado XPath posicional`);
      needs.push(`Línea ${n}: definir selector estable (getByTestId/getByRole) en un Page Object`);
      return `${q}TODO selector${q} /* TODO selector: XPath posicional eliminado */`;
    });
    out.push(l);
  });
  const code = out.join('\n');
  if (!/\bexpect\s*\(/.test(code)) needs.push('El test no tiene verificaciones: agregar expect(...) del resultado esperado');
  if (/getByText\(/.test(code)) needs.push('Revisar getByText: preferir getByTestId/getByRole si el frontend los provee');
  if (/\.fill\([^)]*,\s*['"`][^'"`]+['"`]\)/.test(code)) {
    needs.push('Datos de prueba literales en fill(...): parametrizar con fixtures tipadas (prefijo QA-AUTO-…)');
  }
  return { code, changes: [...new Set(changes)], needsHumanReview: [...new Set(needs)] };
}
