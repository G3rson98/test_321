import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Pluralización simple en español: `plural(1, 'caso', 'casos')`. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Iniciales para el avatar del sidebar ("Ana Rojas" → "AR"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** Primer nombre para el saludo ("Ana Rojas" → "Ana"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Identificador corto legible derivado del UUID (D-WEB-04): la API no expone un número secuencial de corrida,
 * programación ni entrega. `shortId('run', uuid)` → "R-3F9C21".
 */
const PREFIX = { run: 'R', schedule: 'P', delivery: 'OB', suite: 'S' } as const;
export function shortId(kind: keyof typeof PREFIX, uuid: string): string {
  return `${PREFIX[kind]}-${uuid.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/** Clave de idempotencia estable por intento de usuario (ESP §9: 8..128 caracteres seguros). */
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
