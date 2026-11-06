/**
 * Preparación del archivo de test grabado (RF-GRB-02, RF-GRB-05; ESP §10, §13.6). Análisis ESTÁTICO: nunca se
 * ejecuta ni instala nada; la verificación de sintaxis usa el eliminador de tipos de Node (parser swc), que no
 * evalúa el código.
 * - Ruta y nombre generados por el servidor (sin traversal); título `C<id> <texto> @etiquetas` + anotación
 *   `stableKey` del manifiesto (convención qa-tests).
 * - Secretos/credenciales ⇒ rechazo (sin reflejar valores). Sintaxis inválida o sin `test(...)` ⇒ rechazo.
 * - `TODO selector`, verificaciones pendientes, `.only`/`.skip`, `waitForTimeout`, selectores generados, falta de
 *   `expect` ⇒ advertencias que bloquean la aprobación (el PR se abre como borrador para el developer).
 */
import * as nodeModule from 'node:module';
import {
  lintTestSource,
  ManifestFilePathSchema,
  MAX_RECORDING_BYTES,
  TAG_REGEX,
  verifySanitized,
  WRITE_TAG,
  type SourceIssue,
} from '@katalyst/shared';

export type RecordingIssueCode = SourceIssue['code'] | 'SYNTAX_ERROR' | 'SYNTAX_NOT_VERIFIED' | 'MULTIPLE_TESTS' | 'STORAGE_STATE_REMOVED' | 'UNSUPPORTED_STEPS' | 'METADATA_SECRET';

export interface RecordingIssue {
  code: RecordingIssueCode;
  message: string;
  line: number | null;
}

/** Hallazgos que RECHAZAN la grabación (no se abre PR). */
export const REJECTING_CODES: ReadonlySet<RecordingIssueCode> = new Set([
  'TOO_LARGE',
  'SECRET_DETECTED',
  'HARDCODED_CREDENTIALS',
  'METADATA_SECRET',
  'SYNTAX_ERROR',
  'NO_TEST',
]);

export function slugCaseRef(caseRef: string): string {
  return caseRef.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Ruta determinista del archivo grabado (permite releerlo para la revisión asistida). */
export function recordingFilePath(dir: string, caseRef: string, recordingId: string): string {
  const p = `${dir.replace(/\/+$/, '')}/${slugCaseRef(caseRef)}-${recordingId.slice(0, 8)}.spec.ts`;
  return ManifestFilePathSchema.parse(p);
}

export function recordingBranch(caseRef: string, recordingId: string): string {
  return `katalyst/grabacion/${slugCaseRef(caseRef)}-${recordingId.slice(0, 8)}`;
}

/** Etiquetas válidas, sin `@escritura` (derivada de la clasificación) y sin duplicados. */
export function normalizeTags(...lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>();
  for (const l of lists) for (const t of l) if (TAG_REGEX.test(t) && t !== WRITE_TAG) out.add(t);
  return [...out].sort();
}

/** Título `C<id> <texto> @tags`: elimina IDs/etiquetas del texto libre para no duplicarlos. */
export function buildTitle(caseRef: string, text: string, tags: readonly string[]): string {
  const clean = text
    .replace(/\bC[1-9]\d*\b/g, '')
    .replace(/(^|\s)@[A-Za-z0-9_-]+/g, ' ')
    .replace(/[\r\n\t`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return [caseRef, clean, ...tags].filter(Boolean).join(' ');
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

export function checkSyntax(code: string): RecordingIssue | null {
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (c: string) => string }).stripTypeScriptTypes;
  if (typeof strip !== 'function') {
    return { code: 'SYNTAX_NOT_VERIFIED', message: 'No se pudo verificar la sintaxis en este entorno', line: null };
  }
  try {
    strip(code);
    return null;
  } catch (err) {
    const c = (err as { code?: string }).code;
    if (c === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      return { code: 'SYNTAX_NOT_VERIFIED', message: 'Sintaxis TypeScript no verificable (requiere transformación)', line: null };
    }
    return { code: 'SYNTAX_ERROR', message: 'El código grabado no es TypeScript válido', line: null };
  }
}

export interface BuildRecordedFileInput {
  code: string;
  caseRef: string;
  titleText: string;
  tags: string[];
  stableKey: string;
  recordingId: string;
  fixtureImport: string;
}

/** Reescribe la salida de codegen al formato de qa-tests. No valida (ver `analyzeRecording`). */
export function buildRecordedTestFile(input: BuildRecordedFileInput): { content: string; title: string; issues: RecordingIssue[] } {
  const issues: RecordingIssue[] = [];
  let code = input.code.replace(/\r\n?/g, '\n');
  // storageState nunca se versiona ni se carga desde el test (ESP §13.6/§13.7).
  if (/storageState/.test(code)) {
    code = code
      .split('\n')
      .filter((l) => !/storageState/.test(l))
      .join('\n');
    issues.push({ code: 'STORAGE_STATE_REMOVED', message: 'Se eliminaron líneas con storageState', line: null });
  }
  const importLine = `import { expect, stableKey, test } from '${input.fixtureImport}';`;
  const importRe = /^import\s*\{[^}]*\}\s*from\s*['"]@playwright\/test['"];?\s*$/m;
  code = importRe.test(code) ? code.replace(importRe, importLine) : `${importLine}\n${code}`;
  const title = buildTitle(input.caseRef, input.titleText, input.tags);
  const testRe = /\btest\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*/g;
  const matches = [...code.matchAll(testRe)];
  if (matches.length > 1) {
    issues.push({
      code: 'MULTIPLE_TESTS',
      message: 'La grabación contiene más de un test; solo el primero quedó vinculado al caso',
      line: lineOf(code, matches[1]!.index ?? 0),
    });
  }
  if (matches.length > 0) {
    const m = matches[0]!;
    const replacement = `test(\n  ${JSON.stringify(title)},\n  { annotation: [stableKey('${input.stableKey}')] },\n  `;
    code = code.slice(0, m.index) + replacement + code.slice((m.index ?? 0) + m[0].length);
  }
  const header = [
    '/**',
    ` * ${input.caseRef} — test grabado con el asistente local de Katalyst (sesión ${input.recordingId}).`,
    ' * PENDIENTE DE REVISIÓN: refactorizar selectores a Page Objects, completar verificaciones del resultado esperado',
    ' * y clasificar (lectura/escritura) en katalyst.manifest.json antes de aprobar (ESP §10, RF-GRB-05).',
    ' */',
  ].join('\n');
  return { content: `${header}\n${code.trim()}\n`, title, issues };
}

export interface RecordingAnalysis {
  content: string;
  title: string;
  /** Rechazan la grabación. */
  rejections: RecordingIssue[];
  /** Bloquean la aprobación del PR. */
  warnings: RecordingIssue[];
}

export function analyzeRecording(
  input: BuildRecordedFileInput & {
    metadata: string[];
    pendingVerifications: number;
    unsupportedSteps: number;
  },
): RecordingAnalysis {
  const all: RecordingIssue[] = [];
  if (new TextEncoder().encode(input.code).length > MAX_RECORDING_BYTES) {
    return { content: '', title: '', rejections: [{ code: 'TOO_LARGE', message: 'El código supera 1 MiB', line: null }], warnings: [] };
  }
  // Metadatos (título libre, etiquetas, pasos) tampoco pueden contener secretos.
  const meta = verifySanitized(input.metadata.join('\n'));
  if (!meta.ok) all.push({ code: 'METADATA_SECRET', message: 'Los metadatos de la grabación contienen posibles secretos', line: null });
  const built = buildRecordedTestFile(input);
  all.push(...built.issues);
  const syntax = checkSyntax(built.content);
  if (syntax) all.push(syntax);
  // Secretos sobre el código ORIGINAL y el generado (lint incluye verifySanitized); mensajes sin valores.
  all.push(...lintTestSource(built.content).issues.map((i) => ({ code: i.code, message: i.message, line: i.line })));
  if (!verifySanitized(input.code).ok && !all.some((i) => i.code === 'SECRET_DETECTED')) {
    all.push({ code: 'SECRET_DETECTED', message: 'Posibles secretos o datos personales en el código grabado', line: null });
  }
  if (input.pendingVerifications > 0) {
    all.push({
      code: 'PENDING_VERIFICATION',
      message: `${input.pendingVerifications} verificación(es) pendiente(s) informadas por el asistente`,
      line: null,
    });
  }
  if (input.unsupportedSteps > 0) {
    all.push({ code: 'UNSUPPORTED_STEPS', message: `${input.unsupportedSteps} interacción(es) no soportada(s) por codegen`, line: null });
  }
  const rejections = all.filter((i) => REJECTING_CODES.has(i.code));
  const warnings = all.filter((i) => !REJECTING_CODES.has(i.code));
  return { content: built.content, title: built.title, rejections, warnings };
}
