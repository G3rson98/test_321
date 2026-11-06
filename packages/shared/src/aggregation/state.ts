/**
 * Máquina de estados de `run.status` (ESP §13.2). Una corrida terminal no se reabre por callbacks tardíos.
 * RF-EJE-03, RF-EJE-08.
 */
import { TERMINAL_RUN_STATUSES, type RunStatus } from '../enums.js';

export const RUN_STATUS_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  en_cola: ['preparando', 'terminada', 'omitida', 'cancelando', 'cancelada', 'interrumpida'],
  preparando: ['corriendo', 'finalizando', 'cancelando', 'interrumpida'],
  corriendo: ['finalizando', 'cancelando', 'interrumpida'],
  finalizando: ['terminada', 'cancelada', 'interrumpida'],
  cancelando: ['cancelada', 'interrumpida'],
  terminada: [],
  cancelada: [],
  interrumpida: [],
  omitida: [],
};

export function isTerminalRunStatus(s: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(s);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

/** Lanza si la transición no está permitida (usar dentro de la transacción que cambia el estado). */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new Error(`Transición de corrida no permitida: ${from} → ${to}`);
}
