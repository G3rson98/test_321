/**
 * Observación complementaria con Playwright para el ciclo de rendimiento (ESP §13.8: "El adaptador puede completar
 * métricas con observación Playwright/CDP si valida sus unidades y procedencia"). RF-REN-01/05.
 *
 * Fronteras medidas (definición completa en tools/README-dxmon.md):
 * - `network_request` (source `app`): desde `startTime` de la petición hasta `responseEnd`, o hasta el corte.
 *   Tiempos de `request.timing()` (CDP): `startTime` en epoch ms, resto en ms relativos a `startTime` o -1.
 * - `screen_ready` (source `ui`): desde la acción/navegación hasta grilla lista o estado vacío esperado.
 * - `root_ready` (source `raiz`): desde la navegación a la raíz hasta la condición de app utilizable.
 * - `root_current_wait` (source `raiz`): desde la navegación a la raíz hasta el fin de la respuesta de `current`
 *   (submétrica del arranque, no prueba de pantalla lista).
 *
 * Solo registra peticiones fetch/xhr del frame principal hacia el origen de la API: las del iframe oculto de DXMon y
 * los GET repetidos por DXMon nunca se mezclan con llamadas observadas de la app (el observador se pausa durante la
 * fase DXMon).
 */
import type { Page, Request } from '@playwright/test';
import { SERVICES, matchesService } from '../pages/services.ts';
import { FRONTEND_CURRENT_TIMEOUT_MS, FRONTEND_FILTER_TIMEOUT_MS } from '../fixtures/timeouts.ts';
import {
  PERF_SCHEMA_VERSION,
  checkSample,
  normalizeEndpoint,
  over29s,
  sampleKey,
  validBytes,
  validMs,
  type PerfCacheMode,
  type PerfMetricKind,
  type PerfSample,
  type PerfSource,
  type QuarantinedSample,
  type SampleContext,
} from './perf-contract.ts';

export interface ObservationPhase {
  screenKey: string;
  cacheMode: PerfCacheMode | null;
}

interface PendingRequest {
  startedAt: number;
  phase: ObservationPhase;
  visible: boolean | null;
}

/** Tolerancia para atribuir un aborto al corte del frontend (ms). */
const ABORT_TOLERANCE_MS = 750;
/** Tolerancia de coherencia entre duración CDP y reloj de pared del proceso de test (ms). */
const WALL_CLOCK_TOLERANCE_MS = 1_500;

/** Límite de corte del frontend conocido para una URL (ESP §2), o null si no está documentado. */
export function frontendLimitFor(url: string): number | null {
  if (matchesService(url, SERVICES.usersCurrent)) return FRONTEND_CURRENT_TIMEOUT_MS;
  try {
    if (/\/filter(?:\/|$)/.test(new URL(url).pathname)) return FRONTEND_FILTER_TIMEOUT_MS;
  } catch {
    return null;
  }
  return null;
}

type SampleDraft = Omit<PerfSample, 'run_id' | 'sample_key' | 'schema_version' | 'environment_id' | 'worker_profile' | 'provenance'>;

export class PlaywrightPerfObserver {
  readonly samples: PerfSample[] = [];
  readonly quarantine: QuarantinedSample[] = [];
  private readonly page: Page;
  private readonly ctx: SampleContext;
  private readonly contention: () => string | null;
  private readonly pending = new Map<Request, PendingRequest>();
  private readonly tasks = new Set<Promise<void>>();
  private phase: ObservationPhase | null = null;
  private visible: boolean | null = null;
  private seq = 0;
  private attached = false;

  private readonly onRequest = (request: Request): void => {
    if (!this.phase || !this.isObservable(request)) return;
    this.pending.set(request, { startedAt: Date.now(), phase: this.phase, visible: this.visible });
  };

  private readonly onFinished = (request: Request): void => {
    const pending = this.pending.get(request);
    if (!pending) return;
    this.pending.delete(request);
    this.track(this.recordFinished(request, pending));
  };

  private readonly onFailed = (request: Request): void => {
    const pending = this.pending.get(request);
    if (!pending) return;
    this.pending.delete(request);
    this.recordFailed(request, pending);
  };

  constructor(page: Page, ctx: SampleContext, opts: { contention?: () => string | null } = {}) {
    this.page = page;
    this.ctx = ctx;
    this.contention = opts.contention ?? (() => null);
  }

  attach(): void {
    if (this.attached) return;
    this.page.on('request', this.onRequest);
    this.page.on('requestfinished', this.onFinished);
    this.page.on('requestfailed', this.onFailed);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onFinished);
    this.page.off('requestfailed', this.onFailed);
    this.attached = false;
  }

  /** Define la fase actual (pantalla y modo de caché) o pausa la observación con `null`. */
  async setPhase(phase: ObservationPhase | null): Promise<void> {
    this.phase = phase;
    await this.refreshVisibility();
  }

  async refreshVisibility(): Promise<boolean | null> {
    try {
      this.visible = await this.page.evaluate(() => document.visibilityState === 'visible');
    } catch {
      this.visible = null;
    }
    return this.visible;
  }

  /** Espera el procesamiento pendiente y cierra peticiones sin respuesta como inválidas (`pendiente_al_cierre`). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    for (const [request, pending] of this.pending) {
      const ne = normalizeEndpoint(request.url(), request.method(), this.ctx);
      this.add({
        ...this.base('app', 'network_request', pending.phase, pending.visible, pending.startedAt),
        endpoint: ne?.endpoint ?? null,
        endpoint_key: ne?.endpointKey ?? null,
        method: request.method(),
        invalid_reason: 'pendiente_al_cierre',
        null_reasons: { total_ms: 'pendiente_al_cierre', status_code: 'pendiente_al_cierre' },
      });
    }
    this.pending.clear();
  }

  /**
   * Mide una frontera de condición (`screen_ready` o `root_ready`). `action` debe incluir la acción y la espera de la
   * condición lista; si falla por tiempo se registra como observación censurada con el límite usado.
   */
  async measureCondition(
    metric: Extract<PerfMetricKind, 'screen_ready' | 'root_ready'>,
    phase: ObservationPhase,
    limitMs: number,
    action: () => Promise<void>,
  ): Promise<{ ok: boolean; error?: unknown }> {
    const source: PerfSource = metric === 'root_ready' ? 'raiz' : 'ui';
    const visible = await this.refreshVisibility();
    const startedAt = Date.now();
    try {
      await action();
      const total = validMs(Date.now() - startedAt);
      this.add({
        ...this.base(source, metric, phase, visible, startedAt),
        ok: true,
        total_ms: total,
        over_29s: over29s(total, false),
        null_reasons: { ...conditionNullReasons(), ...(total === null ? { total_ms: 'unidad_invalida' } : {}) },
        ...(total === null ? { invalid_reason: 'unidad_invalida' } : {}),
      });
      return { ok: true };
    } catch (error) {
      const elapsed = validMs(Date.now() - startedAt);
      const isTimeout = error instanceof Error && /timeout|timed out/i.test(`${error.name} ${error.message}`);
      this.add({
        ...this.base(source, metric, phase, visible, startedAt),
        ok: false,
        timeout: isTimeout,
        censored: isTimeout,
        censored_at_ms: isTimeout ? elapsed : null,
        timeout_limit_ms: isTimeout ? limitMs : null,
        error_kind: isTimeout ? 'timeout' : 'condicion',
        null_reasons: { ...conditionNullReasons(), total_ms: isTimeout ? 'censurada_timeout' : 'condicion_fallida' },
      });
      return { ok: false, error };
    }
  }

  /** Registra la espera por `current` del arranque a partir de la respuesta ya completada. */
  recordCurrentWait(request: Request, navigationStartedAt: number, phase: ObservationPhase, visible: boolean | null): void {
    const timing = request.timing();
    const end = timing.responseEnd >= 0 ? timing.startTime + timing.responseEnd : null;
    const total = end === null ? null : validMs(end - navigationStartedAt);
    const ne = normalizeEndpoint(request.url(), request.method(), this.ctx);
    this.add({
      ...this.base('raiz', 'root_current_wait', phase, visible, navigationStartedAt),
      endpoint: ne?.endpoint ?? null,
      endpoint_key: ne?.endpointKey ?? null,
      method: request.method(),
      ok: true,
      total_ms: total,
      over_29s: over29s(total, false),
      null_reasons: {
        ttfb_ms: 'no_aplica',
        download_ms: 'no_aplica',
        bytes_wire: 'ver_network_request',
        bytes_body: 'ver_network_request',
        status_code: 'ver_network_request',
        ...(total === null ? { total_ms: 'timing_no_disponible' } : {}),
      },
      ...(total === null ? { invalid_reason: 'timing_no_disponible' } : {}),
    });
  }

  private isObservable(request: Request): boolean {
    if (request.method() === 'OPTIONS') return false;
    if (!['fetch', 'xhr'].includes(request.resourceType())) return false;
    if (request.frame() !== this.page.mainFrame()) return false;
    try {
      return new URL(request.url()).origin === this.ctx.apiOrigin;
    } catch {
      return false;
    }
  }

  private track(task: Promise<void>): void {
    const wrapped = task.catch(() => undefined).finally(() => this.tasks.delete(wrapped));
    this.tasks.add(wrapped);
  }

  private async recordFinished(request: Request, pending: PendingRequest): Promise<void> {
    const wallMs = Date.now() - pending.startedAt;
    const response = await request.response();
    const timing = request.timing();
    const sizes = await request.sizes().catch(() => null);
    const nullReasons: Record<string, string> = {};

    const total = timing.responseEnd >= 0 ? validMs(timing.responseEnd) : null;
    if (total === null) nullReasons['total_ms'] = 'timing_no_disponible';
    const ttfb = timing.responseStart >= 0 ? validMs(timing.responseStart) : null;
    if (ttfb === null) nullReasons['ttfb_ms'] = 'timing_no_disponible';
    const download =
      timing.responseStart >= 0 && timing.responseEnd >= timing.responseStart
        ? validMs(timing.responseEnd - timing.responseStart)
        : null;
    if (download === null) nullReasons['download_ms'] = 'timing_no_disponible';

    // bytes_wire: cabeceras + cuerpo codificado recibidos (CDP). bytes_body: longitud del cuerpo descomprimido.
    const wire = sizes ? validBytes(sizes.responseHeadersSize + sizes.responseBodySize) : null;
    if (wire === null) nullReasons['bytes_wire'] = 'tamano_no_disponible';
    let body: number | null = null;
    if (response) {
      try {
        body = validBytes((await response.body()).length);
      } catch {
        body = null;
      }
    }
    if (body === null) nullReasons['bytes_body'] = 'cuerpo_no_disponible';

    let invalid: string | null = null;
    if (total !== null && total > wallMs + WALL_CLOCK_TOLERANCE_MS) invalid = 'unidad_incoherente';
    if (total === null) invalid = 'timing_no_disponible';

    const status = response?.status() ?? null;
    const ne = normalizeEndpoint(request.url(), request.method(), this.ctx);
    const encoding = response?.headers()['content-encoding'] ?? null;
    this.add({
      ...this.base('app', 'network_request', pending.phase, pending.visible, Number.isFinite(timing.startTime) && timing.startTime > 0 ? timing.startTime : pending.startedAt),
      endpoint: ne?.endpoint ?? null,
      endpoint_key: ne?.endpointKey ?? null,
      method: request.method(),
      status_code: status,
      ok: status === null ? null : status >= 200 && status < 300,
      error_kind: status !== null && (status < 200 || status >= 300) ? 'http' : null,
      total_ms: total,
      ttfb_ms: ttfb,
      download_ms: download,
      bytes_wire: wire,
      bytes_body: body,
      over_29s: over29s(total, false),
      content_encoding: encoding ? encoding.replace(/[^a-z0-9, -]/gi, '').slice(0, 40) : null,
      ...(invalid ? { invalid_reason: invalid } : {}),
      null_reasons: nullReasons,
    });
  }

  private recordFailed(request: Request, pending: PendingRequest): void {
    const elapsed = Date.now() - pending.startedAt;
    const errorText = request.failure()?.errorText ?? '';
    const limit = frontendLimitFor(request.url());
    const ne = normalizeEndpoint(request.url(), request.method(), this.ctx);
    const common = {
      ...this.base('app', 'network_request', pending.phase, pending.visible, pending.startedAt),
      endpoint: ne?.endpoint ?? null,
      endpoint_key: ne?.endpointKey ?? null,
      method: request.method(),
    };
    if (limit !== null && elapsed >= limit - ABORT_TOLERANCE_MS) {
      // Corte del frontend: observación censurada.
      this.add({
        ...common,
        ok: false,
        timeout: true,
        censored: true,
        censored_at_ms: validMs(elapsed),
        timeout_limit_ms: limit,
        error_kind: 'timeout',
        null_reasons: { total_ms: 'censurada_timeout', status_code: 'sin_respuesta', ...sizeNullReasons('sin_respuesta') },
      });
    } else if (/ERR_ABORTED|aborted/i.test(errorText)) {
      // Cancelación por navegación u otra acción: no es error de la API ni timeout.
      this.add({
        ...common,
        invalid_reason: 'abortada',
        null_reasons: { total_ms: 'abortada', status_code: 'sin_respuesta', ...sizeNullReasons('sin_respuesta') },
      });
    } else {
      this.add({
        ...common,
        ok: false,
        error_kind: 'red',
        null_reasons: { total_ms: 'error_de_red', status_code: 'sin_respuesta', ...sizeNullReasons('sin_respuesta') },
      });
    }
  }

  private base(
    source: PerfSource,
    metric: PerfMetricKind,
    phase: ObservationPhase,
    visible: boolean | null,
    startedAtEpochMs: number,
  ): SampleDraft {
    const contention = this.contention();
    return {
      ts: new Date(startedAtEpochMs).toISOString(),
      source,
      endpoint: null,
      status_code: null,
      ok: null,
      total_ms: null,
      ttfb_ms: null,
      download_ms: null,
      bytes_wire: null,
      bytes_body: null,
      timeout: false,
      over_29s: false,
      visible,
      endpoint_key: null,
      screen_key: phase.screenKey,
      metric_kind: metric,
      cache_mode: phase.cacheMode,
      censored: false,
      invalid_reason: visible === false ? 'pagina_no_visible' : contention,
      method: null,
      error_kind: null,
      censored_at_ms: null,
      timeout_limit_ms: null,
      content_encoding: null,
      null_reasons: {},
    };
  }

  private add(draft: SampleDraft): void {
    const seq = this.seq++;
    const sample: PerfSample = {
      ...draft,
      run_id: this.ctx.runId,
      environment_id: this.ctx.environmentId,
      worker_profile: this.ctx.workerProfile,
      provenance: 'playwright',
      schema_version: PERF_SCHEMA_VERSION,
      sample_key: sampleKey(this.ctx.runId, 'playwright', seq),
    };
    const reason = checkSample(sample);
    if (reason) this.quarantine.push({ index: seq, provenance: 'playwright', reason });
    else this.samples.push(sample);
  }
}

function sizeNullReasons(reason: string): Record<string, string> {
  return { ttfb_ms: reason, download_ms: reason, bytes_wire: reason, bytes_body: reason };
}

function conditionNullReasons(): Record<string, string> {
  return {
    endpoint: 'no_aplica',
    status_code: 'no_aplica',
    ttfb_ms: 'no_aplica',
    download_ms: 'no_aplica',
    bytes_wire: 'no_aplica',
    bytes_body: 'no_aplica',
  };
}
