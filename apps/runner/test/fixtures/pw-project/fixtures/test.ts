/**
 * `test` con compuerta de intento de Katalyst (protocolo propuesto a qa-tests): antes del cuerpo del test espera
 * `<KATALYST_ATTEMPT_GATE_DIR>/<testId>-<retry>.json`, que el ejecutor escribe DESPUÉS de persistir el inicio del
 * intento (`POST /worker/attempts`). `proceed=false` ⇒ el test no interactúa con la app (ESP §13.3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ katalystGate: void }>({
  katalystGate: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const dir = process.env.KATALYST_ATTEMPT_GATE_DIR;
      if (dir) {
        const file = path.join(dir, `${testInfo.testId}-${testInfo.retry}.json`);
        const end = Date.now() + 30_000;
        let gate: { proceed: boolean } | null = null;
        while (!gate && Date.now() < end) {
          try {
            gate = JSON.parse(fs.readFileSync(file, 'utf8')) as { proceed: boolean };
          } catch {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        if (!gate) throw new Error('[configuracion_invalida] Compuerta de intento no recibida');
        test.skip(!gate.proceed, 'katalyst: intento no autorizado por la API');
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect };

export const stableKey = (uuid: string) => ({ type: 'katalyst.stableKey', description: uuid });
