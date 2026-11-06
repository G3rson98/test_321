/**
 * Respuestas del mock validadas con los MISMOS esquemas Zod que usa la API para serializar (Fastify + Zod descarta
 * campos no declarados). Si el seed o un handler se desvía del contrato, el mock responde 500
 * `MOCK_CONTRACT_VIOLATION` y lo registra en consola: así una divergencia se ve en pruebas y en el navegador en vez
 * de quedar oculta en el mock.
 */
import { HttpResponse } from 'msw';
import type { z } from 'zod';
import { pageSchema } from '@katalyst/shared/schemas';

export function reply<S extends z.ZodType>(schema: S, data: unknown, status = 200): Response {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => ({ path: i.path.map(String), code: i.code, message: i.message }));
    console.error('[katalyst mock] respuesta fuera de contrato', issues);
    return HttpResponse.json(
      { error: { code: 'MOCK_CONTRACT_VIOLATION', message: 'El mock produjo una respuesta fuera de contrato.', requestId: 'mock', details: { issues } } },
      { status: 500 },
    );
  }
  return HttpResponse.json(r.data as never, { status });
}

/** Página `{items, nextCursor, hasNext, total?}` validada con `pageSchema(item)`. */
export function replyPage<S extends z.ZodType>(item: S, data: unknown, status = 200): Response {
  return reply(pageSchema(item), data, status);
}
