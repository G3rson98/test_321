/**
 * `test` extendido de qa-tests (ESP §10 regla 10: parametrización mediante fixtures tipadas sin secretos).
 *
 * - `katalystEnv`: configuración validada del ambiente (sin secretos).
 * - `fixtureProfile`: expectativas de datos sintéticos del ambiente (filas / vacía) según KATALYST_FIXTURE_PROFILE.
 * - `parameterKey`: clave estable de variante; `default` para tests sin parámetros (ESP §7, manifiesto).
 *
 * La sesión llega por `storageState` generado en auth.setup.ts (regla 5); ningún test escribe credenciales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { readEnv, requireTarget, type KatalystEnv } from './env.ts';
import { getFixtureProfile, type FixtureProfile } from './perfiles.ts';

export interface KatalystFixtures {
  /** Compuerta de intento (ESP §13.3): automática; ver comentario en la implementación. */
  katalystAttemptGate: void;
  katalystEnv: KatalystEnv;
  fixtureProfile: FixtureProfile;
}

export interface KatalystOptions {
  parameterKey: string;
}

export const test = base.extend<KatalystFixtures & KatalystOptions>({
  parameterKey: ['default', { option: true }],
  /**
   * Compuerta de intento de Katalyst (contrato con apps/runner, D-051): antes del cuerpo del test espera
   * `<KATALYST_ATTEMPT_GATE_DIR>/<testId>-<retry>.json`, que el ejecutor escribe DESPUÉS de persistir el inicio del
   * intento (`POST /worker/attempts`). `proceed=false` ⇒ el test no interactúa con la app (recuperación no autorizada,
   * escritura sin idempotencia aprobada, lease perdido). Sin la variable (ejecución local) no hace nada.
   */
  katalystAttemptGate: [
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
  // Playwright exige el patrón de desestructuración (aunque vacío) para no inyectar fixtures.
  // eslint-disable-next-line no-empty-pattern
  katalystEnv: async ({}, use) => {
    const env = readEnv();
    requireTarget(env);
    await use(env);
  },
  fixtureProfile: async ({ katalystEnv }, use) => {
    await use(getFixtureProfile(katalystEnv.fixtureProfile));
  },
});

export { expect };

/** Anotación con el UUID estable del manifiesto (RF-CAT-05). El manifiesto sigue siendo la fuente autoritativa. */
export function stableKey(uuid: string): { type: string; description: string } {
  return { type: 'katalyst.stableKey', description: uuid };
}
