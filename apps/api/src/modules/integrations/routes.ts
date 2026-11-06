/**
 * Entregas pendientes y fallas de publicación a TestRail (RF-TR-08): listado visible para qa y reintento
 * administrativo auditado que reconcilia contra TestRail ANTES de reenviar (ESP §9, §13.4).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { OutboxDelivery, Prisma } from '@prisma/client';
import {
  DeliveryListQuerySchema,
  DeliveryRetryRequestSchema,
  DeliveryRetryResponseSchema,
  IdParamsSchema,
  KatalystError,
  OutboxDeliverySchema,
  pageSchema,
  type OutboxOperation,
} from '@katalyst/shared';
import { getTestRailClientFactory } from '../../adapters/testrail/index.js';
import { routeAuth } from '../../lib/auth.js';
import { getOutboxHandler } from '../../lib/outbox.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginateMapped, type SortSpec } from '../../lib/pagination.js';
import { getSecretProvider } from '../../lib/secrets.js';
import { adminRetryDelivery } from '../../control/outbox-publisher.js';
import { recomputeRunSyncStatus, registerTestRailOutboxHandlers } from '../testrail/publication.js';

export const TESTRAIL_OPERATIONS: OutboxOperation[] = [
  'testrail.add_run',
  'testrail.add_results_for_cases',
  'testrail.add_attachment_to_result',
  'testrail.close_run',
];

const SORT: SortSpec = { field: 'createdAt', direction: 'desc', type: 'date' };

export function toDeliveryDto(d: OutboxDelivery) {
  return {
    id: d.id,
    runId: d.runId,
    targetId: d.targetId,
    operation: d.operation as OutboxOperation,
    dedupKey: d.dedupKey,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    expiresAt: d.expiresAt.toISOString(),
    externalId: d.externalId,
    lastError: d.lastError,
    lastHttpStatus: d.lastHttpStatus,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export const integrationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config, logger } = app.deps;
  const secrets = getSecretProvider();
  // La API también necesita los handlers para reconciliar en el reintento administrativo.
  if (!getOutboxHandler('testrail.add_run')) {
    registerTestRailOutboxHandlers({ config, clientFactory: (c) => getTestRailClientFactory(config, secrets)(c), secrets });
  }

  app.get(
    '/integrations/testrail/deliveries',
    {
      ...routeAuth('GET', '/integrations/testrail/deliveries'),
      schema: {
        tags: ['integrations'],
        summary: 'Entregas a TestRail (pendientes, fallidas, entregadas)',
        querystring: DeliveryListQuerySchema,
        response: { 200: pageSchema(OutboxDeliverySchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodePageCursor(q.cursor, SORT);
      const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const ops = q.operation ? [q.operation].filter((o) => TESTRAIL_OPERATIONS.includes(o)) : TESTRAIL_OPERATIONS;
      const where: Prisma.OutboxDeliveryWhereInput = {
        AND: [
          { operation: { in: ops } },
          statuses ? { status: { in: statuses } } : {},
          q.runId ? { runId: q.runId } : {},
          keysetWhere(SORT, after),
        ],
      };
      const rows = await prisma.outboxDelivery.findMany({ where, orderBy: keysetOrderBy(SORT), take: q.limit + 1 });
      return paginateMapped(rows, q.limit, SORT, toDeliveryDto);
    },
  );

  app.post(
    '/integrations/testrail/deliveries/:id/retry',
    {
      ...routeAuth('POST', '/integrations/testrail/deliveries/:id/retry'),
      schema: {
        tags: ['integrations'],
        summary: 'Reintento administrativo (reconcilia antes de reenviar; auditado)',
        params: IdParamsSchema,
        body: DeliveryRetryRequestSchema,
        response: { 200: DeliveryRetryResponseSchema },
      },
    },
    async (request) => {
      const d = await prisma.outboxDelivery.findUnique({ where: { id: request.params.id }, select: { operation: true } });
      if (!d || !TESTRAIL_OPERATIONS.includes(d.operation as OutboxOperation)) throw new KatalystError('NOT_FOUND');
      const r = await adminRetryDelivery({ prisma, logger, secrets }, request.params.id, request.principal!, {
        ...(request.body.note ? { note: request.body.note } : {}),
        requestId: request.requestId,
      });
      if (r.reconciliation === 'no_aplicada' && r.delivery.targetId) {
        await prisma.$transaction(async (tx) => {
          const t = await tx.runTestRailTarget.update({
            where: { id: r.delivery.targetId! },
            data: { syncStatus: 'enviando' },
            select: { runId: true },
          });
          await recomputeRunSyncStatus(tx, t.runId);
        });
      }
      return { delivery: toDeliveryDto(r.delivery), reconciliation: r.reconciliation };
    },
  );
};

export default integrationsRoutes;
