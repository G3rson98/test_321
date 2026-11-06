/**
 * Instalaciones · Configuración (`/warehouses`). ESP §2: servicio warehouse/api/warehouse.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { DEFAULT_SERVICE_TIMEOUT_MS, UI_READY_TIMEOUT_MS } from '../fixtures/timeouts.ts';
import { inovuaGrid, waitForInovuaGridReady, type GridReadyResult } from './inovua.ts';
import { SERVICES, waitForService } from './services.ts';

export const WAREHOUSES_PATH = '/warehouses';

export class WarehousePage {
  readonly page: Page;
  readonly heading: Locator;
  readonly grid: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO selector (Bloque 0): confirmar encabezado de Instalaciones · Configuración.
    this.heading = page.getByRole('heading', { name: /instalaciones|configuraci[oó]n/i }).first();
    // Excepción E-01 hasta contar con data-testid de la grilla (regla 8).
    this.grid = inovuaGrid(page);
  }

  async open(): Promise<{ response: Response; grid: GridReadyResult }> {
    const responsePromise = waitForService(this.page, SERVICES.warehouse, { timeout: DEFAULT_SERVICE_TIMEOUT_MS });
    await this.page.goto(WAREHOUSES_PATH, { waitUntil: 'domcontentloaded' });
    const response = await responsePromise;
    await expect(this.heading, 'No se ve el encabezado de Instalaciones').toBeVisible({ timeout: UI_READY_TIMEOUT_MS });
    const grid = await waitForInovuaGridReady(this.grid);
    return { response, grid };
  }
}
