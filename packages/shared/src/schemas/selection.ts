/**
 * Selección de ejecución: exactamente uno de `suiteId | caseIds | tags` (ESP §9).
 * Listas no vacías, sin duplicados; máximo 500 casos explícitos (ESP §17.3). Etiquetas se combinan con OR.
 * RF-EJE-01, RF-PRG-01, RF-CAT-03.
 */
import { z } from 'zod';
import { TagSchema, UuidSchema } from './common.js';

export const MAX_EXPLICIT_CASES = 500;
export const MAX_TAGS = 50;
export const MAX_SECTIONS = 200;

function noDuplicates(arr: readonly string[]): boolean {
  return new Set(arr).size === arr.length;
}

const caseIdsField = z
  .array(UuidSchema)
  .min(1, { message: 'SELECTION_EMPTY' })
  .max(MAX_EXPLICIT_CASES, { message: 'SELECTION_TOO_LARGE' })
  .refine(noDuplicates, { message: 'SELECTION_DUPLICATES' });

const tagsField = z
  .array(TagSchema)
  .min(1, { message: 'SELECTION_EMPTY' })
  .max(MAX_TAGS, { message: 'SELECTION_TOO_LARGE' })
  .refine(noDuplicates, { message: 'SELECTION_DUPLICATES' });

const sectionIdsField = z
  .array(UuidSchema)
  .min(1, { message: 'SELECTION_EMPTY' })
  .max(MAX_SECTIONS, { message: 'SELECTION_TOO_LARGE' })
  .refine(noDuplicates, { message: 'SELECTION_DUPLICATES' });

/** Campos de selección planos tal como llegan en el cuerpo (`POST /runs`, `/runs/preview`, `/schedules`). */
export const SelectionFieldsShape = {
  /** UUID local de `suite`. */
  suiteId: UuidSchema.optional(),
  /** UUIDs locales de `testrail_case` (D-011). */
  caseIds: caseIdsField.optional(),
  tags: tagsField.optional(),
} as const;

/** Refinamiento "exactamente uno" reutilizable sobre un objeto con los campos de selección. */
export function refineExactlyOneSelection(
  value: { suiteId?: string | undefined; caseIds?: string[] | undefined; tags?: string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const present = (['suiteId', 'caseIds', 'tags'] as const).filter((k) => value[k] !== undefined);
  if (present.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'SELECTION_EXCLUSIVE',
      path: present.length === 0 ? [] : [present[1] ?? present[0]!],
      params: { code: 'SELECTION_EXCLUSIVE', present },
    });
  }
}

export const SelectionInputSchema = z.object(SelectionFieldsShape).superRefine(refineExactlyOneSelection);
export type SelectionInput = z.infer<typeof SelectionInputSchema>;

/** Forma discriminada normalizada (la que guarda el snapshot y el `schedule.selector`). */
export const RunSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('suite'), suiteId: UuidSchema }),
  z.object({ kind: z.literal('cases'), caseIds: caseIdsField }),
  z.object({ kind: z.literal('tags'), tags: tagsField }),
]);
export type RunSelection = z.infer<typeof RunSelectionSchema>;

/** Convierte la entrada plana validada a la forma discriminada. Lanza si no hay exactamente uno. */
export function normalizeSelection(input: {
  suiteId?: string | undefined;
  caseIds?: string[] | undefined;
  tags?: string[] | undefined;
}): RunSelection {
  const present = [input.suiteId, input.caseIds, input.tags].filter((v) => v !== undefined).length;
  if (present !== 1) throw new Error('SELECTION_EXCLUSIVE');
  if (input.suiteId !== undefined) return { kind: 'suite', suiteId: input.suiteId };
  if (input.caseIds !== undefined) return { kind: 'cases', caseIds: input.caseIds };
  return { kind: 'tags', tags: input.tags! };
}

/** Inversa de `normalizeSelection` para formularios del panel. */
export function selectionToFields(sel: RunSelection): { suiteId?: string; caseIds?: string[]; tags?: string[] } {
  switch (sel.kind) {
    case 'suite':
      return { suiteId: sel.suiteId };
    case 'cases':
      return { caseIds: sel.caseIds };
    case 'tags':
      return { tags: sel.tags };
  }
}

/**
 * Selector de una suite guardada (ESP §7 `suite.selector`: casos, etiquetas, secciones).
 * Al menos un criterio; se combinan con OR (unión). Secciones incluyen descendientes (ESP §9).
 */
export const SuiteSelectorSchema = z
  .object({
    caseIds: caseIdsField.optional(),
    tags: tagsField.optional(),
    sectionIds: sectionIdsField.optional(),
    /** Excluir tests marcados flaky al resolver (RF-CAT-04). */
    excludeFlaky: z.boolean().default(false),
  })
  .refine((s) => s.caseIds !== undefined || s.tags !== undefined || s.sectionIds !== undefined, {
    message: 'SELECTION_EMPTY',
  });
export type SuiteSelector = z.infer<typeof SuiteSelectorSchema>;
