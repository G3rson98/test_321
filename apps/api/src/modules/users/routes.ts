/**
 * Administración de usuarios del panel (admin): roles qa/dev/admin, deshabilitar sin borrar (ESP §7: no se borran
 * usuarios referenciados por historial), concurrencia optimista por `version`, protección del último admin.
 * RF-USR-01, RF-USR-02.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { PanelUser, Prisma } from '@prisma/client';
import {
  IdParamsSchema,
  KatalystError,
  PanelUserCreateSchema,
  PanelUserListQuerySchema,
  PanelUserSchema,
  PanelUserUpdateSchema,
  pageSchema,
} from '@katalyst/shared';
import { routeAuth } from '../../lib/auth.js';
import { recordAudit, shallowDiff } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto-tokens.js';
import { QueryBool, decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, parseSort } from '../../lib/pagination.js';
import { revokeUserSessions } from '../auth/sessions.js';

export function toPanelUserDto(u: PanelUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    hasLocalPassword: !!u.passwordHash,
    authSubject: u.authSubject,
    disabledAt: u.disabledAt?.toISOString() ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    version: u.version,
  };
}

const ListQuery = PanelUserListQuerySchema.extend({ includeDisabled: QueryBool.default(false) });

async function assertNotLastAdmin(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Bloqueo de filas admin activas para serializar cambios concurrentes de rol/deshabilitación.
  const admins = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id" FROM "panel_user" WHERE "role" = 'admin' AND "disabled_at" IS NULL FOR UPDATE`;
  if (admins.length <= 1 && admins.some((a) => a.id === userId)) throw new KatalystError('LAST_ADMIN');
}

export const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/users',
    {
      ...routeAuth('GET', '/users'),
      schema: { tags: ['users'], summary: 'Usuarios del panel', querystring: ListQuery, response: { 200: pageSchema(PanelUserSchema) } },
    },
    async (request) => {
      const q = request.query;
      const sort = parseSort(q.sort, { email: 'string', name: 'string', createdAt: 'date' });
      const after = decodePageCursor(q.cursor, sort);
      const rows = await prisma.panelUser.findMany({
        where: {
          AND: [
            q.includeDisabled ? {} : { disabledAt: null },
            q.role ? { role: q.role } : {},
            q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] } : {},
            keysetWhere(sort, after),
          ],
        },
        orderBy: keysetOrderBy(sort),
        take: q.limit + 1,
      });
      return paginateMapped(rows, q.limit, sort, toPanelUserDto);
    },
  );

  app.post(
    '/users',
    {
      ...routeAuth('POST', '/users'),
      schema: { tags: ['users'], summary: 'Crear usuario del panel', body: PanelUserCreateSchema, response: { 201: PanelUserSchema } },
    },
    async (request, reply) => {
      const { email, name, role, initialPassword } = request.body;
      const passwordHash = initialPassword ? await hashPassword(initialPassword) : null;
      const user = await prisma.$transaction(async (tx) => {
        const exists = await tx.panelUser.findUnique({ where: { email }, select: { id: true } });
        if (exists) throw new KatalystError('EMAIL_TAKEN');
        const u = await tx.panelUser.create({ data: { email, name, role, passwordHash } });
        await recordAudit(tx, {
          actor: request.principal!,
          action: 'panel_user.create',
          entity: 'panel_user',
          entityId: u.id,
          diff: { email, name, role, localPassword: !!passwordHash },
          requestId: request.requestId,
        });
        return u;
      });
      return reply.status(201).send(toPanelUserDto(user));
    },
  );

  app.get(
    '/users/:id',
    {
      ...routeAuth('GET', '/users/:id'),
      schema: { tags: ['users'], summary: 'Detalle de usuario', params: IdParamsSchema, response: { 200: PanelUserSchema } },
    },
    async (request) => {
      const u = await prisma.panelUser.findUnique({ where: { id: request.params.id } });
      if (!u) throw new KatalystError('NOT_FOUND');
      return toPanelUserDto(u);
    },
  );

  app.put(
    '/users/:id',
    {
      ...routeAuth('PUT', '/users/:id'),
      schema: {
        tags: ['users'],
        summary: 'Actualizar rol/nombre o deshabilitar (sin borrar)',
        params: IdParamsSchema,
        body: PanelUserUpdateSchema,
        response: { 200: PanelUserSchema },
      },
    },
    async (request) => {
      const { id } = request.params;
      const b = request.body;
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.panelUser.findUnique({ where: { id } });
        if (!u) throw new KatalystError('NOT_FOUND');
        if (u.version !== b.version) throw new KatalystError('VERSION_CONFLICT');
        const disabling = b.disabled === true && !u.disabledAt;
        const demoting = b.role !== undefined && b.role !== 'admin' && u.role === 'admin';
        if ((disabling || demoting) && u.role === 'admin' && !u.disabledAt) await assertNotLastAdmin(tx, id);
        const data: Prisma.PanelUserUpdateManyMutationInput = { version: { increment: 1 } };
        if (b.name !== undefined) data.name = b.name;
        if (b.role !== undefined) data.role = b.role;
        if (b.disabled !== undefined) data.disabledAt = b.disabled ? (u.disabledAt ?? new Date()) : null;
        const res = await tx.panelUser.updateMany({ where: { id, version: b.version }, data });
        if (res.count === 0) throw new KatalystError('VERSION_CONFLICT');
        const after = await tx.panelUser.findUniqueOrThrow({ where: { id } });
        if (disabling || (b.role !== undefined && b.role !== u.role)) await revokeUserSessions(tx, id);
        await recordAudit(tx, {
          actor: request.principal!,
          action: disabling ? 'panel_user.disable' : 'panel_user.update',
          entity: 'panel_user',
          entityId: id,
          diff: shallowDiff(
            { name: u.name, role: u.role, disabled: !!u.disabledAt },
            { name: after.name, role: after.role, disabled: !!after.disabledAt },
            ['name', 'role', 'disabled'],
          ),
          requestId: request.requestId,
        });
        return after;
      });
      return toPanelUserDto(updated);
    },
  );
};

export default usersRoutes;
