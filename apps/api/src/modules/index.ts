/**
 * Registro de módulos bajo /api/v1. Cada módulo es un plugin encapsulado (ver su README.md).
 * El inventario de rutas/permisos es `ROUTES` de @katalyst/shared (RNF-SEG-03).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiModule } from '@katalyst/shared';
import { alertsRoutes } from './alerts/routes.js';
import { artifactsRoutes } from './artifacts/routes.js';
import { auditRoutes } from './audit/routes.js';
import { authRoutes } from './auth/routes.js';
import { catalogRoutes } from './catalog/routes.js';
import { devicesRoutes } from './devices/routes.js';
import { environmentsRoutes } from './environments/routes.js';
import { eventsRoutes } from './events/routes.js';
import { exportsRoutes } from './exports/routes.js';
import { generateRoutes } from './generate/routes.js';
import { integrationsRoutes } from './integrations/routes.js';
import { notificationsRoutes } from './notifications/routes.js';
import { perfRoutes } from './perf/routes.js';
import { recordingsRoutes } from './recordings/routes.js';
import { runsRoutes } from './runs/routes.js';
import { schedulesRoutes } from './schedules/routes.js';
import { suitesRoutes } from './suites/routes.js';
import { testrailRoutes } from './testrail/routes.js';
import { usersRoutes } from './users/routes.js';
import { workerRoutes } from './worker/routes.js';

/** Módulos de negocio montados bajo /api/v1 (`health` se monta en la raíz desde app.ts). */
export const API_MODULES: Record<Exclude<ApiModule, 'health'>, FastifyPluginAsyncZod> = {
  auth: authRoutes,
  users: usersRoutes,
  audit: auditRoutes,
  testrail: testrailRoutes,
  catalog: catalogRoutes,
  suites: suitesRoutes,
  runs: runsRoutes,
  worker: workerRoutes,
  schedules: schedulesRoutes,
  events: eventsRoutes,
  artifacts: artifactsRoutes,
  perf: perfRoutes,
  alerts: alertsRoutes,
  notifications: notificationsRoutes,
  recordings: recordingsRoutes,
  devices: devicesRoutes,
  generate: generateRoutes,
  exports: exportsRoutes,
  environments: environmentsRoutes,
  integrations: integrationsRoutes,
};

export const registerModules: FastifyPluginAsyncZod = async (app) => {
  for (const plugin of Object.values(API_MODULES)) {
    await app.register(plugin);
  }
};
