/**
 * Preferencias de notificación por usuario (RF-NOT-03): qué programaciones y alertas recibe y por qué canales.
 * Decisión D-API-C: las preferencias personales determinan los destinatarios de CORREO; Slack/Teams son canales
 * del equipo (un webhook compartido) y reciben según la configuración del canal y de la programación.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { KatalystError, type NotificationChannelKind, type NotificationEvent } from '@katalyst/shared';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface PreferencesInput {
  channels: NotificationChannelKind[];
  events: NotificationEvent[];
  scheduleIds: string[];
  allSchedules: boolean;
  thresholdIds: string[];
  allThresholds: boolean;
  version?: number | undefined;
}

export async function getPreferences(db: Db, userId: string) {
  const [pref, schedules, thresholds] = await Promise.all([
    db.notificationPreference.findUnique({ where: { userId } }),
    db.notificationScheduleSubscription.findMany({ where: { userId }, select: { scheduleId: true } }),
    db.notificationThresholdSubscription.findMany({ where: { userId }, select: { thresholdId: true } }),
  ]);
  return {
    userId,
    channels: pref?.channels ?? [],
    events: pref?.events ?? [],
    scheduleIds: schedules.map((s) => s.scheduleId).sort(),
    allSchedules: pref?.allSchedules ?? false,
    thresholdIds: thresholds.map((t) => t.thresholdId).sort(),
    allThresholds: pref?.allThresholds ?? false,
    updatedAt: (pref?.updatedAt ?? new Date(0)).toISOString(),
    version: pref?.version ?? 0,
  };
}

export async function updatePreferences(
  prisma: PrismaClient,
  actor: Principal,
  userId: string,
  input: PreferencesInput,
  requestId?: string,
) {
  await prisma.$transaction(async (tx) => {
    const current = await tx.notificationPreference.findUnique({ where: { userId } });
    if (input.version !== undefined && current && current.version !== input.version) {
      throw new KatalystError('VERSION_CONFLICT');
    }
    const scheduleIds = [...new Set(input.scheduleIds)];
    const thresholdIds = [...new Set(input.thresholdIds)];
    const [sCount, tCount] = await Promise.all([
      tx.schedule.count({ where: { id: { in: scheduleIds }, deletedAt: null } }),
      tx.perfThreshold.count({ where: { id: { in: thresholdIds }, deletedAt: null } }),
    ]);
    if (sCount !== scheduleIds.length || tCount !== thresholdIds.length) {
      throw new KatalystError('SELECTION_FOREIGN_IDS', 'Programaciones o umbrales inexistentes.');
    }
    const data = {
      channels: [...new Set(input.channels)],
      events: [...new Set(input.events)],
      allSchedules: input.allSchedules,
      allThresholds: input.allThresholds,
    };
    if (current) {
      const r = await tx.notificationPreference.updateMany({
        where: { userId, version: current.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (r.count !== 1) throw new KatalystError('VERSION_CONFLICT');
    } else {
      await tx.notificationPreference.create({ data: { userId, ...data } });
    }
    await tx.notificationScheduleSubscription.deleteMany({ where: { userId, scheduleId: { notIn: scheduleIds } } });
    await tx.notificationThresholdSubscription.deleteMany({ where: { userId, thresholdId: { notIn: thresholdIds } } });
    if (scheduleIds.length) {
      await tx.notificationScheduleSubscription.createMany({
        data: scheduleIds.map((scheduleId) => ({ userId, scheduleId })),
        skipDuplicates: true,
      });
    }
    if (thresholdIds.length) {
      await tx.notificationThresholdSubscription.createMany({
        data: thresholdIds.map((thresholdId) => ({ userId, thresholdId })),
        skipDuplicates: true,
      });
    }
    await recordAudit(tx, {
      actor,
      action: 'notification_preference.update',
      entity: 'notification_preference',
      entityId: userId,
      diff: { ...data, scheduleIds: scheduleIds.length, thresholdIds: thresholdIds.length },
      ...(requestId ? { requestId } : {}),
    });
  });
  return getPreferences(prisma, userId);
}

/** Correos de usuarios activos suscritos a un evento (y a la programación/umbral si se indica). */
export async function subscribedEmails(
  db: Db,
  event: NotificationEvent,
  scope: { scheduleId?: string | null; thresholdId?: string | null; userIds?: string[] },
): Promise<string[]> {
  const or: Prisma.NotificationPreferenceWhereInput[] = [];
  if (scope.scheduleId) {
    or.push({ allSchedules: true }, { user: { scheduleSubscriptions: { some: { scheduleId: scope.scheduleId } } } });
  }
  if (scope.thresholdId) {
    or.push({ allThresholds: true }, { user: { thresholdSubscriptions: { some: { thresholdId: scope.thresholdId } } } });
  }
  if (scope.userIds && scope.userIds.length) or.push({ userId: { in: scope.userIds } });
  if (or.length === 0) return [];
  const prefs = await db.notificationPreference.findMany({
    where: { channels: { has: 'correo' }, events: { has: event }, user: { disabledAt: null }, OR: or },
    select: { user: { select: { email: true } } },
    take: 500,
  });
  return [...new Set(prefs.map((p) => p.user.email.toLowerCase()))].sort();
}
