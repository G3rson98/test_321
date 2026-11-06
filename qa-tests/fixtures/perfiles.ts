/**
 * Perfiles de datos sintéticos por ambiente (ESP §10 reglas 10 y 11).
 *
 * Una grilla vacía puede ser un estado correcto. Cada perfil declara, por pantalla, qué estado de grilla se espera:
 * - `con_filas`: el ambiente garantiza datos (fixture sembrado en staging);
 * - `vacia`: el ambiente garantiza ausencia de datos;
 * - `con_filas_o_vacia`: lectura en un ambiente sin fixture controlado (p. ej. producción de solo lectura): se exige
 *   que la grilla termine de cargar y muestre explícitamente filas o el estado vacío, nunca un loader colgado.
 *
 * Se elige con `KATALYST_FIXTURE_PROFILE` (default `default`). No contiene datos de clientes ni secretos.
 * Bloque 0: confirmar, por caso real de TestRail, el fixture que garantiza filas en staging.
 */
export type GridExpectation = 'con_filas' | 'vacia' | 'con_filas_o_vacia';

export type LoadOrderTypeOperation = 'catering' | 'direct' | 'distribution';

export interface FixtureProfile {
  /** Descripción legible del origen de los datos. */
  descripcion: string;
  loadOrder: Record<LoadOrderTypeOperation, GridExpectation>;
  warehouses: GridExpectation;
  schedulingsList: GridExpectation;
}

export const FIXTURE_PROFILES: Readonly<Record<string, FixtureProfile>> = {
  default: {
    descripcion: 'Lectura sin fixture garantizado: acepta filas o estado vacío explícito.',
    loadOrder: { catering: 'con_filas_o_vacia', direct: 'con_filas_o_vacia', distribution: 'con_filas_o_vacia' },
    warehouses: 'con_filas_o_vacia',
    schedulingsList: 'con_filas_o_vacia',
  },
  'staging-sembrado': {
    descripcion:
      'Staging con datos sintéticos sembrados (QA-AUTO-*). Pendiente Bloque 0: confirmar que el sembrado existe.',
    loadOrder: { catering: 'con_filas', direct: 'con_filas', distribution: 'con_filas' },
    warehouses: 'con_filas',
    schedulingsList: 'con_filas_o_vacia',
  },
};

export function getFixtureProfile(name: string): FixtureProfile {
  const profile = FIXTURE_PROFILES[name];
  if (!profile) {
    throw new Error(`[configuracion_invalida] Perfil de fixture desconocido: ${name}`);
  }
  return profile;
}
