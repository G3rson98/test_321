/**
 * Módulo artifacts: lista de evidencia de una corrida y acceso autorizado por recurso (URL firmada ≤ 5 min o ticket
 * de un solo uso del visor en origen separado). RF-RES-02, RNF-SEG-05.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ArtifactAccessResponseSchema, ArtifactParamsSchema, ArtifactSchema, IdParamsSchema } from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { artifactStoreOf } from '../runs/deps.js';
import { accessArtifact, listRunArtifacts } from './service.js';

const TAGS = ['artifacts'];

export const artifactsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/runs/:id/artifacts',
    {
      ...routeGuard('GET', '/runs/:id/artifacts'),
      schema: { tags: TAGS, params: IdParamsSchema, response: { 200: z.object({ items: z.array(ArtifactSchema) }) } },
    },
    async (request) => listRunArtifacts(app.deps.prisma, request.params.id),
  );

  app.get(
    '/runs/:id/artifacts/:artifactId',
    {
      ...routeGuard('GET', '/runs/:id/artifacts/:artifactId'),
      schema: { tags: TAGS, params: ArtifactParamsSchema, response: { 200: ArtifactAccessResponseSchema } },
    },
    async (request, reply) => {
      const c = app.deps.config;
      const res = await accessArtifact(
        {
          prisma: app.deps.prisma,
          store: await artifactStoreOf(app),
          signedUrlTtlSeconds: c.SIGNED_URL_TTL_SECONDS,
          publicBaseUrl: c.PUBLIC_BASE_URL,
          redis: app.deps.redis,
          queuePrefix: c.QUEUE_PREFIX,
          reportsBaseUrl: c.REPORTS_BASE_URL,
        },
        request.params.id,
        request.params.artifactId,
      );
      void reply.header('cache-control', 'no-store');
      return res;
    },
  );
};

export default artifactsRoutes;
