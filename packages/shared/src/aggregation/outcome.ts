/**
 * `outcome` de la corrida (ESP §13.2):
 * `fallido` si existe test fallido; si no, `bloqueado` si hay caso parcial/bloqueado; luego `inestable` si pasó tras
 * retry; `pasado` si todo lo seleccionado está cubierto y pasó. Canceladas/interrumpidas/omitidas → `incompleto`;
 * activa → `null`. Una corrida bloqueada nunca se presenta como exitosa.
 * RF-RES-05, RF-EJE-05.
 */
import type { CaseResultStatus, Coverage, RunOutcome, RunResultStatus, RunStatus } from '../enums.js';
import { isTerminalRunStatus } from './state.js';

export interface OutcomeInput {
  status: RunStatus;
  results: readonly { status: RunResultStatus }[];
  cases: readonly { status: CaseResultStatus; coverage: Coverage }[];
}

export function computeRunOutcome(input: OutcomeInput): RunOutcome | null {
  if (!isTerminalRunStatus(input.status)) return null;
  if (input.status !== 'terminada') return 'incompleto';
  if (input.results.some((r) => r.status === 'fallido') || input.cases.some((c) => c.status === 'fallido')) {
    return 'fallido';
  }
  const allResultsOk = input.results.every((r) => r.status === 'pasado' || r.status === 'inestable');
  const allCasesOk = input.cases.every(
    (c) => (c.status === 'pasado' || c.status === 'inestable') && c.coverage === 'completa',
  );
  if (!allResultsOk || !allCasesOk || (input.results.length === 0 && input.cases.length === 0)) return 'bloqueado';
  if (input.results.some((r) => r.status === 'inestable') || input.cases.some((c) => c.status === 'inestable')) {
    return 'inestable';
  }
  return 'pasado';
}
