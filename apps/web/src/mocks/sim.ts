/**
 * Simulador del backend en modo mock: bus de eventos SSE (seq persistido en memoria, replay por Last-Event-ID) y
 * avance de corridas activas. Solo se activa en el navegador (startSimulation), no en pruebas.
 */
import type { MockRun } from './data/seed';
import { NOW, recomputeRun, runs } from './data/seed';

interface LoggedEvent {
  seq: number;
  type: string;
  payload: string;
}
let seq = 1000;
const log: LoggedEvent[] = [];
type Listener = (e: LoggedEvent) => void;
const listeners = new Set<Listener>();

export function currentSeq(): number {
  return seq;
}

export function emit(type: string, entity: string, entityId: string, version: number, runId: string | null, data: Record<string, unknown>): void {
  seq += 1;
  const ev = {
    id: String(seq),
    seq,
    type,
    entity,
    entityId,
    version,
    occurredAt: new Date().toISOString(),
    runId,
    environmentId: null,
    data,
  };
  const logged = { seq, type, payload: JSON.stringify(ev) };
  log.push(logged);
  if (log.length > 500) log.shift();
  for (const l of listeners) l(logged);
}

const enc = new TextEncoder();
/** Respuesta `text/event-stream` con snapshot inicial, replay desde Last-Event-ID y pings. */
export function sseStream(lastEventId: string | null): ReadableStream<Uint8Array> {
  let listener: Listener | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* cerrado */
        }
      };
      const last = lastEventId ? Number(lastEventId) : null;
      const active = runs.filter((r) => isActive(r)).map((r) => r.id);
      if (last !== null && log.length > 0 && last < (log[0]?.seq ?? 0) - 1) {
        send(`event: reset\ndata: ${JSON.stringify({ reason: 'last_event_id_expirado', lastSeq: seq })}\n\n`);
      } else if (last !== null) {
        for (const e of log.filter((x) => x.seq > last)) send(`id: ${e.seq}\nevent: ${e.type}\ndata: ${e.payload}\n\n`);
      }
      send(`event: snapshot\ndata: ${JSON.stringify({ lastSeq: seq, activeRunIds: active, serverTime: new Date().toISOString() })}\n\n`);
      listener = (e) => send(`id: ${e.seq}\nevent: ${e.type}\ndata: ${e.payload}\n\n`);
      listeners.add(listener);
      ping = setInterval(() => send(`event: ping\ndata: {}\n\n`), 25_000);
    },
    cancel() {
      if (listener) listeners.delete(listener);
      if (ping) clearInterval(ping);
    },
  });
}

export function isActive(r: MockRun): boolean {
  return ['en_cola', 'preparando', 'corriendo', 'finalizando', 'cancelando'].includes(r.status);
}

function bump(run: MockRun) {
  run.version += 1;
  recomputeRun(run);
  emit('run.updated', 'run', run.id, run.version, run.id, {
    status: run.status,
    outcome: run.outcome,
    syncStatus: run.syncStatus,
    counts: run.counts,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancelRequestedAt: run.cancelRequestedAt,
  });
}

function resultEvent(run: MockRun, resultId: string) {
  const r = run.results.find((x) => x.id === resultId);
  if (!r) return;
  r.version += 1;
  r.updatedAt = new Date().toISOString();
  emit('run_result.updated', 'run_result', r.id, r.version, run.id, { status: r.status });
}

function finish(run: MockRun) {
  const anyFail = run.results.some((r) => r.status === 'fallido');
  const anyBlocked = run.caseResults.some((c) => c.status === 'bloqueado') || run.results.some((r) => r.status === 'bloqueado');
  const anyFlaky = run.results.some((r) => r.status === 'inestable');
  run.outcome = anyFail ? 'fallido' : anyBlocked ? 'bloqueado' : anyFlaky ? 'inestable' : 'pasado';
  run.status = 'terminada';
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt ?? run.createdAt);
  run.syncStatus = 'enviando';
  for (const cr of run.caseResults) {
    const rs = run.results.filter((r) => r.caseIds.includes(cr.caseId));
    cr.status = rs.length === 0 ? 'bloqueado' : rs.some((r) => r.status === 'fallido') ? 'fallido' : rs.some((r) => r.status === 'bloqueado') ? 'bloqueado' : rs.some((r) => r.status === 'inestable') ? 'inestable' : 'pasado';
    cr.durationMs = rs.reduce((a, r) => a + (r.durationMs ?? 0), 0) || null;
    cr.publishable = true;
  }
}

/** Un paso de simulación sobre las corridas activas. */
export function tick(rand: () => number = Math.random): void {
  for (const run of runs.filter(isActive)) {
    const now = new Date().toISOString();
    if (run.status === 'cancelando') {
      for (const r of run.results) if (r.status === 'pendiente' || r.status === 'corriendo') {
        r.status = 'cancelado';
        r.reason = 'cancelado_por_usuario';
        resultEvent(run, r.id);
      }
      run.status = 'cancelada';
      run.outcome = 'incompleto';
      run.finishedAt = now;
      run.syncStatus = 'pendiente';
      bump(run);
      continue;
    }
    if (run.status === 'en_cola') {
      run.status = 'preparando';
      bump(run);
      continue;
    }
    if (run.status === 'preparando') {
      run.status = 'corriendo';
      run.startedAt = now;
      bump(run);
      continue;
    }
    if (run.status === 'finalizando') {
      finish(run);
      bump(run);
      setTimeout(() => {
        run.syncStatus = 'sincronizada';
        for (const t of run.targets) t.syncStatus = 'sincronizada';
        bump(run);
        emit('sync.updated', 'run_testrail_target', run.targets[0]?.id ?? run.id, run.version, run.id, {});
      }, 3000);
      continue;
    }
    const running = run.results.find((r) => r.status === 'corriendo');
    if (running) {
      const ok = rand() < 0.8;
      running.status = ok ? 'pasado' : 'fallido';
      running.durationMs = Math.round(8000 + rand() * 20000);
      running.lastError = ok ? null : 'TimeoutError: la grilla no respondió en 20 000 ms';
      const att = run.attempts.find((a) => a.runResultId === running.id && a.status === 'corriendo');
      if (att) {
        att.status = ok ? 'pasado' : 'fallido';
        att.finishedAt = now;
        att.durationMs = running.durationMs;
        att.error = running.lastError ?? null;
        att.errorCategory = ok ? null : 'timeout_aplicacion';
      }
      resultEvent(run, running.id);
      bump(run);
      continue;
    }
    const next = run.results.find((r) => r.status === 'pendiente');
    if (next) {
      next.status = 'corriendo';
      run.attempts.push({
        id: crypto.randomUUID(),
        runResultId: next.id,
        attemptNo: 1,
        kind: 'inicial',
        status: 'corriendo',
        startedAt: now,
        finishedAt: null,
        durationMs: null,
        errorCategory: null,
        error: null,
        workerLeaseId: null,
      });
      resultEvent(run, next.id);
      bump(run);
      continue;
    }
    run.status = 'finalizando';
    bump(run);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSimulation(intervalMs = 4000): void {
  if (timer) return;
  timer = setInterval(() => tick(), intervalMs);
  void NOW;
}
export function stopSimulation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
