/**
 * Logger pino JSON con redacción de secretos y sanitización de mensajes de error (RNF-OBS-01, RNF-SEG-01).
 * Logs sin cuerpos por defecto (ESP §17.4). Hijos con requestId/runId para correlación.
 */
import { pino, type Logger, type LoggerOptions } from 'pino';
import { sanitizeText } from '@katalyst/shared';

/** Rutas redactadas (encabezados, credenciales y cualquier campo sensible conocido). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'password',
  'passwordHash',
  'token',
  'leaseToken',
  'accessToken',
  'deviceCode',
  'secret',
  'apiKey',
  'storageState',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.leaseToken',
  '*.accessToken',
  '*.deviceCode',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.storageState',
];

function sanitizeErr(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: sanitizeText(String(err)).value };
  const out: Record<string, unknown> = {
    type: err.name,
    message: sanitizeText(err.message).value,
  };
  if (err.stack) out.stack = sanitizeText(err.stack).value;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  return out;
}

export function createLogger(
  opts: { level?: string; service: string; pretty?: boolean } & Partial<LoggerOptions>,
): Logger {
  const { level = 'info', service, pretty = false, ...rest } = opts;
  return pino({
    level,
    base: { service },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: sanitizeErr,
      error: sanitizeErr,
      req: (req: { method?: string; url?: string; id?: string }) => ({
        method: req.method,
        // Quitar query string: puede contener datos sensibles (ESP §13.7).
        url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        id: req.id,
      }),
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
    ...rest,
  });
}

/** Logger hijo correlacionado con corrida/solicitud. */
export function withContext(logger: Logger, ctx: { requestId?: string; runId?: string; shardId?: string }): Logger {
  return logger.child(ctx);
}
