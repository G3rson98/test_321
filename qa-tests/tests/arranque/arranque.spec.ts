/**
 * Arranque de la raíz — caso inicial de Bloque 1 (ESP §11). Clasificación: lectura (RF-EJE-06).
 * Hallazgos ESP §2: `current` pesa ~1,2 MB (≈150 KB comprimido) y bloquea el arranque; el frontend lo corta a 30 s.
 * Mide la espera por `current` (submétrica del arranque, ESP §13.8) y verifica la condición de app utilizable.
 *
 * C900004 es un ID PLACEHOLDER: sustituir por el ID real de TestRail confirmado en Bloque 0 (README).
 */
import { expect, stableKey, test } from '../../fixtures/test.ts';
import { ControlCenterPage } from '../../pages/ControlCenterPage.ts';
import { FRONTEND_CURRENT_TIMEOUT_MS } from '../../fixtures/timeouts.ts';

test(
  'C900004 Arrancar la raíz y esperar current dentro del timeout del frontend @arranque @humo',
  { annotation: [stableKey('a5f8fc2b-af9c-4c6c-8768-823a8e87f1c3')] },
  async ({ page }, testInfo) => {
    const controlCenter = new ControlCenterPage(page);

    const start = await test.step('Navegar a la raíz y esperar users/api/users/current (≤ 30 s)', async () => {
      const result = await controlCenter.start('/', { withServices: true });
      expect(result.current.status(), 'current debe responder 200').toBe(200);
      await result.current.finished();
      const timing = result.current.request().timing();
      // timing.startTime es epoch ms; responseEnd es relativo a startTime (ms) o -1 si no está disponible.
      expect(Number.isFinite(timing.startTime) && timing.responseEnd >= 0, 'Timing de current disponible').toBe(true);
      const waitMs = Math.round(timing.startTime + timing.responseEnd - result.navigationStartedAt);
      expect(waitMs, 'Espera por current no negativa (unidades ms coherentes)').toBeGreaterThanOrEqual(0);
      testInfo.annotations.push({ type: 'katalyst.metric', description: `root_current_wait_ms=${waitMs}` });
      expect(waitMs, `current debe completar antes del corte del frontend (${FRONTEND_CURRENT_TIMEOUT_MS} ms)`).toBeLessThan(
        FRONTEND_CURRENT_TIMEOUT_MS,
      );
      return result;
    });

    await test.step('Servicios de la página principal responden sin error', async () => {
      for (const [key, response] of start.services) {
        expect(response.status(), `${key} debe responder sin error`).toBeLessThan(400);
      }
    });

    await test.step('La página principal queda utilizable', async () => {
      await controlCenter.expectUsable();
      const rootReadyMs = Date.now() - start.navigationStartedAt;
      testInfo.annotations.push({ type: 'katalyst.metric', description: `root_ready_ms=${rootReadyMs}` });
    });
  },
);
