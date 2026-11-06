/**
 * Correlación corrida/shard/lease/contenedor y cancelación (ESP §13.3: "El supervisor conserva correlación
 * corrida/shard/contenedor y permite consultar/cancelar su árbol de procesos"). Una cancelación aborta la
 * preparación (checkout, instalación) o detiene el ejecutor (SIGTERM → gracia → SIGKILL) en < 30 s.
 * Dos cancelaciones tienen el mismo efecto (idempotente). RF-EJE-03.
 */
import type { ExecutorHandle } from './launcher/types.js';

export type ShardPhase = 'preparando' | 'ejecutando' | 'finalizando';

/** Margen reservado tras la gracia para SIGKILL + `complete cancelado` antes del `deadlineAt` de la API. */
export const CANCEL_DEADLINE_MARGIN_MS = 4_000;
const MIN_GRACE_MS = 500;

export class ShardEntry {
  readonly controller = new AbortController();
  handle: ExecutorHandle | null = null;
  phase: ShardPhase = 'preparando';
  cancelRequestedAt: number | null = null;
  /** Gracia efectiva de la cancelación (acotada por `deadlineAt` del mensaje de control o del heartbeat). */
  cancelGraceMs: number;
  leaseLost = false;
  stopPromise: Promise<void> | null = null;

  constructor(
    readonly runId: string,
    readonly shardId: string,
    readonly leaseId: string,
    private readonly graceMs: number,
  ) {
    this.cancelGraceMs = graceMs;
  }

  get cancelled(): boolean {
    return this.cancelRequestedAt !== null;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  attach(handle: ExecutorHandle): void {
    this.handle = handle;
    this.phase = 'ejecutando';
    if (this.cancelled) this.stopPromise = handle.stop('cancel', this.cancelGraceMs);
  }

  /**
   * Cancelación: SIGTERM → gracia → SIGKILL. Con `deadlineAtMs` (contrato D-049: detener antes de `deadlineAt`) la
   * gracia se acorta para que el árbol esté detenido y el `complete cancelado` enviado antes del límite.
   */
  requestCancel(now: number, deadlineAtMs?: number | null): void {
    if (this.cancelRequestedAt !== null) return;
    this.cancelRequestedAt = now;
    if (deadlineAtMs != null && Number.isFinite(deadlineAtMs)) {
      this.cancelGraceMs = Math.max(MIN_GRACE_MS, Math.min(this.graceMs, deadlineAtMs - now - CANCEL_DEADLINE_MARGIN_MS));
    }
    this.controller.abort();
    if (this.handle) this.stopPromise = this.handle.stop('cancel', this.cancelGraceMs);
  }

  markLeaseLost(): void {
    this.leaseLost = true;
    this.controller.abort();
  }

  /** Lease revocado por la API: detener de inmediato sin más callbacks (no se puede confirmar al backend). */
  revoke(): void {
    if (this.leaseLost && this.stopPromise) return;
    this.markLeaseLost();
    if (this.handle) this.stopPromise = this.handle.stop('revoke', this.graceMs);
  }

  /** Apagado del supervisor: se abandona la preparación (el lease vence y el backend recupera). */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.controller.abort();
    if (this.handle) this.stopPromise = this.handle.stop('shutdown', this.graceMs);
    return this.stopPromise ?? Promise.resolve();
  }

  shuttingDown = false;
}

export class CancelRegistry {
  private readonly entries = new Set<ShardEntry>();
  /** Corridas canceladas recientemente: un claim tardío de la misma corrida se detiene de inmediato. */
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly graceMs: number,
    private readonly now: () => number = Date.now,
    private readonly rememberMs = 30 * 60_000,
  ) {}

  register(runId: string, shardId: string, leaseId: string): ShardEntry {
    const e = new ShardEntry(runId, shardId, leaseId, this.graceMs);
    this.entries.add(e);
    if (this.isCancelled(runId)) e.requestCancel(this.now());
    return e;
  }

  unregister(e: ShardEntry): void {
    this.entries.delete(e);
  }

  isCancelled(runId: string): boolean {
    const at = this.recent.get(runId);
    if (at === undefined) return false;
    if (this.now() - at > this.rememberMs) {
      this.recent.delete(runId);
      return false;
    }
    return true;
  }

  private matching(runId: string, shardIds: readonly string[] = [], leaseIds: readonly string[] = []): ShardEntry[] {
    const all = shardIds.length === 0 && leaseIds.length === 0;
    return [...this.entries].filter(
      (e) => e.runId === runId && (all || shardIds.includes(e.shardId) || (e.leaseId !== '' && leaseIds.includes(e.leaseId))),
    );
  }

  /**
   * Cancela los shards locales de la corrida (todos, o los indicados). Devuelve cuántos se afectaron. Una
   * cancelación de corrida completa se recuerda para claims tardíos.
   */
  cancelRun(runId: string, shardIds: readonly string[] = [], deadlineAtMs?: number | null): number {
    if (shardIds.length === 0) this.recent.set(runId, this.now());
    const list = this.matching(runId, shardIds);
    for (const e of list) e.requestCancel(this.now(), deadlineAtMs);
    return list.length;
  }

  /** Revocación de lease (mensaje `revoke`): detener sin callbacks. */
  revoke(runId: string, shardIds: readonly string[] = [], leaseIds: readonly string[] = []): number {
    const list = this.matching(runId, shardIds, leaseIds);
    for (const e of list) e.revoke();
    return list.length;
  }

  /** Espera a que terminen las detenciones en curso de una corrida (pruebas/operación). */
  async settled(runId: string): Promise<void> {
    await Promise.all([...this.entries].filter((e) => e.runId === runId).map((e) => e.stopPromise));
  }

  /** Detiene todos los ejecutores locales con motivo `shutdown` (launcher `process`). */
  async shutdownAll(): Promise<void> {
    await Promise.all([...this.entries].map((e) => e.shutdown()));
  }

  list(): Array<{ runId: string; shardId: string; leaseId: string; executorId: string | null; phase: ShardPhase; cancelled: boolean }> {
    return [...this.entries].map((e) => ({
      runId: e.runId,
      shardId: e.shardId,
      leaseId: e.leaseId,
      executorId: e.handle?.id ?? null,
      phase: e.phase,
      cancelled: e.cancelled,
    }));
  }

  get size(): number {
    return this.entries.size;
  }
}
