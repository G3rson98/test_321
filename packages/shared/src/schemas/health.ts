/** Health/liveness y readiness sin secretos (RNF-OBS-02). */
import { z } from 'zod';

export const HealthzResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});

const CheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});

export const ReadyzResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: CheckSchema, redis: CheckSchema }),
});
export type ReadyzResponse = z.infer<typeof ReadyzResponseSchema>;
