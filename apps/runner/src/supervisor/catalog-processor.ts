/**
 * Trabajos `catalog-listing` (RF-CAT-01; ESP §4: "incluso listar tests importa código; usar contenedor aislado sin
 * secretos sobre commit permitido"). Checkout del commit (debe pertenecer a la rama protegida), instalación aislada
 * si hace falta, `playwright test --list --reporter=json` SIN red y SIN secretos, lectura del manifiesto y envío a
 * `POST /worker/catalog/listing` con la credencial de servicio. Nunca dentro de la API.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CatalogListingJobPayloadSchema, sanitizeErrorMessage, type CatalogListingJobPayload } from '@katalyst/shared';
import { resolvePlaywright } from '../executor/playwright-process.js';
import type { Logger } from '../logger.js';
import { readManifest } from '../manifest-check.js';
import { rmrf } from '../util/fs.js';
import type { SupervisorApiClient } from '../worker-api/types.js';
import type { DependencyInstaller } from './dependency-installer.js';
import { CommitNotAllowedError, CommitNotAvailableError, type GitCheckout } from './git-checkout.js';
import type { ExecutorLauncher } from './launcher/types.js';

/** Payload de la cola `catalog-listing` (`CatalogListingJobPayloadSchema` de @katalyst/shared, encolado por API-A). */
export { CatalogListingJobPayloadSchema, type CatalogListingJobPayload };

/**
 * Límite del cuerpo de `POST /worker/catalog/listing`: la API acepta `MAX_LISTING_BYTES` = 16 MiB de manifiesto +
 * listado serializados (`apps/api/src/modules/catalog/listing.ts`, D-050; `bodyLimit` = 16 MiB + 256 KiB). Si se
 * excede, se envía `error: 'listado_demasiado_grande'` en vez del listado (un 413 dejaría la revisión `en_curso`).
 */
export const MAX_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_LIST_BYTES = MAX_LISTING_BYTES;
const TOO_LARGE = 'listado_demasiado_grande';

export interface CatalogProcessorDeps {
  api: SupervisorApiClient;
  checkout: GitCheckout;
  installer: DependencyInstaller;
  launcher: ExecutorLauncher;
  workDir: string;
  timeoutMs: number;
  logger: Logger;
}

export class CatalogProcessor {
  constructor(private readonly d: CatalogProcessorDeps) {}

  async process(raw: unknown): Promise<{ status: string }> {
    const job = CatalogListingJobPayloadSchema.parse(raw);
    const log = this.d.logger.child({ catalogRevisionId: job.catalogRevisionId, commit: job.gitCommit });
    let result = await this.list(job, log);
    if (result.manifest !== null || result.playwrightList !== null) {
      const size = Buffer.byteLength(JSON.stringify({ m: result.manifest, l: result.playwrightList }));
      if (size > MAX_LISTING_BYTES) {
        log.warn({ size }, 'listado excede el límite de la API: se envía error');
        result = { manifest: null, playwrightList: null, error: TOO_LARGE };
      }
    }
    const res = await this.d.api.postCatalogListing({
      catalogRevisionId: job.catalogRevisionId,
      gitCommit: job.gitCommit,
      manifest: result.manifest,
      playwrightList: result.playwrightList,
      error: result.error ? sanitizeErrorMessage(result.error, 8192) : null,
    });
    log.info({ status: res.status, ok: !result.error }, 'listado de catálogo enviado');
    return { status: res.status };
  }

  private async list(
    job: CatalogListingJobPayload,
    log: Logger,
  ): Promise<{ manifest: unknown; playwrightList: unknown; error: string | null }> {
    let co;
    try {
      co = await this.d.checkout.prepare(job.gitCommit);
    } catch (e) {
      if (e instanceof CommitNotAvailableError) return { manifest: null, playwrightList: null, error: 'commit_no_disponible: el commit no puede obtenerse' };
      if (e instanceof CommitNotAllowedError) return { manifest: null, playwrightList: null, error: 'commit_no_permitido: el commit no pertenece a la rama protegida' };
      return { manifest: null, playwrightList: null, error: 'checkout_fallido: no se pudo preparar el commit' };
    }
    const { raw: manifest } = await readManifest(co.testsDir);
    try {
      await this.d.installer.ensure(co, null);
    } catch (e) {
      return { manifest, playwrightList: null, error: `dependencia_fallida: ${(e as Error).message}` };
    }
    const pw = resolvePlaywright(co.testsDir);
    if (!pw) return { manifest, playwrightList: null, error: 'dependencia_fallida: @playwright/test no instalado' };
    const realRoot = await fs.realpath(co.root);
    const realCli = await fs.realpath(pw.cliPath);
    const relCli = path.relative(realRoot, realCli);
    // En contenedor solo se monta el checkout: Playwright debe estar dentro de él.
    const inside = !relCli.startsWith('..') && !path.isAbsolute(relCli);
    if (this.d.launcher.kind === 'docker' && !inside) {
      return { manifest, playwrightList: null, error: 'dependencia_fallida: Playwright fuera del checkout' };
    }
    const cliFor = (root: string) => (inside ? path.posix.join(root, relCli.split(path.sep).join('/')) : realCli);
    const outDir = path.join(this.d.workDir, `listing-${job.catalogRevisionId}-${randomBytes(3).toString('hex')}`);
    try {
      const r = await this.d.launcher.runIsolated({
        purpose: 'listing',
        checkoutRoot: co.root,
        testsSubdir: co.testsSubdir,
        outputDir: outDir,
        command: (rt) => [rt.node, cliFor(rt.root), 'test', '--list', '--reporter=json'],
        // Sin secretos ni ambiente: qa-tests usa `sin-ambiente` para listar.
        env: (rt) => ({ PLAYWRIGHT_JSON_OUTPUT_FILE: path.posix.join(rt.outDir, 'list.json'), FORCE_COLOR: '0' }),
        network: 'none',
        writableCheckout: false,
        cwd: 'tests',
        timeoutMs: this.d.timeoutMs,
      });
      if (r.timedOut) return { manifest, playwrightList: null, error: 'listado_timeout: el listado excedió el tiempo permitido' };
      const file = path.join(outDir, 'list.json');
      let text: string;
      try {
        const st = await fs.stat(file);
        if (st.size > MAX_LIST_BYTES) return { manifest, playwrightList: null, error: TOO_LARGE };
        text = await fs.readFile(file, 'utf8');
      } catch {
        return { manifest, playwrightList: null, error: `listado_fallido: ${r.outputTail.slice(-2000) || `código ${r.exitCode}`}` };
      }
      try {
        const playwrightList = JSON.parse(text) as unknown;
        const errors = (playwrightList as { errors?: Array<{ message?: string }> }).errors ?? [];
        return { manifest, playwrightList, error: errors.length ? `listado_con_errores: ${errors[0]?.message ?? ''}` : null };
      } catch {
        return { manifest, playwrightList: null, error: 'listado_invalido: la salida no es JSON' };
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, 'listado aislado fallido');
      return { manifest, playwrightList: null, error: 'listado_fallido: error del runner' };
    } finally {
      await rmrf(outDir);
    }
  }
}
