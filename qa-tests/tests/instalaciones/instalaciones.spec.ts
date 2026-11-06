/**
 * Instalaciones · Configuración — caso inicial de Bloque 1 (ESP §11). Clasificación: lectura (RF-EJE-06).
 *
 * C900003 es un ID PLACEHOLDER: sustituir por el ID real de TestRail confirmado en Bloque 0 (README).
 */
import { expect, stableKey, test } from '../../fixtures/test.ts';
import { WarehousePage } from '../../pages/WarehousePage.ts';
import { expectGridState } from '../../pages/inovua.ts';

test(
  'C900003 Abrir Instalaciones y ver la grilla de configuración de instalaciones @instalaciones @humo',
  { annotation: [stableKey('cb8366a4-09c9-4701-a96f-86aa9e2b6e37')] },
  async ({ page, fixtureProfile }) => {
    const warehouses = new WarehousePage(page);

    await test.step('Abrir Instalaciones · Configuración', async () => {
      const result = await warehouses.open();
      expect(result.response.status(), 'warehouse/api/warehouse debe responder 200').toBe(200);
      expect(result.response.headers()['content-type'] ?? '', 'La respuesta es JSON').toMatch(/json/i);
      await expect(page).toHaveURL(/\/warehouses(?:[/?#]|$)/);
      expectGridState(result.grid, fixtureProfile.warehouses, 'Instalaciones');
    });
  },
);
