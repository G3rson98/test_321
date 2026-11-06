/**
 * Fábrica del almacén de artefactos según `ARTIFACT_STORE` (fs | s3 | minio). Las credenciales de MinIO y la clave de
 * firma del almacén fs se resuelven por REFERENCIA (SecretProvider); en AWS se usa el instance profile.
 * RF-RES-02, RNF-SEG-05, RNF-SEG-01.
 */
import { createHash } from 'node:crypto';
import type { Config } from '../../config.js';
import { FsArtifactStore } from './fs.js';
import type { ArtifactStore } from './types.js';

export * from './types.js';
export { FsArtifactStore } from './fs.js';
export type { S3StoreOptions } from './s3.js';

export type ResolveSecret = (ref: string) => Promise<string>;

/**
 * Clave de firma del almacén fs (solo desarrollo). Se deriva de `SESSION_SECRET_REF` si existe; en desarrollo/pruebas,
 * sin referencia, se deriva determinísticamente de la configuración local para que API y visor coincidan.
 */
export async function fsSigningSecret(config: Config, resolveSecret?: ResolveSecret): Promise<string> {
  // Clave dedicada (preferida): permite rotarla sin invalidar sesiones del panel.
  if (config.ARTIFACT_FS_SIGNING_KEY_REF && resolveSecret) {
    const k = await resolveSecret(config.ARTIFACT_FS_SIGNING_KEY_REF);
    if (k.length < 32) throw new Error('ARTIFACT_FS_SIGNING_KEY_REF debe resolver a un secreto de al menos 32 caracteres');
    return createHash('sha256').update(`katalyst-fs-store-key:${k}`).digest('hex');
  }
  if (config.SESSION_SECRET_REF && resolveSecret) {
    const s = await resolveSecret(config.SESSION_SECRET_REF);
    return createHash('sha256').update(`katalyst-fs-store:${s}`).digest('hex');
  }
  if (config.NODE_ENV === 'production') {
    throw new Error('ARTIFACT_STORE=fs en producción requiere SESSION_SECRET_REF');
  }
  return createHash('sha256').update(`katalyst-fs-store-dev:${config.DATABASE_URL}:${config.ARTIFACT_FS_DIR}`).digest('hex');
}

export async function createArtifactStore(config: Config, resolveSecret?: ResolveSecret): Promise<ArtifactStore> {
  switch (config.ARTIFACT_STORE) {
    case 'fs':
      return new FsArtifactStore({
        rootDir: config.ARTIFACT_FS_DIR,
        publicBaseUrl: config.REPORTS_BASE_URL,
        signingSecret: await fsSigningSecret(config, resolveSecret),
      });
    case 'minio': {
      if (!config.S3_ENDPOINT) throw new Error('ARTIFACT_STORE=minio requiere S3_ENDPOINT');
      const credentials =
        config.S3_ACCESS_KEY_REF && config.S3_SECRET_KEY_REF && resolveSecret
          ? {
              accessKeyId: await resolveSecret(config.S3_ACCESS_KEY_REF),
              secretAccessKey: await resolveSecret(config.S3_SECRET_KEY_REF),
            }
          : undefined;
      const { S3ArtifactStore } = await import('./s3.js');
      return new S3ArtifactStore({
        bucket: config.ARTIFACT_BUCKET,
        endpoint: config.S3_ENDPOINT,
        forcePathStyle: true,
        kind: 'minio',
        ...(config.AWS_REGION ? { region: config.AWS_REGION } : {}),
        ...(credentials ? { credentials } : {}),
      });
    }
    case 's3': {
      const { S3ArtifactStore } = await import('./s3.js');
      return new S3ArtifactStore({
        bucket: config.ARTIFACT_BUCKET,
        kind: 's3',
        ...(config.AWS_REGION ? { region: config.AWS_REGION } : {}),
        ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      });
    }
  }
}
