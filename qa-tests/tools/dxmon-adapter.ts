/**
 * Adaptador DXMon v3 (ESP §2, §10 `tools/deltax_monitor.js` sin modificar su lógica, §13.8). RF-REN-01/05.
 *
 * - Inyecta `tools/deltax_monitor.js` tal cual con `addInitScript` y lo reinyecta (`addScriptTag`) si tras una recarga
 *   no está presente. No envuelve ni reescribe el script.
 * - Verifica el hash fijado en `tools/dxmon-legacy.lock.json` antes de inyectarlo.
 * - Llama `DXMon.start/mark/summary/stop` y normaliza las muestras crudas al contrato de importación
 *   (tools/perf-contract.ts). Endpoints repetidos (`probe`) fuera de la allowlist aprobada invalidan la muestra y
 *   hacen fallar el test con `dxmon_endpoint_no_permitido`.
 *
 * ESTADO: `tools/deltax_monitor.js` no existe todavía (ESP §2 "Dependencia por verificar"). La forma exacta de la API
 * y de las muestras crudas de DXMon está marcada como `TODO(Bloque 2B)` y debe confirmarse con el código y muestras
 * anonimizadas del legado. Ver tools/README-dxmon.md.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { KatalystError } from '../fixtures/errors.ts';
import {
  PERF_SCHEMA_VERSION,
  checkSample,
  normalizeEndpoint,
  over29s,
  sampleKey,
  validBytes,
  validMs,
  type PerfMetricKind,
  type PerfSample,
  type PerfSource,
  type QuarantinedSample,
  type SampleContext,
} from './perf-contract.ts';

export const TOOLS_DIR = import.meta.dirname;
export const DXMON_SCRIPT_PATH = path.join(TOOLS_DIR, 'deltax_monitor.js');
export const DXMON_LOCK_PATH = path.join(TOOLS_DIR, 'dxmon-legacy.lock.json');
export const DXMON_ALLOWLIST_PATH = path.join(TOOLS_DIR, 'dxmon-allowlist.json');
export const ADAPTER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------------------------------------------
// Disponibilidad, versión y allowlist
// ---------------------------------------------------------------------------------------------------------------

export interface DxmonAvailability {
  available: boolean;
  reason: string;
}

/** ¿Existe el script legado? Si no, el test se omite con motivo `dxmon_no_disponible` (skip autorizado). */
export function dxmonAvailability(): DxmonAvailability {
  if (!fs.existsSync(DXMON_SCRIPT_PATH)) {
    return {
      available: false,
      reason:
        'tools/deltax_monitor.js no está en el repositorio (ESP §2 "Dependencia por verificar"; bloqueo de Bloque 2B, ver tools/README-dxmon.md)',
    };
  }
  return { available: true, reason: 'ok' };
}

export interface DxmonScript {
  code: string;
  sha256: string;
  version: string | null;
}

interface LegacyLock {
  dxmonVersion: string | null;
  sha256: string | null;
}

/** Lee el script y exige que su SHA-256 coincida con el fijado en el lock (ESP §13.8). */
export function loadDxmonScript(): DxmonScript {
  const code = fs.readFileSync(DXMON_SCRIPT_PATH, 'utf8');
  const sha256 = createHash('sha256').update(code).digest('hex');
  const lock = JSON.parse(fs.readFileSync(DXMON_LOCK_PATH, 'utf8')) as LegacyLock;
  if (!lock.sha256) {
    throw new KatalystError(
      'dxmon_no_versionado',
      'tools/dxmon-legacy.lock.json no fija sha256: versionar el legado (hash, versión, condiciones de uso) en un PR revisado.',
    );
  }
  if (lock.sha256.toLowerCase() !== sha256) {
    throw new KatalystError('dxmon_hash_no_coincide', 'El SHA-256 de tools/deltax_monitor.js no coincide con el lock.');
  }
  return { code, sha256, version: lock.dxmonVersion };
}

export interface AllowlistEntry {
  key: string;
  method: string;
  pathRegex: string;
  allowedQueryParams: string[];
  screen: string;
  approved: boolean;
}

export interface DxmonAllowlist {
  schemaVersion: number;
  endpoints: AllowlistEntry[];
  denied: Array<{ key: string; pathRegex: string }>;
}

export function loadAllowlist(): DxmonAllowlist {
  const parsed = JSON.parse(fs.readFileSync(DXMON_ALLOWLIST_PATH, 'utf8')) as DxmonAllowlist;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.endpoints)) {
    throw new KatalystError('dxmon_api_incompatible', 'tools/dxmon-allowlist.json con formato no soportado.');
  }
  for (const entry of parsed.endpoints) new RegExp(entry.pathRegex); // valida expresiones
  return parsed;
}

/** ¿La petición está permitida para repetición por DXMon? Solo entradas aprobadas y nunca las denegadas. */
export function isAllowlisted(rawUrl: string, method: string, allowlist: DxmonAllowlist): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (allowlist.denied.some((d) => new RegExp(d.pathRegex).test(url.pathname))) return false;
  return allowlist.endpoints.some(
    (e) =>
      e.approved &&
      e.method.toUpperCase() === method.toUpperCase() &&
      new RegExp(e.pathRegex).test(url.pathname) &&
      [...url.searchParams.keys()].every((k) => e.allowedQueryParams.includes(k)),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Control de DXMon en la página
// ---------------------------------------------------------------------------------------------------------------

/** Forma mínima esperada de `window.DXMon` (ESP §2). TODO(Bloque 2B): confirmar firmas con el código legado. */
interface DxmonApi {
  start(options?: unknown): unknown;
  stop(): unknown;
  summary(): unknown;
  mark(label: string): unknown;
  samples?: () => unknown;
  isRunning?: () => boolean;
}

type DxmonWindow = Window & { DXMon?: DxmonApi };

export interface DxmonStartOptions {
  /** Endpoints aprobados para repetición (solo `approved: true`). TODO(Bloque 2B): confirmar opción en DXMon v3. */
  allowlist: Array<{ method: string; pathRegex: string; allowedQueryParams: string[] }>;
  runId: string;
}

export class DxmonAdapter {
  readonly script: DxmonScript;
  private readonly page: Page;
  private running = false;
  private startOptions: DxmonStartOptions | undefined;
  reinjections = 0;
  reloadsWithoutRestart = 0;
  restarts = 0;

  private readonly onLoad = (): void => {
    void this.afterReload().catch(() => undefined);
  };

  constructor(page: Page, script: DxmonScript) {
    this.page = page;
    this.script = script;
  }

  /** Registra el script sin modificar para cada documento nuevo del contexto y vigila recargas. */
  async install(context: BrowserContext): Promise<void> {
    await context.addInitScript({ content: this.script.code });
    this.page.on('load', this.onLoad);
  }

  uninstall(): void {
    this.page.off('load', this.onLoad);
  }

  private async isPresent(): Promise<boolean> {
    return this.page.evaluate(() => typeof (window as DxmonWindow).DXMon === 'object' || typeof (window as DxmonWindow).DXMon === 'function');
  }

  /** Reinyección si el script no está tras una recarga (p. ej. la app limpió `window`). */
  async ensurePresent(): Promise<void> {
    if (await this.isPresent()) return;
    await this.page.addScriptTag({ content: this.script.code });
    this.reinjections += 1;
    if (!(await this.isPresent())) {
      throw new KatalystError('dxmon_api_incompatible', 'DXMon no quedó disponible en window tras inyectarlo.');
    }
  }

  async assertApi(): Promise<void> {
    await this.ensurePresent();
    const missing = await this.page.evaluate(() => {
      const api = (window as DxmonWindow).DXMon as unknown as Record<string, unknown> | undefined;
      return ['start', 'stop', 'summary', 'mark'].filter((fn) => typeof api?.[fn] !== 'function');
    });
    if (missing.length > 0) {
      throw new KatalystError('dxmon_api_incompatible', `DXMon no expone: ${missing.join(', ')}.`);
    }
  }

  private async afterReload(): Promise<void> {
    await this.ensurePresent();
    if (!this.running || !this.startOptions) return;
    const state = await this.page.evaluate(() => {
      const api = (window as DxmonWindow).DXMon;
      return typeof api?.isRunning === 'function' ? api.isRunning() : null;
    });
    if (state === false) {
      // TODO(Bloque 2B): confirmar que start() es idempotente/reanudable tras recarga (estado en IndexedDB).
      await this.page.evaluate((opts) => (window as DxmonWindow).DXMon?.start(opts), this.startOptions);
      this.restarts += 1;
    } else if (state === null) {
      // API sin isRunning: no se reinicia a ciegas para no duplicar mediciones; se registra para verificación.
      this.reloadsWithoutRestart += 1;
    }
    await this.mark('katalyst:recarga');
  }

  async start(options: DxmonStartOptions): Promise<void> {
    await this.assertApi();
    this.startOptions = options;
    await this.page.evaluate(async (opts) => {
      await (window as DxmonWindow).DXMon?.start(opts);
    }, options);
    this.running = true;
  }

  async mark(label: string): Promise<void> {
    const safe = label.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80);
    await this.page.evaluate(async (l) => {
      await (window as DxmonWindow).DXMon?.mark(l);
    }, safe);
  }

  /**
   * Espera el ciclo de DXMon hasta `durationMs` o hasta que su resumen indique fin.
   * `waitForTimeout` está permitido solo en el monitor de rendimiento (ESP §10 regla 3).
   */
  async waitCycle(durationMs: number): Promise<void> {
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      await this.page.waitForTimeout(Math.min(1_000, Math.max(0, end - Date.now())));
      const done = await this.page
        .evaluate(async () => {
          const s = (await (window as DxmonWindow).DXMon?.summary()) as Record<string, unknown> | undefined;
          // TODO(Bloque 2B): confirmar la bandera de fin de ciclo del resumen de DXMon v3.
          return s?.['done'] === true || s?.['finished'] === true || s?.['cycleComplete'] === true;
        })
        .catch(() => false);
      if (done) return;
    }
  }

  /** Resumen crudo. Nunca se persiste tal cual (puede contener URLs con datos): solo se usan sus claves/conteos. */
  async summary(): Promise<unknown> {
    return this.page.evaluate(async () => (await (window as DxmonWindow).DXMon?.summary()) ?? null);
  }

  /** Muestras crudas. TODO(Bloque 2B): confirmar si DXMon v3 las expone por `samples()` o solo en IndexedDB/summary. */
  async rawSamples(): Promise<unknown[]> {
    return this.page.evaluate(async () => {
      const api = (window as DxmonWindow).DXMon;
      if (typeof api?.samples === 'function') {
        const s = await api.samples();
        if (Array.isArray(s)) return s as unknown[];
      }
      const summary = (await api?.summary()) as Record<string, unknown> | undefined;
      const fromSummary = summary?.['samples'];
      return Array.isArray(fromSummary) ? (fromSummary as unknown[]) : [];
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.page.evaluate(async () => {
      await (window as DxmonWindow).DXMon?.stop();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Normalización de muestras crudas de DXMon
// ---------------------------------------------------------------------------------------------------------------

function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function mapSource(raw: unknown): PerfSource | null {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'ui' || s === 'screen' || s === 'pantalla') return 'ui';
  if (s === 'raiz' || s === 'root' || s === 'iframe') return 'raiz';
  if (s === 'probe' || s === 'replay' || s === 'learned' || s === 'repeat') return 'probe';
  if (s === 'app' || s === 'page' || s === 'observed') return 'app';
  return null;
}

function toIso(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1e12) return new Date(raw).toISOString();
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return null;
}

export interface NormalizedDxmon {
  samples: PerfSample[];
  quarantine: QuarantinedSample[];
  notAllowlisted: number;
}

/**
 * Convierte muestras crudas de DXMon al contrato. Mapeo tolerante de nombres de campo marcado como TODO(Bloque 2B):
 * debe reemplazarse por el esquema real del `samples.json` legado. No altera la lógica de DXMon: solo traduce.
 */
export function normalizeDxmonSamples(
  raw: readonly unknown[],
  ctx: SampleContext,
  allowlist: DxmonAllowlist,
  cacheMode: PerfSample['cache_mode'],
): NormalizedDxmon {
  const samples: PerfSample[] = [];
  const quarantine: QuarantinedSample[] = [];
  let notAllowlisted = 0;

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      quarantine.push({ index, provenance: 'dxmon', reason: 'muestra_no_objeto' });
      return;
    }
    const r = item as Record<string, unknown>;
    const source = mapSource(pick(r, ['source', 'origin', 'kind', 'type']));
    if (!source) {
      quarantine.push({ index, provenance: 'dxmon', reason: 'source_desconocido' });
      return;
    }
    const ts = toIso(pick(r, ['ts', 'timestamp', 'time', 'startedAt', 'start']));
    if (!ts) {
      quarantine.push({ index, provenance: 'dxmon', reason: 'ts_invalido' });
      return;
    }
    const nullReasons: Record<string, string> = {};
    const method = String(pick(r, ['method']) ?? 'GET').toUpperCase();
    const rawUrl = pick(r, ['url', 'endpoint', 'name']);
    const ne = typeof rawUrl === 'string' ? normalizeEndpoint(rawUrl, method, ctx) : null;
    const isCurrentWait = /current/i.test(String(pick(r, ['metric', 'label']) ?? '')) && source === 'raiz';
    const metric: PerfMetricKind =
      source === 'ui' ? 'screen_ready' : source === 'raiz' ? (isCurrentWait ? 'root_current_wait' : 'root_ready') : 'network_request';

    const statusRaw = pick(r, ['status', 'statusCode', 'status_code']);
    const status = typeof statusRaw === 'number' && Number.isInteger(statusRaw) && statusRaw > 0 ? statusRaw : null;
    if (status === null) nullReasons['status_code'] = metric === 'network_request' ? 'no_reportado_por_dxmon' : 'no_aplica';

    const timeoutFlag = pick(r, ['timeout', 'timedOut']) === true;
    const durationRaw = pick(r, ['total_ms', 'totalMs', 'duration', 'ms', 'elapsed']);
    const duration = validMs(durationRaw);
    if (durationRaw !== undefined && duration === null) {
      quarantine.push({ index, provenance: 'dxmon', reason: 'duracion_invalida' });
      return;
    }
    const ttfb = validMs(pick(r, ['ttfb_ms', 'ttfb', 'ttfbMs']));
    if (ttfb === null) nullReasons['ttfb_ms'] = 'no_reportado_por_dxmon';
    const download = validMs(pick(r, ['download_ms', 'download', 'downloadMs']));
    if (download === null) nullReasons['download_ms'] = 'no_reportado_por_dxmon';

    // Sin Timing-Allow-Origin, Resource Timing reporta 0 en tamaños: un cero no prueba compresión (ESP §13.8).
    const sizeOrNull = (keys: readonly string[], field: string): number | null => {
      const v = validBytes(pick(r, keys));
      if (v === null) {
        nullReasons[field] = 'no_reportado_por_dxmon';
        return null;
      }
      if (v === 0 && status !== 204 && status !== 304) {
        nullReasons[field] = 'cero_no_confiable_sin_timing_allow_origin';
        return null;
      }
      return v;
    };
    const bytesWire = sizeOrNull(['bytes_wire', 'transferSize', 'wire', 'bytesWire'], 'bytes_wire');
    const bytesBody = sizeOrNull(['bytes_body', 'decodedBodySize', 'body', 'bytesBody'], 'bytes_body');

    let invalid: string | null = null;
    if (source === 'probe' && typeof rawUrl === 'string' && !isAllowlisted(rawUrl, method, allowlist)) {
      invalid = 'endpoint_no_permitido';
      notAllowlisted += 1;
    }
    const visibleRaw = pick(r, ['visible', 'visibility']);
    const visible = visibleRaw === true || visibleRaw === 'visible' ? true : visibleRaw === false || visibleRaw === 'hidden' ? false : null;
    if (visible === false && !invalid) invalid = 'pagina_no_visible';

    const total = timeoutFlag ? null : duration;
    if (total === null) nullReasons['total_ms'] = timeoutFlag ? 'censurada_timeout' : 'no_reportado_por_dxmon';
    const okRaw = pick(r, ['ok']);
    const ok = timeoutFlag ? false : typeof okRaw === 'boolean' ? okRaw : status !== null ? status >= 200 && status < 300 : null;
    const screenKey = pick(r, ['screen', 'pantalla', 'screenKey']);
    const limitRaw = validMs(pick(r, ['timeoutMs', 'limit', 'timeout_limit_ms']));

    const sample: PerfSample = {
      run_id: ctx.runId,
      ts,
      source,
      endpoint: ne?.endpoint ?? null,
      status_code: status,
      ok,
      total_ms: total,
      ttfb_ms: timeoutFlag ? null : ttfb,
      download_ms: timeoutFlag ? null : download,
      bytes_wire: bytesWire,
      bytes_body: bytesBody,
      timeout: timeoutFlag,
      over_29s: over29s(total, timeoutFlag),
      visible,
      environment_id: ctx.environmentId,
      sample_key: sampleKey(ctx.runId, 'dxmon', index),
      schema_version: PERF_SCHEMA_VERSION,
      endpoint_key: ne?.endpointKey ?? null,
      screen_key: typeof screenKey === 'string' ? screenKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) : null,
      metric_kind: metric,
      cache_mode: cacheMode,
      worker_profile: ctx.workerProfile,
      censored: timeoutFlag,
      invalid_reason: invalid,
      provenance: 'dxmon',
      method,
      error_kind: timeoutFlag ? 'timeout' : ok === false ? (status === null ? 'red' : 'http') : null,
      censored_at_ms: timeoutFlag ? duration : null,
      timeout_limit_ms: timeoutFlag ? limitRaw : null,
      content_encoding: null,
      null_reasons: { ...nullReasons, content_encoding: 'no_reportado_por_dxmon' },
    };
    const reason = checkSample(sample);
    if (reason) quarantine.push({ index, provenance: 'dxmon', reason });
    else samples.push(sample);
  });

  return { samples, quarantine, notAllowlisted };
}

/** Lista de la allowlist aprobada para entregar a DXMon.start. */
export function approvedForDxmon(allowlist: DxmonAllowlist): DxmonStartOptions['allowlist'] {
  return allowlist.endpoints
    .filter((e) => e.approved)
    .map((e) => ({ method: e.method, pathRegex: e.pathRegex, allowedQueryParams: e.allowedQueryParams }));
}
