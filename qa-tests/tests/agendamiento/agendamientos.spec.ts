/**
 * Agendamientos — caso inicial de Bloque 1 (ESP §11). Clasificación: lectura (RF-EJE-06).
 * ESP §2: la lista crece durante el día y llegó a no cargar en 60 s; el test espera hasta ese límite conocido.
 *
 * C900002 es un ID PLACEHOLDER: sustituir por el ID real de TestRail confirmado en Bloque 0 (README).
 */
import { expect, stableKey, test } from '../../fixtures/test.ts';
import { SchedulingPage } from '../../pages/SchedulingPage.ts';
import { expectGridState } from '../../pages/inovua.ts';

test(
  'C900002 Abrir Agendamientos y alternar entre vista lista y calendario @agendamiento @humo',
  { annotation: [stableKey('254f1b1d-74af-489f-b953-a6a87cfbcf39')] },
  async ({ page, fixtureProfile }) => {
    const scheduling = new SchedulingPage(page);

    await test.step('Abrir Agendamientos en vista lista', async () => {
      const result = await scheduling.open();
      expect(result.list.status(), 'list/scheduling debe responder 200').toBe(200);
      expect(result.status.status(), 'scheduling/status debe responder 200').toBe(200);
      await scheduling.expectViewActive(scheduling.listViewButton, 'lista');
      expectGridState(result.grid, fixtureProfile.schedulingsList, 'Agendamientos lista');
    });

    await test.step('Cambiar a vista calendario', async () => {
      await scheduling.switchToCalendar();
    });

    await test.step('Volver a vista lista', async () => {
      const grid = await scheduling.switchToList();
      expectGridState(grid, fixtureProfile.schedulingsList, 'Agendamientos lista (regreso)');
    });
  },
);
