/**
 * Manifiesto de tests `qa-tests/katalyst.manifest.json` (plan §4.2). Autoritativo para identidad, casos,
 * clasificación, etiquetas y variantes (ESP §10 regla 9, RF-CAT-05, RF-EJE-06).
 */
import { z } from 'zod';
import { ClassificationSchema } from '../enums.js';
import { CASE_REF_REGEX, PARAMETER_KEY_REGEX, TAG_REGEX } from '../schemas/common.js';
import { canonicalJson, sha256Hex } from '../crypto/sha256.js';

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILE_NAME = 'katalyst.manifest.json';
/** Etiqueta derivada de la clasificación `escritura` (no es el único control, RF-EJE-06). */
export const WRITE_TAG = '@escritura';

const uniq = (arr: readonly string[]) => new Set(arr).size === arr.length;

export const ManifestFilePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_\-./]+\.(?:spec|test)\.(?:ts|js|mts|mjs)$/, 'Ruta de test inválida')
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('//'),
    'Ruta con traversal o absoluta',
  );

export const ManifestTestSchema = z
  .object({
    stableKey: z.uuid({ version: 'v4' }),
    file: ManifestFilePathSchema,
    title: z.string().trim().min(1).max(500),
    cases: z.array(z.string().regex(CASE_REF_REGEX)).min(1).refine(uniq, 'Casos duplicados'),
    tags: z.array(z.string().regex(TAG_REGEX)).refine(uniq, 'Etiquetas duplicadas'),
    classification: ClassificationSchema,
    parameterKeys: z
      .array(z.string().regex(PARAMETER_KEY_REGEX))
      .min(1)
      .refine(uniq, 'parameterKeys duplicados')
      .default(['default']),
    writeIdempotencyApproved: z.boolean().default(false),
    owner: z.string().trim().min(1).max(100),
    status: z.enum(['aprobado', 'retirado']).default('aprobado'),
  })
  .strict();
export type ManifestTest = z.output<typeof ManifestTestSchema>;
export type ManifestTestInput = z.input<typeof ManifestTestSchema>;

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    tests: z.array(ManifestTestSchema).max(20_000),
  })
  .strict();
export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;

/** Etiquetas efectivas: las del manifiesto más `@escritura` si la clasificación es `escritura`. */
export function effectiveTags(t: Pick<ManifestTest, 'tags' | 'classification'>): string[] {
  const set = new Set(t.tags.filter((x) => x !== WRITE_TAG));
  if (t.classification === 'escritura') set.add(WRITE_TAG);
  return [...set].sort();
}

/** Forma canónica (orden estable) usada para el hash. */
export function canonicalManifest(m: Manifest): Manifest {
  return {
    schemaVersion: m.schemaVersion,
    tests: [...m.tests]
      .map((t) => ({
        ...t,
        cases: [...t.cases].sort(),
        tags: [...t.tags].sort(),
        parameterKeys: [...t.parameterKeys].sort(),
      }))
      .sort((a, b) => (a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0)),
  };
}

/** SHA-256 hex del manifiesto canónico (snapshot y revalidación en el worker, ESP §13.1). */
export function manifestHash(m: Manifest): string {
  return sha256Hex(canonicalJson(canonicalManifest(m)));
}
