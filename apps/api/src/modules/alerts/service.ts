/**
 * Alertas (RF-REN-03, RF-NOT-01, RF-NOT-02; ESP §13.8). Una fila por huella (umbral/ambiente/origen/canal o
 * corrida/canal): deduplicación persistente en BD. `last_sent_at` + bloqueo de fila (`FOR UPDATE`, mutex) garantizan
 * como máximo un envío de la misma alerta en cualquier ventana móvil de 60 min, también tras reinicios.
 * Los intentos de envío viven en `outbox_delivery` (reintentos sin crear alertas nuevas).
 */
import { randomUUID } from 'node:crypto';
import type { Alert, Prisma, PrismaClient } from '@prisma/client';
import { KatalystError, type AlertKind, type NotificationChannelKind } from '@katalyst/shared';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Huella usada cuando no hay canal activo: la alerta se registra para el panel sin envío. */
export const NO_CHANNEL = 'sin_canal';

export interface LockedAlert {
  id: string;
  status: 'activa' | 'recuperada';
  last_sent_at: Date | null;
  send_count: number;
}

/**
 * Crea (si no existe) y bloquea la fila de la alerta por huella dentro de la transacción `tx`.
 * El bloqueo serializa evaluadores concurrentes (varias réplicas o reinicio solapado).
 */
export async function lockAlert(
  tx: Prisma.TransactionClient,
  a: {
    kind: AlertKind;
    fingerprint: string;
    environmentId: string | null;
    thresholdId?: string | null;
    runId?: string | null;
    channel: NotificationChannelKind | null;
    payload: unknown;
  },
): Promise<LockedAlert> {
  const now = new Date();
  await tx.$executeRaw`
    INSERT INTO alert (id, kind, environment_id, threshold_id, run_id, fingerprint, payload, status, channel,
      send_count, created_at, updated_at)
    VALUES (${randomUUID()}::uuid, ${a.kind}::alert_kind, ${a.environmentId}::uuid, ${a.thresholdId ?? null}::uuid,
      ${a.runId ?? null}::uuid, ${a.fingerprint}, ${JSON.stringify(a.payload)}::jsonb, 'activa'::alert_status,
      ${a.channel}::notification_channel_kind, 0, ${now}, ${now})
    ON CONFLICT (fingerprint) DO NOTHING`;
  const rows = await tx.$queryRaw<LockedAlert[]>`
    SELECT id::text AS id, status::text AS status, last_sent_at, send_count
    FROM alert WHERE fingerprint = ${a.fingerprint} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new Error('alerta no visible tras inserción');
  return row;
}

export function toAlertDto(a: Alert) {
  return {
    id: a.id,
    kind: a.kind,
    environmentId: a.environmentId,
    thresholdId: a.thresholdId,
    runId: a.runId,
    fingerprint: a.fingerprint,
    status: a.status,
    channel: a.channel,
    payload: (a.payload ?? {}) as Record<string, unknown>,
    lastSentAt: a.lastSentAt ? a.lastSentAt.toISOString() : null,
    recoveredAt: a.recoveredAt ? a.recoveredAt.toISOString() : null,
    sendCount: a.sendCount,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function listAlerts(
  db: Db,
  q: {
    environmentId?: string | undefined;
    kind?: AlertKind | undefined;
    status?: 'activa' | 'recuperada' | undefined;
    thresholdId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
) {
  const sort = parseSort('-updatedAt', { updatedAt: 'date' });
  const after = decodePageCursor(q.cursor, sort);
  const rows = await db.alert.findMany({
    where: {
      AND: [
        q.environmentId ? { environmentId: q.environmentId } : {},
        q.kind ? { kind: q.kind } : {},
        q.status ? { status: q.status } : {},
        q.thresholdId ? { thresholdId: q.thresholdId } : {},
        q.from ? { updatedAt: { gte: new Date(q.from) } } : {},
        q.to ? { updatedAt: { lt: new Date(q.to) } } : {},
        keysetWhere(sort, after),
      ],
    },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
  });
  const page = paginate(rows, q.limit, sort);
  return { ...page, items: page.items.map(toAlertDto) };
}

export async function getAlert(db: Db, id: string) {
  const a = await db.alert.findUnique({ where: { id } });
  if (!a) throw new KatalystError('NOT_FOUND');
  return toAlertDto(a);
}
