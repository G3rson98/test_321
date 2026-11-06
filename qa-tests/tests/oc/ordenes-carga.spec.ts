/**
 * Órdenes de carga — caso inicial de Bloque 1 (ESP §11). Clasificación: lectura (RF-EJE-06).
 * RF-TR-03 (ID de caso en el título), RF-CAT-05 (stableKey), ESP §10 reglas 1-5, 7, 11.
 *
 * C900001 es un ID PLACEHOLDER: sustituir por el ID real de TestRail confirmado en Bloque 0 (README).
 */
import { expect, stableKey, test } from '../../fixtures/test.ts';
import { LOAD_ORDER_TABS, LoadOrderPage } from '../../pages/LoadOrderPage.ts';
import { expectGridState } from '../../pages/inovua.ts';

test(
  'C900001 Abrir Órdenes de carga y recorrer Abastecimiento, Directa y Distribuidores @oc @humo',
  { annotation: [stableKey('9050dd7e-9ec9-4634-91ac-5b1ecfc8a990')] },
  async ({ page, fixtureProfile }) => {
    const loadOrder = new LoadOrderPage(page);

    const initial = await test.step('Abrir Órdenes de carga', async () => {
      const result = await loadOrder.open();
      expect(result.response.status(), 'loadingOrder inicial debe responder 200').toBe(200);
      for (const tab of LOAD_ORDER_TABS) {
        await expect(loadOrder.tab(tab.name), `Pestaña ${tab.name} visible`).toBeVisible();
      }
      return result;
    });

    for (const tab of LOAD_ORDER_TABS) {
      await test.step(`Pestaña ${tab.name} (typeOperation=${tab.typeOperation})`, async () => {
        if (await loadOrder.isTabSelected(tab.name)) {
          // Pestaña activa al abrir: su carga es la respuesta inicial.
          expect(initial.typeOperation, `La carga inicial corresponde a ${tab.name}`).toBe(tab.typeOperation);
          expectGridState(initial.grid, fixtureProfile.loadOrder[tab.typeOperation], tab.name);
          return;
        }
        const result = await loadOrder.selectTab(tab);
        expect(result.response.status(), `loadingOrder ${tab.typeOperation} debe responder 200`).toBe(200);
        expect(result.typeOperation).toBe(tab.typeOperation);
        expect(await loadOrder.isTabSelected(tab.name), `La pestaña ${tab.name} queda seleccionada`).toBe(true);
        expectGridState(result.grid, fixtureProfile.loadOrder[tab.typeOperation], tab.name);
      });
    }
  },
);
