/**
 * API de worker (plan §4.3, ESP §13.3). `claim` y `catalog/listing`: credencial de servicio del supervisor
 * (`worker.claim`). El resto: token de lease del ejecutor (`worker.callback`), con fencing `leaseId + generation`
 * en el cuerpo: lease vencido/revocado o generación vieja ⇒ 409 LEASE_STALE/LEASE_EXPIRED, sin sobrescribir.
 * Repetir un mensaje ya persistido ⇒ acuse original; misma clave con contenido distinto ⇒ 409 CALLBACK_CONFLICT.
 * RF-EJE-03, RF-EJE-05, RF-EJE-08, RF-RES-01, RF-RES-02, RF-REN-01, RF-CAT-01, RNF-CON-01, RNF-SEG-05.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  IdParamsSchema,
  KatalystError,
  parsePerfSamples,
  WorkerArtifactFinalizeRequestSchema,
  WorkerArtifactFinalizeResponseSchema,
  WorkerArtifactUploadRequestSchema,
  WorkerArtifactUploadResponseSchema,
  WorkerAttemptStartRequestSchema,
  WorkerAttemptStartResponseSchema,
  WorkerCatalogListingRequestSchema,
  WorkerCatalogListingResponseSchema,
  WorkerClaimRequestSchema,
  WorkerClaimResponseSchema,
  WorkerCompleteRequestSchema,
  WorkerCompleteResponseSchema,
  WorkerHeartbeatRequestSchema,
  WorkerHeartbeatResponseSchema,
  WorkerPerfSamplesRequestSchema,
  WorkerPerfSamplesResponseSchema,
  WorkerResultRequestSchema,
  WorkerResultResponseSchema,
} from '@katalyst/shared';
import { routeGuard } from '../../lib/auth.js';
import { runInTransaction } from '../../lib/events-publish.js';
import { claimShard, heartbeat, validateLease } from '../../services/leases.js';
import { completeShard, recordResult, startAttempt } from '../../services/results.js';
import { artifactStoreOf, leaseDepsOf, principalOf } from '../runs/deps.js';
import { finalizeUpload, registerUpload } from '../artifacts/service.js';
import { importPerfSamples } from '../perf/import.js';

const TAGS = ['worker'];

export const workerRoutes: FastifyPluginAsyncZod = async (app) => {
  const artifactDeps = async () => ({
    prisma: app.deps.prisma,
    store: await artifactStoreOf(app),
    signedUrlTtlSeconds: app.deps.config.SIGNED_URL_TTL_SECONDS,
    publicBaseUrl: app.deps.config.PUBLIC_BASE_URL,
  });

  app.post(
    '/worker/claim',
    {
      ...routeGuard('POST', '/worker/claim'),
      schema: {
        tags: TAGS,
        summary: 'Lease atómico por shard (supervisor)',
        body: WorkerClaimRequestSchema,
        response: { 200: WorkerClaimResponseSchema },
      },
    },
    async (request, reply) => {
      const res = await claimShard(leaseDepsOf(app), request.body);
      request.log.info({ runId: request.body.runId, shardId: request.body.shardId, generation: res.generation }, 'shard reclamado');
      void reply.header('cache-control', 'no-store');
      return res;
    },
  );

  app.post(
    '/worker/catalog/listing',
    {
      ...routeGuard('POST', '/worker/catalog/listing'),
      schema: {
        tags: TAGS,
        summary: 'Resultado del listado aislado del catálogo (supervisor)',
        body: WorkerCatalogListingRequestSchema,
        response: { 200: WorkerCatalogListingResponseSchema },
      },
    },
    async (request) => {
      // La lógica del catálogo (RF-CAT-01) pertenece al módulo catalog; se delega si está disponible.
      const modulePath = '../catalog/listing.js';
      const mod = (await import(modulePath).catch(() => null)) as {
        applyCatalogListing?: (prisma: typeof app.deps.prisma, body: unknown, principal: unknown) => Promise<{ status: string }>;
      } | null;
      if (!mod?.applyCatalogListing) throw new KatalystError('SERVICE_UNAVAILABLE', 'El módulo de catálogo no está disponible.');
      const r = await mod.applyCatalogListing(app.deps.prisma, request.body, principalOf(request));
      return { ok: true as const, status: r.status };
    },
  );

  app.post(
    '/worker/heartbeat',
    {
      ...routeGuard('POST', '/worker/heartbeat'),
      schema: { tags: TAGS, body: WorkerHeartbeatRequestSchema, response: { 200: WorkerHeartbeatResponseSchema } },
    },
    async (request) => heartbeat(leaseDepsOf(app), principalOf(request), request.body),
  );

  app.post(
    '/worker/attempts',
    {
      ...routeGuard('POST', '/worker/attempts'),
      schema: {
        tags: TAGS,
        summary: 'Inicio de intento (persistir antes de despachar)',
        body: WorkerAttemptStartRequestSchema,
        response: { 200: WorkerAttemptStartResponseSchema },
      },
    },
    async (request) => startAttempt(app.deps.prisma, principalOf(request), request.body, new Date()),
  );

  app.post(
    '/worker/results',
    {
      ...routeGuard('POST', '/worker/results'),
      schema: { tags: TAGS, body: WorkerResultRequestSchema, response: { 200: WorkerResultResponseSchema } },
    },
    async (request) => recordResult(app.deps.prisma, principalOf(request), request.body, new Date()),
  );

  app.post(
    '/worker/artifacts/upload',
    {
      ...routeGuard('POST', '/worker/artifacts/upload'),
      schema: {
        tags: TAGS,
        summary: 'Registrar artefacto y obtener URL de carga firmada (≤ 5 min)',
        body: WorkerArtifactUploadRequestSchema,
        response: { 200: WorkerArtifactUploadResponseSchema },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return registerUpload(await artifactDeps(), principalOf(request), request.body);
    },
  );

  app.post(
    '/worker/artifacts/:id/finalize',
    {
      ...routeGuard('POST', '/worker/artifacts/:id/finalize'),
      schema: {
        tags: TAGS,
        params: IdParamsSchema,
        body: WorkerArtifactFinalizeRequestSchema,
        response: { 200: WorkerArtifactFinalizeResponseSchema },
      },
    },
    async (request) => finalizeUpload(await artifactDeps(), principalOf(request), request.params.id, request.body),
  );

  app.post(
    '/worker/perf/samples',
    {
      ...routeGuard('POST', '/worker/perf/samples'),
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        tags: TAGS,
        summary: 'Importación DXMon (dedupe por (run_id, sample_key), cuarentena con conteo)',
        body: WorkerPerfSamplesRequestSchema,
        response: { 200: WorkerPerfSamplesResponseSchema },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const body = request.body;
      try {
        const summary = await runInTransaction(
          app.deps.prisma,
          async (tx) => {
            const { run } = await validateLease(tx, body, principal, new Date());
            return importPerfSamples(tx, run.id, body.samplesFile);
          },
          { timeout: 60_000 },
        );
        const details = parsePerfSamples(body.samplesFile, { expectedRunId: summary.runId }).quarantined.slice(0, 500);
        request.log.info({ runId: summary.runId, imported: summary.imported, quarantined: summary.quarantined }, 'muestras importadas');
        return { accepted: summary.imported, duplicates: summary.duplicates, quarantined: details, fileError: null };
      } catch (err) {
        if (err instanceof KatalystError && err.code === 'PERF_IMPORT_INVALID') {
          return { accepted: 0, duplicates: 0, quarantined: [], fileError: err.details?.reasons?.[0] ?? 'invalido' };
        }
        throw err;
      }
    },
  );

  app.post(
    '/worker/complete',
    {
      ...routeGuard('POST', '/worker/complete'),
      schema: { tags: TAGS, body: WorkerCompleteRequestSchema, response: { 200: WorkerCompleteResponseSchema } },
    },
    async (request) => {
      const res = await completeShard(
        app.deps.prisma,
        principalOf(request),
        request.body,
        new Date(),
        app.deps.config.PUBLIC_BASE_URL,
      );
      request.log.info({ leaseId: request.body.leaseId, shardStatus: request.body.shardStatus, duplicate: res.duplicate }, 'shard completado');
      return res;
    },
  );
};

export default workerRoutes;
