/**
 * Instalaciones · Agendamientos (`/schedulings`), vistas lista y calendario. ESP §2.
 *
 * Servicios: warehouse/api/warehouse/list/scheduling, .../list/filter/scheduling, .../scheduling/status.
 * Hallazgo ESP §2: la lista crece durante el día (hasta 586 KB) y llegó a no cargar en 60 s.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { DEFAULT_SERVICE_TIMEOUT_MS, SCHEDULING_LIST_TIMEOUT_MS, UI_READY_TIMEOUT_MS } from '../fixtures/timeouts.ts';
import { inovuaGrid, waitForInovuaGridReady, type GridReadyResult } from './inovua.ts';
import { SERVICES, waitForService } from './services.ts';

export const SCHEDULINGS_PATH = '/schedulings';

export interface SchedulingOpenResult {
  list: Response;
  status: Response;
  grid: GridReadyResult;
}

export class SchedulingPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly grid: Locator;
  readonly listViewButton: Locator;
  readonly calendarViewButton: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO selector (Bloque 0): confirmar encabezado "Agendamientos".
    this.heading = page.getByRole('heading', { name: /agendamientos?/i }).first();
    // Excepción E-01 hasta contar con data-testid de la grilla (regla 8).
    this.grid = inovuaGrid(page);
    // TODO selector (Bloque 0): botones de vista lista/calendario (MUI ToggleButton con aria-pressed o Tabs);
    // pedir data-testid al frontend (regla 8).
    this.listViewButton = page
      .getByRole('button', { name: /^lista$/i })
      .or(page.getByRole('tab', { name: /^lista$/i }))
      .first();
    this.calendarViewButton = page
      .getByRole('button', { name: /^calendario$/i })
      .or(page.getByRole('tab', { name: /^calendario$/i }))
      .first();
  }

  /** Abre la vista lista: espera lista (o filtro) y catálogo de estados, luego la grilla lista. */
  async open(): Promise<SchedulingOpenResult> {
    const listPromise = waitForService(this.page, SERVICES.schedulingList, { timeout: SCHEDULING_LIST_TIMEOUT_MS });
    const statusPromise = waitForService(this.page, SERVICES.schedulingStatus, { timeout: DEFAULT_SERVICE_TIMEOUT_MS });
    await this.page.goto(SCHEDULINGS_PATH, { waitUntil: 'domcontentloaded' });
    const [list, status] = await Promise.all([listPromise, statusPromise]);
    await expect(this.heading, 'No se ve el encabezado "Agendamientos"').toBeVisible({ timeout: UI_READY_TIMEOUT_MS });
    const grid = await waitForInovuaGridReady(this.grid, { timeout: UI_READY_TIMEOUT_MS });
    return { list, status, grid };
  }

  /** ¿El control de vista está activo? Acepta aria-pressed (ToggleButton) o aria-selected (Tabs). */
  async expectViewActive(button: Locator, label: string): Promise<void> {
    await expect
      .poll(
        async () =>
          (await button.getAttribute('aria-pressed')) === 'true' || (await button.getAttribute('aria-selected')) === 'true',
        { message: `La vista ${label} no quedó activa`, timeout: UI_READY_TIMEOUT_MS },
      )
      .toBe(true);
  }

  async switchToCalendar(): Promise<void> {
    await this.calendarViewButton.click();
    await this.expectViewActive(this.calendarViewButton, 'calendario');
    // En calendario la grilla de lista deja de mostrarse. TODO selector (Bloque 0): verificación positiva del
    // calendario (data-testid solicitado, regla 8).
    await expect(this.grid, 'La grilla de lista sigue visible en la vista calendario').toBeHidden({
      timeout: UI_READY_TIMEOUT_MS,
    });
  }

  /** Vuelve a lista; si la app vuelve a pedir datos, los loaders se esperan en waitForInovuaGridReady. */
  async switchToList(): Promise<GridReadyResult> {
    await this.listViewButton.click();
    await this.expectViewActive(this.listViewButton, 'lista');
    await expect(this.grid, 'La grilla de lista no reaparece').toBeVisible({ timeout: UI_READY_TIMEOUT_MS });
    const grid = await waitForInovuaGridReady(this.grid);
    return grid;
  }
}
