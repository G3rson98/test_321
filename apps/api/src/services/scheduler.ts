/**
 * Programaciones (RF-PRG-01..05, ESP §13.5; RNF-REN-02).
 * - El ÚNICO servicio lógico de horarios es `@katalyst/shared/schedule` (`buildCronExpressions`, `validateSchedule`,
 *   `previewOccurrences`, `occurrencesBetween`): lo usan vista previa, admisión y reconciliación.
 * - CRUD con revisiones y autor (`schedule_revision`) + auditoría; pausar/editar/borrar cancelan corridas aún no
 *   iniciadas con motivo y no hacen catch-up al reanudar (el cursor salta a "ahora").
 * - `materializeDueOccurrences`: cada ≤ 15 s registra cada instante UTC (zona + revisión) desde el cursor persistido,
 *   por lotes. En la MISMA transacción: ocurrencia + corrida (snapshot) + reserva de capacidad + outbox de despacho.
 *   Solapamiento ⇒ `omitida/solapamiento`; ventana de exclusión ⇒ `omitida/ventana_exclusion`; instante vencido más de
 *   60 s (caída del servicio) ⇒ `omitida/caida_servicio` sin ráfaga; sin capacidad la corrida espera en cola hasta
 *   60 s y luego queda `omitida/sin_capacidad` (run-admission).
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Schedule as ScheduleRow } from '@prisma/client';
import type { Logger } from 'pino';
import { Histogram } from 'prom-client';
import {
  ACTIVE_RUN_STATUSES,
  KatalystError,
  ScheduleBuildError,
  buildCronExpressions,
  isExcluded,
  normalizeSelection,
  nextOccurrence,
  occurrencesBetween,
  previewOccurrences,
  reasonText,
  validateSchedule,
  RunSelectionSchema,
  type ErrorCode,
  type OccurrenceSkipReason,
  type RunSelection,
  type Schedule,
  type ScheduleCreate,
  type ScheduleEditor,
  type ScheduleUpdate,
} from '@katalyst/shared';
import type { Principal } from '../lib/auth.js';
import { principalUserId } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { publishEvent, runInTransaction } from '../lib/events-publish.js';
import { metricsRegistry } from '../lib/metrics.js';
import { loadRuntimeSettings, resolvePlan } from './run-planner.js';
import { admitShardInTx, capacityLimits, createRunFromPlan, type RunDeps } from './run-admission.js';
import { releaseShardCapacity } from './capacity.js';
import { finalizeRun } from './results.js';

type Db = Prisma.TransactionClient;

export const occurrenceDelaySeconds = new Histogram({
  name: 'katalyst_schedule_occurrence_delay_seconds',
  help: 'Retraso entre el instante programado y el registro de la ocurrencia (RNF-REN-02, objetivo ≤ 60 s)',
  labelNames: ['status'] as const,
  buckets: [1, 5, 10, 15, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

/** Máximo de instantes procesados por programación y tick (huecos tras caída se procesan por lotes). */
export const MATERIALIZE_BATCH = 200;
export const MATERIALIZE_GRACE_MS = 60_000;

const BUILD_CODES: Record<string, ErrorCode> = {
  SCHEDULE_RANGE_CROSSES_MIDNIGHT: 'SCHEDULE_RANGE_CROSSES_MIDNIGHT',
  CRON_INTERVAL_TOO_SHORT: 'CRON_INTERVAL_TOO_SHORT',
  SCHEDULE_NO_OCCURRENCES: 'SCHEDULE_NO_OCCURRENCES',
};

export interface CompiledSchedule {
  cronExpressions: string[];
  description: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  editor: ScheduleEditor | null;
}

/** Compila editor visual o expresiones avanzadas y valida (422 con código estable). */
export function compileSchedule(
  input: { editor?: ScheduleEditor | undefined; cronExpressions?: string[] | undefined; timezone: string },
  minIntervalMinutes: number,
): CompiledSchedule {
  let crons: string[];
  let description: string | null = null;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  if (input.editor) {
    try {
      const b = buildCronExpressions(input.editor, { minIntervalMinutes });
      crons = b.cronExpressions;
      description = b.description;
      windowStart = b.windowStart;
      windowEnd = b.windowEnd;
    } catch (err) {
      if (err instanceof ScheduleBuildError) {
        throw new KatalystError(BUILD_CODES[err.code] ?? 'CRON_INVALID', err.message);
      }
      throw err;
    }
  } else {
    crons = input.cronExpressions ?? [];
  }
  const v = validateSchedule(crons, input.timezone, { minIntervalMinutes });
  if (!v.ok) {
    const first = v.issues[0]!;
    throw new KatalystError(first.code, first.message, {
      issues: v.issues.map((i) => ({ path: ['cronExpressions', ...(i.index !== undefined ? [i.index] : [])], code: i.code, message: i.message })),
    });
  }
  return { cronExpressions: v.normalized, description, windowStart, windowEnd, editor: input.editor ?? null };
}

// =================================================================================================================
// DTO
// =================================================================================================================

type ScheduleWithRefs = ScheduleRow & { createdBy: { id: string; name: string } | null };

export async function toScheduleDto(db: Db, s: ScheduleWithRefs, now: Date): Promise<Schedule> {
  const last = await db.scheduleOccurrence.findFirst({
    where: { scheduleId: s.id },
    orderBy: { scheduledFor: 'desc' },
  });
  const active = s.enabled && !s.deletedAt;
  return {
    id: s.id,
    name: s.name,
    suiteId: s.suiteId,
    selector: RunSelectionSchema.parse(s.selector),
    environmentId: s.environmentId,
    cronExpressions: s.cronExpressions,
    editor: (s.editor as ScheduleEditor | null) ?? null,
    description: s.description,
    timezone: s.timezone,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    enabled: s.enabled,
    pausedAt: s.pausedAt?.toISOString() ?? null,
    retries: s.retries,
    notify: s.notify as Schedule['notify'],
    revision: s.revision,
    createdBy: s.createdBy
      ? { id: s.createdBy.id, kind: 'panel_user', displayName: s.createdBy.name }
      : { id: null, kind: 'sistema', displayName: 'sistema' },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    deletedAt: s.deletedAt?.toISOString() ?? null,
    nextOccurrence: active ? (nextOccurrence(s.cronExpressions, s.timezone, now)?.toISOString() ?? null) : null,
    lastOccurrence: last
      ? {
          scheduledFor: last.scheduledFor.toISOString(),
          status: last.status,
          reason: last.reason,
          runId: last.runId,
        }
      : null,
    version: s.version,
  };
}

function scheduleSnapshot(s: ScheduleRow): Record<string, unknown> {
  return {
    name: s.name,
    suiteId: s.suiteId,
    selector: s.selector,
    environmentId: s.environmentId,
    cronExpressions: s.cronExpressions,
    editor: s.editor,
    timezone: s.timezone,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    enabled: s.enabled,
    retries: s.retries,
    notify: s.notify,
    revision: s.revision,
    deletedAt: s.deletedAt?.toISOString() ?? null,
  };
}

const DIFF_KEYS = [
  'name',
  'suiteId',
  'selector',
  'environmentId',
  'cronExpressions',
  'timezone',
  'enabled',
  'retries',
  'notify',
  'deletedAt',
] as const;

function diffOf(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of DIFF_KEYS) {
    const a = before ? before[k] : undefined;
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

/** Usuario autor detrás del principal (sesión, dispositivo o dueño del token API) para historial con autor. */
export async function actorUserId(db: Db, actor: Principal): Promise<string | null> {
  const direct = principalUserId(actor);
  if (direct) return direct;
  if (actor.kind === 'api_token') {
    const c = await db.apiCredential.findUnique({ where: { id: actor.id }, select: { principalId: true } });
    return c?.principalId ?? null;
  }
  return null;
}

async function writeRevision(
  tx: Db,
  s: ScheduleRow,
  action: 'create' | 'update' | 'pause' | 'resume' | 'delete' | 'duplicate',
  actor: Principal,
  before: Record<string, unknown> | null,
  requestId?: string,
): Promise<void> {
  const snapshot = scheduleSnapshot(s);
  const diff = diffOf(before, snapshot);
  await tx.scheduleRevision.create({
    data: {
      scheduleId: s.id,
      revision: s.revision,
      action,
      changedById: await actorUserId(tx, actor),
      diff: diff as Prisma.InputJsonValue,
      snapshot: snapshot as Prisma.InputJsonValue,
    },
  });
  await recordAudit(tx, {
    actor,
    action: `schedule.${action}`,
    entity: 'schedule',
    entityId: s.id,
    diff: { revision: s.revision, ...diff },
    ...(requestId ? { requestId } : {}),
  });
  await publishEvent(tx, {
    type: 'schedule.updated',
    entity: 'schedule',
    entityId: s.id,
    version: s.version,
    environmentId: s.environmentId,
    data: { action, revision: s.revision, enabled: s.enabled, deleted: s.deletedAt !== null },
  });
}

/** Valida la selección resolviendo el plan como lo haría la admisión programada (422 si vacía/ajena/deshabilitada). */
async function validateSelection(db: Db, selection: RunSelection, environmentId: string, retries: number) {
  await resolvePlan(db, {
    selection,
    environmentId,
    retries,
    excludeFlaky: false,
    testrail: { mode: 'nueva' },
    trigger: 'programada',
  });
}

const INCLUDE = { createdBy: { select: { id: true, name: true } } } as const;

export interface ScheduleDeps {
  prisma: PrismaClient;
  logger: Logger;
  publicBaseUrl: string;
  globalBrowserCeiling: number;
  /** Notifica cambios a los disparadores BullMQ (best effort; el reconciliador corrige desde PostgreSQL). */
  onChanged?: (scheduleId: string) => Promise<void>;
}

export async function createSchedule(
  deps: ScheduleDeps,
  body: ScheduleCreate,
  actor: Principal,
  now: Date = new Date(),
  requestId?: string,
): Promise<Schedule> {
  const settings = await loadRuntimeSettings(deps.prisma);
  const compiled = compileSchedule(body, settings.schedule.minIntervalMinutes);
  const selection = normalizeSelection(body);
  await validateSelection(deps.prisma, selection, body.environmentId, body.retries);
  const s = await runInTransaction(deps.prisma, async (tx) => {
    const row = await tx.schedule.create({
      data: {
        name: body.name,
        suiteId: selection.kind === 'suite' ? selection.suiteId : null,
        selector: selection,
        environmentId: body.environmentId,
        cronExpressions: compiled.cronExpressions,
        editor: (compiled.editor ?? undefined) as Prisma.InputJsonValue | undefined,
        description: compiled.description,
        timezone: body.timezone,
        windowStart: compiled.windowStart,
        windowEnd: compiled.windowEnd,
        enabled: body.enabled,
        pausedAt: body.enabled ? null : now,
        retries: body.retries,
        notify: body.notify,
        revision: 1,
        createdById: await actorUserId(tx, actor),
        createdAt: now,
      },
      include: INCLUDE,
    });
    // Sin catch-up: el cursor empieza en el instante de creación.
    await tx.reconciliationCursor.create({
      data: { scheduleId: row.id, reconciledUntil: now, scheduleRevision: 1 },
    });
    await writeRevision(tx, row, 'create', actor, null, requestId);
    return row;
  });
  await deps.onChanged?.(s.id).catch(() => undefined);
  return toScheduleDto(deps.prisma, s, now);
}

async function loadForUpdate(tx: Db, id: string): Promise<ScheduleWithRefs> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM schedule WHERE id = ${id}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new KatalystError('NOT_FOUND');
  const s = await tx.schedule.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  if (s.deletedAt) throw new KatalystError('NOT_FOUND');
  return s;
}

/**
 * Cancela corridas de la programación aún no iniciadas (en cola, sin shard reclamado) con motivo (ESP §13.5).
 * No detiene corridas en curso.
 */
export async function cancelUnstartedScheduleRuns(
  tx: Db,
  scheduleId: string,
  now: Date,
  publicBaseUrl: string,
): Promise<string[]> {
  const runs = await tx.run.findMany({
    where: { scheduleId, status: 'en_cola', shards: { every: { currentGeneration: 0 } } },
    select: { id: true },
  });
  const cause = 'cancelado_por_programacion' as const;
  for (const r of runs) {
    await tx.$queryRaw`SELECT id FROM run WHERE id = ${r.id}::uuid FOR NO KEY UPDATE`;
    await tx.run.update({ where: { id: r.id }, data: { cancelRequestedAt: now, reason: cause } });
    const shards = await tx.runShard.findMany({ where: { runId: r.id }, select: { id: true } });
    for (const sh of shards) await releaseShardCapacity(tx, sh.id, now);
    await tx.runResult.updateMany({
      where: { runId: r.id, status: 'pendiente' },
      data: { status: 'cancelado', reason: cause, reasonText: reasonText(cause) },
    });
    await finalizeRun(tx, { runId: r.id, terminal: 'cancelada', reason: cause, now, publicBaseUrl });
  }
  return runs.map((r) => r.id);
}

export async function updateSchedule(
  deps: ScheduleDeps,
  id: string,
  body: ScheduleUpdate,
  actor: Principal,
  now: Date = new Date(),
  requestId?: string,
): Promise<Schedule> {
  const settings = await loadRuntimeSettings(deps.prisma);
  const compiled = compileSchedule(body, settings.schedule.minIntervalMinutes);
  const selection = normalizeSelection(body);
  await validateSelection(deps.prisma, selection, body.environmentId, body.retries);
  const s = await runInTransaction(deps.prisma, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    if (cur.revision !== body.revision) throw new KatalystError('VERSION_CONFLICT');
    const before = scheduleSnapshot(cur);
    const row = await tx.schedule.update({
      where: { id },
      data: {
        name: body.name,
        suiteId: selection.kind === 'suite' ? selection.suiteId : null,
        selector: selection,
        environmentId: body.environmentId,
        cronExpressions: compiled.cronExpressions,
        editor: (compiled.editor ?? null) as Prisma.InputJsonValue,
        description: compiled.description,
        timezone: body.timezone,
        windowStart: compiled.windowStart,
        windowEnd: compiled.windowEnd,
        enabled: body.enabled,
        pausedAt: body.enabled ? null : (cur.pausedAt ?? now),
        retries: body.retries,
        notify: body.notify,
        revision: { increment: 1 },
        version: { increment: 1 },
      },
      include: INCLUDE,
    });
    await cancelUnstartedScheduleRuns(tx, id, now, deps.publicBaseUrl);
    await tx.reconciliationCursor.upsert({
      where: { scheduleId: id },
      create: { scheduleId: id, reconciledUntil: now, scheduleRevision: row.revision },
      update: { reconciledUntil: now, scheduleRevision: row.revision },
    });
    await writeRevision(tx, row, 'update', actor, before, requestId);
    return row;
  });
  await deps.onChanged?.(id).catch(() => undefined);
  return toScheduleDto(deps.prisma, s, now);
}

export async function setSchedulePaused(
  deps: ScheduleDeps,
  id: string,
  paused: boolean,
  actor: Principal,
  now: Date = new Date(),
  requestId?: string,
): Promise<Schedule> {
  const s = await runInTransaction(deps.prisma, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    if (cur.enabled === !paused) return cur; // idempotente
    const before = scheduleSnapshot(cur);
    const row = await tx.schedule.update({
      where: { id },
      data: {
        enabled: !paused,
        pausedAt: paused ? now : null,
        revision: { increment: 1 },
        version: { increment: 1 },
      },
      include: INCLUDE,
    });
    if (paused) await cancelUnstartedScheduleRuns(tx, id, now, deps.publicBaseUrl);
    // Sin catch-up al reanudar: el cursor salta al instante actual.
    await tx.reconciliationCursor.upsert({
      where: { scheduleId: id },
      create: { scheduleId: id, reconciledUntil: now, scheduleRevision: row.revision },
      update: { reconciledUntil: now, scheduleRevision: row.revision },
    });
    await writeRevision(tx, row, paused ? 'pause' : 'resume', actor, before, requestId);
    return row;
  });
  await deps.onChanged?.(id).catch(() => undefined);
  return toScheduleDto(deps.prisma, s, now);
}

export async function deleteSchedule(
  deps: ScheduleDeps,
  id: string,
  actor: Principal,
  now: Date = new Date(),
  requestId?: string,
): Promise<void> {
  await runInTransaction(deps.prisma, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    const before = scheduleSnapshot(cur);
    const row = await tx.schedule.update({
      where: { id },
      data: { deletedAt: now, enabled: false, pausedAt: cur.pausedAt ?? now, revision: { increment: 1 }, version: { increment: 1 } },
    });
    await cancelUnstartedScheduleRuns(tx, id, now, deps.publicBaseUrl);
    await writeRevision(tx, row, 'delete', actor, before, requestId);
  });
  await deps.onChanged?.(id).catch(() => undefined);
}

export async function duplicateSchedule(
  deps: ScheduleDeps,
  id: string,
  name: string | undefined,
  actor: Principal,
  now: Date = new Date(),
  requestId?: string,
): Promise<Schedule> {
  const s = await runInTransaction(deps.prisma, async (tx) => {
    const src = await tx.schedule.findUnique({ where: { id } });
    if (!src || src.deletedAt) throw new KatalystError('NOT_FOUND');
    // La copia nace pausada: no ejecuta nada hasta que se reanude explícitamente.
    const row = await tx.schedule.create({
      data: {
        name: (name ?? `${src.name} (copia)`).slice(0, 120),
        suiteId: src.suiteId,
        selector: src.selector as Prisma.InputJsonValue,
        environmentId: src.environmentId,
        cronExpressions: src.cronExpressions,
        editor: (src.editor ?? undefined) as Prisma.InputJsonValue | undefined,
        description: src.description,
        timezone: src.timezone,
        windowStart: src.windowStart,
        windowEnd: src.windowEnd,
        enabled: false,
        pausedAt: now,
        retries: src.retries,
        notify: src.notify as Prisma.InputJsonValue,
        revision: 1,
        createdById: await actorUserId(tx, actor),
        createdAt: now,
      },
      include: INCLUDE,
    });
    await tx.reconciliationCursor.create({ data: { scheduleId: row.id, reconciledUntil: now, scheduleRevision: 1 } });
    await writeRevision(tx, row, 'duplicate', actor, null, requestId);
    return row;
  });
  return toScheduleDto(deps.prisma, s, now);
}

export async function getSchedule(db: Db, id: string, now: Date = new Date()): Promise<Schedule> {
  const s = await db.schedule.findUnique({ where: { id }, include: INCLUDE });
  if (!s || s.deletedAt) throw new KatalystError('NOT_FOUND');
  return toScheduleDto(db, s, now);
}

export async function scheduleNext(db: Db, id: string, count: number, after: Date) {
  const s = await db.schedule.findUnique({ where: { id } });
  if (!s || s.deletedAt) throw new KatalystError('NOT_FOUND');
  return {
    timezone: s.timezone,
    revision: s.revision,
    occurrences: previewOccurrences(s.cronExpressions, s.timezone, after, count),
  };
}

// =================================================================================================================
// Materialización de ocurrencias (planificador ≤ 15 s + reconciliación por cursor)
// =================================================================================================================

export interface MaterializeStats {
  admitted: number;
  queued: number;
  omitted: Partial<Record<OccurrenceSkipReason, number>>;
  schedules: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002';
}

async function recordOmitted(
  tx: Db,
  s: ScheduleRow,
  at: Date,
  reason: OccurrenceSkipReason,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO schedule_occurrence
      (id, schedule_id, schedule_revision, scheduled_for, timezone, status, reason, created_at, updated_at)
    VALUES (${randomUUID()}::uuid, ${s.id}::uuid, ${s.revision}, ${at}, ${s.timezone}, 'omitida',
            ${reason}::"occurrence_skip_reason", now(), now())
    ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
    RETURNING id::text AS id`;
  if (rows.length) {
    await publishEvent(tx, {
      type: 'schedule.occurrence',
      entity: 'schedule_occurrence',
      entityId: rows[0]!.id,
      version: 0,
      environmentId: s.environmentId,
      data: { scheduleId: s.id, scheduledFor: at.toISOString(), status: 'omitida', reason },
    });
  }
  return rows.length > 0;
}

async function advanceCursor(tx: Db, s: ScheduleRow, at: Date): Promise<void> {
  await tx.reconciliationCursor.upsert({
    where: { scheduleId: s.id },
    create: { scheduleId: s.id, reconciledUntil: at, scheduleRevision: s.revision },
    update: { reconciledUntil: at, scheduleRevision: s.revision },
  });
}

const PLAN_SKIP: Partial<Record<ErrorCode, OccurrenceSkipReason>> = {
  SELECTION_EMPTY: 'seleccion_vacia',
  ENVIRONMENT_DISABLED: 'ambiente_deshabilitado',
};

/**
 * Procesa un instante de una programación: registra la ocurrencia (idempotente por `(schedule_id, scheduled_for)`)
 * y, si corresponde, crea la corrida + reserva + despacho atómicamente.
 */
async function materializeInstant(
  deps: ScheduleDeps,
  s: ScheduleRow,
  at: Date,
  now: Date,
  windows: { startsAt: Date; endsAt: Date }[],
  stats: MaterializeStats,
): Promise<void> {
  const omit = async (reason: OccurrenceSkipReason) => {
    const created = await runInTransaction(deps.prisma, async (tx) => {
      const ok = await recordOmitted(tx, s, at, reason);
      await advanceCursor(tx, s, at);
      return ok;
    });
    if (created) {
      stats.omitted[reason] = (stats.omitted[reason] ?? 0) + 1;
      occurrenceDelaySeconds.observe({ status: 'omitida' }, Math.max(0, (now.getTime() - at.getTime()) / 1000));
    }
  };
  if (now.getTime() - at.getTime() > MATERIALIZE_GRACE_MS) return omit('caida_servicio');
  if (isExcluded(at, windows)) return omit('ventana_exclusion');

  const selection = RunSelectionSchema.parse(s.selector);
  let plan;
  try {
    plan = await resolvePlan(deps.prisma, {
      selection,
      environmentId: s.environmentId,
      retries: s.retries,
      excludeFlaky: false,
      testrail: { mode: 'nueva' },
      trigger: 'programada',
      scheduleId: s.id,
      scheduleRevision: s.revision,
    });
  } catch (err) {
    if (err instanceof KatalystError) return omit(PLAN_SKIP[err.code] ?? 'configuracion_invalida');
    throw err;
  }
  try {
    const result = await runInTransaction(
      deps.prisma,
      async (tx) => {
        const exists = await tx.scheduleOccurrence.findUnique({
          where: { scheduleId_scheduledFor: { scheduleId: s.id, scheduledFor: at } },
          select: { id: true },
        });
        if (exists) {
          await advanceCursor(tx, s, at);
          return 'exists' as const;
        }
        const active = await tx.run.count({
          where: { scheduleId: s.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        });
        if (active > 0) {
          await recordOmitted(tx, s, at, 'solapamiento');
          await advanceCursor(tx, s, at);
          return 'solapamiento' as const;
        }
        const runId = await createRunFromPlan(
          tx,
          { globalBrowserCeiling: deps.globalBrowserCeiling, publicBaseUrl: deps.publicBaseUrl },
          plan,
          { trigger: 'programada', actor: 'system', scheduleId: s.id, scheduledFor: at },
          now,
        );
        const occ = await tx.scheduleOccurrence.create({
          data: {
            scheduleId: s.id,
            scheduleRevision: s.revision,
            scheduledFor: at,
            timezone: s.timezone,
            status: 'admitida',
            runId,
          },
        });
        // Reserva de capacidad + outbox de despacho en la misma transacción (ESP §13.5).
        const limits = await capacityLimits(tx, deps.globalBrowserCeiling);
        const shards = await tx.runShard.findMany({ where: { runId, status: 'pendiente' }, select: { id: true } });
        let admittedAll = shards.length > 0;
        for (const sh of shards) {
          const r = await admitShardInTx(
            tx,
            {
              runId,
              shardId: sh.id,
              environmentId: s.environmentId,
              testUserId: plan.testUser?.id ?? null,
              trigger: 'programada',
              scheduledFor: at,
            },
            limits,
            now,
          );
          if (!r.ok) admittedAll = false;
        }
        if (shards.length === 0) await tx.scheduleOccurrence.update({ where: { id: occ.id }, data: { admittedAt: now } });
        await publishEvent(tx, {
          type: 'schedule.occurrence',
          entity: 'schedule_occurrence',
          entityId: occ.id,
          version: 0,
          runId,
          environmentId: s.environmentId,
          data: { scheduleId: s.id, scheduledFor: at.toISOString(), status: 'admitida', runId },
        });
        await advanceCursor(tx, s, at);
        return admittedAll || shards.length === 0 ? ('admitted' as const) : ('queued' as const);
      },
      { timeout: 30_000 },
    );
    if (result === 'admitted') stats.admitted++;
    if (result === 'queued') stats.queued++;
    if (result === 'solapamiento') stats.omitted.solapamiento = (stats.omitted.solapamiento ?? 0) + 1;
    if (result !== 'exists') {
      occurrenceDelaySeconds.observe(
        { status: result === 'solapamiento' ? 'omitida' : 'admitida' },
        Math.max(0, (now.getTime() - at.getTime()) / 1000),
      );
    }
  } catch (err) {
    // Carrera con otra réplica: el índice ux_run_active_per_schedule o la unicidad de la ocurrencia lo impiden.
    if (isUniqueViolation(err)) {
      const exists = await deps.prisma.scheduleOccurrence.findUnique({
        where: { scheduleId_scheduledFor: { scheduleId: s.id, scheduledFor: at } },
      });
      if (!exists) return omit('solapamiento');
      return;
    }
    throw err;
  }
}

/** Un tick del planificador/reconciliador. Reloj inyectable (`now`). */
export async function materializeDueOccurrences(
  deps: ScheduleDeps,
  now: Date = new Date(),
  opts: { scheduleId?: string } = {},
): Promise<MaterializeStats> {
  const stats: MaterializeStats = { admitted: 0, queued: 0, omitted: {}, schedules: 0 };
  const schedules = await deps.prisma.schedule.findMany({
    where: { enabled: true, deletedAt: null, ...(opts.scheduleId ? { id: opts.scheduleId } : {}) },
    include: { reconciliationCursor: true },
    orderBy: { id: 'asc' },
  });
  for (const s of schedules) {
    stats.schedules++;
    const from = s.reconciliationCursor?.reconciledUntil ?? s.createdAt;
    // (cursor, now] — instantes de minuto exacto; el cursor es inclusivo del último procesado.
    const due = occurrencesBetween(s.cronExpressions, s.timezone, new Date(from.getTime() + 1), new Date(now.getTime() + 1));
    if (due.length === 0) continue;
    const windows = await deps.prisma.exclusionWindow.findMany({
      where: {
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: from },
        OR: [{ environmentId: null, scheduleId: null }, { environmentId: s.environmentId }, { scheduleId: s.id }],
      },
      select: { startsAt: true, endsAt: true },
    });
    for (const at of due.slice(0, MATERIALIZE_BATCH)) {
      await materializeInstant(deps, s, at, now, windows, stats);
    }
  }
  return stats;
}

export type { RunDeps };
