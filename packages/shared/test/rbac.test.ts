import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  can,
  canWithScopes,
  findRoute,
  PERMISSION_MIN_ROLE,
  permissionMatrix,
  PERMISSIONS,
  permissionsForRole,
  roleAtLeast,
  ROUTES,
} from '../src/rbac/index.js';

describe('RF-USR-01 matriz de permisos qa < dev < admin; servicio disjunto (ESP §3, §9)', () => {
  it('jerarquía', () => {
    expect(roleAtLeast('admin', 'qa')).toBe(true);
    expect(roleAtLeast('dev', 'admin')).toBe(false);
    const qa = permissionsForRole('qa');
    const dev = permissionsForRole('dev');
    const admin = permissionsForRole('admin');
    expect(qa.every((p) => dev.includes(p))).toBe(true);
    expect(dev.every((p) => admin.includes(p))).toBe(true);
    expect(admin).not.toContain('worker.callback');
  });

  it('tabla ESP §9: rol mínimo por operación', () => {
    // admin
    for (const p of [
      'testrail.sync',
      'testrail.connection.manage',
      'environments.manage',
      'users.manage',
      'audit.read',
      'integrations.deliveries.retry',
    ] as const) {
      expect(can('dev', p)).toBe(false);
      expect(can('admin', p)).toBe(true);
    }
    // dev
    for (const p of [
      'catalog.refresh',
      'catalog.link.review',
      'generate.create',
      'perf.thresholds.manage',
      'perf.events.write',
    ] as const) {
      expect(can('qa', p)).toBe(false);
      expect(can('dev', p)).toBe(true);
    }
    // qa
    for (const p of [
      'runs.create',
      'runs.cancel',
      'schedules.write',
      'suites.write',
      'recordings.create',
      'perf.read',
      'testrail.read',
      'catalog.read',
      'artifacts.read',
      'environments.list',
    ] as const) {
      expect(can('qa', p)).toBe(true);
    }
  });

  it('servicio solo tiene permisos de worker y no accede al panel', () => {
    expect(permissionsForRole('servicio')).toEqual(['worker.claim', 'worker.callback']);
    expect(can('servicio', 'runs.read')).toBe(false);
    expect(can('servicio', 'worker.callback')).toBe(true);
    for (const r of ['qa', 'dev', 'admin'] as const) expect(can(r, 'worker.claim')).toBe(false);
  });

  it('tokens API: rol ∩ scopes (RF-USR-03)', () => {
    expect(canWithScopes('admin', ['runs.read'], 'runs.read')).toBe(true);
    expect(canWithScopes('admin', ['runs.read'], 'runs.create')).toBe(false);
    expect(canWithScopes('qa', ['users.manage'], 'users.manage')).toBe(false);
    expect(canWithScopes('qa', null, 'runs.create')).toBe(true);
  });

  it('matriz completa cubre todos los permisos', () => {
    const m = permissionMatrix();
    expect(Object.keys(m)).toEqual(['qa', 'dev', 'admin', 'servicio']);
    for (const r of Object.values(m)) expect(Object.keys(r)).toHaveLength(PERMISSIONS.length);
    expect(Object.keys(PERMISSION_MIN_ROLE).sort()).toEqual([...PERMISSIONS].sort());
  });
});

describe('RNF-SEG-03 inventario de rutas', () => {
  it('rutas únicas, permisos válidos, worker con lease, POST /runs idempotente', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROUTES) {
      expect(r.access === 'public' || r.access === 'authenticated' || PERMISSIONS.includes(r.access as never)).toBe(
        true,
      );
      expect(r.rf.length).toBeGreaterThan(0);
      if (r.module === 'worker' && r.path !== '/worker/claim' && r.path !== '/worker/catalog/listing')
        expect(r.lease).toBe(true);
    }
    expect(findRoute('POST', '/runs')).toMatchObject({ idempotent: true, access: 'runs.create' });
    expect(findRoute('GET', '/nope')).toBeUndefined();
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('incluye todas las rutas de la tabla principal y adicionales de ESP §9', () => {
    const required = [
      'POST /testrail/sync',
      'GET /testrail/cases',
      'GET /tests',
      'POST /tests/refresh',
      'GET /suites',
      'POST /suites',
      'PUT /suites/:id',
      'DELETE /suites/:id',
      'POST /runs',
      'GET /runs',
      'GET /runs/:id',
      'POST /runs/:id/cancel',
      'GET /runs/:id/events',
      'GET /schedules',
      'POST /schedules',
      'PUT /schedules/:id',
      'DELETE /schedules/:id',
      'POST /schedules/:id/pause',
      'GET /schedules/:id/next',
      'POST /recordings',
      'POST /recordings/:id/complete',
      'POST /generate',
      'GET /perf',
      'GET /perf/thresholds',
      'POST /perf/thresholds',
      'POST /events',
      'GET /environments',
      'POST /environments',
      'PUT /environments/:id',
      'GET /environments/:id/users',
      'POST /worker/results',
      'POST /testrail/connection/test',
      'GET /testrail/connection',
      'PUT /testrail/connection',
      'POST /runs/preview',
      'GET /runs/:id/artifacts/:artifactId',
      'POST /worker/heartbeat',
      'POST /worker/artifacts/upload',
      'PUT /tests/:id/case-links/:caseId/review',
      'POST /integrations/testrail/deliveries/:id/retry',
      'POST /auth/login',
      'POST /auth/logout',
      'GET /auth/me',
      'GET /users',
      'POST /recordings/:id/cancel',
      'GET /recordings/:id',
      'GET /audit-log',
      'GET /devices/status',
      'POST /devices/authorize',
      'POST /devices/token',
      'POST /devices/approve',
      'GET /events/stream',
      'POST /worker/claim',
      'POST /worker/attempts',
      'POST /worker/complete',
    ];
    const keys = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const k of required) expect(keys.has(k), k).toBe(true);
  });
});
