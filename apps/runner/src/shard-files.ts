/**
 * Archivos que el supervisor monta para el ejecutor en `/run/katalyst/shards/<shardId>/secrets` (tmpfs, 0700/0600,
 * solo lectura dentro del contenedor). Nada de esto viaja por argumentos ni variables de entorno visibles
 * (ESP §13.7). `lease.json` lleva el leaseToken (alcance shard, expirable) y la asignación congelada.
 */
import { z } from 'zod';
import { GitCommitShaSchema, IsoDateTimeSchema, Sha256HexSchema, UuidSchema } from '@katalyst/shared';
import { RunnerShardAssignmentSchema } from './worker-api/types.js';

export const LeaseFileSchema = z.object({
  schemaVersion: z.literal(1),
  runId: UuidSchema,
  shardId: UuidSchema,
  leaseId: UuidSchema,
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32),
  leaseExpiresAt: IsoDateTimeSchema,
  heartbeatIntervalMs: z.number().int().positive(),
  assignment: RunnerShardAssignmentSchema,
  checkout: z.object({
    commit: GitCommitShaSchema,
    manifestHash: Sha256HexSchema,
    /** `false` solo en `local-dir` (desarrollo): el commit no pudo verificarse con git. */
    commitVerified: z.boolean(),
  }),
  image: z.object({ image: z.string().nullable(), digest: z.string().nullable() }).optional(),
});
export type LeaseFile = z.infer<typeof LeaseFileSchema>;

/** `test-user.json` (formato de qa-tests: `{username, password}`). */
export const TestUserFileSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

/** `control.json`: el supervisor indica el motivo antes de enviar SIGTERM al ejecutor. */
/** `revoke`: la API revocó el lease (watchdog/cancelación sin confirmar): detener sin más callbacks. */
export const ControlFileSchema = z.object({ stop: z.enum(['cancel', 'shutdown', 'revoke']), at: IsoDateTimeSchema });
export type ControlFile = z.infer<typeof ControlFileSchema>;

/** `executor-complete.json` en el directorio de salida: el ejecutor ya envió `POST /worker/complete`. */
export const CompleteMarkerSchema = z.object({
  shardStatus: z.enum(['completado', 'cancelado', 'interrumpido']),
  reason: z.string().nullable(),
  delivered: z.boolean(),
  at: IsoDateTimeSchema,
});
export type CompleteMarker = z.infer<typeof CompleteMarkerSchema>;
