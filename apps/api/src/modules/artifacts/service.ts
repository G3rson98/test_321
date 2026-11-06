/**
 * Evidencia de corridas (RF-RES-02, RF-TR-05, RNF-SEG-02, RNF-SEG-05, ESP §13.7, §18).
 * - Carga acotada al lease: el ejecutor declara tipo, tamaño, checksum y resultado de sanitización; solo evidencia
 *   `sanitizado` sin hallazgos recibe URL de carga firmada (≤ 5 min). Lo deshabilitado por política, no sanitizable o
 *   fuera de cuota se REGISTRA con motivo (sin objeto) y marca evidencia incompleta, sin cambiar el resultado.
 * - Cuota por corrida 250 MiB (configurable en la política del ambiente); tipo/tamaño/checksum validados al finalizar.
 * - Acceso: autorización por recurso (artefacto ∈ corrida) ⇒ URL firmada ≤ 5 min o ticket de un solo uso del visor
 *   en origen separado (reportes HTML/trazas).
 */
import { randomUUID } from 'node:crypto';
import type { Artifact as ArtifactRow, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  KatalystError,
  type Artifact,
  type ArtifactKind,
  type WorkerArtifactUploadRequestSchema,
  type WorkerArtifactFinalizeRequestSchema,
} from '@katalyst/shared';
import type { z } from 'zod';
import type { Principal } from '../../lib/auth.js';
import { generateOpaqueToken, hashToken } from '../../lib/crypto-tokens.js';
import { runInTransaction } from '../../lib/events-publish.js';
import {
  MAX_ARTIFACT_BYTES,
  artifactStorageKey,
  baseContentType,
  extensionFor,
  isAllowedContentType,
  type ArtifactStore,
} from '../../adapters/artifact-store/index.js';
import { validateLease } from '../../services/leases.js';
import { finalizeRun, snapshotOf } from '../../services/results.js';

type UploadReq = z.infer<typeof WorkerArtifactUploadRequestSchema>;
type FinalizeReq = z.infer<typeof WorkerArtifactFinalizeRequestSchema>;

export const VIEWER_TICKET_TTL_MS = 5 * 60_000;

export function viewerTicketKey(prefix: string, ticket: string): string {
  return `${prefix}:viewer-ticket:${hashToken(ticket)}`;
}

export interface ViewerTicket {
  artifactId: string;
  runId: string;
  storageKey: string;
  contentType: string;
  kind: ArtifactKind;
}

export function isPublishable(a: ArtifactRow, now: Date): boolean {
  return (
    a.sanitizationStatus === 'sanitizado' &&
    a.uploadedAt !== null &&
    a.storageKey !== null &&
    (a.expiresAt === null || a.expiresAt.getTime() > now.getTime())
  );
}

export function toArtifactDto(a: ArtifactRow, now: Date = new Date()): Artifact {
  return {
    id: a.id,
    runId: a.runId,
    runResultId: a.runResultId,
    testAttemptId: a.testAttemptId,
    kind: a.kind,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes),
    checksum: a.checksum,
    sanitizationStatus: a.sanitizationStatus,
    sanitizationReason: a.sanitizationReason,
    publishable: isPublishable(a, now),
    expiresAt: a.expiresAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export interface ArtifactDeps {
  prisma: PrismaClient;
  store: ArtifactStore;
  signedUrlTtlSeconds: number;
  publicBaseUrl: string;
}

/** `POST /worker/artifacts/upload`. */
export async function registerUpload(deps: ArtifactDeps, principal: Principal, req: UploadReq, now: Date = new Date()) {
  if (!isAllowedContentType(req.kind, req.contentType)) throw new KatalystError('UNSUPPORTED_MEDIA_TYPE');
  if (req.sizeBytes > MAX_ARTIFACT_BYTES) throw new KatalystError('ARTIFACT_TOO_LARGE');
  const contentType = baseContentType(req.contentType);
  const result = await runInTransaction(deps.prisma, async (tx) => {
    const { run, lease } = await validateLease(tx, req, principal, now);
    let testAttemptId: string | null = null;
    if (req.runResultId) {
      const rr = await tx.runResult.findUnique({ where: { id: req.runResultId }, select: { runId: true, runShardId: true } });
      if (!rr || rr.runId !== run.id || rr.runShardId !== lease.runShardId) throw new KatalystError('NOT_FOUND');
      if (req.attemptNo) {
        const att = await tx.testAttempt.findUnique({
          where: { runResultId_attemptNo: { runResultId: req.runResultId, attemptNo: req.attemptNo } },
          select: { id: true },
        });
        if (!att) throw new KatalystError('NOT_FOUND');
        testAttemptId = att.id;
      }
    }
    // Repetición idempotente del mismo artefacto.
    const dup = await tx.artifact.findFirst({
      where: {
        runId: run.id,
        runResultId: req.runResultId,
        testAttemptId,
        kind: req.kind,
        checksum: req.checksumSha256,
      },
    });
    if (dup) return { artifact: dup, needsUrl: dup.sanitizationStatus === 'pendiente' && !dup.uploadedAt, rejected: dup.sanitizationStatus === 'pendiente' || dup.sanitizationStatus === 'sanitizado' ? null : dup.sanitizationReason };

    const snap = snapshotOf(run);
    const policy = snap.artifactPolicy;
    const base = {
      id: randomUUID(),
      runId: run.id,
      runResultId: req.runResultId,
      testAttemptId,
      kind: req.kind,
      contentType,
      sizeBytes: BigInt(req.sizeBytes),
      checksum: req.checksumSha256,
      createdAt: now,
    };
    const reject = async (status: 'deshabilitado' | 'fallido' | 'retenido', reason: string) => {
      const a = await tx.artifact.create({ data: { ...base, sanitizationStatus: status, sanitizationReason: reason } });
      if (req.runResultId) {
        await tx.runResult.update({ where: { id: req.runResultId }, data: { evidenceIncomplete: true } });
      }
      await tx.run.update({ where: { id: run.id }, data: { evidenceIncomplete: true } });
      return { artifact: a, needsUrl: false, rejected: reason };
    };
    if (!policy.enabledKinds.includes(req.kind)) {
      return reject('deshabilitado', policy.disabledReasons[req.kind] ?? 'Deshabilitado por la política de evidencia del ambiente.');
    }
    if (req.sanitization.status !== 'sanitizado' || req.sanitization.findingsRemaining > 0) {
      const status = req.sanitization.status === 'deshabilitado' || req.sanitization.status === 'retenido' ? req.sanitization.status : 'fallido';
      return reject(status, 'La evidencia no pudo sanitizarse y fue bloqueada (RNF-SEG-02).');
    }
    const used = await tx.artifact.aggregate({
      where: { runId: run.id, storageKey: { not: null }, sanitizationStatus: { in: ['pendiente', 'sanitizado'] } },
      _sum: { sizeBytes: true },
    });
    const usedBytes = Number(used._sum.sizeBytes ?? 0n);
    if (usedBytes + req.sizeBytes > policy.maxEvidenceBytesPerRun) {
      return reject('retenido', 'Cuota de evidencia de la corrida agotada; se detuvo la captura.');
    }
    const a = await tx.artifact.create({
      data: {
        ...base,
        storageKey: artifactStorageKey(run.id, base.id, contentType),
        sanitizationStatus: 'pendiente',
        expiresAt: new Date(now.getTime() + policy.retentionDays * 86_400_000),
      },
    });
    return { artifact: a, needsUrl: true, rejected: null };
  });
  const a = result.artifact;
  const upload =
    result.needsUrl && a.storageKey
      ? await deps.store.presignPut(a.storageKey, {
          contentType: a.contentType,
          sizeBytes: Number(a.sizeBytes ?? 0n),
          checksumSha256: a.checksum ?? '',
          expiresInSeconds: deps.signedUrlTtlSeconds,
        })
      : null;
  return {
    artifactId: a.id,
    upload: upload
      ? { method: 'PUT' as const, url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() }
      : null,
    rejectedReason: result.rejected,
  };
}

/** `POST /worker/artifacts/{id}/finalize`: verifica el objeto (tamaño y checksum) y lo marca publicable. */
export async function finalizeUpload(
  deps: ArtifactDeps,
  principal: Principal,
  artifactId: string,
  req: FinalizeReq,
  now: Date = new Date(),
): Promise<Artifact> {
  const existing = await deps.prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!existing) throw new KatalystError('NOT_FOUND');
  if (existing.uploadedAt) {
    if (existing.checksum !== req.checksumSha256 || Number(existing.sizeBytes) !== req.sizeBytes) {
      throw new KatalystError('CALLBACK_CONFLICT');
    }
    return toArtifactDto(existing, now);
  }
  if (existing.checksum !== req.checksumSha256 || Number(existing.sizeBytes) !== req.sizeBytes) {
    throw new KatalystError('ARTIFACT_CHECKSUM_MISMATCH');
  }
  if (existing.sanitizationStatus !== 'pendiente' || !existing.storageKey) {
    throw new KatalystError('ARTIFACT_NOT_PUBLISHABLE');
  }
  const stat = await deps.store.stat(existing.storageKey);
  // Objeto aún no cargado: 409 sin cambiar estado (el ejecutor puede reintentar la carga dentro de su URL).
  if (!stat) throw new KatalystError('CONFLICT', 'El objeto aún no fue cargado.');
  const mismatch =
    stat.sizeBytes !== req.sizeBytes || (stat.checksumSha256 !== null && stat.checksumSha256 !== req.checksumSha256);
  return runInTransaction(deps.prisma, async (tx) => {
    const { run } = await validateLease(tx, req, principal, now, { allowReleased: true });
    if (existing.runId !== run.id) throw new KatalystError('NOT_FOUND');
    if (mismatch) {
      await deps.store.deleteObject(existing.storageKey!).catch(() => undefined);
      await tx.artifact.update({
        where: { id: artifactId },
        data: { sanitizationStatus: 'fallido', sanitizationReason: 'Checksum o tamaño no coinciden.' },
      });
      await tx.run.update({ where: { id: run.id }, data: { evidenceIncomplete: true } });
      return null;
    }
    const a = await tx.artifact.update({
      where: { id: artifactId },
      data: { uploadedAt: now, sanitizationStatus: 'sanitizado' },
    });
    if (run.status === 'finalizando') {
      const pending = await tx.artifact.count({ where: { runId: run.id, sanitizationStatus: 'pendiente' } });
      if (pending === 0) {
        await finalizeRun(tx, { runId: run.id, terminal: 'terminada', reason: null, now, publicBaseUrl: deps.publicBaseUrl });
      }
    }
    return toArtifactDto(a, now);
  }).then((dto) => {
    if (!dto) throw new KatalystError('ARTIFACT_CHECKSUM_MISMATCH');
    return dto;
  });
}

export async function listRunArtifacts(prisma: PrismaClient, runId: string, now: Date = new Date()) {
  const run = await prisma.run.count({ where: { id: runId } });
  if (!run) throw new KatalystError('NOT_FOUND');
  const rows = await prisma.artifact.findMany({ where: { runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1000 });
  return { items: rows.map((a) => toArtifactDto(a, now)) };
}

/** `GET /runs/{id}/artifacts/{artifactId}`: URL firmada ≤ 5 min o ticket de un solo uso del visor. */
export async function accessArtifact(
  deps: ArtifactDeps & { redis: Redis; queuePrefix: string; reportsBaseUrl: string },
  runId: string,
  artifactId: string,
  now: Date = new Date(),
) {
  const a = await deps.prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!a || a.runId !== runId) throw new KatalystError('NOT_FOUND');
  if (!isPublishable(a, now)) throw new KatalystError('ARTIFACT_NOT_PUBLISHABLE');
  const ttl = Math.min(300, deps.signedUrlTtlSeconds);
  const viewer = (a.kind === 'reporte' && a.contentType === 'text/html') || a.kind === 'traza';
  if (viewer) {
    const ticket = generateOpaqueToken('reportTicket');
    const payload: ViewerTicket = {
      artifactId: a.id,
      runId: a.runId,
      storageKey: a.storageKey!,
      contentType: a.contentType,
      kind: a.kind,
    };
    if (deps.redis.status === 'wait') await deps.redis.connect();
    await deps.redis.set(viewerTicketKey(deps.queuePrefix, ticket), JSON.stringify(payload), 'PX', ttl * 1000);
    return {
      artifact: toArtifactDto(a, now),
      url: `${deps.reportsBaseUrl.replace(/\/$/, '')}/view/${ticket}`,
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      disposition: 'viewer' as const,
    };
  }
  const signed = await deps.store.presignGet(a.storageKey!, {
    expiresInSeconds: ttl,
    contentType: a.contentType,
    downloadName: `${a.kind}-${a.id}.${extensionFor(a.contentType)}`,
  });
  return {
    artifact: toArtifactDto(a, now),
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    disposition: 'download' as const,
  };
}

/** Consume un ticket del visor (GETDEL: un solo uso). */
export async function consumeViewerTicket(redis: Redis, prefix: string, ticket: string): Promise<ViewerTicket | null> {
  if (!/^krt_[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  if (redis.status === 'wait') await redis.connect();
  const raw = await redis.getdel(viewerTicketKey(prefix, ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ViewerTicket;
  } catch {
    return null;
  }
}
