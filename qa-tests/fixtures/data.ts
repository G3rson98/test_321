/**
 * Datos de prueba para futuros tests `@escritura` (ESP §10 reglas 6 y 10; RNF-SEG-04; RF-EJE-05/06; ESP §13.3).
 *
 * - Prefijo único `QA-AUTO-<runId>-<worker>-<uuid>` para todo dato creado por un test.
 * - Limpieza en `finally`, en orden inverso de creación, limitada a recursos con el prefijo del test (nunca datos
 *   ajenos al prefijo y propietario). Los residuos que no se puedan limpiar quedan para la tarea de reconciliación.
 * - Los tests de escritura nunca corren en producción y no se reintentan salvo idempotencia aprobada en el
 *   manifiesto (`writeIdempotencyApproved`).
 *
 * Ejemplo de uso (test de escritura futuro, clasificado `escritura` en katalyst.manifest.json):
 *
 * ```ts
 * import { test } from '../../fixtures/test.ts';
 * import { configureWriteSuite, withTestData } from '../../fixtures/data.ts';
 *
 * configureWriteSuite(test, { idempotencyApproved: false });
 *
 * test('C1234 Crear agendamiento sintético @agendamiento @escritura', async ({ page, katalystEnv }, testInfo) => {
 *   await withTestData(testInfo, katalystEnv, async (data) => {
 *     const nombre = data.name('agendamiento');           // QA-AUTO-<runId>-w0-<uuid>-agendamiento
 *     // ... crear en la UI ...
 *     data.registerCleanup(nombre, async () => { ... borrar por UI/API ... });
 *     // ... verificaciones ...
 *   });
 * });
 * ```
 */
import { randomUUID } from 'node:crypto';
import type { TestInfo, TestType } from '@playwright/test';
import type { KatalystEnv } from './env.ts';
import { KatalystError } from './errors.ts';

export const TEST_DATA_PREFIX_ROOT = 'QA-AUTO';

const SAFE_SEGMENT = /[^A-Za-z0-9_-]/g;

export interface TestDataPrefixParts {
  runId: string;
  worker: number | string;
  uuid?: string;
}

/** Construye `QA-AUTO-<runId>-<worker>-<uuid>`; los segmentos se reducen a [A-Za-z0-9_-]. */
export function buildTestDataPrefix(parts: TestDataPrefixParts): string {
  const runId = String(parts.runId).replace(SAFE_SEGMENT, '');
  const worker = typeof parts.worker === 'number' ? `w${parts.worker}` : String(parts.worker).replace(SAFE_SEGMENT, '');
  const uuid = (parts.uuid ?? randomUUID()).replace(SAFE_SEGMENT, '');
  if (!runId || !worker || !uuid) {
    throw new KatalystError('configuracion_invalida', 'Prefijo de datos inválido: runId, worker y uuid son obligatorios.');
  }
  return `${TEST_DATA_PREFIX_ROOT}-${runId}-${worker}-${uuid}`;
}

/** Comprueba que un identificador pertenece al prefijo del test antes de borrarlo. */
export function assertOwnedByPrefix(identifier: string, prefix: string): void {
  if (!identifier.startsWith(`${prefix}`)) {
    throw new KatalystError(
      'datos_fuera_de_prefijo',
      'Se intentó limpiar un recurso que no pertenece al prefijo del test; se omite para no borrar datos ajenos.',
    );
  }
}

/** Impide crear datos en ambientes marcados como producción (RNF-SEG-04, RF-EJE-06). */
export function assertWriteAllowed(env: Pick<KatalystEnv, 'isProduction' | 'envName'>): void {
  if (env.isProduction) {
    throw new KatalystError(
      'datos_escritura_en_produccion',
      `El ambiente "${env.envName}" está marcado como producción: los tests de escritura están bloqueados.`,
    );
  }
}

interface CleanupEntry {
  identifier: string;
  fn: () => Promise<void>;
}

export interface TestDataScope {
  /** Prefijo `QA-AUTO-<runId>-<worker>-<uuid>` de este test. */
  readonly prefix: string;
  /** Nombre derivado del prefijo: `<prefix>-<etiqueta>`. */
  name(label: string): string;
  /** Registra la limpieza de un recurso creado (se ejecuta en `finally`, orden inverso). */
  registerCleanup(identifier: string, fn: () => Promise<void>): void;
}

/**
 * Ejecuta `body` con un ámbito de datos y garantiza la limpieza en `finally`. Si el cuerpo falla, se conserva su
 * error; los errores de limpieza se anotan en el test (`katalyst.cleanup`) para la reconciliación de residuos.
 */
export async function withTestData<T>(
  testInfo: TestInfo,
  env: Pick<KatalystEnv, 'isProduction' | 'envName' | 'runId'>,
  body: (scope: TestDataScope) => Promise<T>,
): Promise<T> {
  assertWriteAllowed(env);
  const prefix = buildTestDataPrefix({ runId: env.runId, worker: testInfo.parallelIndex });
  const cleanups: CleanupEntry[] = [];
  const scope: TestDataScope = {
    prefix,
    name(label: string): string {
      const clean = label.replace(SAFE_SEGMENT, '').slice(0, 40);
      return clean ? `${prefix}-${clean}` : prefix;
    },
    registerCleanup(identifier: string, fn: () => Promise<void>): void {
      assertOwnedByPrefix(identifier, prefix);
      cleanups.push({ identifier, fn });
    },
  };
  testInfo.annotations.push({ type: 'katalyst.dataPrefix', description: prefix });

  let bodyError: unknown;
  try {
    return await body(scope);
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const failures: string[] = [];
    for (const entry of cleanups.reverse()) {
      try {
        await entry.fn();
      } catch (error) {
        failures.push(`${entry.identifier}: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
    if (failures.length > 0) {
      testInfo.annotations.push({
        type: 'katalyst.cleanup',
        description: `datos_cleanup_fallido: ${failures.length} recurso(s) pendientes de reconciliación (${failures.join('; ')})`,
      });
      // Si el cuerpo pasó, el residuo convierte el test en fallido: un dato huérfano no es un éxito silencioso.
      if (bodyError === undefined) {
        // eslint-disable-next-line no-unsafe-finally
        throw new KatalystError('datos_cleanup_fallido', `No se pudo limpiar ${failures.length} recurso(s) con prefijo ${prefix}.`);
      }
    }
  }
}

/**
 * Configura un archivo de tests de escritura: sin reintentos automáticos salvo idempotencia aprobada (ESP §13.3) y
 * ejecución serial dentro del archivo.
 */
export function configureWriteSuite(
  test: Pick<TestType<object, object>, 'describe'>,
  opts: { idempotencyApproved: boolean },
): void {
  test.describe.configure({ mode: 'serial', ...(opts.idempotencyApproved ? {} : { retries: 0 }) });
}
