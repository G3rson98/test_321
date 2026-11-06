/**
 * Helper de grillas Inovua DataGrid (ESP §10 reglas 7, 11 y 12).
 *
 * Usa clases PÚBLICAS de MUI/Inovua como excepción controlada y versionada; ver `pages/selectores-excepciones.md`
 * (E-01..E-06). Ningún test usa estas clases directamente: solo los Page Objects a través de este módulo.
 * Sustituir por `data-testid` cuando el frontend los provea (regla 8); no eliminar las excepciones automáticamente.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { GridExpectation } from '../fixtures/perfiles.ts';
import { UI_READY_TIMEOUT_MS } from '../fixtures/timeouts.ts';

/** Versión del catálogo de excepciones (debe coincidir con `pages/selectores-excepciones.md`). */
export const SELECTOR_EXCEPTIONS_VERSION = 1;

export const INOVUA_SELECTORS = {
  /** E-01 raíz de la grilla. */
  grid: '.InovuaReactDataGrid',
  /** E-02 fila de datos. */
  row: '.InovuaReactDataGrid__row',
  /** E-03 máscara de carga visible. */
  loadMaskVisible: '.InovuaReactDataGrid__load-mask--visible',
  /** E-04 estado vacío nativo de Inovua. TODO(Bloque 0): confirmar que DeltaX no lo reemplaza por un componente propio. */
  emptyWrapper: '.InovuaReactDataGrid__empty-wrapper',
} as const;

export const MUI_LOADER_SELECTORS = {
  /** E-05 */
  skeleton: '.MuiSkeleton-root',
  /** E-06 */
  circularProgress: '.MuiCircularProgress-root',
} as const;

/** Localiza la grilla Inovua dentro de un contenedor (página o región). Excepción E-01. */
export function inovuaGrid(scope: Page | Locator): Locator {
  return scope.locator(INOVUA_SELECTORS.grid).first();
}

export interface GridReadyResult {
  rows: number;
  empty: boolean;
}

export interface GridReadyOptions {
  timeout?: number;
  /**
   * Dónde buscar loaders MUI: `page` (default; los skeleton/progress de DeltaX pueden quedar fuera del nodo de la
   * grilla) o `grid` (solo dentro de la grilla).
   */
  loaderScope?: 'page' | 'grid';
}

/**
 * Espera a que una grilla Inovua esté lista (regla 7): visible, sin `.MuiSkeleton-root`, `.MuiCircularProgress-root`
 * ni `.InovuaReactDataGrid__load-mask--visible` visibles, y mostrando filas (`.InovuaReactDataGrid__row`) o el estado
 * vacío. Precondición: llamar DESPUÉS de esperar la respuesta del servicio que llena la grilla (si no, el loader podría
 * no haber aparecido todavía).
 */
export async function waitForInovuaGridReady(grid: Locator, opts: GridReadyOptions = {}): Promise<GridReadyResult> {
  const timeout = opts.timeout ?? UI_READY_TIMEOUT_MS;
  await expect(grid, 'La grilla Inovua no es visible').toBeVisible({ timeout });

  const loaderRoot: Page | Locator = (opts.loaderScope ?? 'page') === 'page' ? grid.page() : grid;
  await expect(
    grid.locator(INOVUA_SELECTORS.loadMaskVisible).filter({ visible: true }),
    'La máscara de carga de la grilla sigue visible',
  ).toHaveCount(0, { timeout });
  for (const selector of Object.values(MUI_LOADER_SELECTORS)) {
    await expect(loaderRoot.locator(selector).filter({ visible: true }), `Loader MUI visible (${selector})`).toHaveCount(0, {
      timeout,
    });
  }

  const rows = grid.locator(INOVUA_SELECTORS.row);
  const empty = grid.locator(INOVUA_SELECTORS.emptyWrapper);
  await expect(rows.or(empty).first(), 'La grilla no muestra filas ni estado vacío').toBeVisible({ timeout });

  const rowCount = await rows.count();
  const isEmpty = rowCount === 0 && (await empty.isVisible());
  return { rows: rowCount, empty: isEmpty };
}

/** Verifica el estado de grilla esperado por el perfil de fixture (regla 11: la grilla vacía puede ser correcta). */
export function expectGridState(result: GridReadyResult, expected: GridExpectation, context: string): void {
  switch (expected) {
    case 'con_filas':
      expect(result.rows, `${context}: el fixture garantiza filas`).toBeGreaterThan(0);
      break;
    case 'vacia':
      expect(result.empty, `${context}: el fixture garantiza estado vacío`).toBe(true);
      break;
    case 'con_filas_o_vacia':
      expect(result.rows > 0 || result.empty, `${context}: se esperaba filas o estado vacío explícito`).toBe(true);
      break;
  }
}
