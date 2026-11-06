/**
 * Suite @rendimiento: ciclo DXMon (RF-REN-01, RF-REN-05; ESP §13.8; ESP §10 `tests/rendimiento/`).
 * Clasificación: lectura. Repite únicamente GET de la allowlist aprobada (ESP §13.7).
 *
 * Fase 1 — observación Playwright (provenance `playwright`): raíz con caché fría y caliente (`root_ready`,
 *   `root_current_wait`), pantallas (`screen_ready`) y llamadas de la app (`network_request`, source `app`).
 * Fase 2 — DXMon legado (provenance `dxmon`): start → ciclo → mark → summary → stop; el observador Playwright queda
 *   pausado para no mezclar GET repetidos con llamadas de la app.
 * Salida: `samples.json` y `summary.json` normalizados (tools/perf-contract.ts), adjuntos al resultado del test.
 *
 * Skip autorizado y documentado: si falta tools/deltax_monitor.js, el test se omite con motivo `dxmon_no_disponible`
 * (ESP §2 "Dependencia por verificar"; tools/README-dxmon.md). C900005 es un ID PLACEHOLDER (README).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Request } from '@playwright/test';
import { expect, stableKey, test } from '../../fixtures/test.ts';
import { KatalystError } from '../../fixtures/errors.ts';
import { FRONTEND_CURRENT_TIMEOUT_MS, PERF_RUN_LIMIT_MS, SCHEDULING_LIST_TIMEOUT_MS, UI_READY_TIMEOUT_MS } from '../../fixtures/timeouts.ts';
import { ControlCenterPage } from '../../pages/ControlCenterPage.ts';
import { LOAD_ORDER_TABS, LoadOrderPage } from '../../pages/LoadOrderPage.ts';
import { SchedulingPage } from '../../pages/SchedulingPage.ts';
import { WarehousePage } from '../../pages/WarehousePage.ts';
import {
  ADAPTER_VERSION,
  DxmonAdapter,
  approvedForDxmon,
  dxmonAvailability,
  loadAllowlist,
  loadDxmonScript,
  normalizeDxmonSamples,
  type DxmonScript,
} from '../../tools/dxmon-adapter.ts';
import { PERF_SCHEMA_VERSION, summarize, type PerfSample, type QuarantinedSample, type SampleContext } from '../../tools/perf-contract.ts';
import { PlaywrightPerfObserver, type ObservationPhase } from '../../tools/playwright-observer.ts';

const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }).version;

function intFromEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new KatalystError('configuracion_invalida', `${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

/** Presupuesto total del ciclo (ms): debe completar en <= 4 min incluyendo la escritura de salidas (ESP §13.8). */
const CYCLE_BUDGET_MS = intFromEnv('KATALYST_PERF_CYCLE_BUDGET_MS', 200_000, 60_000, PERF_RUN_LIMIT_MS - 30_000);
/** Duración máxima de la fase DXMon (ms). */
const DXMON_CYCLE_MS = intFromEnv('KATALYST_DXMON_CYCLE_MS', 90_000, 10_000, 180_000);
/** Reserva para escribir salidas y cerrar (ms). */
const OUTPUT_RESERVE_MS = 15_000;
const MAX_LOAD_PER_CPU = Number(process.env['KATALYST_PERF_MAX_LOAD_PER_CPU'] ?? '1.5');

function workerProfile(): string {
  const explicit = process.env['KATALYST_WORKER_PROFILE'];
  if (explicit && /^[A-Za-z0-9._-]{1,80}$/.test(explicit)) return explicit;
  const gib = Math.round(os.totalmem() / 1024 ** 3);
  return `${os.platform()}-${os.arch()}-${os.cpus().length}cpu-${gib}gib-pw${PLAYWRIGHT_VERSION}`;
}

/** Contención del host: carga media de 1 min por CPU por encima del umbral invalida la muestra (ESP §13.8). */
function contention(): string | null {
  if (os.platform() === 'win32') return null;
  const perCpu = (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length);
  return perCpu > MAX_LOAD_PER_CPU ? 'contencion_worker' : null;
}

function resources(): Record<string, number> {
  return {
    cpus: os.cpus().length,
    loadavg_1m: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    free_mem_bytes: os.freemem(),
    total_mem_bytes: os.totalmem(),
  };
}

test(
  'C900005 Medir ciclo DXMon de raíz, pantallas y GET aprendidos @rendimiento',
  { annotation: [stableKey('08da2055-0aa2-4fb5-8240-0b52558d806f')] },
  async ({ page, context, katalystEnv }, testInfo) => {
    const availability = dxmonAvailability();
    // katalyst-skip-autorizado: dxmon_no_disponible (tools/README-dxmon.md)
    test.skip(!availability.available, `dxmon_no_disponible: ${availability.reason}`);
    test.setTimeout(CYCLE_BUDGET_MS + 30_000);

    const startedAt = Date.now();
    const deadline = startedAt + CYCLE_BUDGET_MS - OUTPUT_RESERVE_MS;
    const remaining = (): number => deadline - Date.now();
    const resourcesStart = resources();

    const ctx: SampleContext = {
      runId: katalystEnv.runId,
      environmentId: katalystEnv.environmentId ?? null,
      workerProfile: workerProfile(),
      apiOrigin: katalystEnv.apiUrl ? new URL(katalystEnv.apiUrl).origin : undefined,
      appOrigin: katalystEnv.appUrl ? new URL(katalystEnv.appUrl).origin : undefined,
    };
    const observer = new PlaywrightPerfObserver(page, ctx, { contention });
    const dxmonSamples: PerfSample[] = [];
    const dxmonQuarantine: QuarantinedSample[] = [];
    const skippedScreens: string[] = [];
    let script: DxmonScript | undefined;
    let adapter: DxmonAdapter | undefined;
    let notAllowlisted = 0;
    let rawSummaryKeys: string[] = [];
    let rootError: unknown;
    let failure: unknown;

    try {
      // ---------------- Fase 1: observación Playwright ----------------
      observer.attach();
      const controlCenter = new ControlCenterPage(page);

      for (const cacheMode of ['fria', 'caliente'] as const) {
        const phase: ObservationPhase = { screenKey: 'raiz', cacheMode };
        await observer.setPhase(phase);
        let navStart = 0;
        let currentRequest: Request | undefined;
        const result = await observer.measureCondition('root_ready', phase, FRONTEND_CURRENT_TIMEOUT_MS + UI_READY_TIMEOUT_MS, async () => {
          const start = await controlCenter.start('/');
          navStart = start.navigationStartedAt;
          await start.current.finished();
          currentRequest = start.current.request();
          await controlCenter.expectUsable();
        });
        if (currentRequest) observer.recordCurrentWait(currentRequest, navStart, phase, await observer.refreshVisibility());
        if (!result.ok) {
          rootError = result.error;
          break;
        }
      }

      if (!rootError) {
        const screens: Array<{ key: string; limit: number; applies?: () => Promise<boolean>; run: () => Promise<void> }> = [];
        const loadOrder = new LoadOrderPage(page);
        screens.push({ key: 'loadOrder', limit: 20_000 + UI_READY_TIMEOUT_MS, run: async () => void (await loadOrder.open()) });
        for (const tab of LOAD_ORDER_TABS) {
          screens.push({
            key: `loadOrder:${tab.typeOperation}`,
            limit: 20_000 + UI_READY_TIMEOUT_MS,
            // La pestaña activa al abrir ya quedó medida como `loadOrder`; solo se miden cambios de pestaña.
            applies: async () => !(await loadOrder.isTabSelected(tab.name)),
            run: async () => void (await loadOrder.selectTab(tab)),
          });
        }
        const warehouses = new WarehousePage(page);
        screens.push({ key: 'warehouses', limit: 30_000 + UI_READY_TIMEOUT_MS, run: async () => void (await warehouses.open()) });
        const scheduling = new SchedulingPage(page);
        screens.push({
          key: 'schedulings:lista',
          limit: SCHEDULING_LIST_TIMEOUT_MS + UI_READY_TIMEOUT_MS,
          run: async () => void (await scheduling.open()),
        });

        for (const screen of screens) {
          // Reserva tiempo para la fase DXMon: no se recortan límites de pantalla para "caber" (ESP §13.3).
          if (remaining() - DXMON_CYCLE_MS < screen.limit) {
            skippedScreens.push(screen.key);
            continue;
          }
          if (screen.applies && !(await screen.applies().catch(() => false))) continue;
          const phase: ObservationPhase = { screenKey: screen.key, cacheMode: 'caliente' };
          await observer.setPhase(phase);
          await observer.measureCondition('screen_ready', phase, screen.limit, screen.run);
        }
      }
      await observer.setPhase(null);
      await observer.flush();
      observer.detach();
      if (rootError) {
        throw new KatalystError('rendimiento_raiz_no_disponible', 'La raíz no quedó utilizable; se omite la fase DXMon.');
      }

      // ---------------- Fase 2: DXMon legado ----------------
      script = loadDxmonScript();
      const allowlist = loadAllowlist();
      adapter = new DxmonAdapter(page, script);
      await adapter.install(context);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await adapter.start({ allowlist: approvedForDxmon(allowlist), runId: katalystEnv.runId });
      await adapter.mark('katalyst:ciclo:inicio');
      await adapter.waitCycle(Math.max(0, Math.min(DXMON_CYCLE_MS, remaining())));
      await adapter.mark('katalyst:ciclo:fin');
      const summary = await adapter.summary();
      rawSummaryKeys = summary && typeof summary === 'object' ? Object.keys(summary).slice(0, 50) : [];
      const raw = await adapter.rawSamples();
      await adapter.stop();
      const normalized = normalizeDxmonSamples(raw, ctx, allowlist, 'caliente');
      dxmonSamples.push(...normalized.samples);
      dxmonQuarantine.push(...normalized.quarantine);
      notAllowlisted = normalized.notAllowlisted;
    } catch (error) {
      failure = error;
    } finally {
      adapter?.uninstall();
      observer.detach();
      const finishedAt = Date.now();
      const samples = [...observer.samples, ...dxmonSamples];
      const quarantine = [...observer.quarantine, ...dxmonQuarantine];
      const outDir = path.resolve(process.env['KATALYST_PERF_OUTPUT_DIR'] ?? testInfo.outputPath('dxmon'));
      await fs.mkdir(outDir, { recursive: true });

      const producer = {
        adapter: 'katalyst-dxmon-adapter',
        adapter_version: ADAPTER_VERSION,
        playwright_version: PLAYWRIGHT_VERSION,
        browser_version: page.context().browser()?.version() ?? null,
        dxmon: { available: availability.available, version: script?.version ?? null, sha256: script?.sha256 ?? null },
      };
      const samplesDoc = {
        schema_version: PERF_SCHEMA_VERSION,
        kind: 'katalyst.perf_samples',
        run_id: ctx.runId,
        environment_id: ctx.environmentId,
        environment_name: katalystEnv.envName,
        generated_at: new Date(finishedAt).toISOString(),
        worker_profile: ctx.workerProfile,
        producer,
        samples,
        quarantine,
      };
      const summaryDoc = {
        schema_version: PERF_SCHEMA_VERSION,
        kind: 'katalyst.perf_summary',
        run_id: ctx.runId,
        environment_id: ctx.environmentId,
        environment_name: katalystEnv.envName,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - startedAt,
        cycle_budget_ms: CYCLE_BUDGET_MS,
        cycle_limit_ms: PERF_RUN_LIMIT_MS,
        worker: { profile: ctx.workerProfile, start: resourcesStart, end: resources(), max_load_per_cpu: MAX_LOAD_PER_CPU },
        producer,
        dxmon: {
          reinjections: adapter?.reinjections ?? 0,
          restarts: adapter?.restarts ?? 0,
          reloads_without_restart: adapter?.reloadsWithoutRestart ?? 0,
          raw_summary_keys: rawSummaryKeys,
          not_allowlisted: notAllowlisted,
        },
        skipped_screens: skippedScreens,
        counts: {
          samples: samples.length,
          quarantined: quarantine.length,
          invalid: samples.filter((s) => s.invalid_reason !== null).length,
          censored: samples.filter((s) => s.censored).length,
          by_provenance: { playwright: observer.samples.length, dxmon: dxmonSamples.length },
        },
        series: summarize(samples),
        error: failure instanceof Error ? failure.message.slice(0, 300) : null,
      };
      await fs.writeFile(path.join(outDir, 'samples.json'), JSON.stringify(samplesDoc, null, 2), { mode: 0o600 });
      await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summaryDoc, null, 2), { mode: 0o600 });
      await testInfo.attach('samples.json', { path: path.join(outDir, 'samples.json'), contentType: 'application/json' });
      await testInfo.attach('summary.json', { path: path.join(outDir, 'summary.json'), contentType: 'application/json' });
      if (skippedScreens.length > 0) {
        testInfo.annotations.push({ type: 'katalyst.perf', description: `pantallas_omitidas_por_presupuesto=${skippedScreens.join(',')}` });
      }
    }

    if (failure) throw failure;
    expect(observer.quarantine, 'El adaptador produjo muestras Playwright inválidas (rendimiento_salida_invalida)').toEqual([]);
    if (notAllowlisted > 0) {
      throw new KatalystError('dxmon_endpoint_no_permitido', `${notAllowlisted} muestra(s) probe fuera de la allowlist aprobada.`);
    }
    if (Date.now() - startedAt > PERF_RUN_LIMIT_MS) {
      throw new KatalystError('rendimiento_ciclo_excedido', 'El ciclo superó 4 min (ESP §13.8).');
    }
  },
);
