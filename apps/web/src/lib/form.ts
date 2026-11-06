/**
 * Utilidades de formularios (TanStack Form + Zod, ESP §17.4): primer error por campo, errores del servidor por
 * campo (`details.issues[].path`) y resumen. El servidor conserva la validación final.
 */
import { fieldErrorsFrom } from './api/client';

/** Primer mensaje de error de un campo (strings o issues de Standard Schema). */
export function firstError(errors: readonly unknown[] | undefined): string | null {
  for (const e of errors ?? []) {
    if (!e) continue;
    if (typeof e === 'string') return e;
    if (typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
  }
  return null;
}

interface FormLike {
  setFieldMeta: (field: never, updater: (prev: never) => never) => void;
  getFieldMeta?: (field: never) => unknown;
}

/**
 * Coloca los errores 422 del servidor en sus campos (`errorMap.onServer`) y devuelve los no asignados para el
 * resumen. `fields` lista los nombres de campo conocidos del formulario.
 */
export function applyServerErrors(form: FormLike, error: unknown, fields: readonly string[]): string[] {
  const byPath = fieldErrorsFrom(error);
  const leftovers: string[] = [];
  for (const [path, message] of Object.entries(byPath)) {
    const field = fields.find((f) => path === f || path.startsWith(`${f}.`));
    if (field) {
      form.setFieldMeta(field as never, ((prev: { errorMap?: Record<string, unknown> }) => ({
        ...prev,
        errorMap: { ...(prev?.errorMap ?? {}), onServer: message },
      })) as never);
    } else leftovers.push(message);
  }
  return leftovers;
}

/** Limpia el error de servidor de un campo cuando el usuario lo edita. */
export function clearServerError(form: FormLike, field: string): void {
  form.setFieldMeta(field as never, ((prev: { errorMap?: Record<string, unknown> }) => ({
    ...prev,
    errorMap: { ...(prev?.errorMap ?? {}), onServer: undefined },
  })) as never);
}
