/**
 * Datos sintéticos de referencia para tests de escritura futuros en staging (ESP §10 reglas 6 y 10, §13.7).
 * Nunca contienen datos reales de clientes ni secretos; todo nombre deriva del prefijo `QA-AUTO-...` del test.
 */
import type { TestDataScope } from './data.ts';

export interface SyntheticScheduling {
  referencia: string;
  observacion: string;
}

export function syntheticScheduling(scope: TestDataScope): SyntheticScheduling {
  return {
    referencia: scope.name('agendamiento'),
    observacion: 'Dato sintético creado por Katalyst; se elimina en el cleanup del test.',
  };
}

export interface SyntheticWarehouseFilter {
  /** Texto de búsqueda que no coincide con datos reales (útil para verificar el estado vacío). */
  textoSinCoincidencias: string;
}

export function syntheticWarehouseFilter(scope: TestDataScope): SyntheticWarehouseFilter {
  return { textoSinCoincidencias: scope.name('sin-coincidencias') };
}
