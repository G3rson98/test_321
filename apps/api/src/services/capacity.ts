/**
 * Reserva atómica de capacidad (ESP §13.3, §13.5; RF-EJE-04, RNF-OPT-05, RNF-REN-02).
 * Una reserva por shard y alcance: `global` (navegadores reales del host; default 1), `environment`
 * (`environment.max_concurrency`) y `test_user` (1 si el usuario no admite concurrencia). Los slots libres se toman con
 * `INSERT … ON CONFLICT DO NOTHING` sobre el índice parcial `ux_capacity_reservation_slot_active`: dos admisiones
 * concurrentes nunca obtienen el mismo slot y un conflicto no aborta la transacción.
 */
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

export type CapacityScope = 'global' | 'environment' | 'test_user';

export interface ShardCapacityRequest {
  runId: string;
  shardId: string;
  environmentId: string;
  environmentMax: number;
  globalMax: number;
  testUserId: string | null;
  testUserMax: number;
  expiresAt: Date;
  now: Date;
}

export class CapacityUnavailable extends Error {
  constructor(readonly scope: CapacityScope) {
    super(`sin capacidad: ${scope}`);
    this.name = 'CapacityUnavailable';
  }
}

async function reserveSlot(
  db: Db,
  scope: CapacityScope,
  scopeKey: string,
  max: number,
  r: ShardCapacityRequest,
): Promise<string | null> {
  const existing = await db.capacityReservation.findFirst({
    where: { runShardId: r.shardId, scope, releasedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO capacity_reservation
      (id, scope, scope_key, slot, run_id, run_shard_id, environment_id, test_user_id,
       acquired_at, expires_at, created_at, updated_at)
    SELECT gen_random_uuid(), ${scope}, ${scopeKey}, s, ${r.runId}::uuid, ${r.shardId}::uuid,
           ${r.environmentId}::uuid, ${r.testUserId}::uuid, ${r.now}, ${r.expiresAt}, ${r.now}, ${r.now}
    FROM generate_series(0, ${Math.max(1, max)}::int - 1) AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM capacity_reservation c
      WHERE c.scope = ${scope} AND c.scope_key = ${scopeKey} AND c.slot = s AND c.released_at IS NULL
    )
    ORDER BY s
    LIMIT 1
    ON CONFLICT (scope, scope_key, slot) WHERE released_at IS NULL DO NOTHING
    RETURNING id::text AS id`;
  return rows[0]?.id ?? null;
}

/**
 * Reserva global + ambiente (+ usuario de prueba) para un shard dentro de la transacción del llamador.
 * Lanza `CapacityUnavailable` (el llamador revierte la transacción) si algún alcance está lleno.
 */
export async function reserveShardCapacity(db: Db, r: ShardCapacityRequest): Promise<void> {
  if (!(await reserveSlot(db, 'global', 'global', r.globalMax, r))) throw new CapacityUnavailable('global');
  if (!(await reserveSlot(db, 'environment', r.environmentId, r.environmentMax, r))) {
    throw new CapacityUnavailable('environment');
  }
  if (r.testUserId && !(await reserveSlot(db, 'test_user', r.testUserId, r.testUserMax, r))) {
    throw new CapacityUnavailable('test_user');
  }
}

export async function releaseShardCapacity(db: Db, shardId: string, now: Date): Promise<number> {
  const r = await db.capacityReservation.updateMany({
    where: { runShardId: shardId, releasedAt: null },
    data: { releasedAt: now },
  });
  return r.count;
}

export async function releaseRunCapacity(db: Db, runId: string, now: Date): Promise<number> {
  const r = await db.capacityReservation.updateMany({ where: { runId, releasedAt: null }, data: { releasedAt: now } });
  return r.count;
}

/** Extiende la vigencia de las reservas de un shard (heartbeat). */
export async function extendShardCapacity(db: Db, shardId: string, expiresAt: Date): Promise<void> {
  await db.capacityReservation.updateMany({ where: { runShardId: shardId, releasedAt: null }, data: { expiresAt } });
}

/** Libera reservas huérfanas: vencidas o de corridas terminales (watchdog). */
export async function releaseOrphanReservations(db: Db, now: Date): Promise<number> {
  const r = await db.$executeRaw`
    UPDATE capacity_reservation c SET released_at = ${now}, updated_at = ${now}
    WHERE c.released_at IS NULL AND (
      c.expires_at < ${now}
      OR EXISTS (SELECT 1 FROM run r WHERE r.id = c.run_id
                 AND r.status IN ('terminada', 'cancelada', 'interrumpida', 'omitida'))
      OR EXISTS (SELECT 1 FROM run_shard s WHERE s.id = c.run_shard_id
                 AND s.status IN ('completado', 'cancelado', 'interrumpido', 'pendiente'))
    )`;
  return r;
}

export interface CapacityUsage {
  globalInUse: number;
  byEnvironment: Record<string, number>;
}

export async function capacityUsage(db: Db): Promise<CapacityUsage> {
  const rows = await db.capacityReservation.groupBy({
    by: ['scope', 'scopeKey'],
    where: { releasedAt: null },
    _count: { _all: true },
  });
  const out: CapacityUsage = { globalInUse: 0, byEnvironment: {} };
  for (const r of rows) {
    if (r.scope === 'global') out.globalInUse = r._count._all;
    if (r.scope === 'environment') out.byEnvironment[r.scopeKey] = r._count._all;
  }
  return out;
}
