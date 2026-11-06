/**
 * Sincronización TestRail horaria del proceso de control (RF-TR-02). `main.control.ts` (API-B) debe registrar
 * `testrailSyncLoop(...)` en lugar del tick vacío `sync_testrail` y `registerTestRailControl(...)` para el
 * publicador de outbox (handlers TestRail). Una sincronización a la vez por conexión (TESTRAIL_SYNC_IN_PROGRESS se
 * ignora); el resultado se registra en `testrail_sync_run` y en métricas.
 */
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { isKatalystError } from '@katalyst/shared';
import type { Config } from '../config.js';
import { getTestRailClientFactory, type TestRailClientFactory } from '../adapters/testrail/index.js';
import type { SecretProvider } from '../lib/secrets.js';
import { getConnection, syncNow } from '../modules/testrail/sync.js';
import { registerTestRailMetrics } from '../modules/testrail/metrics.js';
import { registerTestRailOutboxHandlers } from '../modules/testrail/publication.js';

export interface TestRailControlDeps {
  prisma: PrismaClient;
  logger: Logger;
  config: Config;
  secrets: SecretProvider;
  clientFactory?: TestRailClientFactory;
}

/** Un tick: sincroniza si hay conexión habilitada con proyecto. Devuelve el estado o `null` si no aplicó. */
export async function runScheduledTestRailSync(deps: TestRailControlDeps): Promise<'exitosa' | 'fallida' | null> {
  const conn = await getConnection(deps.prisma);
  if (!conn || !conn.enabled || !conn.projectExternalId) return null;
  try {
    const run = await syncNow(
      {
        prisma: deps.prisma,
        logger: deps.logger,
        clientFactory: deps.clientFactory ?? getTestRailClientFactory(deps.config, deps.secrets),
        businessFields: deps.config.TESTRAIL_BUSINESS_FIELDS,
      },
      { trigger: 'programada', actor: 'system', connectionId: conn.id },
    );
    return run.status === 'exitosa' ? 'exitosa' : 'fallida';
  } catch (e) {
    if (isKatalystError(e) && (e.code === 'TESTRAIL_SYNC_IN_PROGRESS' || e.code === 'TESTRAIL_CONNECTION_INVALID')) return null;
    throw e;
  }
}

/** Bucle `ControlLoop` (nombre `sync_testrail`) con intervalo `TESTRAIL_SYNC_INTERVAL_MS` (1 h por defecto). */
export function testrailSyncLoop(deps: TestRailControlDeps) {
  return {
    name: 'sync_testrail',
    intervalMs: deps.config.TESTRAIL_SYNC_INTERVAL_MS,
    tick: async ({ logger }: { logger: Logger; now: Date }) => {
      const r = await runScheduledTestRailSync({ ...deps, logger });
      if (r) logger.info({ status: r }, 'sync TestRail programada');
    },
  };
}

/** Registra handlers de outbox TestRail y métricas en el proceso de control. */
export function registerTestRailControl(deps: TestRailControlDeps): void {
  registerTestRailOutboxHandlers({
    config: deps.config,
    clientFactory: deps.clientFactory ?? ((c) => getTestRailClientFactory(deps.config, deps.secrets)(c)),
    secrets: deps.secrets,
  });
  registerTestRailMetrics(deps.prisma);
}
