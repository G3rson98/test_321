/**
 * Subida de evidencia por URL acotada al lease (RNF-SEG-05: sin credenciales de nube en el ejecutor):
 * `POST /worker/artifacts/upload` (metadatos + resultado de sanitización) → carga del contenido → `finalize`
 * con checksum/tamaño. Política del ambiente (tipos habilitados, solo-en-falla) y cuota de evidencia por corrida
 * (250 MiB, ARQ §6); al superarla se deja de subir y se marca evidencia incompleta, sin alterar resultados.
 * Evidencia que no puede sanitizarse se registra como `fallido` con motivo y NO se sube. RF-RES-02, RNF-SEG-02.
 */
import path from 'node:path';
import type { ArtifactKind, ArtifactPolicy } from '@katalyst/shared';
import type { Logger } from '../../logger.js';
import { sha256File } from '../../util/fs.js';
import { isLeaseLost } from '../../worker-api/errors.js';
import type { WorkerApiClient } from '../../worker-api/types.js';
import { SANITIZER_VERSION, sanitizeArtifactFile } from './sanitize-artifact.js';

export interface UploadCandidate {
  file: string;
  kind: ArtifactKind;
  contentType: string;
  runResultId: string | null;
  attemptNo: number | null;
  /** El intento al que pertenece falló (políticas "solo en fallas"). */
  failed: boolean;
}

export type UploadOutcome =
  | 'subido'
  | 'deshabilitado'
  | 'omitido_politica'
  | 'fallido_sanitizacion'
  | 'cuota_excedida'
  | 'rechazado'
  | 'error';

export interface UploadRecord {
  kind: ArtifactKind;
  name: string;
  outcome: UploadOutcome;
  reason: string | null;
  artifactId: string | null;
  sizeBytes: number | null;
}

export interface UploaderOptions {
  api: Pick<WorkerApiClient, 'requestArtifactUpload' | 'uploadArtifactContent' | 'finalizeArtifact'>;
  leaseId: string;
  generation: number;
  policy: ArtifactPolicy;
  knownSecrets: () => readonly string[];
  sanitizedDir: string;
  logger: Logger;
  onLeaseLost: () => void;
  /** Cuota local por shard (la API aplica la de la corrida completa). */
  evidenceQuotaBytes?: number;
}

/** Tipo de evidencia de un adjunto de Playwright. */
export function kindForAttachment(a: { name: string; contentType: string; path?: string }): ArtifactKind | null {
  const base = path.basename(a.path ?? '').toLowerCase();
  const ct = a.contentType.toLowerCase();
  if (base === 'samples.json' || a.name === 'samples.json') return 'dxmon_samples';
  if (base === 'summary.json' || a.name === 'summary.json') return 'dxmon_summary';
  if (a.name === 'trace' || ct === 'application/zip') return 'traza';
  if (a.name === 'video' || ct.startsWith('video/')) return 'video';
  if (a.name === 'screenshot' || ct.startsWith('image/')) return 'captura';
  if (ct.startsWith('text/') || ct.includes('json')) return 'log';
  return null;
}

export class ArtifactUploader {
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  usedBytes = 0;
  evidenceIncomplete = false;
  readonly records: UploadRecord[] = [];
  private stopped = false;

  constructor(private readonly o: UploaderOptions) {}

  get quota(): number {
    return Math.min(this.o.evidenceQuotaBytes ?? Number.POSITIVE_INFINITY, this.o.policy.maxEvidenceBytesPerRun);
  }

  /** Marca evidencia incompleta (p. ej. cuota temporal superada) y deja de subir. */
  markIncomplete(): void {
    this.evidenceIncomplete = true;
  }

  stop(): void {
    this.stopped = true;
  }

  enqueue(c: UploadCandidate): Promise<void> {
    const p = this.chain.then(() => this.handle(c));
    this.chain = p.catch(() => undefined);
    return p;
  }

  async drain(): Promise<void> {
    await this.chain;
  }

  private record(c: UploadCandidate, outcome: UploadOutcome, reason: string | null, artifactId: string | null = null, size: number | null = null): void {
    this.records.push({ kind: c.kind, name: path.basename(c.file), outcome, reason, artifactId, sizeBytes: size });
  }

  private onFailureOnly(kind: ArtifactKind): boolean {
    const p = this.o.policy;
    return (kind === 'captura' && p.screenshotsOnFailureOnly) || (kind === 'video' && p.videoOnFailureOnly) || (kind === 'traza' && p.traceOnFailureOnly);
  }

  private async handle(c: UploadCandidate): Promise<void> {
    if (this.stopped) return;
    const fencing = { leaseId: this.o.leaseId, generation: this.o.generation };
    try {
      if (!this.o.policy.enabledKinds.includes(c.kind)) {
        // Defensa en profundidad: Playwright no debería haberlo generado. Se registra sin subir (RF-RES-02).
        const { sha256, size } = await sha256File(c.file);
        if (size > 0) {
          await this.o.api.requestArtifactUpload({
            ...fencing,
            runResultId: c.runResultId,
            attemptNo: c.attemptNo,
            kind: c.kind,
            contentType: c.contentType,
            sizeBytes: size,
            checksumSha256: sha256,
            sanitization: {
              status: 'deshabilitado',
              reason: (this.o.policy.disabledReasons[c.kind] ?? 'Tipo de evidencia deshabilitado por la política del ambiente.').slice(0, 500),
              sanitizerVersion: SANITIZER_VERSION,
              findingsRemaining: 0,
            },
          });
        }
        this.record(c, 'deshabilitado', 'tipo deshabilitado por política');
        return;
      }
      if (!c.failed && this.onFailureOnly(c.kind)) {
        this.record(c, 'omitido_politica', 'solo en fallas');
        return;
      }
      if (this.evidenceIncomplete && this.usedBytes >= this.quota) {
        this.record(c, 'cuota_excedida', 'cuota de evidencia agotada');
        return;
      }
      const out = path.join(this.o.sanitizedDir, `${String(++this.seq).padStart(5, '0')}-${path.basename(c.file)}`);
      const s = await sanitizeArtifactFile(c.file, out, c.contentType, { knownSecrets: this.o.knownSecrets() }, { keepInput: true });
      if (s.status !== 'sanitizado' || !s.outputPath) {
        this.evidenceIncomplete = true;
        const { sha256, size } = await sha256File(c.file);
        if (size > 0) {
          await this.o.api.requestArtifactUpload({
            ...fencing,
            runResultId: c.runResultId,
            attemptNo: c.attemptNo,
            kind: c.kind,
            contentType: c.contentType,
            sizeBytes: size,
            checksumSha256: sha256,
            sanitization: {
              status: 'fallido',
              reason: (s.reason ?? 'No se pudo sanitizar').slice(0, 500),
              sanitizerVersion: SANITIZER_VERSION,
              findingsRemaining: Math.max(1, s.findingsRemaining),
            },
          });
        }
        this.record(c, 'fallido_sanitizacion', s.reason);
        this.o.logger.warn({ kind: c.kind, reason: s.reason }, 'evidencia no sanitizable: no se sube');
        return;
      }
      const { sha256, size } = await sha256File(s.outputPath);
      if (size === 0) {
        this.record(c, 'omitido_politica', 'archivo vacío');
        return;
      }
      if (this.usedBytes + size > this.quota) {
        this.evidenceIncomplete = true;
        this.usedBytes = Math.max(this.usedBytes, this.quota);
        this.record(c, 'cuota_excedida', 'cuota de evidencia de la corrida superada', null, size);
        this.o.logger.warn({ kind: c.kind, sizeBytes: size }, 'cuota de evidencia superada: se detiene la captura');
        return;
      }
      const res = await this.o.api.requestArtifactUpload({
        ...fencing,
        runResultId: c.runResultId,
        attemptNo: c.attemptNo,
        kind: c.kind,
        contentType: c.contentType,
        sizeBytes: size,
        checksumSha256: sha256,
        sanitization: { status: 'sanitizado', reason: null, sanitizerVersion: SANITIZER_VERSION, findingsRemaining: 0 },
      });
      if (!res.upload) {
        this.evidenceIncomplete = true;
        this.record(c, 'rechazado', res.rejectedReason, res.artifactId, size);
        return;
      }
      await this.o.api.uploadArtifactContent(res.upload, s.outputPath, size);
      await this.o.api.finalizeArtifact(res.artifactId, { ...fencing, sizeBytes: size, checksumSha256: sha256 });
      this.usedBytes += size;
      this.record(c, 'subido', null, res.artifactId, size);
    } catch (e) {
      if (isLeaseLost(e)) {
        this.stopped = true;
        this.o.onLeaseLost();
        return;
      }
      this.evidenceIncomplete = true;
      this.record(c, 'error', 'error al subir la evidencia');
      this.o.logger.warn({ kind: c.kind, err: (e as Error).message }, 'error al subir evidencia');
    }
  }
}
