/**
 * Manejador de errores uniforme: `{ error: { code, message, requestId, details? } }` (ESP §9).
 * - KatalystError → su código/estado.
 * - Validación Zod → 422 VALIDATION_FAILED (o el código estable si el mensaje del issue es un ErrorCode, p. ej.
 *   SELECTION_EXCLUSIVE, SELECTION_EMPTY, CRON_INVALID, THRESHOLD_MIN_SAMPLES), con issues sanitizados sin valores.
 * - 404 ROUTE_NOT_FOUND, 429 RATE_LIMITED con Retry-After, resto 500 INTERNAL_ERROR sin filtrar detalles.
 * RNF-SEG-03, RNF-OBS-01.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import {
  ERROR_CATALOG,
  isKatalystError,
  sanitizeText,
  toApiErrorBody,
  type ApiErrorDetails,
  type ErrorCode,
  type ValidationIssue,
} from '@katalyst/shared';

const MAX_ISSUES = 50;

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, v);
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ErrorCode,
  message?: string,
  details?: ApiErrorDetails,
): FastifyReply {
  const status = ERROR_CATALOG[code].status;
  const retry = details?.retryAfterSeconds;
  if (status === 429 && typeof retry === 'number') void reply.header('retry-after', String(retry));
  return reply.status(status).send(toApiErrorBody(code, String(request.id), message, details));
}

/** Convierte issues de validación en detalles sanitizados y elige el código estable más específico. */
export function mapValidation(
  validation: { instancePath?: string; keyword?: string; message?: string; params?: Record<string, unknown> }[],
  context?: string,
): { code: ErrorCode; issues: ValidationIssue[] } {
  let code: ErrorCode = 'VALIDATION_FAILED';
  const issues: ValidationIssue[] = validation.slice(0, MAX_ISSUES).map((v) => {
    const paramCode =
      v.params?.['params'] && typeof v.params['params'] === 'object'
        ? (v.params['params'] as { code?: unknown }).code
        : undefined;
    const candidate = isErrorCode(paramCode) ? paramCode : isErrorCode(v.message) ? v.message : undefined;
    if (candidate && code === 'VALIDATION_FAILED') code = candidate;
    const path = (v.instancePath ?? '')
      .split('/')
      .filter(Boolean)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return {
      path: context ? [context, ...path] : path,
      code: v.keyword ?? 'invalid',
      message: sanitizeText(candidate ? ERROR_CATALOG[candidate].message : (v.message ?? 'Inválido')).value,
    };
  });
  return { code, issues };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void sendError(reply, request, 'ROUTE_NOT_FOUND');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isKatalystError(error)) {
      if (error.status >= 500) request.log.error({ err: error }, 'error de dominio');
      return sendError(reply, request, error.code, error.message, error.details);
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const { code, issues } = mapValidation(
        error.validation,
        (error as { validationContext?: string }).validationContext,
      );
      return sendError(reply, request, code, undefined, { issues });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'respuesta no cumple el esquema');
      return sendError(reply, request, 'INTERNAL_ERROR');
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      const retryAfter = Number(reply.getHeader('retry-after') ?? 60);
      return sendError(reply, request, 'RATE_LIMITED', undefined, {
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 60,
      });
    }
    if (status === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return sendError(reply, request, 'PAYLOAD_TOO_LARGE');
    if (status === 415 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
      return sendError(reply, request, 'UNSUPPORTED_MEDIA_TYPE');
    if (status === 404) return sendError(reply, request, 'NOT_FOUND');
    if (status >= 400 && status < 500) {
      // JSON inválido u otros errores de cliente de Fastify: sin reflejar contenido.
      return sendError(reply, request, 'BAD_REQUEST');
    }
    request.log.error({ err: error }, 'error no controlado');
    return sendError(reply, request, 'INTERNAL_ERROR');
  });
}
