/**
 * Sanitización LOCAL de evidencia antes de subirla (RNF-SEG-02, ESP §13.7). Formatos:
 * - JSON / JSONL (reporte JSON de Playwright, `trace.trace`, `trace.network`): `sanitizeJson` profundo.
 * - HTML (reporte HTML, snapshots DOM): `sanitizeHtml`; los blobs `data:application/zip;base64,…` embebidos
 *   (reporte HTML de Playwright) se decodifican y sanitizan como ZIP.
 * - ZIP (trazas): cada entrada según su formato; se reescribe el ZIP.
 * - Texto (logs, junit, markdown): `sanitizeText`.
 * - Binario (capturas, video, fuentes): no se pueden "limpiar" píxeles; se inspeccionan sus cadenas imprimibles
 *   (metadatos) y con cualquier hallazgo NO se publica. Su publicación depende de que la política del ambiente
 *   habilite el tipo tras el ensayo de canarios.
 * Siempre se termina con `verifySanitized` sobre el resultado; con hallazgos residuales ⇒ `fallido` (no subir).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sanitizeHtml,
  sanitizeJson,
  sanitizeText,
  summarizeFindings,
  verifySanitized,
  type Finding,
} from '@katalyst/shared';
import { isZip, readZip, writeZip, ZipFormatError, type ZipEntry } from './zip.js';

export const SANITIZER_VERSION = 'katalyst-runner-sanitizer/1';

export type ArtifactFormat = 'json' | 'jsonl' | 'html' | 'text' | 'zip' | 'binary';

export interface SanitizeOptions {
  knownSecrets: readonly string[];
  /** Límite de anidamiento de contenedores (ZIP dentro de HTML dentro de ZIP…). */
  maxNesting?: number;
}

export interface SanitizeBufferResult {
  ok: boolean;
  data: Buffer;
  /** Hallazgos enmascarados (informativo, sin valores). */
  masked: number;
  /** Hallazgos que permanecen tras sanitizar (bloquean la publicación). */
  remaining: Finding[];
  reason: string | null;
  format: ArtifactFormat;
}

const JSONL_EXT = new Set(['.jsonl', '.ndjson', '.trace', '.network', '.stacks']);
const TEXT_EXT = new Set(['.txt', '.log', '.md', '.xml', '.csv', '.css', '.js', '.mjs', '.svg', '.yml', '.yaml']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.webm', '.mp4', '.woff', '.woff2', '.ttf', '.otf', '.ico', '.bin', '.pdf']);

function looksText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return false;
  return Buffer.from(sample.toString('utf8'), 'utf8').length >= sample.length * 0.9;
}

export function detectFormat(name: string, contentType: string, buf: Buffer): ArtifactFormat {
  if (isZip(buf)) return 'zip';
  const ext = path.extname(name).toLowerCase();
  const ct = contentType.toLowerCase();
  if (BINARY_EXT.has(ext) || ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('font/')) return 'binary';
  if (JSONL_EXT.has(ext) || ct.includes('ndjson')) return 'jsonl';
  if (ext === '.json' || ct.includes('json')) return 'json';
  if (ext === '.html' || ext === '.htm' || ct.includes('html')) return 'html';
  if (TEXT_EXT.has(ext) || ct.startsWith('text/')) return 'text';
  if (!looksText(buf)) return 'binary';
  const head = buf.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<')) return 'html';
  return 'text';
}

const count = (fs: readonly Finding[]) => fs.reduce((n, f) => n + f.count, 0);

function sanitizeJsonText(text: string, opts: SanitizeOptions): { value: string; masked: number; remaining: Finding[]; complete: boolean } {
  const parsed = JSON.parse(text) as unknown;
  const r = sanitizeJson(parsed, { knownSecrets: opts.knownSecrets });
  const v = verifySanitized(r.value, { knownSecrets: opts.knownSecrets });
  const pretty = /^\s*[[{]\s*\n/.test(text);
  return {
    value: pretty ? JSON.stringify(r.value, null, 2) : JSON.stringify(r.value),
    masked: count(r.findings),
    remaining: v.findings,
    complete: r.complete,
  };
}

/** Cadenas imprimibles (≥ 6) de un binario: metadatos EXIF/PNG tEXt, nombres, URLs incrustadas. */
export function printableStrings(buf: Buffer, min = 6): string {
  const out: string[] = [];
  let cur = '';
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f) {
      cur += String.fromCharCode(byte);
    } else {
      if (cur.length >= min) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= min) out.push(cur);
  return out.join('\n');
}

/** Entradas `screencast/*.jpeg|png` de una traza (fotogramas de la página, píxeles no sanitizables). */
export const SCREENCAST_FRAME_RE = /(^|\/)screencast\/[^/]+\.(?:jpe?g|png|webp)$/i;

const BLOB_RE = /data:(application\/(?:zip|json)|text\/(?:html|plain));base64,([A-Za-z0-9+/=]+)/g;
const PW_REPORT_MARKER = 'id="playwrightReportBase64"';

function sanitizeHtmlText(html: string, opts: SanitizeOptions, depth: number): { value: string; masked: number; remaining: Finding[]; failure: string | null } {
  const blobs: string[] = [];
  let masked = 0;
  const remaining: Finding[] = [];
  let failure: string | null = null;
  // 1) Blobs embebidos: se sanitizan por separado (base64 no es inspeccionable como texto).
  let shell = html.replace(BLOB_RE, (_m, mime: string, b64: string) => {
    const inner = Buffer.from(b64, 'base64');
    const name = mime.includes('zip') ? 'embebido.zip' : mime.includes('json') ? 'embebido.json' : mime.includes('html') ? 'embebido.html' : 'embebido.txt';
    const r = sanitizeBuffer(name, mime, inner, opts, depth + 1);
    masked += r.masked;
    remaining.push(...r.remaining);
    if (!r.ok) failure = failure ?? `blob embebido: ${r.reason ?? 'no sanitizable'}`;
    blobs.push(`data:${mime};base64,${r.data.toString('base64')}`);
    return `__KATALYST_BLOB_${blobs.length - 1}__`;
  });
  // 2) Reporte HTML de Playwright: los <script>/<style> son el visor estático del paquete Playwright (sin datos de
  //    la corrida, que van en el blob ya sanitizado). Se excluyen de las reglas para no romper el visor.
  const preserved: string[] = [];
  if (shell.includes(PW_REPORT_MARKER)) {
    shell = shell.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
      preserved.push(m);
      return `__KATALYST_KEEP_${preserved.length - 1}__`;
    });
  }
  const s = sanitizeHtml(shell, { knownSecrets: opts.knownSecrets });
  masked += count(s.findings);
  const v = verifySanitized(s.value, { knownSecrets: opts.knownSecrets });
  remaining.push(...v.findings);
  const value = s.value
    .replace(/__KATALYST_KEEP_(\d+)__/g, (_m, i: string) => preserved[Number(i)] ?? '')
    .replace(/__KATALYST_BLOB_(\d+)__/g, (_m, i: string) => blobs[Number(i)] ?? '');
  return { value, masked, remaining, failure };
}

export function sanitizeBuffer(
  name: string,
  contentType: string,
  buf: Buffer,
  opts: SanitizeOptions,
  depth = 0,
): SanitizeBufferResult {
  const format = detectFormat(name, contentType, buf);
  const fail = (reason: string, remaining: Finding[] = [], masked = 0): SanitizeBufferResult => ({
    ok: false,
    data: Buffer.alloc(0),
    masked,
    remaining,
    reason,
    format,
  });
  if (depth > (opts.maxNesting ?? 4)) return fail('anidamiento de contenedores excesivo');
  try {
    switch (format) {
      case 'json': {
        const text = buf.toString('utf8');
        let r: ReturnType<typeof sanitizeJsonText>;
        try {
          r = sanitizeJsonText(text, opts);
        } catch {
          return sanitizeBuffer(`${name}.jsonl`, 'application/x-ndjson', buf, opts, depth);
        }
        if (!r.complete) return fail('JSON con anidamiento no inspeccionable', r.remaining, r.masked);
        if (r.remaining.length) return fail(`hallazgos residuales: ${summarizeFindings(r.remaining)}`, r.remaining, r.masked);
        return { ok: true, data: Buffer.from(r.value, 'utf8'), masked: r.masked, remaining: [], reason: null, format };
      }
      case 'jsonl': {
        const lines = buf.toString('utf8').split('\n');
        let masked = 0;
        const remaining: Finding[] = [];
        const out = lines.map((line) => {
          if (!line.trim()) return line;
          try {
            const r = sanitizeJsonText(line, opts);
            masked += r.masked;
            remaining.push(...r.remaining);
            if (!r.complete) remaining.push({ kind: 'depth_exceeded', location: name, count: 1 });
            return r.value;
          } catch {
            const t = sanitizeText(line, { knownSecrets: opts.knownSecrets });
            masked += count(t.findings);
            remaining.push(...verifySanitized(t.value, { knownSecrets: opts.knownSecrets }).findings);
            return t.value;
          }
        });
        if (remaining.length) return fail(`hallazgos residuales: ${summarizeFindings(remaining)}`, remaining, masked);
        return { ok: true, data: Buffer.from(out.join('\n'), 'utf8'), masked, remaining: [], reason: null, format };
      }
      case 'html': {
        const r = sanitizeHtmlText(buf.toString('utf8'), opts, depth);
        if (r.failure) return fail(r.failure, r.remaining, r.masked);
        if (r.remaining.length) return fail(`hallazgos residuales: ${summarizeFindings(r.remaining)}`, r.remaining, r.masked);
        return { ok: true, data: Buffer.from(r.value, 'utf8'), masked: r.masked, remaining: [], reason: null, format };
      }
      case 'text': {
        const t = sanitizeText(buf.toString('utf8'), { knownSecrets: opts.knownSecrets });
        const v = verifySanitized(t.value, { knownSecrets: opts.knownSecrets });
        if (v.findings.length) return fail(`hallazgos residuales: ${summarizeFindings(v.findings)}`, v.findings, count(t.findings));
        return { ok: true, data: Buffer.from(t.value, 'utf8'), masked: count(t.findings), remaining: [], reason: null, format };
      }
      case 'zip': {
        let entries: ZipEntry[];
        try {
          entries = readZip(buf);
        } catch (e) {
          return fail(e instanceof ZipFormatError ? e.message : 'ZIP ilegible');
        }
        let masked = 0;
        const remaining: Finding[] = [];
        const out: ZipEntry[] = [];
        for (const entry of entries) {
          if (entry.isDirectory) {
            out.push(entry);
            continue;
          }
          // Fotogramas del screencast de una traza de Playwright: son píxeles de la página completa (equivalen a
          // capturas) y no pueden sanitizarse; se eliminan para que la traza solo publique formatos verificables
          // (ESP §13.7; hallazgo del ensayo de canarios, D-053). El visor de trazas funciona sin la tira de imágenes.
          if (SCREENCAST_FRAME_RE.test(entry.name)) {
            masked += 1;
            continue;
          }
          const r = sanitizeBuffer(entry.name, '', entry.data, opts, depth + 1);
          masked += r.masked;
          remaining.push(...r.remaining.map((f) => ({ ...f, location: `${entry.name}:${f.location}` })));
          if (!r.ok) return fail(`entrada ${path.basename(entry.name)}: ${r.reason ?? 'no sanitizable'}`, remaining, masked);
          out.push({ name: entry.name, data: r.data, isDirectory: false });
        }
        return { ok: true, data: writeZip(out), masked, remaining: [], reason: null, format };
      }
      case 'binary': {
        const v = verifySanitized(printableStrings(buf), { knownSecrets: opts.knownSecrets });
        if (v.findings.length) {
          return fail(`binario con datos sensibles en metadatos (${summarizeFindings(v.findings)}); no puede sanitizarse`, v.findings);
        }
        return { ok: true, data: buf, masked: 0, remaining: [], reason: null, format };
      }
    }
  } catch {
    return fail('error al sanitizar el formato');
  }
}

export interface SanitizedFile {
  status: 'sanitizado' | 'fallido';
  reason: string | null;
  outputPath: string | null;
  findingsRemaining: number;
  masked: number;
  format: ArtifactFormat;
}

/**
 * Sanitiza `input` hacia `outputPath` (0600). El archivo crudo NO se conserva: se borra siempre (éxito o error),
 * de modo que una falla de sanitización no deja evidencia cruda persistida (ESP §13.7).
 */
export async function sanitizeArtifactFile(
  input: string,
  outputPath: string,
  contentType: string,
  opts: SanitizeOptions,
  { keepInput = false }: { keepInput?: boolean } = {},
): Promise<SanitizedFile> {
  try {
    const buf = await fs.readFile(input);
    const r = sanitizeBuffer(path.basename(input), contentType, buf, opts);
    if (!r.ok) {
      return { status: 'fallido', reason: r.reason, outputPath: null, findingsRemaining: count(r.remaining), masked: r.masked, format: r.format };
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(outputPath, r.data, { mode: 0o600 });
    return { status: 'sanitizado', reason: null, outputPath, findingsRemaining: 0, masked: r.masked, format: r.format };
  } finally {
    if (!keepInput) await fs.rm(input, { force: true });
  }
}
