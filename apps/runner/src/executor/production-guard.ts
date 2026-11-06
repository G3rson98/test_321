/**
 * Restricción de producción validada TAMBIÉN en el worker (doble control con backend; RF-EJE-06, RNF-SEG-04,
 * ESP §13.7): en producción solo tests con clasificación `lectura` y usuario de prueba de solo lectura.
 * Además, la clasificación de la asignación debe coincidir con la del manifiesto del commit (contradicción ⇒
 * bloqueado) y el test debe existir y estar aprobado en el manifiesto.
 */
import type { Manifest, ResultReason } from '@katalyst/shared';
import type { AssignedTest } from '@katalyst/shared';

export interface BlockedTest {
  test: AssignedTest;
  reason: ResultReason;
  message: string;
}

export interface GuardInput {
  tests: readonly AssignedTest[];
  isProduction: boolean;
  testUser: { readOnly: boolean } | null;
  manifest: Manifest | null;
}

export function evaluateGuards(input: GuardInput): { allowed: AssignedTest[]; blocked: BlockedTest[] } {
  const allowed: AssignedTest[] = [];
  const blocked: BlockedTest[] = [];
  const byKey = new Map((input.manifest?.tests ?? []).map((t) => [t.stableKey.toLowerCase(), t]));
  for (const test of input.tests) {
    const m = input.manifest ? byKey.get(test.stableKey.toLowerCase()) : undefined;
    if (input.manifest && !m) {
      blocked.push({ test, reason: 'test_no_aprobado', message: 'El test no figura en el manifiesto del commit asignado.' });
      continue;
    }
    if (m && m.status === 'retirado') {
      blocked.push({ test, reason: 'test_retirado', message: 'El test está retirado en el manifiesto del commit.' });
      continue;
    }
    if (m && !m.parameterKeys.includes(test.parameterKey)) {
      blocked.push({ test, reason: 'variante_faltante', message: 'La variante no está declarada en el manifiesto.' });
      continue;
    }
    if (m && m.classification !== test.classification) {
      blocked.push({
        test,
        reason: 'clasificacion_contradictoria',
        message: 'La clasificación de la asignación no coincide con el manifiesto.',
      });
      continue;
    }
    if (input.isProduction) {
      if (test.classification === 'sin_clasificar') {
        blocked.push({ test, reason: 'clasificacion_ausente', message: 'Producción exige clasificación explícita de lectura.' });
        continue;
      }
      if (test.classification !== 'lectura') {
        blocked.push({ test, reason: 'escritura_en_produccion', message: 'Producción solo admite tests de lectura.' });
        continue;
      }
      if (!input.testUser || !input.testUser.readOnly) {
        blocked.push({
          test,
          reason: 'usuario_con_escritura',
          message: 'Producción exige un usuario de prueba declarado de solo lectura.',
        });
        continue;
      }
    }
    allowed.push(test);
  }
  return { allowed, blocked };
}

/** Retries efectivos: escritura sin idempotencia aprobada ⇒ 0 (ESP §13.3, RF-EJE-05). */
export function effectiveRetries(test: AssignedTest): number {
  if (test.classification === 'sin_clasificar') return 0;
  if (test.classification === 'escritura' && !test.writeIdempotencyApproved) return 0;
  return Math.max(0, Math.min(2, test.retries));
}
