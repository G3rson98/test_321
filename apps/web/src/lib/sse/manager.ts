/**
 * Canal SSE único por pestaña (ESP §17.2, RNF-OPT-04): `GET /api/v1/events/stream` con cookie de sesión y
 * `Last-Event-ID` (vía fetch + ReadableStream para poder enviar el encabezado al reanudar; sin tokens en la URL).
 * - Descarta duplicados por `seq` y versiones antiguas por entidad.
 * - Agrupa actualizaciones cada 100–250 ms y luego invalida/actualiza cachés por ID/versión.
 * - Suspende en pestaña oculta y al volver reconcilia con el `snapshot` del servidor.
 * - Reconexión con backoff; el estado alimenta el fallback de polling (ver `polling.ts`).
 * - 401 (sesión vencida) y 403 (sin permiso) NO se reintentan: el canal se detiene (401 → `onUnauthorized`, que
 *   redirige al ingreso; 403 → `onForbidden`, estado `forbidden` y las listas pasan al polling de respaldo).
 * SSE no es fuente de verdad: los contadores siempre vienen de registros persistidos (ESP §13.2).
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { createStore } from '@tanstack/react-store';
import { API_BASE, getCsrfToken } from '../api/client';
import { qk } from '../query/keys';

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'paused' | 'unavailable' | 'forbidden' | 'closed';

export interface SseState {
  status: SseStatus;
  /** Intentos fallidos consecutivos (para el backoff del fallback). */
  failures: number;
  lastEventId: string | null;
}

export const sseStore = createStore<SseState>({ status: 'idle', failures: 0, lastEventId: null });

export interface DomainEventLike {
  id?: string;
  seq: number;
  type: string;
  entity: string;
  entityId: string;
  version: number;
  runId: string | null;
  data: Record<string, unknown>;
}

export interface VisibilitySource {
  isHidden(): boolean;
  subscribe(cb: () => void): () => void;
}

const documentVisibility: VisibilitySource = {
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (cb) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
};

export interface SseManagerOptions {
  queryClient: QueryClient;
  url?: string;
  fetchImpl?: typeof fetch;
  /** Ventana de agrupación (100–250 ms). */
  batchMs?: number;
  visibility?: VisibilitySource;
  backoffMs?: (attempt: number) => number;
  onUnauthorized?: () => void;
  /** El servidor negó el canal (403): se muestra «sin permiso» y no se reintenta. */
  onForbidden?: () => void;
  /** Para pruebas: aplica cada lote. */
  onFlush?: (events: DomainEventLike[]) => void;
}

export function defaultBackoff(attempt: number): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

interface ParsedMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Parser incremental de `text/event-stream`. */
export class SseParser {
  private buffer = '';
  push(chunk: string): ParsedMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: ParsedMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let id: string | null = null;
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'id') id = value;
        else if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0 || id !== null) out.push({ id, event, data: data.join('\n') });
    }
    return out;
  }
}

export class SseManager {
  private readonly qc: QueryClient;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly batchMs: number;
  private readonly visibility: VisibilitySource;
  private readonly backoffMs: (attempt: number) => number;
  private readonly opts: SseManagerOptions;

  private controller: AbortController | null = null;
  private running = false;
  private hasConnectedBefore = false;
  private lastSeq = -1;
  private readonly versions = new Map<string, number>();
  private pending: DomainEventLike[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private attempt = 0;

  constructor(opts: SseManagerOptions) {
    this.opts = opts;
    this.qc = opts.queryClient;
    this.url = opts.url ?? `${API_BASE}/events/stream`;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.batchMs = Math.min(250, Math.max(100, opts.batchMs ?? 150));
    this.visibility = opts.visibility ?? documentVisibility;
    this.backoffMs = opts.backoffMs ?? defaultBackoff;
  }

  get lastEventId(): string | null {
    return this.lastSeq >= 0 ? String(this.lastSeq) : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeVisibility = this.visibility.subscribe(() => this.onVisibilityChange());
    if (this.visibility.isHidden()) this.setStatus('paused');
    else void this.connect();
  }

  stop(finalStatus: SseStatus = 'closed'): void {
    this.running = false;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.controller?.abort();
    this.controller = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.retryTimer = null;
    this.flushTimer = null;
    this.pending = [];
    this.setStatus(finalStatus, finalStatus === 'forbidden' ? 1 : undefined);
  }

  private setStatus(status: SseStatus, failures?: number): void {
    sseStore.setState((s) => ({
      status,
      failures: failures ?? (status === 'open' ? 0 : s.failures),
      lastEventId: this.lastEventId,
    }));
  }

  private onVisibilityChange(): void {
    if (!this.running) return;
    if (this.visibility.isHidden()) {
      // Suspender canal en pestaña oculta (ESP §17.2).
      this.controller?.abort();
      this.controller = null;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.setStatus('paused');
    } else if (!this.controller) {
      this.attempt = 0;
      void this.connect();
    }
  }

  private scheduleReconnect(unavailable = false): void {
    if (!this.running || this.visibility.isHidden()) return;
    this.attempt += 1;
    this.setStatus(unavailable ? 'unavailable' : 'reconnecting', this.attempt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.backoffMs(this.attempt));
  }

  private async connect(): Promise<void> {
    if (!this.running || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus(this.hasConnectedBefore || this.attempt > 0 ? 'reconnecting' : 'connecting', this.attempt);
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { headers, credentials: 'same-origin', signal: controller.signal });
    } catch {
      if (this.controller === controller) this.controller = null;
      if (!controller.signal.aborted) this.scheduleReconnect();
      return;
    }
    // Detenido u oculto mientras se esperaba la respuesta: no abrir el canal (evita dos lectores por pestaña).
    if (controller.signal.aborted || this.controller !== controller) {
      void res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // Ni la sesión vencida ni la falta de permiso se arreglan reintentando: se detiene el canal.
      this.controller = null;
      void res.body?.cancel().catch(() => undefined);
      if (res.status === 401) {
        this.opts.onUnauthorized?.();
        this.stop();
      } else {
        this.stop('forbidden');
        this.opts.onForbidden?.();
      }
      return;
    }
    if (!res.ok || !res.body) {
      this.controller = null;
      this.scheduleReconnect(res.status === 404 || res.status === 501);
      return;
    }
    const wasReconnect = this.hasConnectedBefore;
    this.hasConnectedBefore = true;
    this.attempt = 0;
    this.setStatus('open', 0);
    if (wasReconnect) this.reconcile();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) this.handleMessage(msg);
      }
    } catch {
      // abortado o cortado: se maneja abajo
    }
    if (this.controller === controller) this.controller = null;
    if (!controller.signal.aborted) this.scheduleReconnect();
  }

  /** Mensaje SSE crudo → control o evento de dominio. Expuesto para pruebas. */
  handleMessage(msg: ParsedMessage): void {
    if (msg.event === 'ping') return;
    let data: unknown;
    try {
      data = msg.data ? JSON.parse(msg.data) : {};
    } catch {
      return;
    }
    if (msg.event === 'snapshot') {
      const s = data as { lastSeq?: number; activeRunIds?: string[] };
      if (typeof s.lastSeq === 'number' && s.lastSeq > this.lastSeq) this.lastSeq = s.lastSeq;
      for (const id of s.activeRunIds ?? []) this.qc.invalidateQueries({ queryKey: ['runs', 'detail', id] });
      this.setStatus('open');
      return;
    }
    if (msg.event === 'reset') {
      const s = data as { lastSeq?: number };
      if (typeof s.lastSeq === 'number') this.lastSeq = s.lastSeq;
      this.versions.clear();
      this.reconcile();
      return;
    }
    const ev = data as DomainEventLike;
    if (typeof ev?.seq !== 'number' || typeof ev.entity !== 'string') return;
    this.ingest(ev);
  }

  /** Dedupe por seq y versión; encola para el lote. */
  ingest(ev: DomainEventLike): boolean {
    if (ev.seq <= this.lastSeq) return false;
    this.lastSeq = ev.seq;
    const vkey = `${ev.entity}:${ev.entityId}`;
    const known = this.versions.get(vkey);
    if (known !== undefined && ev.version <= known) return false;
    this.versions.set(vkey, ev.version);
    this.pending.push(ev);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.batchMs);
    return true;
  }

  /** Reconciliación tras reconexión/visibilidad: refetch de consultas activas operativas. */
  private reconcile(): void {
    for (const key of [['runs'], ['dashboard'], ['alerts'], ['schedules'], ['testrail']] as QueryKey[]) {
      void this.qc.invalidateQueries({ queryKey: key });
    }
  }

  flush(): void {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    const invalidate = new Map<string, QueryKey>();
    const add = (key: QueryKey) => invalidate.set(JSON.stringify(key), key);

    for (const ev of batch) {
      const runId = ev.runId ?? (ev.entity === 'run' ? ev.entityId : null);
      switch (ev.type) {
        case 'run.created':
          add(['runs', 'list']);
          add(['dashboard']);
          break;
        case 'run.updated': {
          const key = qk.runs.detail(ev.entityId);
          const prev = this.qc.getQueryData<{ version?: number }>(key);
          if (prev && (prev.version ?? -1) < ev.version) {
            this.qc.setQueryData(key, { ...prev, ...ev.data, version: ev.version });
          } else if (!prev) {
            add(['runs', 'detail', ev.entityId]);
          }
          add(['runs', 'list']);
          add(['dashboard']);
          break;
        }
        case 'run_result.updated':
        case 'attempt.updated':
        case 'case_result.updated':
          if (runId) {
            add(['runs', 'results', runId]);
            add(['runs', 'case-results', runId]);
            add(['runs', 'attempts', runId]);
            add(['runs', 'artifacts', runId]);
          }
          break;
        case 'shard.updated':
          if (runId) add(['runs', 'detail', runId]);
          break;
        case 'sync.updated':
          if (runId) add(['runs', 'detail', runId]);
          add(['runs', 'list']);
          add(['testrail']);
          break;
        case 'schedule.updated':
        case 'schedule.occurrence':
          add(['schedules']);
          add(['dashboard']);
          break;
        case 'alert.updated':
          add(['alerts']);
          add(['dashboard']);
          break;
        case 'catalog.updated':
          add(['catalog']);
          break;
        case 'testrail.sync':
          add(['testrail']);
          add(['catalog']);
          break;
        case 'recording.updated':
          add(['recordings', ev.entityId]);
          break;
        case 'export.updated':
          add(['exports', ev.entityId]);
          break;
        case 'generation.updated':
          add(['generation', ev.entityId]);
          break;
        default:
          break;
      }
    }
    for (const key of invalidate.values()) void this.qc.invalidateQueries({ queryKey: key });
    this.opts.onFlush?.(batch);
  }
}

let current: SseManager | null = null;
export function startSse(opts: SseManagerOptions): SseManager {
  current?.stop();
  current = new SseManager(opts);
  current.start();
  return current;
}
export function stopSse(): void {
  current?.stop();
  current = null;
  sseStore.setState(() => ({ status: 'idle', failures: 0, lastEventId: null }));
}
