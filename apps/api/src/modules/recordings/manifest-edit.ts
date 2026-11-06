/**
 * Edición del manifiesto `katalyst.manifest.json` en la rama del PR (nunca en la rama protegida). La entrada nueva
 * lleva `stableKey` nuevo y clasificación `sin_clasificar`: el developer clasifica en el PR y la validación del
 * manifiesto bloquea la aprobación mientras siga sin clasificar (ESP §10 regla 9, RF-GRB-05, RF-CAT-05).
 */
import { MANIFEST_FILE_NAME, ManifestTestSchema, type ManifestTestInput } from '@katalyst/shared';
import { GitProviderError, type GitPrProvider } from '../../adapters/git-pr/index.js';

export { MANIFEST_FILE_NAME };

export async function manifestWithEntry(
  git: GitPrProvider,
  baseBranch: string,
  entry: ManifestTestInput,
): Promise<string> {
  const parsedEntry = ManifestTestSchema.parse(entry);
  const raw = await git.readFile(baseBranch, MANIFEST_FILE_NAME);
  let manifest: { schemaVersion: number; tests: unknown[]; [k: string]: unknown };
  if (raw === null) {
    manifest = { schemaVersion: 1, tests: [] };
  } else {
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== 'object' || !Array.isArray((v as { tests?: unknown }).tests)) throw new Error('forma');
      manifest = v as typeof manifest;
    } catch {
      throw new GitProviderError('El manifiesto de la rama base no es JSON válido');
    }
  }
  const tests = manifest.tests as { stableKey?: string; file?: string }[];
  if (tests.some((t) => t.stableKey === parsedEntry.stableKey || t.file === parsedEntry.file)) {
    throw new GitProviderError('El manifiesto ya contiene la entrada o el archivo');
  }
  manifest.tests = [...manifest.tests, parsedEntry];
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
