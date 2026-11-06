/**
 * Borra el storageState al terminar la invocación (RF-AMB-03: "borrar al terminar"; RNF-SEG-01; ESP §13.7).
 * El supervisor de Katalyst además desmonta el tmpfs y limpia huérfanos tras un crash antes de aceptar trabajo nuevo.
 */
import fs from 'node:fs/promises';
import { readEnv } from './fixtures/env.ts';

export default async function globalTeardown(): Promise<void> {
  const { storageStatePath } = readEnv();
  await fs.rm(storageStatePath, { force: true });
  await fs.rm(`${storageStatePath}.${process.pid}.tmp`, { force: true });
}
