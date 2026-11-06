/**
 * Visor de reportes (puerto 3001, ORIGEN SEPARADO del panel; ESP §13.7, RNF-SEG-05, RF-RES-02).
 * - `GET /view/:ticket`: ticket de un solo uso (≤ 5 min, GETDEL en Redis) emitido por la API tras autorización por
 *   recurso (`GET /runs/{id}/artifacts/{artifactId}`). Sin cookies del panel: este origen nunca lee ni emite cookies.
 *   Reportes HTML con CSP estricta + `sandbox` (origen opaco, sin red saliente: `connect-src 'none'`, sin formularios
 *   ni navegación superior); trazas como descarga (`attachment`, `nosniff`). Nada del código subido corre en el origen
 *   del panel.
 * - `/_store/*` (solo `ARTIFACT_STORE=fs`, desarrollo): emula URLs firmadas S3 (HMAC, vencimiento ≤ 5 min, tamaño y
 *   checksum firmados) para carga/descarga directa.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { getConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { createRedis } from './redis.js';
import { getSecretProvider } from './lib/secrets.js';
import {
  FsArtifactStore,
  MAX_ARTIFACT_BYTES,
  createArtifactStore,
  type ArtifactStore,
} from './adapters/artifact-store/index.js';
import { consumeViewerTicket } from './modules/artifacts/service.js';

export const REPORTS_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

/**
 * CSP del reporte HTML de Playwright (autocontenido, con script inline): `sandbox allow-scripts` sin
 * `allow-same-origin` ⇒ origen opaco; `connect-src 'none'` y `form-action 'none'` impiden exfiltración.
 */
export const REPORT_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

export interface ReportsDeps {
  redis: Redis;
  store: ArtifactStore;
}

export function buildReportsApp(config: Config, deps?: ReportsDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger({ level: config.LOG_LEVEL, service: 'katalyst-reports' }) as FastifyBaseLogger,
    bodyLimit: 1024,
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(REPORTS_SECURITY_HEADERS)) {
      if (!reply.hasHeader(k)) void reply.header(k, v);
    }
    // Nunca emitir cookies desde este origen.
    reply.removeHeader('set-cookie');
    return payload;
  });
  app.get('/healthz', async () => ({ status: 'ok', service: 'katalyst-reports', version: config.SERVICE_VERSION }));
  if (!deps) return app;

  const notFound = (reply: FastifyReply) =>
    reply.status(404).type('text/plain; charset=utf-8').send('No encontrado o vencido.');

  app.get<{ Params: { ticket: string } }>('/view/:ticket', { config: {} }, async (request, reply) => {
    const t = await consumeViewerTicket(deps.redis, config.QUEUE_PREFIX, request.params.ticket);
    if (!t) return notFound(reply);
    let body;
    try {
      body = await deps.store.getStream(t.storageKey);
    } catch {
      return notFound(reply);
    }
    if (t.kind === 'reporte' && t.contentType === 'text/html') {
      void reply.header('content-security-policy', REPORT_HTML_CSP);
      void reply.header('content-disposition', 'inline');
      return reply.type('text/html; charset=utf-8').send(body);
    }
    void reply.header('content-disposition', `attachment; filename="${t.kind}-${t.artifactId}.zip"`);
    return reply.type(t.contentType).send(body);
  });

  // Emulación de URLs firmadas del almacén fs (solo desarrollo).
  if (deps.store instanceof FsArtifactStore) {
    const fsStore = deps.store;
    // Los parsers integrados (application/json, text/plain) ganan a '*': en este alcance se reemplazan todos para
    // recibir el cuerpo crudo como Buffer (checksum exacto) sea cual sea el tipo (logs, reporte JSON, capturas).
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_ARTIFACT_BYTES }, (_req, body, done) => done(null, body));
    app.put<{ Params: { '*': string }; Querystring: Record<string, string> }>(
      '/_store/*',
      { bodyLimit: MAX_ARTIFACT_BYTES },
      async (request, reply) => {
        const params = fsStore.verify('PUT', request.params['*'], request.query);
        if (!params) return reply.status(403).type('text/plain').send('Firma inválida o vencida.');
        if ((request.headers['content-type'] ?? '').split(';')[0] !== params.ct) {
          return reply.status(400).type('text/plain').send('Content-Type no coincide.');
        }
        try {
          await fsStore.acceptUpload(params, request.body as Buffer);
        } catch {
          return reply.status(400).type('text/plain').send('Tamaño o checksum no coinciden.');
        }
        return reply.status(200).send('');
      },
    );
    app.get<{ Params: { '*': string }; Querystring: Record<string, string> }>('/_store/*', async (request, reply) => {
      const params = fsStore.verify('GET', request.params['*'], request.query);
      if (!params) return reply.status(403).type('text/plain').send('Firma inválida o vencida.');
      try {
        const stream = await fsStore.getStream(params.key);
        void reply.header('content-disposition', `attachment; filename="${(params.dn ?? 'artefacto').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        return reply.type(params.ct || 'application/octet-stream').send(stream);
      } catch {
        return notFound(reply);
      }
    });
  }
  return app;
}

async function main(): Promise<void> {
  const config = getConfig();
  const redis = createRedis(config.REDIS_URL);
  const store = await createArtifactStore(config, (ref) => getSecretProvider().get(ref));
  const app = buildReportsApp(config, { redis, store });
  const shutdown = async () => {
    await app.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await app.listen({ host: config.REPORTS_HOST, port: config.REPORTS_PORT });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error('No se pudo iniciar reports:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
