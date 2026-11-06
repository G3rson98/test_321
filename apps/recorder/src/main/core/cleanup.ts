/**
 * Limpieza local idempotente (ESP §7 retención, §13.6, §13.7):
 * - Al iniciar el asistente: todo storageState restante proviene de un cierre/caída anterior ⇒ se elimina.
 * - storageState vence a las 2 h (o al vencer la grabación) aunque la sesión siga abierta.
 * - Código local de codegen: máximo 24 h; carpetas sin metadatos válidos o entradas ajenas se eliminan.
 * - Sesiones activas en memoria no se eliminan completas (solo su storageState si venció).
 * Tarea periódica cada 5 min mientras el asistente está abierto.
 */
import { isRecordingId, type SessionStore } from './session-store.js';

export interface SweepResult {
  removedStorageStates: string[];
  removedSessions: string[];
  removedForeign: string[];
}

export interface SweepOptions {
  /** IDs de grabaciones abiertas en este proceso. */
  activeIds?: ReadonlySet<string>;
  /** Primera limpieza al iniciar el asistente. */
  startup?: boolean;
}

export async function sweepSessions(store: SessionStore, opts: SweepOptions = {}): Promise<SweepResult> {
  const active = new Set([...(opts.activeIds ?? [])].map((s) => s.toLowerCase()));
  const result: SweepResult = { removedStorageStates: [], removedSessions: [], removedForeign: [] };
  for (const entry of await store.listEntries()) {
    if (!entry.isDir || !isRecordingId(entry.name)) {
      await store.removeEntry(entry.name);
      result.removedForeign.push(entry.name);
      continue;
    }
    const id = entry.name.toLowerCase();
    const isActive = active.has(id);
    const meta = await store.readMeta(id);
    if (!meta) {
      if (!isActive) {
        await store.remove(id);
        result.removedSessions.push(id);
      }
      continue;
    }
    if (!isActive && store.codeExpired(meta)) {
      await store.remove(id);
      result.removedSessions.push(id);
      continue;
    }
    const abandoned = opts.startup === true && !isActive;
    if (abandoned || store.storageStateExpired(meta)) {
      if (await store.deleteStorageState(id)) result.removedStorageStates.push(id);
    }
  }
  return result;
}

export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface TimerApi {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: TimerApi = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** Programa la limpieza periódica; devuelve la función para detenerla. */
export function startPeriodicCleanup(
  run: () => Promise<unknown>,
  intervalMs = CLEANUP_INTERVAL_MS,
  timers: TimerApi = realTimers,
): () => void {
  let running = false;
  const handle = timers.setInterval(() => {
    if (running) return;
    running = true;
    run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => timers.clearInterval(handle);
}
