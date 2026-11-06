/**
 * Credenciales de PRUEBA del modo mock (VITE_USE_MOCKS=true). Solo existen dentro de MSW en el navegador del
 * desarrollador; no son credenciales de ningún servicio real.
 */
export const DEMO_PASSWORD = 'katalyst-demo';
export const DEMO_USERS = [
  { email: 'ana.rojas@deltax.la', name: 'Ana Rojas', role: 'qa' },
  { email: 'carlos@deltax.la', name: 'Carlos Méndez', role: 'dev' },
  { email: 'kevin@deltax.la', name: 'Kevin Subieta', role: 'admin' },
  { email: 'luis@deltax.la', name: 'Luis Paz', role: 'qa' },
] as const;
