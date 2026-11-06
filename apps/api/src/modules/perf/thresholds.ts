/**
 * Umbrales de rendimiento (RF-REN-03; ESP §7 `perf_threshold`, §13.8) y marcas de eventos (RF-REN-04).
 * - Selector de UNA sola serie (ambiente + endpoint/pantalla + procedencia + origen + tipo de métrica + caché + perfil).
 * - Métrica `p95 | max | error_rate | timeout_rate` con unidad explícita; `min_samples` nunca bajo el piso
 *   (p95/tasas ≥ 20, máx ≥ 1); el CHECK de BD lo garantiza también.
 * - Concurrencia optimista por `version`; borrado lógico (conserva alertas históricas).
 */
import type { PerfThreshold, Prisma, PrismaClient } from '@prisma/client';
import {
  KatalystError,
  METRIC_UNIT,
  type PerfThresholdCreate,
  type SeriesDimensions,
} from '@katalyst/shared';
import type { z } from 'zod';
import type { PerfThresholdUpdateSchema, SeriesSelectorSchema } from '@katalyst/shared';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type SeriesSelector = z.infer<typeof SeriesSelectorSchema>;
export type PerfThresholdUpdate = z.infer<typeof PerfThresholdUpdateSchema>;

export function principalUserId(p: Principal): string | null {
  if (p.kind === 'panel_user') return p.id;
  if (p.kind === 'device') return p.userId;
  return null;
}

/** El selector debe identificar exactamente una serie: sin comodines. */
export function assertSingleSeries(sel: SeriesSelector): void {
  if (/[*%?]/.test(sel.endpointKey) || sel.endpointKey.trim() !== sel.endpointKey) {
    throw new KatalystError('THRESHOLD_SERIES_INVALID');
  }
}

export function thresholdDims(t: PerfThreshold): SeriesDimensions {
  const sel = t.seriesSelector as unknown as SeriesSelector;
  return {
    environmentId: t.environmentId,
    endpointKey: t.endpointKey,
    provenance: sel.provenance,
    source: t.source,
    metricKind: t.metricKind,
    cacheMode: t.cacheMode,
    workerProfile: t.workerProfile,
  };
}

type ThresholdWithUser = PerfThreshold & { createdBy: { id: string; name: string } | null };

export function toThresholdDto(t: ThresholdWithUser) {
  const sel = t.seriesSelector as unknown as SeriesSelector;
  return {
    id: t.id,
    environmentId: t.environmentId,
    seriesSelector: sel,
    metric: t.metric,
    limit: t.limit,
    windowMin: t.windowMin,
    minSamples: t.minSamples,
    enabled: t.enabled,
    label: t.label,
    unit: t.unit as 'ms' | 'ratio',
    lastEvaluation:
      t.lastEvaluatedAt && t.lastState
        ? {
            at: t.lastEvaluatedAt.toISOString(),
            state: t.lastState as 'superado' | 'normal' | 'insuficiente',
            value: t.lastValue,
            n: t.lastN ?? 0,
          }
        : null,
    createdBy: t.createdBy
      ? { id: t.createdBy.id, kind: 'panel_user' as const, displayName: t.createdBy.name }
      : { id: null, kind: 'sistema' as const, displayName: 'sistema' },
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

async function assertEnvironment(db: Db, environmentId: string): Promise<void> {
  const env = await db.environment.findUnique({ where: { id: environmentId }, select: { id: true } });
  if (!env) throw new KatalystError('NOT_FOUND', 'Ambiente inexistente.');
}

function dataFrom(input: PerfThresholdCreate) {
  assertSingleSeries(input.seriesSelector);
  return {
    environmentId: input.environmentId,
    seriesSelector: input.seriesSelector as unknown as Prisma.InputJsonValue,
    endpointKey: input.seriesSelector.endpointKey,
    source: input.seriesSelector.source,
    metricKind: input.seriesSelector.metricKind,
    cacheMode: input.seriesSelector.cacheMode,
    workerProfile: input.seriesSelector.workerProfile,
    metric: input.metric,
    limit: input.limit,
    unit: METRIC_UNIT[input.metric],
    windowMin: input.windowMin,
    minSamples: input.minSamples,
    enabled: input.enabled,
    label: input.label ?? null,
  };
}

const include = { createdBy: { select: { id: true, name: true } } } as const;

export async function createThreshold(
  prisma: PrismaClient,
  actor: Principal,
  input: PerfThresholdCreate,
  requestId?: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertEnvironment(tx, input.environmentId);
    const t = await tx.perfThreshold.create({
      data: { ...dataFrom(input), createdById: principalUserId(actor) },
      include,
    });
    await recordAudit(tx, {
      actor,
      action: 'perf_threshold.create',
      entity: 'perf_threshold',
      entityId: t.id,
      diff: dataFrom(input),
      ...(requestId ? { requestId } : {}),
    });
    return toThresholdDto(t);
  });
}

export async function updateThreshold(
  prisma: PrismaClient,
  actor: Principal,
  id: string,
  input: PerfThresholdUpdate,
  requestId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.perfThreshold.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new KatalystError('NOT_FOUND');
    if (current.version !== input.version) throw new KatalystError('VERSION_CONFLICT');
    await assertEnvironment(tx, input.environmentId);
    const data = dataFrom(input);
    const r = await tx.perfThreshold.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new KatalystError('VERSION_CONFLICT');
    await recordAudit(tx, {
      actor,
      action: 'perf_threshold.update',
      entity: 'perf_threshold',
      entityId: id,
      diff: {
        before: {
          seriesSelector: current.seriesSelector,
          metric: current.metric,
          limit: current.limit,
          windowMin: current.windowMin,
          minSamples: current.minSamples,
          enabled: current.enabled,
        },
        after: data,
      },
      ...(requestId ? { requestId } : {}),
    });
    const t = await tx.perfThreshold.findUniqueOrThrow({ where: { id }, include });
    return toThresholdDto(t);
  });
}

export async function deleteThreshold(prisma: PrismaClient, actor: Principal, id: string, requestId?: string) {
  await prisma.$transaction(async (tx) => {
    const r = await tx.perfThreshold.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new KatalystError('NOT_FOUND');
    await recordAudit(tx, {
      actor,
      action: 'perf_threshold.update',
      entity: 'perf_threshold',
      entityId: id,
      diff: { deleted: true },
      ...(requestId ? { requestId } : {}),
    });
  });
}

export async function listThresholds(
  db: Db,
  q: { environmentId?: string | undefined; limit: number; cursor?: string | undefined },
) {
  const sort = parseSort('createdAt', { createdAt: 'date' });
  const after = decodePageCursor(q.cursor, sort);
  const rows = await db.perfThreshold.findMany({
    where: { AND: [{ deletedAt: null }, q.environmentId ? { environmentId: q.environmentId } : {}, keysetWhere(sort, after)] },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
    include,
  });
  const page = paginate(rows, q.limit, sort);
  return { ...page, items: page.items.map(toThresholdDto) };
}

// ---------------------------------------------------------------------------
// Marcas de eventos (RF-REN-04)
// ---------------------------------------------------------------------------

export function toEventMarkDto(m: {
  id: string;
  ts: Date;
  label: string;
  environmentId: string;
  frontendVersion: string | null;
  backendVersion: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string } | null;
}) {
  return {
    id: m.id,
    ts: m.ts.toISOString(),
    label: m.label,
    environmentId: m.environmentId,
    frontendVersion: m.frontendVersion,
    backendVersion: m.backendVersion,
    createdBy: m.createdBy
      ? { id: m.createdBy.id, kind: 'panel_user' as const, displayName: m.createdBy.name }
      : { id: null, kind: 'sistema' as const, displayName: 'sistema' },
    createdAt: m.createdAt.toISOString(),
  };
}

export async function createEventMark(
  prisma: PrismaClient,
  actor: Principal,
  input: { ts: string; label: string; environmentId: string; frontendVersion?: string | undefined; backendVersion?: string | undefined },
  requestId?: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertEnvironment(tx, input.environmentId);
    const m = await tx.eventMark.create({
      data: {
        ts: new Date(input.ts),
        label: input.label,
        environmentId: input.environmentId,
        frontendVersion: input.frontendVersion ?? null,
        backendVersion: input.backendVersion ?? null,
        createdById: principalUserId(actor),
      },
      include,
    });
    await recordAudit(tx, {
      actor,
      action: 'event_mark.create',
      entity: 'event_mark',
      entityId: m.id,
      diff: { ts: input.ts, label: input.label, environmentId: input.environmentId },
      ...(requestId ? { requestId } : {}),
    });
    return toEventMarkDto(m);
  });
}

export async function listEventMarks(
  db: Db,
  q: { environmentId?: string | undefined; from?: string | undefined; to?: string | undefined; limit: number; cursor?: string | undefined },
) {
  const sort = parseSort('-ts', { ts: 'date' });
  const after = decodePageCursor(q.cursor, sort);
  const rows = await db.eventMark.findMany({
    where: {
      AND: [
        q.environmentId ? { environmentId: q.environmentId } : {},
        q.from ? { ts: { gte: new Date(q.from) } } : {},
        q.to ? { ts: { lt: new Date(q.to) } } : {},
        keysetWhere(sort, after),
      ],
    },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
    include,
  });
  const page = paginate(rows, q.limit, sort);
  return { ...page, items: page.items.map(toEventMarkDto) };
}
