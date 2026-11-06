/**
 * `test` extendido de qa-tests (ESP §10 regla 10: parametrización mediante fixtures tipadas sin secretos).
 *
 * - `katalystEnv`: configuración validada del ambiente (sin secretos).
 * - `fixtureProfile`: expectativas de datos sintéticos del ambiente (filas / vacía) según KATALYST_FIXTURE_PROFILE.
 * - `parameterKey`: clave estable de variante; `default` para tests sin parámetros (ESP §7, manifiesto).
 *
 * La sesión llega por `storageState` generado en auth.setup.ts (regla 5); ningún test escribe credenciales.
 */
import { test as base, expect } from '@playwright/test';
import { readEnv, requireTarget, type KatalystEnv } from './env.ts';
import { getFixtureProfile, type FixtureProfile } from './perfiles.ts';

export interface KatalystFixtures {
  katalystEnv: KatalystEnv;
  fixtureProfile: FixtureProfile;
}

export interface KatalystOptions {
  parameterKey: string;
}

export const test = base.extend<KatalystFixtures & KatalystOptions>({
  parameterKey: ['default', { option: true }],
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
