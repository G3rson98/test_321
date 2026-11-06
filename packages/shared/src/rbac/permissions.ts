/**
 * Matriz de permisos (ESP §3 y §9). Roles de panel jerárquicos `qa < dev < admin`; `servicio` es un actor de sistema
 * disjunto (worker/supervisor) que no hereda permisos del panel ni accede a él (ESP §3).
 * RF-USR-01, RF-USR-03, RNF-SEG-03.
 */
import { z } from 'zod';
import type { PanelRole, Role } from '../enums.js';

export const PERMISSIONS = [
  // TestRail
  'testrail.read',
  'testrail.sync',
  'testrail.connection.manage',
  // Catálogo
  'catalog.read',
  'catalog.refresh',
  'catalog.link.review',
  // Suites
  'suites.read',
  'suites.write',
  // Corridas
  'runs.read',
  'runs.create',
  'runs.cancel',
  'artifacts.read',
  // Programación
  'schedules.read',
  'schedules.write',
  'exclusion_windows.write',
  // Grabación, dispositivos, IA
  'recordings.create',
  'recordings.read',
  'devices.approve',
  'generate.create',
  // Rendimiento y alertas
  'perf.read',
  'perf.thresholds.manage',
  'perf.events.write',
  'alerts.read',
  // Notificaciones
  'notifications.preferences',
  'notifications.channels.manage',
  // Ambientes
  'environments.list',
  'environments.manage',
  // Administración
  'users.manage',
  'audit.read',
  'api_tokens.manage',
  'settings.manage',
  // Integraciones / outbox
  'integrations.deliveries.read',
  'integrations.deliveries.retry',
  // Exportaciones
  'exports.create',
  // Actor de sistema (ESP §3 "Ejecutor")
  'worker.claim',
  'worker.callback',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

/** Rol mínimo de panel por permiso. `null` = solo `servicio`. */
export const PERMISSION_MIN_ROLE: Record<Permission, PanelRole | null> = {
  'testrail.read': 'qa',
  'testrail.sync': 'admin',
  'testrail.connection.manage': 'admin',
  'catalog.read': 'qa',
  'catalog.refresh': 'dev',
  'catalog.link.review': 'dev',
  'suites.read': 'qa',
  'suites.write': 'qa',
  'runs.read': 'qa',
  'runs.create': 'qa',
  'runs.cancel': 'qa',
  'artifacts.read': 'qa',
  'schedules.read': 'qa',
  'schedules.write': 'qa',
  'exclusion_windows.write': 'dev',
  'recordings.create': 'qa',
  'recordings.read': 'qa',
  'devices.approve': 'qa',
  'generate.create': 'dev',
  'perf.read': 'qa',
  'perf.thresholds.manage': 'dev',
  'perf.events.write': 'dev',
  'alerts.read': 'qa',
  'notifications.preferences': 'qa',
  'notifications.channels.manage': 'admin',
  'environments.list': 'qa',
  'environments.manage': 'admin',
  'users.manage': 'admin',
  'audit.read': 'admin',
  'api_tokens.manage': 'admin',
  'settings.manage': 'admin',
  'integrations.deliveries.read': 'qa',
  'integrations.deliveries.retry': 'admin',
  'exports.create': 'qa',
  'worker.claim': null,
  'worker.callback': null,
};

/** Permisos del actor `servicio` (supervisor con token propio; ejecutor con token de lease). */
export const SERVICE_PERMISSIONS: readonly Permission[] = ['worker.claim', 'worker.callback'];

const ROLE_RANK: Record<PanelRole, number> = { qa: 1, dev: 2, admin: 3 };

export function roleAtLeast(role: PanelRole, min: PanelRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function permissionsForRole(role: Role): Permission[] {
  if (role === 'servicio') return [...SERVICE_PERMISSIONS];
  return PERMISSIONS.filter((p) => {
    const min = PERMISSION_MIN_ROLE[p];
    return min !== null && roleAtLeast(role, min);
  });
}

/** ¿El rol tiene el permiso? Para tokens API, además intersecar con `scopes` (ver `canWithScopes`). */
export function can(role: Role, permission: Permission): boolean {
  if (role === 'servicio') return SERVICE_PERMISSIONS.includes(permission);
  const min = PERMISSION_MIN_ROLE[permission];
  return min !== null && roleAtLeast(role, min);
}

/** Token API revocable: permiso efectivo = rol del dueño ∩ scopes del token (RF-USR-03). */
export function canWithScopes(role: Role, scopes: readonly Permission[] | null, permission: Permission): boolean {
  if (!can(role, permission)) return false;
  return scopes === null || scopes.includes(permission);
}

/** Matriz completa para documentación/pruebas: rol → permiso → booleano. */
export function permissionMatrix(): Record<Role, Record<Permission, boolean>> {
  const roles: Role[] = ['qa', 'dev', 'admin', 'servicio'];
  return Object.fromEntries(
    roles.map((r) => [r, Object.fromEntries(PERMISSIONS.map((p) => [p, can(r, p)]))]),
  ) as Record<Role, Record<Permission, boolean>>;
}
