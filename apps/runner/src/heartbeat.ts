/**
 * Heartbeat del lease cada 15 s con `leaseId` + `generation` (fencing). RNF-CON-01, RF-EJE-03, ESP §13.3.
 * - `cancelRequested` en la respuesta ⇒ detener (cancelación durable desde la API).
 * - 409 `LEASE_STALE`/`LEASE_EXPIRED` (o token revocado) ⇒ detener de inmediato: otro worker puede tener el shard.
 * - Si no hay heartbeat exitoso durante `LEASE_TTL_MS` (75 s), el lease ya venció en el backend ⇒ detener.
 * Lo usan el supervisor (durante la preparación del checkout) y el ejecutor (durante la ejecución).
 */
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from '@katalyst/shared';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import { errorCode, isLeaseLost } from './worker-api/errors.js';
import type { HeartbeatRequest, HeartbeatResponse } from './worker-api/types.js';

export type HeartbeatStopReason = 'cancel' | 'lease_lost' | 'unreachable';

export interface HeartbeatStop {
  reason: HeartbeatStopReason;
  cancelDeadlineAt?: string | null;
  code?: string | null;
}

export interface HeartbeatLoopOptions {
  api: { heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> };
  leaseId: string;
  generation: number;
  clock: Clock;
  intervalMs?: number;
  leaseTtlMs?: number;
  progress?: () => HeartbeatRequest['progress'];
  resources?: () => HeartbeatRequest['resources'];
  onStop: (stop: HeartbeatStop) => void;
  /** Se invoca tras cada heartbeat exitoso (p. ej. medir cuota temporal). */
  onTick?: () => void | Promise<void>;
  logger?: Logger;
}

export class HeartbeatLoop {
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private lastOkAt: number;
  private stopped = false;
  beats = 0;
  failures = 0;

  constructor(private readonly opts: HeartbeatLoopOptions) {
    this.lastOkAt = opts.clock.now();
  }

  get intervalMs(): number {
    return Math.min(this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS);
  }

  start(): void {
    if (this.running) return;
    this.lastOkAt = this.opts.clock.now();
    this.running = this.loop();
  }

  /** Detiene el bucle (no notifica `onStop`). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.running;
  }

  private signalStop(stop: HeartbeatStop): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.opts.onStop(stop);
  }

  /** Un heartbeat; expuesto para pruebas y para el primer latido inmediato. */
  async beat(): Promise<void> {
    const { clock } = this.opts;
    try {
      const req: HeartbeatRequest = { leaseId: this.opts.leaseId, generation: this.opts.generation };
      const progress = this.opts.progress?.();
      if (progress) req.progress = progress;
      const resources = this.opts.resources?.();
      if (resources) req.resources = resources;
      const res = await this.opts.api.heartbeat(req);
      this.beats += 1;
      this.lastOkAt = clock.now();
      if (res.cancelRequested) {
        this.opts.logger?.warn({ cancelDeadlineAt: res.cancelDeadlineAt }, 'cancelación solicitada por la API (heartbeat)');
        this.signalStop({ reason: 'cancel', cancelDeadlineAt: res.cancelDeadlineAt });
        return;
      }
      await this.opts.onTick?.();
    } catch (e) {
      this.failures += 1;
      if (isLeaseLost(e)) {
        this.opts.logger?.error({ errorCode: errorCode(e) }, 'lease obsoleto o revocado (fencing): se detiene el trabajo');
        this.signalStop({ reason: 'lease_lost', code: errorCode(e) });
        return;
      }
      const silentFor = clock.now() - this.lastOkAt;
      this.opts.logger?.warn({ errorCode: errorCode(e), silentForMs: silentFor }, 'heartbeat fallido');
      if (silentFor >= (this.opts.leaseTtlMs ?? LEASE_TTL_MS)) {
        this.signalStop({ reason: 'unreachable', code: errorCode(e) });
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.beat();
      if (this.stopped) break;
      await this.opts.clock.sleep(this.intervalMs, this.abort.signal);
    }
  }
}
