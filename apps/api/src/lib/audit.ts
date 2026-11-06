/**
 * Auditoría transaccional (RF-USR-02): quién ejecutó, programó, aprobó o cambió configuraciones.
 * Se escribe en la MISMA transacción que el cambio auditado. El `diff` se sanitiza (RNF-SEG-01): las referencias de
 * secretos (`*Ref` con formato `env:|file:|ssm:`) se conservan; cualquier otro dato sensible se enmascara.
 */
import type { Prisma } from '@prisma/client';
import { AUDIT_ACTION_REGEX, REDACTED, SECRET_REF_REGEX, isSensitiveName, sanitizeText } from '@katalyst/shared';
import type { Principal } from './auth.js';

export interface AuditEvent {
  actor: Principal | 'system';
  action: string;
  entity: string;
  entityId?: string;
  diff?: unknown;
  /** Correlación con la solicitud HTTP (opcional). */
  requestId?: string;
}

type ActorKindValue = 'panel_user' | 'api_credential' | 'servicio' | 'sistema';

export function auditActorOf(actor: Principal | 'system'): {
  actorKind: ActorKindValue;
  actorId: string | null;
  actorDisplay: string;
} {
  if (actor === 'system') return { actorKind: 'sistema', actorId: null, actorDisplay: 'sistema' };
  switch (actor.kind) {
    case 'panel_user':
      return { actorKind: 'panel_user', actorId: actor.id, actorDisplay: actor.email };
    case 'api_token':
      return { actorKind: 'api_credential', actorId: actor.id, actorDisplay: `token:${actor.id.slice(0, 8)}` };
    case 'service':
      return { actorKind: 'servicio', actorId: actor.id, actorDisplay: `servicio:${actor.id.slice(0, 8)}` };
    case 'lease':
      return { actorKind: 'servicio', actorId: actor.leaseId, actorDisplay: `lease:${actor.leaseId.slice(0, 8)}` };
    case 'device':
      return { actorKind: 'panel_user', actorId: actor.userId, actorDisplay: `dispositivo:${actor.id.slice(0, 8)}` };
  }
}

const REF_KEY_RE = /ref$/i;

/**
 * Sanitiza un diff conservando referencias de secretos válidas (no son secretos): claves sensibles → `[REDACTED]`,
 * cadenas → reglas de texto (tokens, JWT, correos…). Profundidad máxima 16.
 */
export function sanitizeAuditDiff(diff: unknown): Prisma.InputJsonValue | null {
  if (diff === undefined || diff === null) return null;
  const walk = (v: unknown, key: string | undefined, depth: number): unknown => {
    if (depth > 16) return '[TRUNCATED]';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') {
      if (key && REF_KEY_RE.test(key) && SECRET_REF_REGEX.test(v)) return v;
      return sanitizeText(v).value;
    }
    if (typeof v === 'bigint') return Number(v);
    if (v === null || typeof v !== 'object') return v ?? null;
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const isRef = REF_KEY_RE.test(k) && (typeof x !== 'string' || SECRET_REF_REGEX.test(x));
      if (!isRef && isSensitiveName(k) && x !== null && x !== undefined && x !== '') {
        out[k] = REDACTED;
        continue;
      }
      // `{from, to}` de un campo *Ref: conservar la clave de contexto.
      out[k] = walk(x, REF_KEY_RE.test(k) ? k : (k === 'from' || k === 'to') && key ? key : k, depth + 1);
    }
    return out;
  };
  return walk(diff, undefined, 0) as Prisma.InputJsonValue;
}

/** Diff mínimo `{campo: {from, to}}` entre dos objetos planos (solo claves indicadas). */
export function shallowDiff<T extends Record<string, unknown>>(
  before: T | null,
  after: T,
  keys: readonly (keyof T)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[String(k)] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

export async function recordAudit(tx: Prisma.TransactionClient, e: AuditEvent): Promise<void> {
  if (!AUDIT_ACTION_REGEX.test(e.action) || e.action.length > 64) {
    throw new TypeError(`Acción de auditoría inválida: ${e.action}`);
  }
  const actor = auditActorOf(e.actor);
  const diff = sanitizeAuditDiff(e.diff);
  await tx.auditLog.create({
    data: {
      ...actor,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId ?? null,
      ...(diff !== null ? { diff } : {}),
      requestId: e.requestId ?? null,
    },
  });
}
