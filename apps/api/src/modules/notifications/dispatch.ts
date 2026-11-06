/**
 * Notificaciones vía outbox (RF-NOT-01, RF-NOT-02, RF-NOT-03; ESP §13.4, §13.8).
 * - `enqueueRunFinishedNotification(tx, runId)`: API-B la llama en la MISMA transacción que finaliza una corrida
 *   (terminada con outcome `fallido` o estado `interrumpida`). Idempotente por corrida/canal.
 * - Handlers `notification.alert` y `notification.run_finished` (registrados en el publicador genérico de API-A).
 * - Entrega ambigua (webhook/SMTP sin confirmación): se registra en la alerta y NO se repite (evita duplicados; la
 *   deduplicación horaria prevalece). Reintentable → backoff del outbox; permanente → intervención.
 */
import type { OutboxDelivery, Prisma, PrismaClient } from '@prisma/client';
import { sanitizeText, type NotificationChannelKind, type NotificationEvent } from '@katalyst/shared';
import type { Config } from '../../config.js';
import { getNotifiers, type NotifierRegistry, type SendResult } from '../../adapters/notifier/index.js';
import { enqueueOutbox, registerOutboxHandler, type OutboxCtx, type OutboxHandlerResult } from '../../lib/outbox.js';
import { lockAlert } from '../alerts/service.js';
import { activeChannels, listChannels, resolveTarget, type EffectiveChannel } from './channels.js';
import {
  runFinishedMessage,
  thresholdAlertMessage,
  type RunSummaryForMessage,
  type ThresholdAlertPayload,
} from './messages.js';
import { subscribedEmails } from './preferences.js';

export const RUN_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

interface ScheduleNotify {
  onFailure?: boolean;
  onInterruption?: boolean;
  channels?: NotificationChannelKind[];
}

/** Evento de notificación que corresponde a la corrida terminal, o `null` si no notifica. */
export function runNotificationEvent(run: { status: string; outcome: string | null }): NotificationEvent | null {
  if (run.status === 'interrumpida') return 'corrida_interrumpida';
  if (run.status === 'terminada' && run.outcome === 'fallido') return 'corrida_con_fallas';
  return null;
}

export async function enqueueRunFinishedNotification(
  tx: Prisma.TransactionClient,
  runId: string,
  config: Config,
): Promise<{ enqueued: number; event: NotificationEvent | null }> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      outcome: true,
      environmentId: true,
      schedule: { select: { notify: true } },
    },
  });
  if (!run) return { enqueued: 0, event: null };
  const event = runNotificationEvent(run);
  if (!event) return { enqueued: 0, event: null };
  const notify = (run.schedule?.notify ?? {}) as ScheduleNotify;
  if (run.schedule) {
    if (event === 'corrida_con_fallas' && notify.onFailure === false) return { enqueued: 0, event };
    if (event === 'corrida_interrumpida' && notify.onInterruption === false) return { enqueued: 0, event };
  }
  const channels = await activeChannels(tx, config, notify.channels ?? []);
  let enqueued = 0;
  for (const c of channels) {
    const alert = await lockAlert(tx, {
      kind: event === 'corrida_interrumpida' ? 'corrida_interrumpida' : 'corrida_fallida',
      fingerprint: `corrida:${run.id}:${c.kind}`,
      environmentId: run.environmentId,
      runId: run.id,
      channel: c.kind,
      payload: { runId: run.id, event },
    });
    const r = await enqueueOutbox(tx, {
      operation: 'notification.run_finished',
      dedupKey: `run_finished:${run.id}:${c.kind}`,
      payload: { alertId: alert.id, runId: run.id, event },
      runId: run.id,
      alertId: alert.id,
      expiresAt: new Date(Date.now() + RUN_NOTIFICATION_TTL_MS),
    });
    if (r.created) {
      await tx.alert.update({ where: { id: alert.id }, data: { lastSentAt: new Date(), sendCount: { increment: 1 } } });
      enqueued++;
    }
  }
  return { enqueued, event };
}

function toHandlerResult(r: SendResult): OutboxHandlerResult {
  switch (r.outcome) {
    case 'entregada':
      return { kind: 'delivered', externalId: r.externalId ?? null };
    case 'ambigua':
      return { kind: 'delivered', externalId: null, note: 'entrega_ambigua' };
    case 'reintentable':
      return {
        kind: 'retry',
        error: sanitizeText(r.message).value,
        ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
        ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
      };
    case 'permanente':
      return {
        kind: 'intervention',
        error: sanitizeText(r.message).value,
        ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      };
  }
}

async function recordDeliveryOutcome(prisma: PrismaClient, alertId: string, r: SendResult): Promise<void> {
  const alert = await prisma.alert.findUnique({ where: { id: alertId }, select: { payload: true } });
  if (!alert) return;
  const payload = (alert.payload ?? {}) as Record<string, unknown>;
  await prisma.alert.update({
    where: { id: alertId },
    data: {
      payload: {
        ...payload,
        lastDelivery: { outcome: r.outcome, at: new Date().toISOString(), message: sanitizeText(r.message).value },
        ...(r.outcome === 'ambigua' ? { deliveryAmbiguous: true } : {}),
      },
    },
  });
}

async function channelFor(prisma: PrismaClient, config: Config, kind: NotificationChannelKind | null): Promise<EffectiveChannel | null> {
  if (!kind) return null;
  const c = (await listChannels(prisma, config)).find((x) => x.kind === kind);
  return c && c.enabled ? c : null;
}

export interface DispatchDeps {
  config: Config;
  notifiers?: () => NotifierRegistry;
}

export function alertHandler(deps: DispatchDeps) {
  return async (delivery: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const alertId = (delivery.payload as { alertId?: string }).alertId ?? delivery.alertId;
    if (!alertId) return { kind: 'cancelled', reason: 'alerta_inexistente' };
    const alert = await ctx.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return { kind: 'cancelled', reason: 'alerta_inexistente' };
    const channel = await channelFor(ctx.prisma, deps.config, alert.channel);
    if (!channel) return { kind: 'cancelled', reason: 'canal_deshabilitado' };
    const payload = alert.payload as unknown as ThresholdAlertPayload;
    const extra =
      channel.kind === 'correo' && alert.thresholdId
        ? await subscribedEmails(ctx.prisma, 'umbral_superado', { thresholdId: alert.thresholdId })
        : [];
    let target;
    try {
      target = await resolveTarget(channel, extra, ctx.secrets);
    } catch {
      return { kind: 'intervention', error: 'secreto_del_canal_no_disponible' };
    }
    const r = await (deps.notifiers ?? getNotifiers)()[channel.kind].send(
      thresholdAlertMessage({ ...payload, alertId: alert.id }, deps.config.PUBLIC_BASE_URL),
      target,
    );
    await recordDeliveryOutcome(ctx.prisma, alert.id, r);
    return toHandlerResult(r);
  };
}

export async function runSummary(prisma: PrismaClient | Prisma.TransactionClient, runId: string): Promise<RunSummaryForMessage | null> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      outcome: true,
      trigger: true,
      gitCommit: true,
      startedAt: true,
      finishedAt: true,
      environment: { select: { name: true } },
      suite: { select: { name: true } },
      schedule: { select: { name: true } },
    },
  });
  if (!run) return null;
  const groups = await prisma.runResult.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.status] = g._count._all;
  return {
    runId: run.id,
    status: run.status,
    outcome: run.outcome,
    trigger: run.trigger,
    environmentName: run.environment.name,
    suiteName: run.suite?.name ?? null,
    scheduleName: run.schedule?.name ?? null,
    counts,
    durationMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    gitCommit: run.gitCommit,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

export function runFinishedHandler(deps: DispatchDeps) {
  return async (delivery: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const p = delivery.payload as { alertId?: string; runId?: string; event?: NotificationEvent };
    const alertId = p.alertId ?? delivery.alertId;
    if (!alertId || !p.runId) return { kind: 'cancelled', reason: 'payload_incompleto' };
    const alert = await ctx.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return { kind: 'cancelled', reason: 'alerta_inexistente' };
    const channel = await channelFor(ctx.prisma, deps.config, alert.channel);
    if (!channel) return { kind: 'cancelled', reason: 'canal_deshabilitado' };
    const summary = await runSummary(ctx.prisma, p.runId);
    if (!summary) return { kind: 'cancelled', reason: 'corrida_inexistente' };
    let extra: string[] = [];
    if (channel.kind === 'correo') {
      const run = await ctx.prisma.run.findUnique({ where: { id: p.runId }, select: { scheduleId: true, createdById: true } });
      extra = await subscribedEmails(ctx.prisma, p.event ?? 'corrida_con_fallas', {
        scheduleId: run?.scheduleId ?? null,
        userIds: run?.createdById && !run.scheduleId ? [run.createdById] : [],
      });
    }
    let target;
    try {
      target = await resolveTarget(channel, extra, ctx.secrets);
    } catch {
      return { kind: 'intervention', error: 'secreto_del_canal_no_disponible' };
    }
    const r = await (deps.notifiers ?? getNotifiers)()[channel.kind].send(
      runFinishedMessage(summary, deps.config.PUBLIC_BASE_URL),
      target,
    );
    await recordDeliveryOutcome(ctx.prisma, alert.id, r);
    return toHandlerResult(r);
  };
}

/** Registra los handlers de notificación en el publicador genérico (llamar al arrancar el proceso de control). */
export function registerNotificationHandlers(deps: DispatchDeps): void {
  registerOutboxHandler('notification.alert', alertHandler(deps), { timeoutMs: 30_000 });
  registerOutboxHandler('notification.run_finished', runFinishedHandler(deps), { timeoutMs: 30_000 });
}
