/**
 * Generación asistida por IA (proveedor pendiente ESP §12; adaptador `AiProvider`). Pasos/código se tratan como datos
 * no confiables; presupuesto y timeout por solicitud; trazabilidad de modelo, versión de prompt y costo (ESP §13.7).
 * RF-GRB-03, RF-GRB-04.
 */
import { z } from 'zod';
import { GenerationKindSchema, GenerationStatusSchema } from '../enums.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';

/** `POST /generate` con `{ caseId }`. */
export const GenerateRequestSchema = z.object({ caseId: UuidSchema });
/** `POST /generate/review`: revisión asistida de una grabación. */
export const GenerateReviewRequestSchema = z.object({ recordingId: UuidSchema });

export const GenerationRequestSchema = z.object({
  id: UuidSchema,
  kind: GenerationKindSchema,
  status: GenerationStatusSchema,
  caseId: UuidSchema.nullable(),
  recordingId: UuidSchema.nullable(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  result: z
    .object({
      code: z.string(),
      todos: z.number().int().nonnegative(),
      changes: z.array(z.string()),
      needsHumanReview: z.array(z.string()),
    })
    .nullable(),
  error: z.string().nullable(),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

/** `GET /generate/{id}` y respuestas de `POST /generate[/review]`: resultado con rama/PR/archivo (API-C, D-029). */
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
export type GenerationDetail = z.infer<typeof GenerationDetailSchema>;
