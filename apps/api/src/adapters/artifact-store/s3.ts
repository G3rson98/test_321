/**
 * Almacén S3 privado (producción, credenciales del instance profile) o MinIO (desarrollo, path-style con claves por
 * referencia). URLs firmadas SigV4 de ≤ 5 min. La carga exige `content-type`, `content-length` y
 * `x-amz-checksum-sha256` firmados: S3 rechaza el objeto si el contenido no coincide (ESP §13.7).
 * RF-RES-02, RNF-SEG-05.
 */
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertSafeKey,
  base64ToHex,
  clampTtl,
  hexToBase64,
  type ArtifactStore,
  type GetOptions,
  type ObjectStat,
  type PresignedRequest,
  type PutOptions,
} from './types.js';

export interface S3StoreOptions {
  bucket: string;
  region?: string;
  /** MinIO / S3 compatible. */
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  kind?: 's3' | 'minio';
  now?: () => Date;
  client?: S3Client;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly kind: 's3' | 'minio';
  private readonly client: S3Client;
  private readonly now: () => Date;

  constructor(private readonly opts: S3StoreOptions) {
    this.kind = opts.kind ?? (opts.endpoint ? 'minio' : 's3');
    this.now = opts.now ?? (() => new Date());
    const cfg: S3ClientConfig = {
      region: opts.region ?? 'us-east-1',
      // Evita checksums CRC32 implícitos en URLs firmadas (el checksum SHA-256 se firma explícitamente).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.forcePathStyle !== undefined ? { forcePathStyle: opts.forcePathStyle } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    };
    this.client = opts.client ?? new S3Client(cfg);
  }

  async presignPut(key: string, o: PutOptions): Promise<PresignedRequest> {
    const ttl = clampTtl(o.expiresInSeconds);
    const checksum = hexToBase64(o.checksumSha256);
    const cmd = new PutObjectCommand({
      Bucket: this.opts.bucket,
      Key: assertSafeKey(key),
      ContentType: o.contentType,
      ContentLength: o.sizeBytes,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(this.client, cmd, {
      expiresIn: ttl,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    return {
      method: 'PUT',
      url,
      headers: {
        'content-type': o.contentType,
        'content-length': String(o.sizeBytes),
        'x-amz-checksum-sha256': checksum,
      },
      expiresAt: new Date(this.now().getTime() + ttl * 1000),
    };
  }

  async presignGet(key: string, o: GetOptions): Promise<PresignedRequest> {
    const ttl = clampTtl(o.expiresInSeconds);
    const cmd = new GetObjectCommand({
      Bucket: this.opts.bucket,
      Key: assertSafeKey(key),
      ...(o.contentType ? { ResponseContentType: o.contentType } : {}),
      ResponseContentDisposition: o.downloadName
        ? `attachment; filename="${o.downloadName.replace(/[^A-Za-z0-9._-]/g, '_')}"`
        : 'attachment',
      ResponseCacheControl: 'no-store',
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttl });
    return { method: 'GET', url, headers: {}, expiresAt: new Date(this.now().getTime() + ttl * 1000) };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: assertSafeKey(key), ChecksumMode: 'ENABLED' }),
      );
      return {
        sizeBytes: Number(r.ContentLength ?? 0),
        checksumSha256: r.ChecksumSHA256 ? base64ToHex(r.ChecksumSHA256) : null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: assertSafeKey(key) }));
    return r.Body as Readable;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: assertSafeKey(key), Body: body, ContentType: contentType }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: assertSafeKey(key) }));
  }
}
