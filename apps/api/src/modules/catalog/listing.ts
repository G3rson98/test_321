/**
 * Punto de entrada de `POST /worker/catalog/listing` (módulo worker de API-B delega aquí; RF-CAT-01, ESP §4).
 * El supervisor del runner hizo checkout del commit permitido y ejecutó `playwright --list` aislado, sin secretos;
 * aquí solo se valida el resultado (nunca se ejecuta ni importa código de tests) y se aplica con `ingestCatalogListing`.
 */
import type { PrismaClient } from '@prisma/client';
import { KatalystError, WorkerCatalogListingRequestSchema } from '@katalyst/shared';
import type { Principal } from '../../lib/auth.js';
import { ingestCatalogListing } from './service.js';

/** Tamaño máximo aceptado (manifiesto + listado serializados). La ruta del worker debe fijar `bodyLimit` ≥ este valor. */
export const MAX_LISTING_BYTES = 16 * 1024 * 1024;

export async function applyCatalogListing(prisma: PrismaClient, body: unknown, principal: Principal): Promise<{ status: string }> {
  // Solo la credencial de servicio del supervisor (scope worker.claim ya verificado por routeGuard) entrega listados.
  if (principal.kind !== 'service') throw new KatalystError('FORBIDDEN');
  const parsed = WorkerCatalogListingRequestSchema.safeParse(body);
  if (!parsed.success) throw new KatalystError('VALIDATION_FAILED');
  const size = Buffer.byteLength(JSON.stringify({ m: parsed.data.manifest, l: parsed.data.playwrightList }));
  if (size > MAX_LISTING_BYTES) {
    return ingestCatalogListing(prisma, principal, {
      ...parsed.data,
      manifest: null,
      playwrightList: null,
      error: `El listado excede ${MAX_LISTING_BYTES} bytes.`,
    });
  }
  return ingestCatalogListing(prisma, principal, {
    catalogRevisionId: parsed.data.catalogRevisionId,
    gitCommit: parsed.data.gitCommit,
    manifest: parsed.data.manifest ?? null,
    playwrightList: parsed.data.playwrightList ?? null,
    error: parsed.data.error ?? null,
  });
}
