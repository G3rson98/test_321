/**
 * Flaky score histórico (ESP §13.1): proporción de ejecuciones completas del mismo test con resultado `inestable`
 * entre sus últimas 20, excluyendo canceladas, errores de infraestructura y omitidas. Flaky si hay ≥ 10
 * observaciones y score ≥ 0,20. Se muestra numerador/denominador y ambiente.
 * RF-CAT-04.
 */
import type { RunResultStatus } from '../enums.js';

export const FLAKY_WINDOW = 20;
export const FLAKY_MIN_OBSERVATIONS = 10;
export const FLAKY_THRESHOLD = 0.2;

export interface FlakyObservation {
  status: RunResultStatus;
  finishedAt: Date | string;
  environmentId?: string;
}

export interface FlakyScore {
  numerator: number;
  denominator: number;
  score: number | null;
  isFlaky: boolean;
  environmentId: string | null;
}

const COMPLETE: readonly RunResultStatus[] = ['pasado', 'inestable', 'fallido'];

export function flakyScore(observations: readonly FlakyObservation[], environmentId?: string): FlakyScore {
  const relevant = observations
    .filter((o) => COMPLETE.includes(o.status))
    .filter((o) => environmentId === undefined || o.environmentId === environmentId)
    .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())
    .slice(0, FLAKY_WINDOW);
  const denominator = relevant.length;
  const numerator = relevant.filter((o) => o.status === 'inestable').length;
  const score = denominator > 0 ? numerator / denominator : null;
  return {
    numerator,
    denominator,
    score,
    isFlaky: denominator >= FLAKY_MIN_OBSERVATIONS && score !== null && score >= FLAKY_THRESHOLD,
    environmentId: environmentId ?? null,
  };
}
