/**
 * Lectura de la salida de `playwright codegen --target=playwright-test` para mostrar acciones y verificaciones
 * reconocidas, advertir interacciones no soportadas y detectar verificaciones pendientes antes del PR
 * (RF-GRB-06, ESP §13.6, §10 reglas 3 y 11). No ejecuta código: análisis léxico de sentencias.
 * El asistente NO promete que cualquier interacción grabada sea un test válido: lo que no reconoce se marca
 * `no_soportada` con advertencia visible.
 */
import { sanitizeText } from '@katalyst/shared/sanitize';

export type StepKind = 'accion' | 'verificacion' | 'no_soportada';

export interface ParsedStep {
  /** Posición 1-based entre los pasos mostrados. */
  index: number;
  /** Línea 1-based en el código. */
  line: number;
  kind: StepKind;
  description: string;
}

export type StepWarningCode =
  | 'NO_TEST'
  | 'NO_VERIFICATION'
  | 'ACTIONS_WITHOUT_VERIFICATION'
  | 'UNSUPPORTED_INTERACTION'
  | 'DIALOG'
  | 'POPUP'
  | 'DOWNLOAD'
  | 'IFRAME'
  | 'FILE_UPLOAD'
  | 'COORDINATES'
  | 'FRAGILE_SELECTOR'
  | 'TODO_SELECTOR'
  | 'WAIT_FOR_TIMEOUT';

export interface StepWarning {
  code: StepWarningCode;
  message: string;
  line: number | null;
}

export interface ParseResult {
  testCount: number;
  steps: ParsedStep[];
  warnings: StepWarning[];
  actionCount: number;
  verificationCount: number;
  unsupportedCount: number;
  /** Verificaciones pendientes detectadas por el análisis (sin verificación alguna o acciones finales sin verificar). */
  pendingVerifications: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Escáner léxico (cadenas '', "", `` con ${}, comentarios // y /* */)
// ---------------------------------------------------------------------------------------------------------------

interface Statement {
  text: string;
  line: number;
}

/** Devuelve el índice del cierre que corresponde a `code[openIdx]` (`(`, `{` o `[`), o -1. */
export function findMatching(code: string, openIdx: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let i = openIdx;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(code, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipQuoted(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '\\') i += 2;
    else if (c === quote || c === '\n') return i + 1;
    else i += 1;
  }
  return code.length;
}

function skipTemplate(code: string, start: number): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && code[i + 1] === '{') {
      const end = findMatching(code, i + 1);
      if (end === -1) return code.length;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return code.length;
}

function lineAt(code: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < code.length; i++) if (code.charCodeAt(i) === 10) n++;
  return n;
}

/** Divide un cuerpo de función en sentencias de nivel superior (por `;` fuera de cadenas, paréntesis y llaves). */
export function splitStatements(code: string, baseLine = 1): Statement[] {
  const out: Statement[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = code.slice(start, end);
    const lead = firstCodeOffset(raw);
    const text = stripComments(raw).trim();
    if (text) out.push({ text, line: baseLine + lineAt(code, start + lead) - 1 });
    start = end + 1;
  };
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(code, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(code, i);
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) push(i);
    i += 1;
  }
  if (start < code.length) push(code.length);
  return out;
}

/** Desplazamiento del primer carácter de código (salta espacios y comentarios iniciales). */
function firstCodeOffset(raw: string): number {
  let i = 0;
  for (;;) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (raw.startsWith('//', i)) {
      const nl = raw.indexOf('\n', i);
      if (nl === -1) return raw.length;
      i = nl + 1;
      continue;
    }
    if (raw.startsWith('/*', i)) {
      const end = raw.indexOf('*/', i + 2);
      if (end === -1) return raw.length;
      i = end + 2;
      continue;
    }
    return i;
  }
}

function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === '/' && next === '/') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const e = skipQuoted(s, i, c);
      out += s.slice(i, e);
      i = e;
      continue;
    }
    if (c === '`') {
      const e = skipTemplate(s, i);
      out += s.slice(i, e);
      i = e;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cadenas de llamadas: `page.getByRole('button', { name: 'X' }).click()`
// ---------------------------------------------------------------------------------------------------------------

interface Segment {
  name: string;
  /** Texto entre paréntesis (sin ellos) o `null` si es una propiedad. */
  args: string | null;
}

/** Divide `a.b(x).c` en segmentos de nivel superior. Devuelve null si no es una cadena simple. */
export function splitChain(expr: string): Segment[] | null {
  const segs: Segment[] = [];
  let i = 0;
  const s = expr.trim();
  while (i < s.length) {
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) return null;
    const name = m[0];
    i += name.length;
    let args: string | null = null;
    if (s[i] === '(') {
      const end = findMatching(s, i);
      if (end === -1) return null;
      args = s.slice(i + 1, end);
      i = end + 1;
    }
    segs.push({ name, args });
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i += 1;
  }
  return segs.length ? segs : null;
}

/** Argumentos de nivel superior separados por coma. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < args.length) {
    const c = args[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(args, i, c);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(args, i);
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = args.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Valor de un literal de cadena simple; `null` si no lo es. */
export function stringLiteral(src: string | undefined): string | null {
  if (!src) return null;
  const t = src.trim();
  const q = t[0];
  if ((q !== "'" && q !== '"' && q !== '`') || t[t.length - 1] !== q || t.length < 2) return null;
  const body = t.slice(1, -1);
  if (q === '`' && body.includes('${')) return null;
  return body.replace(/\\(.)/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

function optionString(objSrc: string | undefined, key: string): string | null {
  if (!objSrc) return null;
  const re = new RegExp(`\\b${key}\\s*:\\s*('(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|\`(?:\\\\.|[^\`\\\\])*\`)`);
  const m = re.exec(objSrc);
  return m ? stringLiteral(m[1]) : null;
}

const ROLE_ES: Record<string, string> = {
  button: 'botón',
  link: 'enlace',
  textbox: 'campo',
  searchbox: 'buscador',
  checkbox: 'casilla',
  radio: 'opción',
  combobox: 'lista',
  listbox: 'lista',
  option: 'opción',
  tab: 'pestaña',
  tablist: 'pestañas',
  tabpanel: 'panel',
  heading: 'título',
  menuitem: 'opción de menú',
  menu: 'menú',
  row: 'fila',
  cell: 'celda',
  gridcell: 'celda',
  columnheader: 'encabezado',
  grid: 'grilla',
  table: 'tabla',
  dialog: 'diálogo',
  alert: 'alerta',
  status: 'estado',
  img: 'imagen',
  navigation: 'navegación',
  switch: 'interruptor',
  spinbutton: 'número',
  slider: 'control deslizante',
  treeitem: 'elemento',
  listitem: 'elemento',
};

const MAX_VALUE = 60;

function clip(v: string, max = MAX_VALUE): string {
  const oneLine = v.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Texto visible al usuario: recortado y sin secretos/datos personales (RNF-SEG-01). */
function safe(v: string, max = MAX_VALUE): string {
  return clip(sanitizeText(v).value, max);
}

const LOCATOR_METHODS = new Set([
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'locator',
  'frameLocator',
  'contentFrame',
  'first',
  'last',
  'nth',
  'filter',
  'and',
  'or',
]);

function describeLocatorSegment(seg: Segment): string | null {
  const args = seg.args === null ? [] : splitArgs(seg.args);
  const first = stringLiteral(args[0]);
  switch (seg.name) {
    case 'getByRole': {
      const role = first ?? 'elemento';
      const name = optionString(args[1], 'name');
      const label = ROLE_ES[role] ?? role;
      return name !== null ? `${label} "${safe(name)}"` : label;
    }
    case 'getByText':
      return `texto "${safe(first ?? '…')}"`;
    case 'getByLabel':
      return `campo "${safe(first ?? '…')}"`;
    case 'getByPlaceholder':
      return `campo con texto de ayuda "${safe(first ?? '…')}"`;
    case 'getByAltText':
      return `imagen "${safe(first ?? '…')}"`;
    case 'getByTitle':
      return `elemento con título "${safe(first ?? '…')}"`;
    case 'getByTestId':
      return `[data-testid=${safe(first ?? '…')}]`;
    case 'locator':
    case 'frameLocator':
      return seg.name === 'frameLocator' ? `iframe ${safe(first ?? '…')}` : `elemento ${safe(first ?? '…')}`;
    case 'contentFrame':
      return 'contenido del iframe';
    case 'first':
      return 'primero';
    case 'last':
      return 'último';
    case 'nth':
      return `n.º ${clip(args[0] ?? '?', 6)}`;
    case 'filter': {
      const hasText = optionString(args[0], 'hasText');
      return hasText !== null ? `que contiene "${safe(hasText)}"` : 'filtrado';
    }
    default:
      return null;
  }
}

function describeLocator(segs: Segment[]): string {
  const parts = segs.map(describeLocatorSegment).filter((p): p is string => p !== null);
  return parts.length ? clip(parts.join(' › '), 160) : 'la página';
}

function urlPath(raw: string): string {
  try {
    const u = new URL(raw);
    return safe(`${u.pathname}${u.search}`, 120);
  } catch {
    return safe(raw, 120);
  }
}

const ACTIONS: Record<string, (loc: string, args: string[]) => string> = {
  click: (l) => `Clic en ${l}`,
  dblclick: (l) => `Doble clic en ${l}`,
  tap: (l) => `Tocar ${l}`,
  fill: (l, a) => `Escribir "${safe(stringLiteral(a[0]) ?? '…')}" en ${l}`,
  pressSequentially: (l, a) => `Escribir "${safe(stringLiteral(a[0]) ?? '…')}" tecla a tecla en ${l}`,
  type: (l, a) => `Escribir "${safe(stringLiteral(a[0]) ?? '…')}" tecla a tecla en ${l}`,
  press: (l, a) => `Pulsar ${safe(stringLiteral(a[0]) ?? 'tecla', 30)} en ${l}`,
  check: (l) => `Marcar ${l}`,
  uncheck: (l) => `Desmarcar ${l}`,
  setChecked: (l) => `Cambiar marca de ${l}`,
  selectOption: (l, a) => `Seleccionar ${safe(stringLiteral(a[0]) ?? clip(a[0] ?? '…', 40))} en ${l}`,
  hover: (l) => `Pasar el cursor sobre ${l}`,
  focus: (l) => `Enfocar ${l}`,
  blur: (l) => `Quitar el foco de ${l}`,
  clear: (l) => `Vaciar ${l}`,
  scrollIntoViewIfNeeded: (l) => `Desplazar hasta ${l}`,
  dragTo: (l) => `Arrastrar ${l}`,
};

const ASSERTIONS: Record<string, (loc: string, args: string[], negated: boolean) => string> = {
  toBeVisible: (l, _a, n) => `Verificar que ${l} ${n ? 'no ' : ''}está visible`,
  toBeHidden: (l) => `Verificar que ${l} está oculto`,
  toContainText: (l, a, n) =>
    `Verificar que ${l} ${n ? 'no ' : ''}contiene "${safe(stringLiteral(a[0]) ?? clip(a[0] ?? '…', 40))}"`,
  toHaveText: (l, a, n) =>
    `Verificar que ${l} ${n ? 'no ' : ''}tiene el texto "${safe(stringLiteral(a[0]) ?? clip(a[0] ?? '…', 40))}"`,
  toHaveValue: (l, a, n) =>
    `Verificar que ${l} ${n ? 'no ' : ''}tiene el valor "${safe(stringLiteral(a[0]) ?? clip(a[0] ?? '…', 40))}"`,
  toBeChecked: (l, _a, n) => `Verificar que ${l} ${n ? 'no ' : ''}está marcado`,
  toBeEnabled: (l, _a, n) => `Verificar que ${l} ${n ? 'no ' : ''}está habilitado`,
  toBeDisabled: (l) => `Verificar que ${l} está deshabilitado`,
  toMatchAriaSnapshot: (l) => `Verificar la estructura (snapshot ARIA) de ${l}`,
  toHaveURL: (_l, a) => `Verificar la URL ${urlPath(stringLiteral(a[0]) ?? '…')}`,
  toHaveTitle: (_l, a) => `Verificar el título "${safe(stringLiteral(a[0]) ?? '…')}"`,
  toHaveCount: (l, a) => `Verificar que hay ${clip(a[0] ?? '?', 8)} de ${l}`,
};

interface Classified {
  kind: StepKind;
  description: string;
  warnings: Omit<StepWarning, 'line'>[];
  /** Sentencias auxiliares de codegen que no se muestran como paso (p. ej. `const page1 = await page1Promise`). */
  hidden?: boolean;
}

function fragileSelectorWarnings(stmt: string): Omit<StepWarning, 'line'>[] {
  const w: Omit<StepWarning, 'line'>[] = [];
  if (/locator\(\s*['"`](?:xpath=|\/\/)/.test(stmt))
    w.push({ code: 'FRAGILE_SELECTOR', message: 'Selector XPath: prefiere getByRole/getByTestId (ESP §10 regla 2).' });
  if (/\.nth\(\s*\d+\s*\)/.test(stmt))
    w.push({ code: 'FRAGILE_SELECTOR', message: 'Selector por posición (.nth): puede romperse si cambia el orden.' });
  if (/\.css-[a-z0-9]{5,}\b/.test(stmt))
    w.push({ code: 'FRAGILE_SELECTOR', message: 'Clase CSS generada (css-xxxx): prohibida por ESP §10 regla 2.' });
  const longText = /getByText\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(stmt);
  if (longText && longText[2]!.length > 50)
    w.push({
      code: 'FRAGILE_SELECTOR',
      message: 'Selector por texto muy largo: probablemente capturó un contenedor; revisa el elemento.',
    });
  return w;
}

function classify(stmt: string): Classified {
  let s = stmt.trim();
  if (/^import\s/.test(s)) return { kind: 'accion', description: '', warnings: [], hidden: true };
  const warnings = fragileSelectorWarnings(s);
  if (/\bwaitForTimeout\s*\(/.test(s)) {
    return {
      kind: 'no_soportada',
      description: 'Espera fija (waitForTimeout)',
      warnings: [
        { code: 'WAIT_FOR_TIMEOUT', message: 'Espera fija prohibida: usa esperas por condición (ESP §10 regla 3).' },
      ],
    };
  }
  // Manejo de diálogos nativos generado por codegen: siempre los descarta.
  if (/^\w+\.(once|on)\(\s*['"]dialog['"]/.test(s)) {
    return {
      kind: 'no_soportada',
      description: 'Diálogo nativo del navegador (se descarta automáticamente)',
      warnings: [
        {
          code: 'DIALOG',
          message:
            'Diálogo nativo: codegen siempre lo descarta y no verifica su mensaje; revisa si el flujo debe aceptarlo.',
        },
      ],
    };
  }
  const evt = /^const\s+\w+\s*=\s*(\w+)\.waitForEvent\(\s*['"](popup|download|filechooser)['"]/.exec(s);
  if (evt) {
    const kind = evt[2]!;
    if (kind === 'popup')
      return {
        kind: 'accion',
        description: 'Esperar una ventana emergente',
        warnings: [
          {
            code: 'POPUP',
            message: 'Ventana emergente: confirma que el test la necesita y agrega una verificación en ella.',
          },
        ],
      };
    if (kind === 'download')
      return {
        kind: 'no_soportada',
        description: 'Esperar una descarga',
        warnings: [
          { code: 'DOWNLOAD', message: 'Descarga de archivo: el contenido descargado no se verifica automáticamente.' },
        ],
      };
    return {
      kind: 'no_soportada',
      description: 'Selector de archivos',
      warnings: [
        { code: 'FILE_UPLOAD', message: 'Subida de archivos: depende de archivos locales; requiere fixture.' },
      ],
    };
  }
  if (/^const\s+\w+\s*=\s*await\s+\w+Promise\s*$/.test(s))
    return { kind: 'accion', description: '', warnings: [], hidden: true };

  s = s.replace(/^await\s+/, '');
  // Verificaciones: expect(...)[.not].matcher(...)
  const exp = /^expect(?:\.soft)?\s*\(/.exec(s);
  if (exp) {
    const open = s.indexOf('(');
    const close = findMatching(s, open);
    if (close !== -1) {
      const inner = s.slice(open + 1, close);
      const rest = s.slice(close + 1);
      const m = /^\.(not\.)?(\w+)\(([\s\S]*)\)$/.exec(rest.trim());
      const segs = splitChain(inner);
      if (m && segs) {
        const negated = Boolean(m[1]);
        const matcher = m[2]!;
        const loc = describeLocator(segs.slice(1));
        const fn = ASSERTIONS[matcher];
        const iframe = segs.some((x) => x.name === 'contentFrame' || x.name === 'frameLocator');
        if (iframe)
          warnings.push({
            code: 'IFRAME',
            message: 'Verificación dentro de un iframe: confirma que el selector del iframe es estable.',
          });
        return {
          kind: 'verificacion',
          description: fn ? fn(loc, splitArgs(m[3] ?? ''), negated) : `Verificar ${matcher} en ${loc}`,
          warnings,
        };
      }
    }
    return { kind: 'verificacion', description: 'Verificación', warnings };
  }

  const segs = splitChain(s);
  if (!segs || segs.length < 2) {
    return {
      kind: 'no_soportada',
      description: `Instrucción no reconocida: ${safe(s, 80)}`,
      warnings: [
        {
          code: 'UNSUPPORTED_INTERACTION',
          message: 'Instrucción que el asistente no reconoce; el desarrollador debe revisarla.',
        },
      ],
    };
  }
  const last = segs[segs.length - 1]!;
  const args = last.args === null ? [] : splitArgs(last.args);
  if (segs.length === 2 && last.name === 'goto')
    return { kind: 'accion', description: `Ir a ${urlPath(stringLiteral(args[0]) ?? '…')}`, warnings };
  if (segs.length === 2 && last.name === 'close') return { kind: 'accion', description: 'Cerrar la página', warnings };
  if (segs.length === 2 && (last.name === 'goBack' || last.name === 'goForward' || last.name === 'reload')) {
    const d = {
      goBack: 'Volver a la página anterior',
      goForward: 'Avanzar a la página siguiente',
      reload: 'Recargar la página',
    }[last.name];
    return { kind: 'accion', description: d, warnings };
  }
  if (segs[1]?.name === 'mouse') {
    return {
      kind: 'no_soportada',
      description: 'Acción de mouse por coordenadas',
      warnings: [
        {
          code: 'COORDINATES',
          message: 'Acción por coordenadas: no es estable; reemplázala por una acción sobre un elemento.',
        },
      ],
    };
  }
  if (segs[1]?.name === 'keyboard') {
    return {
      kind: 'accion',
      description: `Teclado: ${safe(stringLiteral(args[0]) ?? last.name, 40)}`,
      warnings: [
        ...warnings,
        { code: 'COORDINATES', message: 'Acción de teclado sin elemento: confirma que el foco es el esperado.' },
      ],
    };
  }
  const middle = segs.slice(1, -1);
  const allLocator = middle.length > 0 && middle.every((x) => LOCATOR_METHODS.has(x.name));
  if (allLocator && last.name === 'setInputFiles') {
    return {
      kind: 'no_soportada',
      description: `Adjuntar archivo en ${describeLocator(middle)}`,
      warnings: [
        { code: 'FILE_UPLOAD', message: 'Subida de archivos: la ruta local no es portable; requiere fixture.' },
      ],
    };
  }
  const action = ACTIONS[last.name];
  if (allLocator && action) {
    if (middle.some((x) => x.name === 'contentFrame' || x.name === 'frameLocator')) {
      warnings.push({
        code: 'IFRAME',
        message: 'Interacción dentro de un iframe: confirma que el selector del iframe es estable.',
      });
    }
    return { kind: 'accion', description: action(describeLocator(middle), args), warnings };
  }
  return {
    kind: 'no_soportada',
    description: `Instrucción no reconocida: ${safe(s, 80)}`,
    warnings: [
      ...warnings,
      {
        code: 'UNSUPPORTED_INTERACTION',
        message: 'Instrucción que el asistente no reconoce; el desarrollador debe revisarla.',
      },
    ],
  };
}

interface TestBlock {
  title: string | null;
  bodyStart: number;
  body: string;
}

function findTests(code: string): TestBlock[] {
  const tests: TestBlock[] = [];
  const re = /\btest(?:\.(?:only|skip|fixme|fail))?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) continue;
    const call = code.slice(open + 1, close);
    const arrow = /=>\s*\{/.exec(call);
    if (!arrow) continue;
    const braceIdx = open + 1 + arrow.index + arrow[0].length - 1;
    const end = findMatching(code, braceIdx);
    if (end === -1) continue;
    const titleArg = splitArgs(call)[0];
    tests.push({ title: stringLiteral(titleArg), bodyStart: braceIdx + 1, body: code.slice(braceIdx + 1, end) });
    re.lastIndex = close + 1;
  }
  return tests;
}

/** Analiza la salida de codegen. Tolera archivos incompletos (codegen escribe mientras se graba). */
export function parseCodegenOutput(code: string): ParseResult {
  const normalized = code.replace(/\r\n?/g, '\n');
  const tests = findTests(normalized);
  const steps: ParsedStep[] = [];
  const warnings: StepWarning[] = [];
  for (const t of tests) {
    const baseLine = lineAt(normalized, t.bodyStart);
    for (const st of splitStatements(t.body, baseLine)) {
      const c = classify(st.text);
      if (c.hidden) continue;
      steps.push({ index: steps.length + 1, line: st.line, kind: c.kind, description: c.description.slice(0, 500) });
      for (const w of c.warnings) warnings.push({ ...w, line: st.line });
    }
  }
  normalized.split('\n').forEach((text, i) => {
    if (/TODO\s*selector/i.test(text))
      warnings.push({
        code: 'TODO_SELECTOR',
        message: 'Selector pendiente (TODO selector): el test no podrá aprobarse así.',
        line: i + 1,
      });
  });
  const actionCount = steps.filter((s) => s.kind === 'accion').length;
  const verificationCount = steps.filter((s) => s.kind === 'verificacion').length;
  const unsupportedCount = steps.filter((s) => s.kind === 'no_soportada').length;
  let pending = 0;
  if (tests.length === 0) {
    warnings.push({ code: 'NO_TEST', message: 'Todavía no hay un test grabado.', line: null });
  } else if (verificationCount === 0 && actionCount > 0) {
    pending += 1;
    warnings.push({
      code: 'NO_VERIFICATION',
      message: 'Falta al menos una verificación del resultado esperado (ESP §10 regla 4).',
      line: null,
    });
  } else if (verificationCount > 0) {
    let lastVerification = -1;
    steps.forEach((s, i) => {
      if (s.kind === 'verificacion') lastVerification = i;
    });
    const trailing = steps.slice(lastVerification + 1).filter((s) => s.kind === 'accion');
    if (trailing.length > 0) {
      pending += 1;
      const lastAction = trailing[trailing.length - 1]!;
      warnings.push({
        code: 'ACTIONS_WITHOUT_VERIFICATION',
        message: `Falta verificación del paso ${lastAction.index}: hay acciones después de la última verificación.`,
        line: lastAction.line,
      });
    }
  }
  return {
    testCount: tests.length,
    steps,
    warnings,
    actionCount,
    verificationCount,
    unsupportedCount,
    pendingVerifications: pending,
  };
}

/** Pasos en el formato de `RecordingStepSchema` de la API (máx. 500). */
export function toApiSteps(result: ParseResult): { kind: StepKind; description: string }[] {
  return result.steps.slice(0, 500).map((s) => ({ kind: s.kind, description: s.description.slice(0, 500) }));
}
