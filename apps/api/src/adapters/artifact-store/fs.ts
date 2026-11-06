/**
 * Almacén de artefactos en filesystem (SOLO desarrollo local). Emula URLs firmadas de S3: el visor de reportes
 * (`main.reports.ts`, origen separado) atiende `/_store/<clave>` verificando una firma HMAC con vencimiento ≤ 5 min,
 * método, tamaño y checksum. Nunca expone el directorio ni sigue rutas fuera de la raíz.
 * RF-RES-02, RNF-SEG-05.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  assertSafeKey,
  clampTtl,
  type ArtifactStore,
  type GetOptions,
  type ObjectStat,
  type PresignedRequest,
  type PutOptions,
} from './types.js';

export interface FsStoreOptions {
  rootDir: string;
  /** Origen público que atiende `/_store/*` (REPORTS_BASE_URL). */
  publicBaseUrl: string;
  /** Clave HMAC compartida entre la API y el visor de reportes. */
  signingSecret: string;
  now?: () => Date;
}

export interface FsSignedParams {
  method: 'PUT' | 'GET';
  key: string;
  exp: number;
  ct: string;
  size?: number;
  sha?: string;
  dn?: string;
}

function canonical(p: FsSignedParams): string {
  return [p.method, p.key, p.exp, p.ct, p.size ?? '', p.sha ?? '', p.dn ?? ''].join('\n');
}

export class FsArtifactStore implements ArtifactStore {
  readonly kind = 'fs' as const;
  private readonly root: string;
  private readonly now: () => Date;

  constructor(private readonly opts: FsStoreOptions) {
    if (!opts.signingSecret || opts.signingSecret.length < 16) {
      throw new Error('FsArtifactStore requiere una clave de firma de al menos 16 caracteres');
    }
    this.root = resolve(opts.rootDir);
    this.now = opts.now ?? (() => new Date());
  }

  private pathFor(key: string): string {
    const p = resolve(join(this.root, assertSafeKey(key)));
    if (!p.startsWith(this.root + sep)) throw new Error('Ruta fuera de la raíz del almacén');
    return p;
  }

  sign(p: FsSignedParams): string {
    return createHmac('sha256', this.opts.signingSecret).update(canonical(p)).digest('base64url');
  }

  private buildUrl(p: FsSignedParams): string {
    const u = new URL(`/_store/${p.key}`, this.opts.publicBaseUrl);
    u.searchParams.set('m', p.method);
    u.searchParams.set('exp', String(p.exp));
    u.searchParams.set('ct', p.ct);
    if (p.size !== undefined) u.searchParams.set('size', String(p.size));
    if (p.sha) u.searchParams.set('sha', p.sha);
    if (p.dn) u.searchParams.set('dn', p.dn);
    u.searchParams.set('sig', this.sign(p));
    return u.toString();
  }

  async presignPut(key: string, opts: PutOptions): Promise<PresignedRequest> {
    const ttl = clampTtl(opts.expiresInSeconds);
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const params: FsSignedParams = {
      method: 'PUT',
      key: assertSafeKey(key),
      exp: Math.floor(expiresAt.getTime() / 1000),
      ct: opts.contentType,
      size: opts.sizeBytes,
      sha: opts.checksumSha256,
    };
    return { method: 'PUT', url: this.buildUrl(params), headers: { 'content-type': opts.contentType }, expiresAt };
  }

  async presignGet(key: string, opts: GetOptions): Promise<PresignedRequest> {
    const ttl = clampTtl(opts.expiresInSeconds);
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const params: FsSignedParams = {
      method: 'GET',
      key: assertSafeKey(key),
      exp: Math.floor(expiresAt.getTime() / 1000),
      ct: opts.contentType ?? 'application/octet-stream',
      ...(opts.downloadName ? { dn: opts.downloadName } : {}),
    };
    return { method: 'GET', url: this.buildUrl(params), headers: {}, expiresAt };
  }

  /** Verifica una solicitud firmada recibida por el visor (`/_store/*`). Devuelve los parámetros o `null`. */
  verify(method: string, key: string, query: Record<string, string | undefined>): FsSignedParams | null {
    try {
      assertSafeKey(key);
    } catch {
      return null;
    }
    const exp = Number(query['exp']);
    if (!Number.isInteger(exp) || query['m'] !== method || (method !== 'PUT' && method !== 'GET')) return null;
    if (exp * 1000 < this.now().getTime()) return null;
    // Nunca aceptar vencimientos más allá del máximo (firma emitida con TTL mayor).
    if (exp * 1000 - this.now().getTime() > 301_000) return null;
    const params: FsSignedParams = {
      method,
      key,
      exp,
      ct: query['ct'] ?? '',
      ...(query['size'] !== undefined ? { size: Number(query['size']) } : {}),
      ...(query['sha'] ? { sha: query['sha'] } : {}),
      ...(query['dn'] ? { dn: query['dn'] } : {}),
    };
    const expected = Buffer.from(this.sign(params));
    const got = Buffer.from(query['sig'] ?? '');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    return params;
  }

  /** Escribe validando tamaño y checksum firmados; atómico (archivo temporal + rename). */
  async acceptUpload(params: FsSignedParams, body: Buffer): Promise<void> {
    if (params.size !== undefined && body.length !== params.size) throw new Error('size_mismatch');
    const sha = createHash('sha256').update(body).digest('hex');
    if (params.sha && sha !== params.sha) throw new Error('checksum_mismatch');
    await this.putObject(params.key, body, params.ct);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const p = this.pathFor(key);
    try {
      const s = await fsStat(p);
      const sha = createHash('sha256')
        .update(await readFile(p))
        .digest('hex');
      return { sizeBytes: s.size, checksumSha256: sha };
    } catch {
      return null;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    await fsStat(p);
    return createReadStream(p);
  }

  async putObject(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, p);
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
