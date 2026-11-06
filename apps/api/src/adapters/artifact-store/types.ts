/**
 * Almacén privado de artefactos (plan §4.5): S3 (producción), MinIO (desarrollo) y filesystem (desarrollo local).
 * - Objetos privados; acceso SOLO mediante URLs firmadas de vida ≤ 5 min tras autorización por recurso (RNF-SEG-05).
 * - Claves generadas por el servidor (`runs/<runId>/<artifactId>.<ext>`), sin traversal.
 * - Checksum SHA-256, tamaño y tipo de contenido validados antes de aceptar la carga (ESP §13.7).
 * RF-RES-02, RNF-SEG-05.
 */
import type { Readable } from 'node:stream';
import { KatalystError, SIGNED_URL_MAX_TTL_SECONDS, type ArtifactKind } from '@katalyst/shared';

export interface PresignedRequest {
  method: 'PUT' | 'GET';
  url: string;
  /** Encabezados que el cliente DEBE enviar exactamente (firmados). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PutOptions {
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  expiresInSeconds: number;
}

export interface GetOptions {
  expiresInSeconds: number;
  contentType?: string;
  /** Nombre sugerido; fuerza `Content-Disposition: attachment`. */
  downloadName?: string;
}

export interface ObjectStat {
  sizeBytes: number;
  /** SHA-256 hex si el almacén lo conoce (S3 con checksum, fs calculado). */
  checksumSha256: string | null;
}

export interface ArtifactStore {
  readonly kind: 'fs' | 's3' | 'minio';
  presignPut(key: string, opts: PutOptions): Promise<PresignedRequest>;
  presignGet(key: string, opts: GetOptions): Promise<PresignedRequest>;
  stat(key: string): Promise<ObjectStat | null>;
  /** Lectura en el servidor (visor de reportes). */
  getStream(key: string): Promise<Readable>;
  /** Escritura directa desde el servidor (pruebas, migraciones). */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

/** Tipos de contenido permitidos por clase de artefacto (ESP §13.7: tipo validado). */
export const ARTIFACT_CONTENT_TYPES: Record<ArtifactKind, readonly string[]> = {
  reporte: ['text/html', 'application/json'],
  traza: ['application/zip'],
  video: ['video/webm', 'video/mp4'],
  captura: ['image/png', 'image/jpeg'],
  log: ['text/plain', 'application/json'],
  dxmon_samples: ['application/json'],
  dxmon_summary: ['application/json'],
};

const EXTENSIONS: Record<string, string> = {
  'text/html': 'html',
  'application/json': 'json',
  'application/zip': 'zip',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
};

/** Tamaño máximo por objeto (además de la cuota por corrida de 250 MiB, ARQ §6). */
export const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

/** Normaliza `content-type` (sin parámetros, minúsculas). */
export function baseContentType(ct: string): string {
  return ct.split(';')[0]!.trim().toLowerCase();
}

export function isAllowedContentType(kind: ArtifactKind, contentType: string): boolean {
  return ARTIFACT_CONTENT_TYPES[kind].includes(baseContentType(contentType));
}

export function extensionFor(contentType: string): string {
  return EXTENSIONS[baseContentType(contentType)] ?? 'bin';
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,400}$/;

/** Clave generada por el servidor; rechaza traversal o caracteres fuera de la lista. */
export function assertSafeKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) {
    throw new KatalystError('BAD_REQUEST', 'Clave de artefacto inválida.');
  }
  return key;
}

export function artifactStorageKey(runId: string, artifactId: string, contentType: string): string {
  return assertSafeKey(`runs/${runId}/${artifactId}.${extensionFor(contentType)}`);
}

/** Acota la vigencia de una URL firmada a ≤ 300 s (RNF-SEG-05). */
export function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return SIGNED_URL_MAX_TTL_SECONDS;
  return Math.min(Math.floor(seconds), SIGNED_URL_MAX_TTL_SECONDS);
}

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex');
}
