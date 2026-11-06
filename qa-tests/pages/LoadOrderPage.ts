/**
 * Órdenes de carga (`/loadOrder`) con pestañas Abastecimiento / Directa / Distribuidores. ESP §2; ESP §10.
 *
 * Servicio: travelUploader/api/travelUploader/cbc/loadingOrder y .../filter con `typeOperation`
 * = catering | direct | distribution.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import type { LoadOrderTypeOperation } from '../fixtures/perfiles.ts';
import { FRONTEND_FILTER_TIMEOUT_MS, UI_READY_TIMEOUT_MS } from '../fixtures/timeouts.ts';
import { inovuaGrid, waitForInovuaGridReady, type GridReadyResult } from './inovua.ts';
import { SERVICES, readTypeOperation, waitForService } from './services.ts';

export const LOAD_ORDER_PATH = '/loadOrder';

export interface LoadOrderTab {
  name: 'Abastecimiento' | 'Directa' | 'Distribuidores';
  typeOperation: LoadOrderTypeOperation;
}

export const LOAD_ORDER_TABS: readonly LoadOrderTab[] = [
  { name: 'Abastecimiento', typeOperation: 'catering' },
  { name: 'Directa', typeOperation: 'direct' },
  { name: 'Distribuidores', typeOperation: 'distribution' },
];

export interface TabLoadResult {
  response: Response;
  typeOperation: string | undefined;
  grid: GridReadyResult;
}

export class LoadOrderPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly grid: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO selector (Bloque 0): confirmar encabezado "Órdenes de carga" (ejemplo ESP §10).
    this.heading = page.getByRole('heading', { name: /órdenes de carga/i }).first();
    // Excepción E-01 (pages/selectores-excepciones.md) hasta contar con data-testid de la grilla (regla 8).
    this.grid = inovuaGrid(page);
  }

  /**
   * Pestaña por nombre accesible. MUI Tabs expone role="tab"; el ejemplo de ESP §10 usa role="button".
   * TODO selector (Bloque 0): confirmar el rol real y pedir data-testid de pestañas (regla 8).
   */
  tab(name: LoadOrderTab['name']): Locator {
    return this.page
      .getByRole('tab', { name, exact: true })
      .or(this.page.getByRole('button', { name, exact: true }))
      .first();
  }

  private waitForLoadingOrder(typeOperation?: string): Promise<Response> {
    return waitForService(this.page, SERVICES.loadingOrder, {
      timeout: FRONTEND_FILTER_TIMEOUT_MS,
      ...(typeOperation ? { where: (r: Response) => readTypeOperation(r.request()) === typeOperation } : {}),
    });
  }

  /** Abre la pantalla y espera la primera carga de la grilla (cualquier typeOperation). */
  async open(): Promise<TabLoadResult> {
    const responsePromise = this.waitForLoadingOrder();
    await this.page.goto(LOAD_ORDER_PATH, { waitUntil: 'domcontentloaded' });
    const response = await responsePromise;
    await expect(this.heading, 'No se ve el encabezado "Órdenes de carga"').toBeVisible({ timeout: UI_READY_TIMEOUT_MS });
    const grid = await waitForInovuaGridReady(this.grid);
    return { response, typeOperation: readTypeOperation(response.request()), grid };
  }

  async isTabSelected(name: LoadOrderTab['name']): Promise<boolean> {
    const tab = this.tab(name);
    const selected = (await tab.getAttribute('aria-selected')) ?? (await tab.getAttribute('aria-pressed'));
    return selected === 'true';
  }

  /** Cambia a la pestaña y espera la llamada con su `typeOperation` y la grilla lista. */
  async selectTab(tab: LoadOrderTab): Promise<TabLoadResult> {
    const responsePromise = this.waitForLoadingOrder(tab.typeOperation);
    await this.tab(tab.name).click();
    const response = await responsePromise;
    const grid = await waitForInovuaGridReady(this.grid);
    return { response, typeOperation: readTypeOperation(response.request()), grid };
  }
}
