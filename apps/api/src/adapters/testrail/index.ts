/**
 * Fábrica del cliente TestRail a partir de la conexión guardada (solo referencias) — RF-TR-01, ESP §13.7.
 * La API key se resuelve en cada construcción mediante SecretProvider (rotación sin reinicio) y no sale del proceso.
 * Las pruebas reemplazan la fábrica con `setTestRailClientFactory` (FakeTestRailClient).
 */
import type { Config } from '../../config.js';
import { HttpGuard } from '../../lib/http-guard.js';
import type { SecretProvider } from '../../lib/secrets.js';
import { policyFromConfig } from '../../lib/ssrf.js';
import { HttpTestRailClient } from './http-client.js';
import type { TestRailClient } from './types.js';

export * from './types.js';
export { HttpTestRailClient, parseRetryAfter } from './http-client.js';
export { FakeTestRailClient } from './fake-client.js';

export interface TestRailConnectionRef {
  baseUrl: string;
  username: string;
  secretRef: string;
}

export type TestRailClientFactory = (conn: TestRailConnectionRef) => Promise<TestRailClient>;

export function httpTestRailClientFactory(config: Config, secrets: SecretProvider): TestRailClientFactory {
  const http = new HttpGuard({ policy: policyFromConfig(config), defaultTimeoutMs: config.OUTBOUND_HTTP_TIMEOUT_MS });
  return async (conn) =>
    new HttpTestRailClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      apiKey: await secrets.get(conn.secretRef),
      http,
      timeoutMs: config.OUTBOUND_HTTP_TIMEOUT_MS,
    });
}

let override: TestRailClientFactory | undefined;

/** Reemplaza la fábrica (pruebas). `undefined` restaura la HTTP real. */
export function setTestRailClientFactory(f: TestRailClientFactory | undefined): void {
  override = f;
}

export function getTestRailClientFactory(config: Config, secrets: SecretProvider): TestRailClientFactory {
  return override ?? httpTestRailClientFactory(config, secrets);
}
