/**
 * Fuentes de exportación (RF-RES-04, ESP §17.3): mismos filtros que los listados de origen (esquemas compartidos),
 * mismo agregado que el panel (ESP §13.2: estados/resultados persistidos), orden estable con desempate por UUID.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AuditListQuerySchema,
  KatalystError,
  PerfQuerySchema,
  RunListQuerySchema,
  RunResultListQuerySchema,
  type CsvColumn,
  type Permission,
} from '@katalyst/shared';
import { z } from 'zod';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort, type SortSpec } from '../../lib/pagination.js';
import { getPerf } from '../perf/query.js';

export type ExportScope = 'runs' | 'run_results' | 'case_results' | 'audit_log' | 'perf';

/** Permiso del listado de origen (además de `exports.create`). */
export const SCOPE_PERMISSION: Record<ExportScope, Permission> = {
  runs: 'runs.read',
  run_results: 'runs.read',
  case_results: 'runs.read',
  audit_log: 'audit.read',
  perf: 'perf.read',
};

export interface Batch<T> {
  rows: T[];
  nextCursor: string | null;
}

export interface ExportSource<T = Record<string, unknown>> {
  title: string;
  columns: CsvColumn<T>[];
  /** Una página (`limit` ≤ 100) o un lote interno (≤ 1000) desde `cursor`. */
  fetch(cursor: string | null, limit: number): Promise<Batch<T>>;
  count(): Promise<number>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function filtersError(): never {
  throw new KatalystError('VALIDATION_FAILED', 'Filtros inválidos para el alcance de la exportación.');
}

async function keysetPage<R extends { id: string }>(
  find: (args: { where: Record<string, unknown>; orderBy: Record<string, string>[]; take: number }) => Promise<R[]>,
  where: Record<string, unknown>,
  sort: SortSpec,
  cursor: string | null,
  limit: number,
): Promise<Batch<R>> {
  const after = decodePageCursor(cursor, sort);
  const rows = await find({ where: { AND: [where, keysetWhere(sort, after)] }, orderBy: keysetOrderBy(sort), take: limit + 1 });
  const page = paginate(rows, limit, sort);
  return { rows: page.items, nextCursor: page.nextCursor };
}

export function buildSource(
  prisma: PrismaClient | Prisma.TransactionClient,
  scope: ExportScope,
  rawFilters: Record<string, unknown>,
  runId?: string,
): ExportSource {
  switch (scope) {
    case 'runs': {
      const f = RunListQuerySchema.safeParse(rawFilters);
      if (!f.success) filtersError();
      const q = f.data;
      const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const where: Prisma.RunWhereInput = {
        ...(q.environmentId ? { environmentId: q.environmentId } : {}),
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(q.outcome ? { outcome: q.outcome } : {}),
        ...(q.syncStatus ? { syncStatus: q.syncStatus } : {}),
        ...(q.trigger ? { trigger: q.trigger } : {}),
        ...(q.suiteId ? { suiteId: q.suiteId } : {}),
        ...(q.scheduleId ? { scheduleId: q.scheduleId } : {}),
        ...(q.createdBy ? { createdById: q.createdBy } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      };
      // `finishedAt` admite nulos: la exportación ordena por creación (orden estable con desempate por UUID).
      const sort = parseSort(q.sort.startsWith('-') ? '-createdAt' : 'createdAt', { createdAt: 'date' });
      type Row = Prisma.RunGetPayload<{ include: { environment: { select: { name: true } }; createdBy: { select: { name: true } }; suite: { select: { name: true } }; schedule: { select: { name: true } } } }>;
      return {
        title: 'Ejecuciones',
        columns: [
          { header: 'ID', value: (r: Row) => r.id },
          { header: 'Creada (UTC)', value: (r: Row) => iso(r.createdAt) },
          { header: 'Origen', value: (r: Row) => r.trigger },
          { header: 'Ambiente', value: (r: Row) => r.environment.name },
          { header: 'Suite', value: (r: Row) => r.suite?.name ?? null },
          { header: 'Programación', value: (r: Row) => r.schedule?.name ?? null },
          { header: 'Estado', value: (r: Row) => r.status },
          { header: 'Resultado', value: (r: Row) => r.outcome },
          { header: 'Publicación TestRail', value: (r: Row) => r.syncStatus },
          { header: 'Inicio (UTC)', value: (r: Row) => iso(r.startedAt) },
          { header: 'Fin (UTC)', value: (r: Row) => iso(r.finishedAt) },
          { header: 'Commit', value: (r: Row) => r.gitCommit },
          { header: 'Iniciada por', value: (r: Row) => r.createdBy?.name ?? (r.trigger === 'programada' ? 'programación' : 'token API') },
        ] as CsvColumn<Row>[] as CsvColumn<Record<string, unknown>>[],
        fetch: (cursor, limit) =>
          keysetPage(
            (a) =>
              prisma.run.findMany({
                ...(a as object),
                include: { environment: { select: { name: true } }, createdBy: { select: { name: true } }, suite: { select: { name: true } }, schedule: { select: { name: true } } },
              }) as Promise<Row[]>,
            where as Record<string, unknown>,
            sort,
            cursor,
            limit,
          ) as Promise<Batch<Record<string, unknown>>>,
        count: () => prisma.run.count({ where }),
      };
    }
    case 'run_results': {
      if (!runId) filtersError();
      const f = RunResultListQuerySchema.safeParse(rawFilters);
      if (!f.success) filtersError();
      const q = f.data;
      const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const where: Prisma.RunResultWhereInput = {
        runId,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(q.q ? { automatedTest: { title: { contains: q.q, mode: 'insensitive' } } } : {}),
      };
      const sort = parseSort('createdAt', { createdAt: 'date' });
      type Row = Prisma.RunResultGetPayload<{ include: { automatedTest: { select: { title: true; stableKey: true; filePath: true; classification: true } } } }>;
      return {
        title: 'Resultados por test',
        columns: [
          { header: 'ID', value: (r: Row) => r.id },
          { header: 'Test', value: (r: Row) => r.automatedTest.title },
          { header: 'stableKey', value: (r: Row) => r.automatedTest.stableKey },
          { header: 'Archivo', value: (r: Row) => r.automatedTest.filePath },
          { header: 'Variante', value: (r: Row) => r.parameterKey },
          { header: 'Clasificación', value: (r: Row) => r.automatedTest.classification },
          { header: 'Estado', value: (r: Row) => r.status },
          { header: 'Causa', value: (r: Row) => r.reason },
          { header: 'Duración (ms)', value: (r: Row) => r.durationMs },
          { header: 'Reintentos', value: (r: Row) => r.retryCount },
          { header: 'Recuperaciones', value: (r: Row) => r.infraRecoveryCount },
          { header: 'Evidencia incompleta', value: (r: Row) => r.evidenceIncomplete },
        ] as CsvColumn<Row>[] as CsvColumn<Record<string, unknown>>[],
        fetch: (cursor, limit) =>
          keysetPage(
            (a) =>
              prisma.runResult.findMany({
                ...(a as object),
                include: { automatedTest: { select: { title: true, stableKey: true, filePath: true, classification: true } } },
              }) as Promise<Row[]>,
            where as Record<string, unknown>,
            sort,
            cursor,
            limit,
          ) as Promise<Batch<Record<string, unknown>>>,
        count: () => prisma.runResult.count({ where }),
      };
    }
    case 'case_results': {
      if (!runId) filtersError();
      const f = z.object({ status: z.string().max(40).optional() }).loose().safeParse(rawFilters);
      if (!f.success) filtersError();
      const where: Prisma.CaseResultWhereInput = { runId, ...(f.data.status ? { status: f.data.status as never } : {}) };
      const sort = parseSort('createdAt', { createdAt: 'date' });
      type Row = Prisma.CaseResultGetPayload<{ include: { case: { select: { trCaseId: true; title: true } } } }>;
      return {
        title: 'Resultados por caso',
        columns: [
          { header: 'Caso', value: (r: Row) => `C${r.case.trCaseId}` },
          { header: 'Título', value: (r: Row) => r.case.title },
          { header: 'Revisión', value: (r: Row) => r.caseRevision },
          { header: 'Estado', value: (r: Row) => r.status },
          { header: 'Cobertura', value: (r: Row) => r.coverage },
          { header: 'Duración (ms)', value: (r: Row) => r.durationMs },
          { header: 'Publicable', value: (r: Row) => r.publishable },
          { header: 'Publicación TestRail', value: (r: Row) => r.syncStatus },
          { header: 'ID resultado TestRail', value: (r: Row) => r.trResultId },
        ] as CsvColumn<Row>[] as CsvColumn<Record<string, unknown>>[],
        fetch: (cursor, limit) =>
          keysetPage(
            (a) => prisma.caseResult.findMany({ ...(a as object), include: { case: { select: { trCaseId: true, title: true } } } }) as Promise<Row[]>,
            where as Record<string, unknown>,
            sort,
            cursor,
            limit,
          ) as Promise<Batch<Record<string, unknown>>>,
        count: () => prisma.caseResult.count({ where }),
      };
    }
    case 'audit_log': {
      const f = AuditListQuerySchema.safeParse(rawFilters);
      if (!f.success) filtersError();
      const q = f.data;
      const where: Prisma.AuditLogWhereInput = {
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.entity ? { entity: q.entity } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      };
      const sort = parseSort('-createdAt', { createdAt: 'date' });
      type Row = Prisma.AuditLogGetPayload<object>;
      return {
        title: 'Auditoría',
        columns: [
          { header: 'Fecha (UTC)', value: (r: Row) => iso(r.createdAt) },
          { header: 'Actor', value: (r: Row) => r.actorDisplay },
          { header: 'Tipo de actor', value: (r: Row) => r.actorKind },
          { header: 'Acción', value: (r: Row) => r.action },
          { header: 'Entidad', value: (r: Row) => r.entity },
          { header: 'ID entidad', value: (r: Row) => r.entityId },
          { header: 'Cambios', value: (r: Row) => (r.diff ? JSON.stringify(r.diff).slice(0, 2000) : null) },
        ] as CsvColumn<Row>[] as CsvColumn<Record<string, unknown>>[],
        fetch: (cursor, limit) =>
          keysetPage((a) => prisma.auditLog.findMany(a as never), where as Record<string, unknown>, sort, cursor, limit) as Promise<
            Batch<Record<string, unknown>>
          >,
        count: () => prisma.auditLog.count({ where }),
      };
    }
    case 'perf': {
      const f = PerfQuerySchema.safeParse(rawFilters);
      if (!f.success) filtersError();
      type Row = Record<string, string | number | boolean | null>;
      let cache: Row[] | null = null;
      const load = async () => {
        if (cache) return cache;
        const r = await getPerf(prisma, f.data);
        cache = r.series.flatMap((s) =>
          s.points.map((p) => ({
            serie: s.key.endpointKey,
            procedencia: s.key.provenance,
            origen: s.key.source,
            metrica: s.key.metricKind,
            cache: s.key.cacheMode,
            perfil: s.key.workerProfile,
            ...p,
          })),
        );
        return cache;
      };
      const col = (header: string, k: string): CsvColumn<Row> => ({ header, value: (r) => r[k] ?? null });
      return {
        title: 'Rendimiento',
        columns: [
          col('Serie', 'serie'),
          col('Procedencia', 'procedencia'),
          col('Origen', 'origen'),
          col('Tipo de métrica', 'metrica'),
          col('Caché', 'cache'),
          col('Perfil', 'perfil'),
          col('Inicio bucket (UTC)', 'bucketStart'),
          col('Iniciadas', 'started'),
          col('Completadas', 'completed'),
          col('Descartadas', 'discarded'),
          col('Media (ms)', 'meanMs'),
          col('p95 (ms)', 'p95Ms'),
          col('Estado p95', 'p95Status'),
          col('Máximo (ms)', 'maxMs'),
          col('Errores HTTP', 'httpErrors'),
          col('Errores de red', 'networkErrors'),
          col('Timeouts', 'timeouts'),
          col('> 29 s', 'over29s'),
          col('Tasa de error', 'errorRate'),
          col('Tasa de timeout', 'timeoutRate'),
        ] as CsvColumn<Record<string, unknown>>[],
        fetch: async (cursor, limit) => {
          const all = await load();
          const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) || 0 : 0;
          const rows = all.slice(start, start + limit);
          const next = start + limit < all.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
          return { rows, nextCursor: next };
        },
        count: async () => (await load()).length,
      };
    }
  }
}
