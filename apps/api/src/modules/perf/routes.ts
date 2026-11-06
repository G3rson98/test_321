/**
 * Módulo perf: agregados DXMon/Playwright (media/p95/máx por serie y bucket, comparación entre períodos, huecos y
 * antigüedad del último dato), errores/timeouts/> 29 s con hora exacta, umbrales y marcas de eventos.
 * RF-REN-02, RF-REN-03, RF-REN-04, RF-REN-05. La importación de muestras la expone la API de worker (API-B) usando
 * `importPerfSamples` (./import.ts).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EventMarkCreateSchema,
  EventMarkListQuerySchema,
  EventMarkSchema,
  IdParamsSchema,
  IsoDateTimeSchema,
  OkResponseSchema,
  PerfErrorItemSchema,
  PerfErrorsQuerySchema,
  PerfQuerySchema,
  PerfResponseSchema,
  PerfSeriesKeySchema,
  PerfSeriesListQuerySchema,
  PerfThresholdCreateSchema,
  PerfThresholdListQuerySchema,
  PerfThresholdSchema,
  PerfThresholdUpdateSchema,
  pageSchema,
} from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { getPerf, listPerfErrors, listSeries } from './query.js';
import {
  createEventMark,
  createThreshold,
  deleteThreshold,
  listEventMarks,
  listThresholds,
  updateThreshold,
} from './thresholds.js';

export const PerfSeriesItemSchema = PerfSeriesKeySchema.extend({
  sampleCount: z.number().int().nonnegative(),
  lastSampleAt: IsoDateTimeSchema,
});

export const perfRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma } = app.deps;
  const tags = ['perf'];

  app.get(
    '/perf',
    {
      ...routeGuard('GET', '/perf'),
      schema: {
        tags,
        summary: 'Agregados de rendimiento por serie (media, p95 por rango, máximo, conteos, huecos)',
        description:
          'p95 por rango ceil(0,95·n) sobre muestras crudas (nunca promediando percentiles); "muestra_insuficiente" con ' +
          'menos de 20 respuestas completadas; fuera de la retención de crudos (90 días) solo métricas conservadas y ' +
          'p95 "no_disponible". Máximo 1.000 puntos por serie: `granularity` indica la granularidad efectiva.',
        querystring: PerfQuerySchema,
        response: { 200: PerfResponseSchema },
      },
    },
    async (request) => getPerf(prisma, request.query),
  );

  app.get(
    '/perf/series',
    {
      ...routeGuard('GET', '/perf/series'),
      schema: { tags, summary: 'Series disponibles', querystring: PerfSeriesListQuerySchema, response: { 200: pageSchema(PerfSeriesItemSchema) } },
    },
    async (request) => listSeries(prisma, request.query),
  );

  app.get(
    '/perf/errors',
    {
      ...routeGuard('GET', '/perf/errors'),
      schema: {
        tags,
        summary: 'Errores HTTP, de red, timeouts y respuestas > 29 s con hora exacta (RF-REN-05)',
        querystring: PerfErrorsQuerySchema,
        response: { 200: pageSchema(PerfErrorItemSchema) },
      },
    },
    async (request) => listPerfErrors(prisma, request.query),
  );

  app.get(
    '/perf/thresholds',
    {
      ...routeGuard('GET', '/perf/thresholds'),
      schema: { tags, summary: 'Umbrales', querystring: PerfThresholdListQuerySchema, response: { 200: pageSchema(PerfThresholdSchema) } },
    },
    async (request) => listThresholds(prisma, request.query),
  );

  app.post(
    '/perf/thresholds',
    {
      ...routeGuard('POST', '/perf/thresholds'),
      schema: { tags, summary: 'Crear umbral (una serie, piso de muestras ≥ 20)', body: PerfThresholdCreateSchema, response: { 201: PerfThresholdSchema } },
    },
    async (request, reply) => {
      const t = await createThreshold(prisma, request.principal!, request.body, String(request.id));
      return reply.status(201).send(t);
    },
  );

  app.put(
    '/perf/thresholds/:id',
    {
      ...routeGuard('PUT', '/perf/thresholds/:id'),
      schema: { tags, summary: 'Actualizar umbral', params: IdParamsSchema, body: PerfThresholdUpdateSchema, response: { 200: PerfThresholdSchema } },
    },
    async (request) => updateThreshold(prisma, request.principal!, request.params.id, request.body, String(request.id)),
  );

  app.delete(
    '/perf/thresholds/:id',
    {
      ...routeGuard('DELETE', '/perf/thresholds/:id'),
      schema: { tags, summary: 'Eliminar umbral (borrado lógico)', params: IdParamsSchema, response: { 200: OkResponseSchema } },
    },
    async (request) => {
      await deleteThreshold(prisma, request.principal!, request.params.id, String(request.id));
      return { ok: true as const };
    },
  );

  app.get(
    '/events',
    {
      ...routeGuard('GET', '/events'),
      schema: { tags, summary: 'Marcas de eventos (despliegues)', querystring: EventMarkListQuerySchema, response: { 200: pageSchema(EventMarkSchema) } },
    },
    async (request) => listEventMarks(prisma, request.query),
  );

  app.post(
    '/events',
    {
      ...routeGuard('POST', '/events'),
      schema: {
        tags,
        summary: 'Marcar evento (despliegue con versión frontend/backend) — RF-REN-04',
        body: EventMarkCreateSchema,
        response: { 201: EventMarkSchema },
      },
    },
    async (request, reply) => reply.status(201).send(await createEventMark(prisma, request.principal!, request.body, String(request.id))),
  );
};

export default perfRoutes;
