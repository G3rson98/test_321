/**
 * Almacén local por grabación en el directorio temporal del usuario (ESP §13.6, §13.7, RNF-SEG-01):
 *   <temp>/katalyst-recorder/<recordingId>/
 *     meta.json            metadatos sin secretos (instantes de creación/vencimiento)
 *     state.json           storageState del login interactivo (SECRETO: 0600, se borra al cerrar/cancelar/vencer 2 h)
 *     recording.spec.ts    salida de codegen (se borra tras envío/cancelación o a las 24 h)
 * El directorio se crea con 0700 (POSIX) y, en Windows, se restringe la ACL al usuario actual (icacls, best-effort).
 * El storageState jamás se envía por API ni al renderer.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const STORAGE_STATE_TTL_MS = 2 * 60 * 60 * 1000;
export const LOCAL_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SessionMetaSchema = z.object({
  recordingId: z.string().regex(UUID_RE),
  createdAt: z.string(),
  recordingExpiresAt: z.string(),
  storageStateCreatedAt: z.string().nullable(),
  codeSavedAt: z.string().nullable(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export interface SessionPaths {
  dir: string;
  metaPath: string;
  storageStatePath: string;
  codePath: string;
}

export interface SessionStoreOptions {
  baseDir: string;
  now?: () => number;
  /** Restringe la ACL del directorio al usuario actual (Windows). Best-effort: un fallo no detiene la grabación. */
  restrictDirectory?: (dir: string) => Promise<void>;
}

export function isRecordingId(id: string): boolean {
  return UUID_RE.test(id);
}

export class SessionStore {
  readonly baseDir: string;
  private readonly now: () => number;
  private readonly restrict: ((dir: string) => Promise<void>) | undefined;

  constructor(opts: SessionStoreOptions) {
    this.baseDir = opts.baseDir;
    this.now = opts.now ?? (() => Date.now());
    this.restrict = opts.restrictDirectory;
  }

  paths(recordingId: string): SessionPaths {
    if (!isRecordingId(recordingId)) throw new Error('recordingId inválido');
    const dir = join(this.baseDir, recordingId.toLowerCase());
    return {
      dir,
      metaPath: join(dir, 'meta.json'),
      storageStatePath: join(dir, 'state.json'),
      codePath: join(dir, 'recording.spec.ts'),
    };
  }

  async ensureBase(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.baseDir, 0o700).catch(() => undefined);
    if (this.restrict) await this.restrict(this.baseDir).catch(() => undefined);
  }

  /** Crea (o reutiliza) la carpeta de la grabación. */
  async open(recordingId: string, recordingExpiresAt: string): Promise<SessionPaths> {
    await this.ensureBase();
    const p = this.paths(recordingId);
    await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(p.dir, 0o700).catch(() => undefined);
    if (this.restrict) await this.restrict(p.dir).catch(() => undefined);
    const existing = await this.readMeta(recordingId);
    if (!existing) {
      await this.writeMeta({
        recordingId: recordingId.toLowerCase(),
        createdAt: new Date(this.now()).toISOString(),
        recordingExpiresAt,
        storageStateCreatedAt: null,
        codeSavedAt: null,
      });
    } else if (existing.recordingExpiresAt !== recordingExpiresAt) {
      await this.writeMeta({ ...existing, recordingExpiresAt });
    }
    return p;
  }

  async readMeta(recordingId: string): Promise<SessionMeta | null> {
    try {
      const raw = await fs.readFile(this.paths(recordingId).metaPath, 'utf8');
      return SessionMetaSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    const p = this.paths(meta.recordingId);
    await fs.writeFile(p.metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  /** Guarda el storageState (objeto de Playwright) con permisos 0600. Nunca se registra su contenido. */
  async writeStorageState(recordingId: string, state: unknown): Promise<string> {
    const p = this.paths(recordingId);
    await fs.writeFile(p.storageStatePath, JSON.stringify(state), { mode: 0o600 });
    await fs.chmod(p.storageStatePath, 0o600).catch(() => undefined);
    const meta = await this.readMeta(recordingId);
    if (meta) await this.writeMeta({ ...meta, storageStateCreatedAt: new Date(this.now()).toISOString() });
    return p.storageStatePath;
  }

  /** Ruta del storageState si existe y no venció (2 h desde su creación ni pasado el vencimiento de la grabación). */
  async validStorageState(recordingId: string): Promise<string | null> {
    const meta = await this.readMeta(recordingId);
    const p = this.paths(recordingId);
    if (!meta?.storageStateCreatedAt) return null;
    if (this.storageStateExpired(meta)) {
      await this.deleteStorageState(recordingId);
      return null;
    }
    try {
      await fs.access(p.storageStatePath);
      return p.storageStatePath;
    } catch {
      return null;
    }
  }

  storageStateExpired(meta: SessionMeta): boolean {
    const now = this.now();
    if (Date.parse(meta.recordingExpiresAt) <= now) return true;
    if (!meta.storageStateCreatedAt) return false;
    return now - Date.parse(meta.storageStateCreatedAt) >= STORAGE_STATE_TTL_MS;
  }

  codeExpired(meta: SessionMeta): boolean {
    const ref = meta.codeSavedAt ?? meta.createdAt;
    return this.now() - Date.parse(ref) >= LOCAL_CODE_TTL_MS;
  }

  /** Sobrescribe con ceros y elimina (best-effort: en SSD no garantiza borrado físico). */
  async deleteStorageState(recordingId: string): Promise<boolean> {
    const p = this.paths(recordingId);
    const existed = await shredFile(p.storageStatePath);
    const meta = await this.readMeta(recordingId);
    if (meta?.storageStateCreatedAt) await this.writeMeta({ ...meta, storageStateCreatedAt: null });
    return existed;
  }

  async markCodeSaved(recordingId: string): Promise<void> {
    const meta = await this.readMeta(recordingId);
    if (meta) await this.writeMeta({ ...meta, codeSavedAt: new Date(this.now()).toISOString() });
  }

  async readCode(recordingId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.paths(recordingId).codePath, 'utf8');
    } catch {
      return null;
    }
  }

  async deleteCode(recordingId: string): Promise<void> {
    await fs.rm(this.paths(recordingId).codePath, { force: true });
  }

  /** Elimina toda la carpeta de la grabación (storageState primero). */
  async remove(recordingId: string): Promise<void> {
    await this.deleteStorageState(recordingId).catch(() => undefined);
    await fs.rm(this.paths(recordingId).dir, { recursive: true, force: true });
  }

  /** Entradas de la carpeta base (para limpieza). */
  async listEntries(): Promise<{ name: string; isDir: boolean }[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  }

  async removeEntry(name: string): Promise<void> {
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') return;
    const full = join(this.baseDir, name);
    if (isRecordingId(name)) await shredFile(join(full, 'state.json'));
    await fs.rm(full, { recursive: true, force: true });
  }
}

async function shredFile(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    return false;
  }
  try {
    const fh = await fs.open(path, 'r+');
    try {
      await fh.write(Buffer.alloc(Math.min(size, 16 * 1024 * 1024)), 0, Math.min(size, 16 * 1024 * 1024), 0);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // sin permiso de escritura: se elimina igualmente
  }
  await fs.rm(path, { force: true });
  return true;
}
