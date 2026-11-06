/**
 * Módulo recordings: sesiones de grabación del asistente local (ESP §9 2C, §13.6). Cada grabación pertenece a su
 * creador (admin puede verla); 404 si no es visible. RF-GRB-01, RF-GRB-02, RF-GRB-05, RF-GRB-06.
 *
 * Contrato (RECORDER / WEB):
 * - `POST /recordings {caseId, environmentId, tags}` → 201 `{recording, assistantLink: 'katalyst://grabar?session=<id>',
 *   assistant: {linked, online, installUrl}}`. 422 RECORDING_PRODUCTION_BLOCKED en producción o ambiente sin grabación.
 * - `GET /recordings/:id` → sesión + extensión `environment {id, name, appUrl, isProduction, recordingAllowed, enabled}`.
 * - `POST /recordings/:id/status {status: vinculada|grabando|validando, steps?}` (idempotente).
 * - `POST /recordings/:id/complete {code ≤ 1 MiB, classification, title, tags, steps, pendingVerifications}` → sesión
 *   `pr_abierto` con `branch`, `prUrl`, `commit` y `rejectionReasons` = advertencias que bloquean la aprobación.
 *   Rechazo: 422 SECRET_DETECTED (sin valores) | 422 RECORDING_REJECTED (`details.reasons`), sesión `rechazada`.
 *   413 RECORDING_TOO_LARGE; 409 RECORDING_EXPIRED / RECORDING_INVALID_STATE; 502 GIT_PROVIDER_UNAVAILABLE (reintentable).
 * - `POST /recordings/:id/cancel {reason?}` (idempotente).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  HttpUrlSchema,
  IdParamsSchema,
  RecordingCancelSchema,
  RecordingCompleteSchema,
  RecordingCreateSchema,
  RecordingListQuerySchema,
  RecordingSessionSchema,
  RecordingStatusUpdateSchema,
  UuidSchema,
  pageSchema,
} from '@katalyst/shared';
import { getGitPrProvider } from '../../adapters/git-pr/index.js';
import { routeGuard } from '../../lib/auth.js';
import {
  cancelRecording,
  completeRecording,
  createRecording,
  getRecording,
  listRecordings,
  updateRecordingStatus,
} from './service.js';

export const RecordingDetailSchema = RecordingSessionSchema.extend({
  environment: z.object({
    id: UuidSchema,
    name: z.string(),
    appUrl: HttpUrlSchema.nullable(),
    isProduction: z.boolean(),
    recordingAllowed: z.boolean(),
    enabled: z.boolean(),
  }),
});

/** Enlace del asistente: SOLO el ID de sesión (ESP §13.6). */
export const RecordingCreatedSchema = z.object({
  recording: RecordingDetailSchema,
  assistantLink: z.string().regex(/^katalyst:\/\/grabar\?session=[0-9a-f-]{36}$/),
  assistant: z.object({ linked: z.boolean(), online: z.boolean(), installUrl: z.string().nullable() }),
});

export const recordingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, config } = app.deps;
  const tags = ['recordings'];

  app.post(
    '/recordings',
    {
      ...routeGuard('POST', '/recordings'),
      schema: {
        tags,
        summary: 'Crear sesión de grabación (sin credenciales ni storageState; vence en 2 h)',
        body: RecordingCreateSchema,
        response: { 201: RecordingCreatedSchema },
      },
    },
    async (request, reply) => reply.status(201).send(await createRecording(prisma, request.principal!, request.body, String(request.id))),
  );

  app.get(
    '/recordings',
    {
      ...routeGuard('GET', '/recordings'),
      schema: { tags, summary: 'Mis grabaciones', querystring: RecordingListQuerySchema, response: { 200: pageSchema(RecordingDetailSchema) } },
    },
    async (request) => listRecordings(prisma, request.principal!, request.query),
  );

  app.get(
    '/recordings/:id',
    {
      ...routeGuard('GET', '/recordings/:id'),
      schema: { tags, summary: 'Detalle de grabación', params: IdParamsSchema, response: { 200: RecordingDetailSchema } },
    },
    async (request) => getRecording(prisma, request.principal!, request.params.id),
  );

  app.post(
    '/recordings/:id/status',
    {
      ...routeGuard('POST', '/recordings/:id/status'),
      schema: {
        tags,
        summary: 'Actualizar estado desde el asistente (idempotente)',
        params: IdParamsSchema,
        body: RecordingStatusUpdateSchema,
        response: { 200: RecordingDetailSchema },
      },
    },
    async (request) => updateRecordingStatus(prisma, request.principal!, request.params.id, request.body),
  );

  app.post(
    '/recordings/:id/complete',
    {
      ...routeGuard('POST', '/recordings/:id/complete'),
      schema: {
        tags,
        summary: 'Enviar código grabado: análisis estático, rama nueva y PR/MR (RF-GRB-02)',
        params: IdParamsSchema,
        body: RecordingCompleteSchema,
        response: { 200: RecordingDetailSchema },
      },
    },
    async (request) =>
      completeRecording(
        prisma,
        { config, git: getGitPrProvider(config) },
        request.principal!,
        request.params.id,
        request.body,
        String(request.id),
      ),
  );

  app.post(
    '/recordings/:id/cancel',
    {
      ...routeGuard('POST', '/recordings/:id/cancel'),
      schema: { tags, summary: 'Cancelar grabación (idempotente)', params: IdParamsSchema, body: RecordingCancelSchema, response: { 200: RecordingDetailSchema } },
    },
    async (request) => cancelRecording(prisma, request.principal!, request.params.id, request.body.reason, String(request.id)),
  );
};

export default recordingsRoutes;
