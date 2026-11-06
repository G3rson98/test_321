/**
 * Traduce eventos del reporter a callbacks de la API (RF-EJE-05, RF-EJE-08, RF-RES-01, ESP §13.3):
 * - inicio de intento persistido (`POST /worker/attempts`) en cuanto Playwright inicia el intento y ANTES de
 *   liberar la compuerta del test (`KATALYST_ATTEMPT_GATE_DIR`), con `attemptNo = nextAttemptNo + retry`;
 * - resultado por intento (`POST /worker/results`), idempotente por `(runResultId, attemptNo)`, con error
 *   sanitizado y `error_category` derivada del prefijo `[codigo]`; `final` cuando Playwright no reintentará;
 * - tests bloqueados (política/producción, variante faltante, login fallido) como intento `omitido` final;
 * - tests en curso al detener (cancelación, timeout de corrida) con estado coherente con la causa.
 * Con 409 LEASE_STALE se deja de llamar a la API (fencing) y se pide detener el ejecutor.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeErrorMessage, type AssignedTest, type ErrorCategory, type ResultReason } from '@katalyst/shared';
import type { Logger } from '../logger.js';
import { testKey, type ReporterMessage } from '../reporter/protocol.js';
import { isCallbackConflict, isLeaseLost } from '../worker-api/errors.js';
import type { ResultRequest, WorkerApiClient } from '../worker-api/types.js';
import type { UploadCandidate } from './artifacts/uploader.js';
import { kindForAttachment } from './artifacts/uploader.js';
import { attemptOutcome, finalStatusOf, stripAnsi, type RecordedAttempt, type StopCause } from './classify.js';

type TestEndMsg = Extract<ReporterMessage, { type: 'testEnd' }>;
type TestBeginMsg = Extract<ReporterMessage, { type: 'testBegin' }>;
type PlanMsg = Extract<ReporterMessage, { type: 'plan' }>;

interface InFlight {
  test: AssignedTest;
  attemptNo: number;
  kind: RecordedAttempt['kind'];
  startedAt: string;
  started: Promise<boolean>;
}

export interface ResultTrackerOptions {
  api: Pick<WorkerApiClient, 'startAttempt' | 'postResult'>;
  leaseId: string;
  generation: number;
  tests: readonly AssignedTest[];
  logger: Logger;
  knownSecrets: () => readonly string[];
  now: () => Date;
  gateDir: string | null;
  /** Se pide detener el ejecutor (cancelación vía `proceed=false` o lease perdido). */
  requestStop: (cause: Exclude<StopCause, null>) => void;
  /** Adjuntos de cada intento terminado (para sanitizar/subir). */
  onAttachments?: (items: UploadCandidate[]) => void;
}

export class ResultTracker {
  private readonly byKey = new Map<string, AssignedTest>();
  private readonly inflight = new Map<string, InFlight>();
  private readonly attempts = new Map<string, RecordedAttempt[]>();
  private readonly finals = new Set<string>();
  private leaseLost = false;
  stopCause: StopCause = null;
  setupFailed: { message: string } | null = null;
  setupRunningSince: number | null = null;
  readonly missing = new Set<string>();
  readonly found = new Set<string>();
  missingChromiumFlags: string[] = [];
  deliveryErrors = 0;

  constructor(private readonly o: ResultTrackerOptions) {
    for (const t of o.tests) this.byKey.set(testKey(t.stableKey, t.parameterKey), t);
  }

  get completed(): number {
    return this.finals.size;
  }

  get total(): number {
    return this.o.tests.length;
  }

  isFinal(test: AssignedTest): boolean {
    return this.finals.has(test.runResultId);
  }

  /** Tests asignados sin resultado final todavía. */
  pending(): AssignedTest[] {
    return this.o.tests.filter((t) => !this.finals.has(t.runResultId));
  }

  startedTests(): Set<string> {
    return new Set([...this.attempts.keys(), ...[...this.inflight.values()].map((f) => f.test.runResultId)]);
  }

  markLeaseLost(): void {
    this.leaseLost = true;
  }

  async handle(msg: ReporterMessage): Promise<void> {
    switch (msg.type) {
      case 'plan':
        return this.onPlan(msg);
      case 'testBegin':
        return this.onBegin(msg);
      case 'testEnd':
        return this.onEnd(msg);
      default:
        return;
    }
  }

  private onPlan(msg: PlanMsg): void {
    for (const f of msg.found) this.found.add(f.key);
    for (const k of msg.missing) this.missing.add(k);
    for (const k of msg.duplicates) this.missing.add(k);
    this.missingChromiumFlags = msg.missingChromiumFlags;
    if (msg.unmapped.length) this.o.logger.warn({ count: msg.unmapped.length }, 'tests sin anotación katalyst.stableKey: excluidos');
    if (msg.duplicates.length) this.o.logger.error({ count: msg.duplicates.length }, 'claves estables duplicadas: excluidas');
  }

  private fencing() {
    return { leaseId: this.o.leaseId, generation: this.o.generation };
  }

  private async writeGate(testId: string, retry: number, body: { proceed: boolean; attemptNo?: number }): Promise<void> {
    if (!this.o.gateDir) return;
    await fs.mkdir(this.o.gateDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.o.gateDir, `${testId.replace(/[^A-Za-z0-9_-]/g, '_')}-${retry}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(body), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }

  private async onBegin(msg: TestBeginMsg): Promise<void> {
    if (msg.isSetup) {
      this.setupRunningSince = Date.parse(msg.startTime) || this.o.now().getTime();
      return;
    }
    const test = msg.key ? this.byKey.get(msg.key) : undefined;
    if (!test) {
      await this.writeGate(msg.testId, msg.retry, { proceed: false });
      return;
    }
    const attemptNo = test.nextAttemptNo + msg.retry;
    const kind: RecordedAttempt['kind'] = msg.retry === 0 ? test.nextAttemptKind : 'retry';
    const startedAt = new Date(Date.parse(msg.startTime) || this.o.now().getTime()).toISOString();
    const started = (async (): Promise<boolean> => {
      if (this.leaseLost || this.stopCause) {
        await this.writeGate(msg.testId, msg.retry, { proceed: false });
        return false;
      }
      try {
        const res = await this.o.api.startAttempt({ ...this.fencing(), runResultId: test.runResultId, attemptNo, kind, startedAt });
        await this.writeGate(msg.testId, msg.retry, { proceed: res.proceed, attemptNo });
        if (!res.proceed) this.o.requestStop('cancel');
        return true;
      } catch (e) {
        await this.writeGate(msg.testId, msg.retry, { proceed: false });
        if (isLeaseLost(e)) {
          this.leaseLost = true;
          this.o.requestStop('lease_lost');
          return false;
        }
        this.deliveryErrors += 1;
        this.o.logger.error({ runResultId: test.runResultId, attemptNo }, 'no se pudo persistir el inicio del intento');
        return false;
      }
    })();
    this.inflight.set(msg.testId, { test, attemptNo, kind, startedAt, started });
    await started;
  }

  private errorText(msg: TestEndMsg): string | null {
    if (msg.status === 'skipped') {
      const skip = msg.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
      return skip?.description ? sanitizeErrorMessage(skip.description, 8192, { knownSecrets: this.o.knownSecrets() }) : null;
    }
    const first = msg.errors.find((e) => e.message || e.value);
    if (!first) return null;
    return sanitizeErrorMessage(stripAnsi(first.message ?? first.value ?? ''), 8192, { knownSecrets: this.o.knownSecrets() });
  }

  private async onEnd(msg: TestEndMsg): Promise<void> {
    if (msg.isSetup) {
      this.setupRunningSince = null;
      if (msg.status === 'failed' || msg.status === 'timedOut' || (msg.status === 'interrupted' && !this.stopCause)) {
        const first = msg.errors.find((e) => e.message || e.value);
        this.setupFailed = {
          message: sanitizeErrorMessage(stripAnsi(first?.message ?? first?.value ?? 'Falla de autenticación'), 8192, {
            knownSecrets: this.o.knownSecrets(),
          }),
        };
      }
      return;
    }
    const flight = this.inflight.get(msg.testId);
    if (!flight) return;
    this.inflight.delete(msg.testId);
    const persisted = await flight.started;
    // Apagado del supervisor: el intento interrumpido no se publica (lo recupera el backend al vencer el lease).
    if (this.stopCause === 'shutdown' && msg.status === 'interrupted') return;
    const outcome = attemptOutcome(msg.status, msg.expectedStatus, msg.errors, this.stopCause);
    const record: RecordedAttempt = {
      attemptNo: flight.attemptNo,
      kind: flight.kind,
      status: outcome.attemptStatus,
      errorCategory: outcome.errorCategory,
      durationMs: msg.duration,
      reason: outcome.reason,
    };
    const list = this.attempts.get(flight.test.runResultId) ?? [];
    list.push(record);
    this.attempts.set(flight.test.runResultId, list);
    const final = !msg.willRetry || this.stopCause !== null;
    const finishedAt = new Date(Date.parse(msg.startTime) + msg.duration || this.o.now().getTime()).toISOString();
    if (persisted) {
      await this.postResult(flight.test, record, finishedAt, this.errorText(msg), final, list);
    }
    if (this.o.onAttachments && persisted) {
      const items: UploadCandidate[] = [];
      for (const a of msg.attachments) {
        const kind = kindForAttachment(a);
        if (!kind || !a.path) continue;
        // La API admite `text/plain`/`application/json` para logs (p. ej. error-context.md de Playwright).
        const contentType = kind === 'log' && a.contentType.toLowerCase().startsWith('text/') ? 'text/plain' : a.contentType;
        items.push({
          file: a.path,
          kind,
          contentType,
          runResultId: flight.test.runResultId,
          attemptNo: flight.attemptNo,
          failed: outcome.attemptStatus !== 'pasado',
        });
      }
      if (items.length) this.o.onAttachments(items);
    }
  }

  private async postResult(
    test: AssignedTest,
    a: RecordedAttempt,
    finishedAt: string,
    error: string | null,
    final: boolean,
    all: readonly RecordedAttempt[],
  ): Promise<void> {
    if (this.leaseLost) return;
    const req: ResultRequest = {
      ...this.fencing(),
      runResultId: test.runResultId,
      attemptNo: a.attemptNo,
      attemptStatus: a.status,
      finishedAt,
      durationMs: Math.max(0, Math.round(a.durationMs)),
      errorCategory: a.errorCategory,
      error,
      final,
    };
    if (final) {
      const f = finalStatusOf(all);
      req.finalStatus = f.status;
      req.reason = f.reason;
    } else {
      req.reason = a.reason;
    }
    try {
      await this.o.api.postResult(req);
      if (final) this.finals.add(test.runResultId);
    } catch (e) {
      if (isLeaseLost(e)) {
        this.leaseLost = true;
        this.o.requestStop('lease_lost');
        return;
      }
      if (isCallbackConflict(e)) {
        this.o.logger.error({ runResultId: test.runResultId, attemptNo: a.attemptNo }, 'conflicto de callback: el resultado ya existía con otro contenido');
        if (final) this.finals.add(test.runResultId);
        return;
      }
      this.deliveryErrors += 1;
      this.o.logger.error({ runResultId: test.runResultId, attemptNo: a.attemptNo }, 'no se pudo entregar el resultado');
    }
  }

  /** Test que nunca llegó a ejecutarse: intento `omitido` final con causa (bloqueo). */
  async block(
    test: AssignedTest,
    reason: ResultReason,
    message: string,
    errorCategory: ErrorCategory | null = 'politica',
    finalStatus: 'bloqueado' | 'omitido' = 'bloqueado',
  ): Promise<void> {
    if (this.leaseLost || this.finals.has(test.runResultId)) return;
    const prior = this.attempts.get(test.runResultId) ?? [];
    const attemptNo = test.nextAttemptNo + prior.length;
    const kind: RecordedAttempt['kind'] = prior.length === 0 ? test.nextAttemptKind : 'retry';
    const now = this.o.now().toISOString();
    try {
      const res = await this.o.api.startAttempt({ ...this.fencing(), runResultId: test.runResultId, attemptNo, kind, startedAt: now });
      void res;
      await this.o.api.postResult({
        ...this.fencing(),
        runResultId: test.runResultId,
        attemptNo,
        attemptStatus: 'omitido',
        finishedAt: now,
        durationMs: 0,
        errorCategory,
        error: sanitizeErrorMessage(message, 8192, { knownSecrets: this.o.knownSecrets() }),
        final: true,
        finalStatus,
        reason,
      });
      this.finals.add(test.runResultId);
    } catch (e) {
      if (isLeaseLost(e)) {
        this.leaseLost = true;
        this.o.requestStop('lease_lost');
        return;
      }
      if (isCallbackConflict(e)) {
        this.finals.add(test.runResultId);
        return;
      }
      this.deliveryErrors += 1;
      this.o.logger.error({ runResultId: test.runResultId }, 'no se pudo registrar el bloqueo del test');
    }
  }

  /**
   * Tests en curso cuando se detuvo Playwright sin `onTestEnd` (SIGKILL): resultado según la causa. Con lease
   * perdido no se llama a la API (el backend aplica recuperación/resultado desconocido, ESP §13.3).
   */
  async finalizeInFlight(cause: Exclude<StopCause, null>): Promise<void> {
    const flights = [...this.inflight.entries()];
    this.inflight.clear();
    // Lease perdido o apagado: el backend recupera (lectura) o marca resultado desconocido (escritura).
    if (cause === 'lease_lost' || cause === 'shutdown' || this.leaseLost) return;
    for (const [, f] of flights) {
      const persisted = await f.started;
      if (!persisted) continue;
      const outcome = attemptOutcome('interrupted', 'passed', [], cause);
      const duration = Math.max(0, this.o.now().getTime() - Date.parse(f.startedAt));
      const record: RecordedAttempt = {
        attemptNo: f.attemptNo,
        kind: f.kind,
        status: outcome.attemptStatus,
        errorCategory: outcome.errorCategory,
        durationMs: duration,
        reason: outcome.reason,
      };
      const list = this.attempts.get(f.test.runResultId) ?? [];
      list.push(record);
      this.attempts.set(f.test.runResultId, list);
      const text =
        cause === 'cancel'
          ? 'Ejecución cancelada durante el test.'
          : cause === 'run_timeout'
            ? 'Timeout de la corrida agotado durante el test.'
            : 'Ejecución detenida durante el test.';
      await this.postResult(f.test, record, this.o.now().toISOString(), text, true, list);
    }
  }
}
