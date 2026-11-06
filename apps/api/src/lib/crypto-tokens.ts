/**
 * Tokens opacos y contraseñas (RF-USR-01, RF-USR-03, RNF-SEG-01, ESP §13.7).
 * - Tokens: 256 bits aleatorios en base64url con prefijo de tipo; en BD solo se guarda su SHA-256 (hex). Con 256 bits
 *   de entropía un hash rápido es suficiente (no hay diccionario); `hmacToken` existe para derivaciones con clave.
 * - Contraseñas: argon2id (parámetros OWASP 2024: m=19 MiB, t=2, p=1) vía @node-rs/argon2 (binario precompilado).
 * Nunca registrar tokens ni contraseñas en logs.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify, type Algorithm } from '@node-rs/argon2';

/** Prefijos de tipo: permiten enrutar la resolución del principal sin consultar varias tablas. */
export const TOKEN_PREFIXES = {
  session: 'kss_',
  apiToken: 'kat_',
  service: 'ksv_',
  lease: 'kls_',
  device: 'kdv_',
  passwordReset: 'kpr_',
  deviceCode: 'kdc_',
  reportTicket: 'krt_',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Token opaco aleatorio de 256 bits con prefijo de tipo. */
export function generateOpaqueToken(kind: TokenKind): string {
  return `${TOKEN_PREFIXES[kind]}${randomBytes(32).toString('base64url')}`;
}

/** Tipo del token según su prefijo (sin validar contra BD). `null` si no tiene forma válida. */
export function tokenKindOf(token: string): TokenKind | null {
  if (token.length > 64) return null;
  for (const [kind, prefix] of Object.entries(TOKEN_PREFIXES) as [TokenKind, string][]) {
    if (token.startsWith(prefix) && TOKEN_BODY_RE.test(token.slice(prefix.length))) return kind;
  }
  return null;
}

/** SHA-256 hex del token: lo único que se persiste (`token_hash`). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** HMAC-SHA256 base64url (derivaciones con clave, p. ej. token CSRF ligado a la sesión). */
export function hmacToken(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}

/** Últimos 4 caracteres para identificar un token en la UI (`hint`). */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/** Comparación en tiempo constante de cadenas (longitudes distintas → false sin filtrar tiempo de contenido). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Código corto legible para humanos (flujo de dispositivo), sin caracteres ambiguos. */
export function randomUserCode(length = 8): string {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Contraseñas (argon2id)
// ---------------------------------------------------------------------------

export const ARGON2_PARAMS = {
  /** Argon2id (valor 2 del `const enum` de @node-rs/argon2; no inlinable con isolatedModules). */
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError('Longitud de contraseña fuera de rango');
  }
  return argonHash(password, ARGON2_PARAMS);
}

/** Verifica sin lanzar: hash corrupto o ausente → false. */
export async function verifyPassword(storedHash: string | null | undefined, password: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('$argon2id$')) return false;
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return false;
  try {
    return await argonVerify(storedHash, password);
  } catch {
    return false;
  }
}

/** Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración por tiempo). */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= argonHash('katalyst-dummy-password-for-timing', ARGON2_PARAMS);
  await verifyPassword(await dummyHash, password.slice(0, PASSWORD_MAX_LENGTH) || 'x');
}

/** ¿El hash usa parámetros más débiles que los actuales? (rehash tras login exitoso). */
export function needsRehash(storedHash: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true;
  return (
    Number(m[1]) < ARGON2_PARAMS.memoryCost ||
    Number(m[2]) < ARGON2_PARAMS.timeCost ||
    Number(m[3]) < ARGON2_PARAMS.parallelism
  );
}
