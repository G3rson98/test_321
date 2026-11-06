/**
 * Dependencias de los servicios de ejecución construidas desde `app.deps` (runs, worker, schedules, artifacts, events).
 * El almacén de artefactos y el publicador de control (Redis) son singletons por proceso, reemplazables en pruebas.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { KatalystError } from '@katalyst/shared';
import type { Principal } from '../../lib/auth.js';
import { getSecretProvider } from '../../lib/secrets.js';
import { createArtifactStore, type ArtifactStore } from '../../adapters/artifact-store/index.js';
import type { RunDeps } from '../../services/run-admission.js';
import {
  redisControlPublisher,
  type CancelDeps,
  type ControlPublisher,
} from '../../services/cancellation.js';
import type { ScheduleDeps } from '../../services/scheduler.js';
import type { LeaseDeps } from '../../services/leases.js';

let storeOverride: ArtifactStore | undefined;
let storePromise: Promise<ArtifactStore> | undefined;
let controlOverride: ControlPublisher | undefined;

/** Solo pruebas: reemplaza el almacén y el publicador de control. */
export function setRunsTestDoubles(o: { store?: ArtifactStore; control?: ControlPublisher }): void {
  storeOverride = o.store;
  controlOverride = o.control;
  storePromise = undefined;
}

export async function artifactStoreOf(app: FastifyInstance): Promise<ArtifactStore> {
  if (storeOverride) return storeOverride;
  storePromise ??= createArtifactStore(app.deps.config, (ref) => getSecretProvider().get(ref));
  return storePromise;
}

export function runDepsOf(app: FastifyInstance): RunDeps {
  return {
    prisma: app.deps.prisma,
    logger: app.deps.logger,
    globalBrowserCeiling: app.deps.config.GLOBAL_BROWSER_CONCURRENCY,
    publicBaseUrl: app.deps.config.PUBLIC_BASE_URL,
  };
}

export function controlPublisherOf(app: FastifyInstance): ControlPublisher {
  return controlOverride ?? redisControlPublisher(app.deps.redis, app.deps.config.QUEUE_PREFIX);
}

export function cancelDepsOf(app: FastifyInstance): CancelDeps {
  return {
    prisma: app.deps.prisma,
    logger: app.deps.logger,
    publicBaseUrl: app.deps.config.PUBLIC_BASE_URL,
    publishControl: controlPublisherOf(app),
  };
}

export function scheduleDepsOf(app: FastifyInstance): ScheduleDeps {
  return {
    prisma: app.deps.prisma,
    logger: app.deps.logger,
    publicBaseUrl: app.deps.config.PUBLIC_BASE_URL,
    globalBrowserCeiling: app.deps.config.GLOBAL_BROWSER_CONCURRENCY,
  };
}

export function leaseDepsOf(app: FastifyInstance): LeaseDeps {
  return {
    prisma: app.deps.prisma,
    logger: app.deps.logger,
    publicBaseUrl: app.deps.config.PUBLIC_BASE_URL,
    leaseTtlMs: app.deps.config.LEASE_TTL_MS,
    heartbeatIntervalMs: app.deps.config.HEARTBEAT_INTERVAL_MS,
  };
}

export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new KatalystError('UNAUTHENTICATED');
  return request.principal;
}
