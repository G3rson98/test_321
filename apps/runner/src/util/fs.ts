/**
 * Utilidades de archivos para secretos y temporales (RNF-SEG-01, ESP §13.7): directorios 0700, archivos 0600
 * creados de forma exclusiva, borrado recursivo tolerante y tamaño de árbol para cuotas (ARQ §6).
 */
import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
  await fs.chmod(dir, mode);
}

/**
 * Escribe un archivo secreto con permisos 0600. Falla si ya existe (no sobrescribe secretos ajenos) salvo
 * `overwrite`. Nunca registra el contenido.
 */
export async function writeSecretFile(file: string, content: string, opts: { overwrite?: boolean } = {}): Promise<void> {
  await ensureDir(path.dirname(file));
  const handle = await fs.open(file, opts.overwrite ? 'w' : 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/** Escritura atómica (tmp + rename) con permisos dados. */
export async function writeFileAtomic(file: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, file);
}

export async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/** Tamaño total en bytes de un árbol (sin seguir enlaces simbólicos). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try {
        total += (await fs.lstat(p)).size;
      } catch {
        // archivo borrado durante el recorrido
      }
    }
  }
  return total;
}

/** Actualiza mtime (salud del proceso; checkouts en uso con /data montado `noatime`). */
export async function touch(file: string): Promise<void> {
  const now = new Date();
  try {
    await fs.utimes(file, now, now);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
  }
}

export async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    size += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest('hex'), size };
}

/** ¿`child` está dentro de `parent` (o es igual)? */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Identificadores usados como nombres de directorio: solo UUID/sha/alfanuméricos (sin traversal). */
export function assertSafeSegment(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('identificador de ruta inválido');
  return id;
}
