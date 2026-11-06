/**
 * Resolución de secretos por referencia (`secret_ref`), nunca valores en BD/configuración (ESP §7, §13.7, RNF-SEG-01).
 * Formatos (`SecretRefSchema`): `env:NOMBRE` | `file:/ruta` | `ssm:/prefijo/nombre`.
 * Restricciones para impedir que una referencia administrable lea secretos del backend:
 * - `env:` solo variables con prefijo `KATALYST_SECRET__` (no `DATABASE_URL`, etc.).
 * - `file:` solo bajo `SECRET_FILE_DIR` (sin traversal ni enlaces fuera del directorio).
 * - `ssm:` solo bajo `SSM_PREFIX`; SecureString con descifrado; caché en memoria 5 min.
 * Los errores nunca incluyen el valor; tampoco la ruta completa en mensajes públicos.
 */
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { SECRET_REF_REGEX } from '@katalyst/shared';

export interface SecretProvider {
  get(ref: string): Promise<string>;
}

export const ENV_SECRET_PREFIX = 'KATALYST_SECRET__';

export class SecretUnavailableError extends Error {
  constructor(
    readonly ref: string,
    readonly reason: 'invalid_ref' | 'not_found' | 'forbidden' | 'provider_error',
  ) {
    // El mensaje solo incluye el esquema de la referencia (no el nombre completo ni el valor).
    super(`Secreto no disponible (${ref.split(':')[0] ?? 'ref'}: ${reason})`);
    this.name = 'SecretUnavailableError';
  }
}

export interface SecretProviderOptions {
  env?: NodeJS.ProcessEnv;
  fileDir: string;
  ssmPrefix: string;
  awsRegion?: string | undefined;
  /** Esquemas habilitados (por defecto todos). */
  schemes?: readonly ('env' | 'file' | 'ssm')[];
  cacheTtlMs?: number;
  /** Inyectable en pruebas. */
  ssmGet?: (name: string) => Promise<string | undefined>;
}

async function defaultSsmGet(region: string | undefined, name: string): Promise<string | undefined> {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient(region ? { region } : {});
  try {
    const out = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return out.Parameter?.Value;
  } finally {
    client.destroy();
  }
}

export class RefSecretProvider implements SecretProvider {
  private readonly cache = new Map<string, { value: string; until: number }>();
  constructor(private readonly opts: SecretProviderOptions) {}

  async get(ref: string): Promise<string> {
    if (!SECRET_REF_REGEX.test(ref) || ref.includes('..')) throw new SecretUnavailableError(ref, 'invalid_ref');
    const idx = ref.indexOf(':');
    const scheme = ref.slice(0, idx) as 'env' | 'file' | 'ssm';
    const name = ref.slice(idx + 1);
    if (this.opts.schemes && !this.opts.schemes.includes(scheme)) throw new SecretUnavailableError(ref, 'forbidden');
    const cached = this.cache.get(ref);
    if (cached && cached.until > Date.now()) return cached.value;
    let value: string | undefined;
    switch (scheme) {
      case 'env':
        value = this.fromEnv(ref, name);
        break;
      case 'file':
        value = await this.fromFile(ref, name);
        break;
      case 'ssm':
        value = await this.fromSsm(ref, name);
        break;
    }
    if (value === undefined || value === '') throw new SecretUnavailableError(ref, 'not_found');
    const ttl = this.opts.cacheTtlMs ?? (scheme === 'ssm' ? 300_000 : 0);
    if (ttl > 0) this.cache.set(ref, { value, until: Date.now() + ttl });
    return value;
  }

  /** Invalida la caché (rotación). */
  clear(): void {
    this.cache.clear();
  }

  private fromEnv(ref: string, name: string): string | undefined {
    if (!name.startsWith(ENV_SECRET_PREFIX)) throw new SecretUnavailableError(ref, 'forbidden');
    return (this.opts.env ?? process.env)[name];
  }

  private async fromFile(ref: string, path: string): Promise<string | undefined> {
    const base = resolve(this.opts.fileDir);
    const target = resolve(path);
    if (!(target === base || target.startsWith(base + sep))) throw new SecretUnavailableError(ref, 'forbidden');
    try {
      const real = await realpath(target);
      const realBase = await realpath(base);
      if (!real.startsWith(realBase + sep)) throw new SecretUnavailableError(ref, 'forbidden');
      return (await readFile(real, 'utf8')).replace(/\r?\n$/, '');
    } catch (e) {
      if (e instanceof SecretUnavailableError) throw e;
      throw new SecretUnavailableError(ref, 'not_found');
    }
  }

  private async fromSsm(ref: string, name: string): Promise<string | undefined> {
    const prefix = this.opts.ssmPrefix.endsWith('/') ? this.opts.ssmPrefix : `${this.opts.ssmPrefix}/`;
    if (!name.startsWith(prefix)) throw new SecretUnavailableError(ref, 'forbidden');
    try {
      return await (this.opts.ssmGet ?? ((n: string) => defaultSsmGet(this.opts.awsRegion, n)))(name);
    } catch {
      throw new SecretUnavailableError(ref, 'provider_error');
    }
  }
}

/** Proveedor en memoria para pruebas. */
export class MemorySecretProvider implements SecretProvider {
  constructor(private readonly values: Record<string, string> = {}) {}
  set(ref: string, value: string): void {
    this.values[ref] = value;
  }
  async get(ref: string): Promise<string> {
    const v = this.values[ref];
    if (v === undefined) throw new SecretUnavailableError(ref, 'not_found');
    return v;
  }
}

let singleton: SecretProvider | undefined;

/**
 * Proveedor del proceso. Usa la configuración vigente (`SECRET_PROVIDER` define el esquema por defecto
 * permitido junto con `env` en desarrollo/pruebas; en producción solo el esquema configurado).
 */
export function getSecretProvider(): SecretProvider {
  if (!singleton) {
    // Import diferido para no crear ciclo config → secrets.
    const env = process.env;
    const scheme = (env.SECRET_PROVIDER as 'env' | 'file' | 'ssm' | undefined) ?? 'env';
    const production = env.NODE_ENV === 'production';
    singleton = new RefSecretProvider({
      fileDir: env.SECRET_FILE_DIR ?? '/run/secrets/katalyst',
      ssmPrefix: env.SSM_PREFIX ?? '/katalyst/internal',
      awsRegion: env.AWS_REGION,
      schemes: production ? [scheme] : ['env', 'file', 'ssm'],
    });
  }
  return singleton;
}

/** Reemplaza el proveedor del proceso (pruebas o arranque con configuración explícita). */
export function setSecretProvider(p: SecretProvider | undefined): void {
  singleton = p;
}

/** Lista de valores de secretos conocidos para sanitización por valor (`knownSecrets`), sin registrarlos. */
export async function tryGetSecret(provider: SecretProvider, ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  try {
    return await provider.get(ref);
  } catch {
    return null;
  }
}
