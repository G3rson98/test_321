/**
 * Servicios de FMS DeltaX observados por pantalla (ESP §2, tabla "Pantallas y servicios principales").
 *
 * Esperas por condición con `waitForResponse` (ESP §10 regla 3). Las rutas exactas (prefijos de microservicio y
 * método HTTP) se confirman en Bloque 0 con tráfico real de staging; las expresiones aquí son tolerantes al prefijo
 * pero exigen el origen de `KATALYST_API_URL` para no confundir assets o terceros.
 */
import type { Page, Request, Response } from '@playwright/test';
import { readEnv } from '../fixtures/env.ts';
import { DEFAULT_SERVICE_TIMEOUT_MS } from '../fixtures/timeouts.ts';

export interface ServiceDef {
  /** Clave estable (snake_case) usada también como `endpoint_key` base en rendimiento. */
  key: string;
  /** Expresión sobre `URL.pathname`. */
  path: RegExp;
  /** Descripción legible para mensajes de error. */
  label: string;
}

export const SERVICES = {
  usersCurrent: { key: 'users_current', path: /\/users\/api\/users\/current\/?$/, label: 'users/api/users/current' },
  // TODO(Bloque 0): confirmar ruta exacta de `place` (ESP §2 solo indica el nombre del servicio).
  place: { key: 'place', path: /\/place(?:\/|$)/, label: 'place' },
  settingI18n: { key: 'setting_i18n', path: /\/setting\/i18n(?:\/|$)/, label: 'setting/i18n' },
  notificationUser: { key: 'notification_user', path: /\/notification\/user(?:\/|$)/, label: 'notification/user' },
  // Emite un token de Power BI: nunca se inspecciona su cuerpo ni se repite desde DXMon (ver tools/dxmon-allowlist.json).
  powerBiToken: { key: 'dashboard_powerbi_token', path: /\/dashboard\/powerBi\/token(?:\/|$)/, label: 'dashboard/powerBi/token' },
  shippingOrderIds: {
    key: 'dashboard_shipping_order_ids',
    path: /\/dashboard\/shippingOrderIds(?:\/|$)/,
    label: 'dashboard/shippingOrderIds',
  },
  loadingOrder: {
    key: 'travel_uploader_loading_order',
    path: /\/travelUploader\/api\/travelUploader\/cbc\/loadingOrder(?:\/filter)?\/?$/,
    label: 'travelUploader/api/travelUploader/cbc/loadingOrder[/filter]',
  },
  warehouse: { key: 'warehouse', path: /\/warehouse\/api\/warehouse\/?$/, label: 'warehouse/api/warehouse' },
  schedulingList: {
    key: 'warehouse_list_scheduling',
    path: /\/warehouse\/api\/warehouse\/list\/(?:filter\/)?scheduling\/?$/,
    label: 'warehouse/api/warehouse/list/[filter/]scheduling',
  },
  schedulingStatus: {
    key: 'warehouse_scheduling_status',
    path: /\/warehouse\/api\/warehouse\/scheduling\/status\/?$/,
    label: 'warehouse/api/warehouse/scheduling/status',
  },
} as const satisfies Record<string, ServiceDef>;

export type ServiceName = keyof typeof SERVICES;

function apiOrigin(): string | undefined {
  const api = readEnv().apiUrl;
  return api ? new URL(api).origin : undefined;
}

/** ¿La URL corresponde al servicio en el origen de la API configurada? */
export function matchesService(url: string, service: ServiceDef): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = apiOrigin();
  if (origin && parsed.origin !== origin) return false;
  return service.path.test(parsed.pathname);
}

/**
 * Lee `typeOperation` de la query o, si la llamada es POST con cuerpo JSON, del cuerpo. No registra el cuerpo.
 * TODO(Bloque 0): confirmar si `.../filter` envía typeOperation por query o por cuerpo.
 */
export function readTypeOperation(request: Request): string | undefined {
  const fromQuery = new URL(request.url()).searchParams.get('typeOperation');
  if (fromQuery) return fromQuery;
  try {
    const body: unknown = request.postDataJSON();
    if (body && typeof body === 'object' && 'typeOperation' in body) {
      const value = (body as Record<string, unknown>)['typeOperation'];
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    // Cuerpo no JSON: no aplica.
  }
  return undefined;
}

export interface WaitServiceOptions {
  timeout?: number;
  /** Filtro adicional (p. ej. typeOperation). */
  where?: (response: Response) => boolean;
}

/**
 * Crea la espera ANTES de la acción que dispara la llamada (patrón Promise + acción). Devuelve la primera respuesta
 * del servicio; el estado HTTP lo verifica el test.
 */
export function waitForService(page: Page, service: ServiceDef, opts: WaitServiceOptions = {}): Promise<Response> {
  const timeout = opts.timeout ?? DEFAULT_SERVICE_TIMEOUT_MS;
  return page
    .waitForResponse(
      (r) =>
        r.request().method() !== 'OPTIONS' && matchesService(r.url(), service) && (opts.where ? opts.where(r) : true),
      { timeout },
    )
    .catch((error: unknown) => {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? `sin respuesta en ${timeout} ms` : 'espera interrumpida';
      throw new Error(`Servicio ${service.label}: ${reason}.`);
    });
}
