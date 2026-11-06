/**
 * Exportaciones CSV/PDF en servidor (RF-RES-04; ESP §17.3, §17.4):
 * - Mismos permisos (exports.create + permiso del listado de origen) y mismos filtros que el listado.
 * - Alcance explícito: `pagina` (cursor/limit ≤ 100, se genera en línea) o `completo` (trabajo diferido, ≤ 50 000
 *   filas CSV / 5 000 PDF, si no 422 EXPORT_TOO_LARGE).
 * - CSV con neutralización de fórmulas (`toCsv` de shared) y BOM UTF-8; PDF con pdfkit.
 * - Archivo privado en el almacén de artefactos con vencimiento; descarga por URL firmada ≤ 5 min tras autorización
 *   por recurso (dueño o admin).
 */
import PDFDocument from 'pdfkit';
import type { ExportJob, Prisma, PrismaClient } from '@prisma/client';
import { EXPORT_MAX_ROWS, KatalystError, PAGE_LIMIT_DEFAULT, toCsv, type CsvColumn, type CsvValue, type ExportCreate } from '@katalyst/shared';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { ArtifactStore } from '../../adapters/artifact-store/types.js';
import { recordAudit } from '../../lib/audit.js';
import { hasPermission, isAdmin, type Principal } from '../../lib/auth.js';
import { getSecretProvider } from '../../lib/secrets.js';
import { actorUserId } from '../recordings/service.js';
import { apiCSettings } from '../recordings/settings.js';
import { buildSource, SCOPE_PERMISSION, type ExportScope, type ExportSource } from './sources.js';

export const EXPORT_MAX_PDF_ROWS = 5_000;
const BATCH = 1000;

export interface ExportDeps {
  config: Config;
  store?: ArtifactStore;
  logger?: Logger;
}

let storeCache: Promise<ArtifactStore> | undefined;
async function storeOf(deps: ExportDeps): Promise<ArtifactStore> {
  if (deps.store) return deps.store;
  const secrets = getSecretProvider();
  // Import diferido: el SDK de S3 solo se carga si se usa el almacén configurado.
  storeCache ??= import('../../adapters/artifact-store/index.js').then((m) => m.createArtifactStore(deps.config, (r) => secrets.get(r)));
  return storeCache;
}

export function toExportDto(j: ExportJob) {
  return {
    id: j.id,
    format: j.format,
    scope: j.scope,
    extent: j.extent as 'pagina' | 'completo',
    status: j.status,
    rowCount: j.rowCount,
    sizeBytes: j.sizeBytes === null ? null : Number(j.sizeBytes),
    error: j.error,
    expiresAt: j.expiresAt ? j.expiresAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  };
}

function cellText(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function renderPdf(title: string, subtitle: string, columns: CsvColumn<Record<string, unknown>>[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: title, Producer: 'Katalyst' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colW = width / Math.max(columns.length, 1);
  const fontSize = columns.length > 12 ? 5.5 : columns.length > 8 ? 6.5 : 8;
  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(fontSize);
    const y = doc.y;
    columns.forEach((c, i) => doc.text(c.header, doc.page.margins.left + i * colW, y, { width: colW - 2, lineBreak: false, ellipsis: true }));
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(fontSize);
  };
  doc.font('Helvetica-Bold').fontSize(14).text(title);
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(subtitle).fillColor('#000').moveDown(0.5);
  drawHeader();
  for (const r of rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    columns.forEach((c, i) =>
      doc.text(cellText(c.value(r)).slice(0, 200), doc.page.margins.left + i * colW, y, { width: colW - 2, lineBreak: false, ellipsis: true }),
    );
    doc.moveDown(0.4);
  }
  if (rows.length === 0) doc.text('Sin filas para los filtros indicados.');
  doc.end();
  return done;
}

interface JobFilters {
  filters: Record<string, unknown>;
  cursor?: string;
  limit?: number;
  runId?: string;
}

async function collectRows(source: ExportSource, extent: 'pagina' | 'completo', f: JobFilters, max: number) {
  if (extent === 'pagina') {
    const page = await source.fetch(f.cursor ?? null, f.limit ?? PAGE_LIMIT_DEFAULT);
    return page.rows;
  }
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const b = await source.fetch(cursor, BATCH);
    out.push(...b.rows);
    cursor = b.nextCursor;
    if (out.length > max) throw new KatalystError('EXPORT_TOO_LARGE');
  } while (cursor);
  return out;
}

/** Genera el archivo del trabajo y lo deja `listo` (o `fallido`). Idempotente: solo procesa trabajos pendientes. */
export async function processExportJob(prisma: PrismaClient, deps: ExportDeps, jobId: string, now = new Date()): Promise<ExportJob> {
  const claimed = await prisma.exportJob.updateMany({ where: { id: jobId, status: 'pendiente' }, data: { status: 'en_proceso' } });
  const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (claimed.count !== 1) return job;
  try {
    const f = job.filters as unknown as JobFilters;
    const source = buildSource(prisma, job.scope as ExportScope, f.filters ?? {}, f.runId);
    const max = job.format === 'pdf' ? EXPORT_MAX_PDF_ROWS : EXPORT_MAX_ROWS;
    const rows = await collectRows(source, job.extent as 'pagina' | 'completo', f, max);
    const subtitle = `Generado ${now.toISOString()} (UTC) · ${job.extent === 'pagina' ? 'página actual' : 'conjunto completo'} · ${rows.length} filas · filtros: ${JSON.stringify(f.filters ?? {}).slice(0, 300)}`;
    const body =
      job.format === 'csv'
        ? Buffer.from(toCsv(rows, source.columns, { bom: true }), 'utf8')
        : await renderPdf(source.title, subtitle, source.columns, rows);
    const contentType = job.format === 'csv' ? 'text/csv' : 'application/pdf';
    const key = `exports/${job.id}.${job.format}`;
    await (await storeOf(deps)).putObject(key, body, contentType);
    return prisma.exportJob.update({
      where: { id: job.id },
      data: {
        status: 'listo',
        rowCount: rows.length,
        sizeBytes: BigInt(body.length),
        storageKey: key,
        finishedAt: new Date(),
        expiresAt: new Date(now.getTime() + apiCSettings().EXPORT_TTL_HOURS * 3_600_000),
      },
    });
  } catch (err) {
    deps.logger?.error({ err, exportJobId: job.id }, 'exportación fallida');
    const code = err instanceof KatalystError ? err.code : 'INTERNAL_ERROR';
    return prisma.exportJob.update({
      where: { id: job.id },
      data: { status: 'fallido', error: code, finishedAt: new Date() },
    });
  }
}

/** `POST /exports`. */
export async function createExport(
  prisma: PrismaClient,
  deps: ExportDeps,
  actor: Principal,
  input: ExportCreate,
  requestId?: string,
): Promise<{ job: ReturnType<typeof toExportDto>; deferred: boolean }> {
  const scope = input.scope as ExportScope;
  if (!hasPermission(actor, SCOPE_PERMISSION[scope])) throw new KatalystError('FORBIDDEN');
  if ((scope === 'run_results' || scope === 'case_results') && !input.runId) {
    throw new KatalystError('VALIDATION_FAILED', 'runId es obligatorio para este alcance.');
  }
  if (input.runId && !(await prisma.run.findUnique({ where: { id: input.runId }, select: { id: true } }))) {
    throw new KatalystError('NOT_FOUND');
  }
  const userId = await actorUserId(prisma, actor);
  // Valida filtros y tamaño ANTES de crear el trabajo.
  const source = buildSource(prisma, scope, input.filters, input.runId);
  if (input.extent === 'completo') {
    const n = await source.count();
    if (n > (input.format === 'pdf' ? EXPORT_MAX_PDF_ROWS : EXPORT_MAX_ROWS)) throw new KatalystError('EXPORT_TOO_LARGE');
  }
  const filters: JobFilters = {
    filters: input.filters,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
  const job = await prisma.$transaction(async (tx) => {
    const j = await tx.exportJob.create({
      data: {
        createdById: userId,
        format: input.format,
        scope,
        extent: input.extent,
        filters: filters as unknown as Prisma.InputJsonValue,
      },
    });
    await recordAudit(tx, {
      actor,
      action: 'export.create',
      entity: 'export_job',
      entityId: j.id,
      diff: { format: input.format, scope, extent: input.extent, filters: input.filters },
      ...(requestId ? { requestId } : {}),
    });
    return j;
  });
  if (input.extent === 'pagina') {
    return { job: toExportDto(await processExportJob(prisma, deps, job.id)), deferred: false };
  }
  // Trabajo diferido: se procesa fuera de la solicitud (y el control reintenta pendientes huérfanos).
  setImmediate(() => {
    void processExportJob(prisma, deps, job.id).catch((err) => deps.logger?.error({ err }, 'exportación diferida fallida'));
  });
  return { job: toExportDto(job), deferred: true };
}

async function ownedJob(prisma: PrismaClient, actor: Principal, id: string): Promise<ExportJob> {
  const j = await prisma.exportJob.findUnique({ where: { id } });
  if (!j) throw new KatalystError('NOT_FOUND');
  if (!isAdmin(actor) && j.createdById !== (await actorUserId(prisma, actor))) throw new KatalystError('NOT_FOUND');
  return j;
}

export async function getExport(prisma: PrismaClient, actor: Principal, id: string) {
  return toExportDto(await ownedJob(prisma, actor, id));
}

/** `GET /exports/:id/download`: URL firmada ≤ 5 min (RNF-SEG-05). */
export async function downloadExport(prisma: PrismaClient, deps: ExportDeps, actor: Principal, id: string, now = new Date()) {
  const j = await ownedJob(prisma, actor, id);
  if (j.status === 'pendiente' || j.status === 'en_proceso') throw new KatalystError('CONFLICT', 'La exportación aún se está generando.');
  if (j.status !== 'listo' || !j.storageKey || (j.expiresAt && j.expiresAt <= now)) {
    throw new KatalystError('NOT_FOUND', 'La exportación no está disponible o venció.');
  }
  const signed = await (await storeOf(deps)).presignGet(j.storageKey, {
    expiresInSeconds: Math.min(deps.config.SIGNED_URL_TTL_SECONDS, 300),
    contentType: j.format === 'csv' ? 'text/csv' : 'application/pdf',
    downloadName: `katalyst-${j.scope}-${j.createdAt.toISOString().slice(0, 10)}.${j.format}`,
  });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

/** Elimina archivos vencidos, marca `vencido` y reprocesa diferidos huérfanos (mantenimiento horario). */
export async function purgeExpiredExports(prisma: PrismaClient, now = new Date(), deps?: ExportDeps): Promise<number> {
  const { getConfig } = await import('../../config.js');
  const d = deps ?? { config: getConfig() };
  // Trabajos diferidos huérfanos (proceso reiniciado): vuelven a pendiente y se procesan.
  await prisma.exportJob.updateMany({
    where: { status: 'en_proceso', updatedAt: { lt: new Date(now.getTime() - 30 * 60_000) } },
    data: { status: 'pendiente' },
  });
  const pending = await prisma.exportJob.findMany({
    where: { status: 'pendiente', createdAt: { lt: new Date(now.getTime() - 60_000) } },
    select: { id: true },
    take: 20,
  });
  for (const p of pending) await processExportJob(prisma, d, p.id, now);
  const expired = await prisma.exportJob.findMany({
    where: { status: 'listo', expiresAt: { lte: now } },
    select: { id: true, storageKey: true },
    take: 500,
  });
  if (expired.length === 0) return 0;
  const store = await storeOf(d);
  for (const e of expired) {
    if (e.storageKey) await store.deleteObject(e.storageKey).catch(() => undefined);
    await prisma.exportJob.update({ where: { id: e.id }, data: { status: 'vencido', storageKey: null } });
  }
  return expired.length;
}
