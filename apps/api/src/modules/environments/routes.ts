/**
 * Ambientes y usuarios de prueba (admin; listado mínimo para qa) y parámetros administrativos auditados.
 * Nunca devuelve secretos: solo referencias (`secretRef`) a administradores. RF-AMB-01, RF-AMB-02, ESP §13.3, §13.7.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  CursorQuerySchema,
  EnvironmentCreateSchema,
  EnvironmentSchema,
  EnvironmentSummarySchema,
  EnvironmentUpdateSchema,
  EnvironmentUserParamsSchema,
  IdParamsSchema,
  KatalystError,
  RuntimeSettingsSchema,
  RuntimeSettingsUpdateSchema,
  TestUserCreateSchema,
  TestUserSchema,
  TestUserUpdateSchema,
  pageSchema,
} from '@katalyst/shared';
import { hasPermission, routeAuth } from '../../lib/auth.js';
import { recordAudit, shallowDiff } from '../../lib/audit.js';
import { QueryBool, decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, type SortSpec } from '../../lib/pagination.js';
import { policyFromConfig } from '../../lib/ssrf.js';
import {
  RUNTIME_SETTINGS_KEY,
  assertSecretRefAdministrable,
  getRuntimeSettings,
  isUniqueViolation,
  resolveArtifactPolicy,
  toEnvironmentDto,
  toEnvironmentSummaryDto,
  toTestUserDto,
  validateAllowedHosts,
  validateTargetUrl,
} from './service.js';

const NAME_SORT: SortSpec = { field: 'name', direction: 'asc', type: 'string' };
const ListQuery = CursorQuerySchema.extend({ includeDisabled: QueryBool.default(false) });
const EnvListItem = z.union([EnvironmentSchema, EnvironmentSummarySchema]);

const ENV_DIFF_KEYS = [
  'name',
  'appUrl',
  'apiUrl',
  'isProduction',
  'maxConcurrency',
  'enabled',
  'recordingAllowed',
  'artifactPolicy',
  'allowedHosts',
] as const;
const USER_DIFF_KEYS = ['label', 'username', 'secretRef', 'readOnly', 'allowsConcurrency', 'enabled'] as const;

export const environmentsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const policy = policyFromConfig(config);

  async function validateEnvInput(b: {
    appUrl?: string | undefined;
    apiUrl?: string | undefined;
    allowedHosts?: string[] | undefined;
  }): Promise<string[] | undefined> {
    if (b.appUrl) await validateTargetUrl(b.appUrl, policy);
    if (b.apiUrl) await validateTargetUrl(b.apiUrl, policy);
    return b.allowedHosts ? validateAllowedHosts(b.allowedHosts, policy) : undefined;
  }

  app.get(
    '/environments',
    {
      ...routeAuth('GET', '/environments'),
      schema: {
        tags: ['environments'],
        summary: 'Ambientes (resumen para qa; detalle para admin)',
        querystring: ListQuery,
        response: { 200: pageSchema(EnvListItem) },
      },
    },
    async (request) => {
      const q = request.query;
      const admin = hasPermission(request.principal, 'environments.manage');
      const after = decodePageCursor(q.cursor, NAME_SORT);
      const rows = await prisma.environment.findMany({
        where: { AND: [q.includeDisabled && admin ? {} : { disabledAt: null }, keysetWhere(NAME_SORT, after)] },
        orderBy: keysetOrderBy(NAME_SORT),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, NAME_SORT, admin ? toEnvironmentDto : toEnvironmentSummaryDto);
    },
  );

  app.post(
    '/environments',
    {
      ...routeAuth('POST', '/environments'),
      schema: { tags: ['environments'], summary: 'Registrar ambiente', body: EnvironmentCreateSchema, response: { 201: EnvironmentSchema } },
    },
    async (request, reply) => {
      const b = request.body;
      const allowedHosts = (await validateEnvInput(b)) ?? [];
      const artifactPolicy = resolveArtifactPolicy(b.isProduction, b.artifactPolicy);
      try {
        const env = await prisma.$transaction(async (tx) => {
          const e = await tx.environment.create({
            data: {
              name: b.name,
              appUrl: b.appUrl,
              apiUrl: b.apiUrl,
              isProduction: b.isProduction,
              maxConcurrency: b.maxConcurrency,
              enabled: b.enabled,
              disabledAt: b.enabled ? null : new Date(),
              // Sin grabación en producción en el alcance inicial (ESP §13.6).
              recordingAllowed: b.isProduction ? false : b.recordingAllowed,
              artifactPolicy: artifactPolicy as Prisma.InputJsonValue,
              allowedHosts,
            },
          });
          await recordAudit(tx, {
            actor: request.principal!,
            action: 'environment.create',
            entity: 'environment',
            entityId: e.id,
            diff: shallowDiff(null, toEnvironmentDto(e), ENV_DIFF_KEYS),
            requestId: request.requestId,
          });
          return e;
        });
        return reply.status(201).send(toEnvironmentDto(env));
      } catch (e) {
        if (isUniqueViolation(e)) throw new KatalystError('CONFLICT', 'Ya existe un ambiente activo con ese nombre.');
        throw e;
      }
    },
  );

  app.get(
    '/environments/:id',
    {
      ...routeAuth('GET', '/environments/:id'),
      schema: { tags: ['environments'], summary: 'Detalle de ambiente', params: IdParamsSchema, response: { 200: EnvironmentSchema } },
    },
    async (request) => {
      const e = await prisma.environment.findUnique({ where: { id: request.params.id } });
      if (!e) throw new KatalystError('NOT_FOUND');
      return toEnvironmentDto(e);
    },
  );

  app.put(
    '/environments/:id',
    {
      ...routeAuth('PUT', '/environments/:id'),
      schema: {
        tags: ['environments'],
        summary: 'Actualizar ambiente (versión optimista)',
        params: IdParamsSchema,
        body: EnvironmentUpdateSchema,
        response: { 200: EnvironmentSchema },
      },
    },
    async (request) => {
      const b = request.body;
      const allowedHosts = await validateEnvInput(b);
      try {
        const env = await prisma.$transaction(async (tx) => {
          const cur = await tx.environment.findUnique({ where: { id: request.params.id } });
          if (!cur) throw new KatalystError('NOT_FOUND');
          if (cur.version !== b.version) throw new KatalystError('VERSION_CONFLICT');
          const isProduction = b.isProduction ?? cur.isProduction;
          const artifactPolicy =
            b.artifactPolicy !== undefined || b.isProduction !== undefined
              ? resolveArtifactPolicy(isProduction, b.artifactPolicy ?? (cur.artifactPolicy as never))
              : undefined;
          const data: Prisma.EnvironmentUpdateManyMutationInput = { version: { increment: 1 } };
          if (b.name !== undefined) data.name = b.name;
          if (b.appUrl !== undefined) data.appUrl = b.appUrl;
          if (b.apiUrl !== undefined) data.apiUrl = b.apiUrl;
          if (b.isProduction !== undefined) data.isProduction = b.isProduction;
          if (b.maxConcurrency !== undefined) data.maxConcurrency = b.maxConcurrency;
          if (b.enabled !== undefined) {
            data.enabled = b.enabled;
            data.disabledAt = b.enabled ? null : (cur.disabledAt ?? new Date());
          }
          if (b.recordingAllowed !== undefined || isProduction) {
            data.recordingAllowed = isProduction ? false : (b.recordingAllowed ?? cur.recordingAllowed);
          }
          if (artifactPolicy) data.artifactPolicy = artifactPolicy as Prisma.InputJsonValue;
          if (allowedHosts) data.allowedHosts = allowedHosts;
          const r = await tx.environment.updateMany({ where: { id: cur.id, version: b.version }, data });
          if (r.count === 0) throw new KatalystError('VERSION_CONFLICT');
          const after = await tx.environment.findUniqueOrThrow({ where: { id: cur.id } });
          await recordAudit(tx, {
            actor: request.principal!,
            action: 'environment.update',
            entity: 'environment',
            entityId: cur.id,
            diff: shallowDiff(toEnvironmentDto(cur), toEnvironmentDto(after), ENV_DIFF_KEYS),
            requestId: request.requestId,
          });
          return after;
        });
        return toEnvironmentDto(env);
      } catch (e) {
        if (isUniqueViolation(e)) throw new KatalystError('CONFLICT', 'Ya existe un ambiente activo con ese nombre.');
        throw e;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Usuarios de prueba (RF-AMB-02)
  // -------------------------------------------------------------------------

  app.get(
    '/environments/:id/users',
    {
      ...routeAuth('GET', '/environments/:id/users'),
      schema: {
        tags: ['environments'],
        summary: 'Usuarios de prueba (solo referencias de secretos)',
        params: IdParamsSchema,
        querystring: ListQuery,
        response: { 200: pageSchema(TestUserSchema) },
      },
    },
    async (request) => {
      const env = await prisma.environment.findUnique({ where: { id: request.params.id }, select: { id: true } });
      if (!env) throw new KatalystError('NOT_FOUND');
      const q = request.query;
      const sort: SortSpec = { field: 'label', direction: 'asc', type: 'string' };
      const after = decodePageCursor(q.cursor, sort);
      const rows = await prisma.testUser.findMany({
        where: { AND: [{ environmentId: env.id }, q.includeDisabled ? {} : { disabledAt: null }, keysetWhere(sort, after)] },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, sort, toTestUserDto);
    },
  );

  app.post(
    '/environments/:id/users',
    {
      ...routeAuth('POST', '/environments/:id/users'),
      schema: {
        tags: ['environments'],
        summary: 'Registrar usuario de prueba (referencia de secreto)',
        params: IdParamsSchema,
        body: TestUserCreateSchema,
        response: { 201: TestUserSchema },
      },
    },
    async (request, reply) => {
      const b = request.body;
      assertSecretRefAdministrable(b.secretRef);
      try {
        const u = await prisma.$transaction(async (tx) => {
          const env = await tx.environment.findUnique({ where: { id: request.params.id } });
          if (!env) throw new KatalystError('NOT_FOUND');
          if (env.isProduction && !b.readOnly) {
            throw new KatalystError('PRODUCTION_BLOCKED', 'En producción solo se admiten usuarios de solo lectura (ESP §13.7).');
          }
          const created = await tx.testUser.create({
            data: {
              environmentId: env.id,
              label: b.label,
              username: b.username,
              secretRef: b.secretRef,
              readOnly: b.readOnly,
              allowsConcurrency: b.allowsConcurrency,
              enabled: b.enabled,
              disabledAt: b.enabled ? null : new Date(),
            },
          });
          await recordAudit(tx, {
            actor: request.principal!,
            action: 'test_user.create',
            entity: 'test_user',
            entityId: created.id,
            diff: { environmentId: env.id, ...shallowDiff(null, toTestUserDto(created), USER_DIFF_KEYS) },
            requestId: request.requestId,
          });
          return created;
        });
        return reply.status(201).send(toTestUserDto(u));
      } catch (e) {
        if (isUniqueViolation(e)) throw new KatalystError('CONFLICT', 'Ya existe un usuario con esa etiqueta en el ambiente.');
        throw e;
      }
    },
  );

  app.put(
    '/environments/:id/users/:userId',
    {
      ...routeAuth('PUT', '/environments/:id/users/:userId'),
      schema: {
        tags: ['environments'],
        summary: 'Actualizar usuario de prueba',
        params: EnvironmentUserParamsSchema,
        body: TestUserUpdateSchema,
        response: { 200: TestUserSchema },
      },
    },
    async (request) => {
      const b = request.body;
      if (b.secretRef) assertSecretRefAdministrable(b.secretRef);
      try {
        const u = await prisma.$transaction(async (tx) => {
          const cur = await tx.testUser.findFirst({
            where: { id: request.params.userId, environmentId: request.params.id },
            include: { environment: { select: { isProduction: true } } },
          });
          if (!cur) throw new KatalystError('NOT_FOUND');
          if (cur.version !== b.version) throw new KatalystError('VERSION_CONFLICT');
          if (cur.environment.isProduction && (b.readOnly ?? cur.readOnly) === false) {
            throw new KatalystError('PRODUCTION_BLOCKED', 'En producción solo se admiten usuarios de solo lectura (ESP §13.7).');
          }
          const data: Prisma.TestUserUpdateManyMutationInput = { version: { increment: 1 } };
          if (b.label !== undefined) data.label = b.label;
          if (b.username !== undefined) data.username = b.username;
          if (b.secretRef !== undefined) data.secretRef = b.secretRef;
          if (b.readOnly !== undefined) data.readOnly = b.readOnly;
          if (b.allowsConcurrency !== undefined) data.allowsConcurrency = b.allowsConcurrency;
          if (b.enabled !== undefined) {
            data.enabled = b.enabled;
            data.disabledAt = b.enabled ? null : (cur.disabledAt ?? new Date());
          }
          const r = await tx.testUser.updateMany({ where: { id: cur.id, version: b.version }, data });
          if (r.count === 0) throw new KatalystError('VERSION_CONFLICT');
          const after = await tx.testUser.findUniqueOrThrow({ where: { id: cur.id } });
          await recordAudit(tx, {
            actor: request.principal!,
            action: 'test_user.update',
            entity: 'test_user',
            entityId: cur.id,
            diff: shallowDiff(toTestUserDto(cur), toTestUserDto(after), USER_DIFF_KEYS),
            requestId: request.requestId,
          });
          return after;
        });
        return toTestUserDto(u);
      } catch (e) {
        if (isUniqueViolation(e)) throw new KatalystError('CONFLICT', 'Ya existe un usuario con esa etiqueta en el ambiente.');
        throw e;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Parámetros administrativos (ESP §13.3)
  // -------------------------------------------------------------------------

  app.get(
    '/settings/runtime',
    {
      ...routeAuth('GET', '/settings/runtime'),
      schema: { tags: ['environments'], summary: 'Parámetros administrativos (timeouts, capacidad)', response: { 200: RuntimeSettingsSchema } },
    },
    async () => getRuntimeSettings(prisma),
  );

  app.put(
    '/settings/runtime',
    {
      ...routeAuth('PUT', '/settings/runtime'),
      schema: {
        tags: ['environments'],
        summary: 'Actualizar parámetros administrativos (auditado)',
        body: RuntimeSettingsUpdateSchema,
        response: { 200: RuntimeSettingsSchema },
      },
    },
    async (request) => {
      const { version, ...value } = request.body;
      return prisma.$transaction(async (tx) => {
        const before = await getRuntimeSettings(tx);
        if (before.version !== version) throw new KatalystError('VERSION_CONFLICT');
        const row = await tx.runtimeSetting.findUnique({ where: { key: RUNTIME_SETTINGS_KEY } });
        const updatedById = request.principal?.kind === 'panel_user' ? request.principal.id : null;
        if (!row) {
          await tx.runtimeSetting.create({
            data: { key: RUNTIME_SETTINGS_KEY, value: value as Prisma.InputJsonValue, version: 1, updatedById },
          });
        } else {
          const r = await tx.runtimeSetting.updateMany({
            where: { key: RUNTIME_SETTINGS_KEY, version },
            data: { value: value as Prisma.InputJsonValue, version: { increment: 1 }, updatedById },
          });
          if (r.count === 0) throw new KatalystError('VERSION_CONFLICT');
        }
        const { version: _v, ...beforeValue } = before;
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'runtime_setting.update',
          entity: 'runtime_setting',
          entityId: RUNTIME_SETTINGS_KEY,
          diff: shallowDiff(beforeValue as Record<string, unknown>, value as Record<string, unknown>, ['timeouts', 'capacity', 'schedule']),
          requestId: request.requestId,
        });
        return getRuntimeSettings(tx);
      });
    },
  );
};

export default environmentsRoutes;
