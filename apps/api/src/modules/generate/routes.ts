/**
 * Módulo generate: borrador de test con IA desde los pasos del caso y revisión asistida de grabaciones (rol dev).
 * El resultado es un PR borrador en una rama `katalyst/...`; nunca se ejecuta ni toca la rama principal.
 * RF-GRB-03, RF-GRB-04 (ESP §10, §13.7).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GenerateRequestSchema, GenerateReviewRequestSchema, GenerationRequestSchema, IdParamsSchema } from '@katalyst/shared';
import { getAiProvider } from '../../adapters/ai/factory.js';
import { getGitPrProvider } from '../../adapters/git-pr/index.js';
import { routeGuard } from '../../lib/auth.js';
import { generateFromCase, getGeneration, reviewRecording } from './service.js';

export const GenerationDetailSchema = GenerationRequestSchema.extend({
  result: z
    .object({
      code: z.string(),
      todos: z.number().int().nonnegative(),
      changes: z.array(z.string()),
      needsHumanReview: z.array(z.string()),
      branch: z.string().nullable(),
      prUrl: z.string().nullable(),
      file: z.string().nullable(),
    })
    .nullable(),
});

export const generateRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const tags = ['generate'];
  const deps = async () => ({ config, ai: await getAiProvider(config), git: getGitPrProvider(config) });

  app.post(
    '/generate',
    {
      ...routeGuard('POST', '/generate'),
      schema: {
        tags,
        summary: 'Borrador de test con IA desde el caso de TestRail (PR borrador, no se ejecuta)',
        description: 'Errores: AI_DISABLED (422), AI_BUDGET_EXCEEDED (429), AI_PROVIDER_UNAVAILABLE (502), SECRET_DETECTED (422).',
        body: GenerateRequestSchema,
        response: { 201: GenerationDetailSchema },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await generateFromCase(prisma, await deps(), request.principal!, request.body.caseId, String(request.id))),
  );

  app.post(
    '/generate/review',
    {
      ...routeGuard('POST', '/generate/review'),
      schema: {
        tags,
        summary: 'Revisión asistida de una grabación con PR abierto (commit en su rama)',
        body: GenerateReviewRequestSchema,
        response: { 201: GenerationDetailSchema },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await reviewRecording(prisma, await deps(), request.principal!, request.body.recordingId, String(request.id))),
  );

  app.get(
    '/generate/:id',
    {
      ...routeGuard('GET', '/generate/:id'),
      schema: { tags, summary: 'Detalle de una solicitud de generación', params: IdParamsSchema, response: { 200: GenerationDetailSchema } },
    },
    async (request) => getGeneration(prisma, request.principal!, request.params.id),
  );
};

export default generateRoutes;
