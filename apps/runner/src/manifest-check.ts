/**
 * Revalidación del manifiesto del commit en el worker (ESP §13.1: "Validar nuevamente en el worker el hash del
 * manifiesto y el commit"). La usan el supervisor (tras el checkout) y el ejecutor (antes de correr).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE_NAME, ManifestSchema, manifestHash, type Manifest } from '@katalyst/shared';

export type ManifestCheck =
  | { ok: true; manifest: Manifest; hash: string }
  | { ok: false; error: 'manifiesto_ausente' | 'manifiesto_invalido' | 'hash_no_coincide'; hash: string | null; manifest: Manifest | null };

export async function readManifest(testsDir: string): Promise<{ raw: unknown; manifest: Manifest | null; error: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(path.join(testsDir, MANIFEST_FILE_NAME), 'utf8');
  } catch {
    return { raw: null, manifest: null, error: 'manifiesto_ausente' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { raw: null, manifest: null, error: 'manifiesto_invalido' };
  }
  const parsed = ManifestSchema.safeParse(raw);
  return parsed.success ? { raw, manifest: parsed.data, error: null } : { raw, manifest: null, error: 'manifiesto_invalido' };
}

export async function verifyManifestHash(testsDir: string, expectedHash: string): Promise<ManifestCheck> {
  const { manifest, error } = await readManifest(testsDir);
  if (!manifest) {
    return { ok: false, error: error === 'manifiesto_ausente' ? 'manifiesto_ausente' : 'manifiesto_invalido', hash: null, manifest: null };
  }
  const hash = manifestHash(manifest);
  if (hash !== expectedHash) return { ok: false, error: 'hash_no_coincide', hash, manifest };
  return { ok: true, manifest, hash };
}
