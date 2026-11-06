/**
 * Pendientes [WEB→API-A/B/C] resueltos en la API (D-054) y RF-TR-06 en el panel, contra los handlers MSW que validan
 * cada respuesta con los schemas de @katalyst/shared: resumen de caso con etiquetas/clasificación/inestabilidad,
 * selección por `ids`, `sin_ejecutar`, `appUrl` para qa, resumen del inicio, etiqueta de selección, p95/bytes del
 * período y selección de Test Plan / corrida existente de TestRail al crear una ejecución.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalogApi, envApi, runsApi, testrailApi } from '@/lib/api/endpoints';
import { isApiError } from '@/lib/api/client';
import { runTitle } from '@/features/runs/run-cells';
import { buildRunBody } from '@/features/runs/new-run-page';
import { summarizePerf } from '@/features/perf/perf-summary';
import type { PerfResponse } from '@/lib/api/types';
import { installFetch, loginAs, renderApp, server } from './app-harness';
import type * as SseManagerModule from '@/lib/sse/manager';

vi.mock('@/lib/sse/manager', async (orig) => {
  const mod = await orig<typeof SseManagerModule>();
  return { ...mod, startSse: () => ({ stop: () => undefined }) };
});

const T = { timeout: 5000 };
const REQUESTS: { method: string; url: string; body: unknown }[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  installFetch();
  server.events.on('request:start', ({ request }) => {
    const entry: (typeof REQUESTS)[number] = { method: request.method, url: request.url, body: undefined };
    REQUESTS.push(entry);
    if (request.method === 'POST') void request.clone().json().then((b: unknown) => void (entry.body = b)).catch(() => undefined);
  });
});
beforeEach(() => {
  REQUESTS.length = 0;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe('WEB→API-A · resumen de caso, ids, sin_ejecutar y appUrl', () => {
  it('GET /testrail/cases trae tags/classification/flaky agregados (sin /tests?caseId= por fila)', async () => {
    await loginAs('qa');
    const page = await catalogApi.cases({ automated: 'true', limit: 100 });
    expect(page.items.length).toBeGreaterThan(3);
    for (const c of page.items) {
      expect(c.tags && c.tags.length).toBeGreaterThan(0);
      expect(c.classification).toMatch(/^(lectura|escritura|sin_clasificar)$/);
      expect(c.flaky).not.toBeNull();
    }
    const manual = await catalogApi.cases({ automated: 'false', limit: 5 });
    expect(manual.items[0]).toMatchObject({ tags: [], classification: null, flaky: null });
  });

  it('filtro ids (repetible) devuelve solo esos casos y se combina con los demás filtros; sin_ejecutar', async () => {
    await loginAs('qa');
    const all = await catalogApi.cases({ limit: 100 });
    const [a, b] = all.items;
    const got = await catalogApi.cases({ ids: [a!.id, b!.id], limit: 100 });
    expect(got.items.map((c) => c.id).sort()).toEqual([a!.id, b!.id].sort());
    const url = REQUESTS.map((r) => r.url).find((u) => u.includes('ids='))!;
    expect(new URL(url).searchParams.getAll('ids')).toEqual([a!.id, b!.id]);
    const never = await catalogApi.cases({ lastResult: 'sin_ejecutar', limit: 100 });
    expect(never.items.length).toBeGreaterThan(0);
    expect(never.items.every((c) => c.lastResult === null)).toBe(true);
  });

  it('el catálogo pinta etiquetas sin consultar los tests de cada fila', async () => {
    await loginAs('qa');
    renderApp('/catalogo');
    const table = await screen.findByRole('table', {}, T);
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1), T);
    await waitFor(() => expect(within(table).getAllByText('@humo').length).toBeGreaterThan(0), T);
    expect(REQUESTS.some((r) => /\/tests\?.*caseId=/.test(r.url))).toBe(false);
  });

  it('el resumen de ambientes para qa incluye appUrl y la pantalla de nueva ejecución lo muestra', async () => {
    await loginAs('qa');
    const envs = await envApi.list();
    expect(envs.items.length).toBeGreaterThan(0);
    for (const e of envs.items) expect(e.appUrl).toMatch(/^https?:\/\//);
    expect(envs.items[0]).not.toHaveProperty('apiUrl');
    renderApp('/ejecuciones/nueva');
    expect((await screen.findAllByText(/^https:\/\//, {}, T)).length).toBeGreaterThan(0);
  });
});

describe('WEB→API-B · resumen del inicio y etiqueta de selección', () => {
  it('el inicio usa GET /runs/summary (una consulta) en vez de listar corridas con tope de 100', async () => {
    await loginAs('qa');
    const s = await runsApi.summary({ todayFrom: new Date(Date.now() - 86_400_000).toISOString() });
    expect(s.successRate.currentRuns).toBeGreaterThan(0);
    expect(s.upcoming.length).toBeLessThanOrEqual(3);
    REQUESTS.length = 0;
    renderApp('/');
    await screen.findByText('Éxito 7 días', {}, T);
    await waitFor(() => expect(REQUESTS.some((r) => r.url.includes('/runs/summary'))).toBe(true), T);
    await waitFor(() => expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0), T);
    expect(REQUESTS.some((r) => /\/runs\?/.test(r.url) && (r.url.includes('status=terminada') || r.url.includes('limit=100')))).toBe(false);
    expect(screen.getByText('Ejecuciones hoy')).toBeInTheDocument();
  });

  it('el título de una corrida sin suite ni programación usa la etiqueta de selección de la API', async () => {
    await loginAs('qa');
    const runs = await runsApi.list({ limit: 100 });
    const bySelection = runs.items.find((r) => !r.suiteName && !r.scheduleName)!;
    expect(bySelection.selectionLabel).toMatch(/^(\d+ casos?|Etiquetas .+)$/);
    expect(runTitle(bySelection)).toBe(bySelection.selectionLabel);
    expect(runTitle({ suiteName: 'Master', scheduleName: null, selectionLabel: 'Suite Master' })).toBe('Master');
    expect(runTitle({ suiteName: null, scheduleName: null })).toBe('Selección de casos');
  });
});

describe('WEB→API-C · p95 del período y bytes por serie', () => {
  it('summarizePerf usa el p95/bytes del período que calcula la API (no el peor intervalo)', () => {
    const point = (p95: number) => ({
      bucketStart: '2026-11-06T12:00:00.000Z', started: 30, completed: 30, discarded: 0, httpErrors: 0, networkErrors: 0, timeouts: 0, over29s: 0,
      meanMs: 1000, maxMs: 4000, p95Ms: p95, p95Status: 'ok' as const, errorRate: 0, timeoutRate: 0, quality: 'suficiente' as const,
    });
    const key = { environmentId: '8b0a6e1e-0000-4000-8000-000000000001', endpointKey: 'GET /x', provenance: 'dxmon', source: 'app', metricKind: 'network_request', cacheMode: 'desconocida', workerProfile: null } as const;
    const resp = {
      granularity: 'hour',
      series: [
        { key, points: [point(1000), point(9000)], comparison: null, summary: { completed: 60, p95Ms: 7000, p95Status: 'ok', avgBytesWire: 20_000, avgBytesBody: 80_000 } },
        { key: { ...key, endpointKey: 'GET /y' }, points: [point(2000)], comparison: null, summary: { completed: 5, p95Ms: null, p95Status: 'muestra_insuficiente', avgBytesWire: null, avgBytesBody: null } },
        { key: { ...key, endpointKey: 'GET /z' }, points: [point(3000)], comparison: null },
      ],
      marks: [],
      lastSampleAt: null,
      gaps: [],
    } as unknown as PerfResponse;
    const rows = summarizePerf(resp);
    expect(rows[0]).toMatchObject({ p95Ms: 7000, p95Status: 'ok', avgBytesWire: 20_000, avgBytesBody: 80_000, completed: 60 });
    expect(rows[1]).toMatchObject({ p95Ms: null, p95Status: 'muestra_insuficiente', avgBytesWire: null });
    expect(rows[2]).toMatchObject({ p95Ms: null, p95Status: 'muestra_insuficiente' });
  });

  it('GET /perf entrega el resumen por serie y la pantalla muestra «En red» y «Descomprimido»', async () => {
    await loginAs('qa');
    const envs = await envApi.list();
    const env = envs.items.find((e) => !e.isProduction) ?? envs.items[0]!;
    const resp = await (await import('@/lib/api/endpoints')).perfApi.aggregates({ environmentId: env.id, from: new Date(Date.now() - 7 * 86_400_000).toISOString(), to: new Date().toISOString(), by: 'day', compare: 'none' });
    expect(resp.series[0]!.summary).toMatchObject({ p95Status: 'ok' });
    expect(resp.series[0]!.summary!.avgBytesWire).toBeGreaterThan(0);
    renderApp('/rendimiento');
    expect(await screen.findByRole('columnheader', { name: 'En red' }, T)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Descomprimido' })).toBeInTheDocument();
    expect(screen.queryByText(/peor intervalo/i)).not.toBeInTheDocument();
  });
});

describe('RF-TR-06 · plan o corrida existente de TestRail en nueva ejecución', () => {
  it('buildRunBody arma el destino: nueva, ninguno, existente (requiere corrida elegida)', () => {
    const base = { mode: 'casos' as const, suiteId: null, caseIds: ['8b0a6e1e-0000-4000-8000-000000000001'], tags: [], environmentId: '8b0a6e1e-0000-4000-8000-000000000002', retries: 0, excludeFlaky: false };
    expect(buildRunBody({ ...base, target: { mode: 'nueva', trRunId: null, closeExistingRun: false } })?.testrail).toEqual({ mode: 'nueva' });
    expect(buildRunBody({ ...base, target: { mode: 'ninguno', trRunId: null, closeExistingRun: false } })?.testrail).toEqual({ mode: 'ninguno' });
    expect(buildRunBody({ ...base, target: { mode: 'existente', trRunId: null, closeExistingRun: false } })).toBeNull();
    expect(buildRunBody({ ...base, target: { mode: 'existente', trRunId: 7101, closeExistingRun: true } })?.testrail).toEqual({ mode: 'existente', trRunId: 7101, closeExistingRun: true });
  });

  it('endpoints de lectura en vivo: plan (404 si no existe) y tests de una corrida', async () => {
    await loginAs('qa');
    const plan = await testrailApi.plan(7001);
    expect(plan.entries[0]!.runs.map((r) => r.trRunId)).toEqual([7101, 7102]);
    await expect(testrailApi.plan(99999)).rejects.toSatisfy((e) => isApiError(e) && e.status === 404);
    expect((await testrailApi.runTests(3301)).tests.length).toBeGreaterThan(0);
  });

  it('elegir un plan, una de sus corridas abiertas y cerrarla al terminar se refleja en la vista previa', async () => {
    await loginAs('qa');
    const user = userEvent.setup();
    renderApp('/ejecuciones/nueva'); // suite preseleccionada: hay cuerpo para la vista previa
    await user.click(await screen.findByRole('radio', { name: 'Plan o corrida existente' }, T));
    await user.type(await screen.findByLabelText('ID del Test Plan', {}, T), '7001');
    await user.click(screen.getByRole('button', { name: /buscar plan/i }));
    expect(await screen.findByText(/Plan de regresión · noviembre/, {}, T)).toBeInTheDocument();
    // La corrida cerrada no se puede elegir.
    expect(screen.getByRole('radio', { name: /Master · Edge/ })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Master · Chrome/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Cerrar la corrida R7101/ }, T));
    expect(screen.getByText(/ya no admitirá nuevos resultados/)).toBeInTheDocument();
    await waitFor(() => {
      const previews = REQUESTS.filter((r) => r.method === 'POST' && r.url.endsWith('/runs/preview') && (r.body as { testrail?: { mode?: string } } | undefined)?.testrail?.mode === 'existente');
      const last = previews.at(-1)?.body as { testrail: unknown } | undefined;
      expect(last?.testrail).toEqual({ mode: 'existente', trRunId: 7101, closeExistingRun: true });
    }, T);
  });

  it('por ID de corrida: verifica en TestRail, informa si no existe y permite usarla', async () => {
    await loginAs('qa');
    const user = userEvent.setup();
    renderApp('/ejecuciones/nueva?modo=casos');
    await user.click(await screen.findByRole('radio', { name: 'Plan o corrida existente' }, T));
    await user.click(screen.getByRole('radio', { name: 'Por ID de corrida' }));
    const input = await screen.findByLabelText('ID de la corrida de TestRail', {}, T);
    await user.type(input, '999');
    await user.click(screen.getByRole('button', { name: /verificar corrida/i }));
    expect(await screen.findByText('No existe esa corrida en TestRail.', {}, T)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '3301');
    await user.click(screen.getByRole('button', { name: /verificar corrida/i }));
    await user.click(await screen.findByRole('button', { name: 'Usar esta corrida' }, T));
    expect(await screen.findByRole('button', { name: 'Seleccionada' }, T)).toBeInTheDocument();
    // Cerrar la corrida sigue siendo una opción explícita, desactivada por defecto.
    expect(screen.getByRole('checkbox', { name: /Cerrar la corrida R3301/ })).not.toBeChecked();
  });
});
