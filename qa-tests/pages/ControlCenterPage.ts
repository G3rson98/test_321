/**
 * Página principal "Informe operativo" (`/controlCenterShipper`). ESP §2; RF-REN-01 (arranque de la raíz).
 *
 * Servicios de la pantalla: users/api/users/current, place, setting/i18n, notification/user,
 * dashboard/powerBi/token, dashboard/shippingOrderIds.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { DEFAULT_SERVICE_TIMEOUT_MS, FRONTEND_CURRENT_TIMEOUT_MS, UI_READY_TIMEOUT_MS } from '../fixtures/timeouts.ts';
import { MUI_LOADER_SELECTORS } from './inovua.ts';
import { SERVICES, waitForService, type ServiceDef } from './services.ts';

export const CONTROL_CENTER_PATH = '/controlCenterShipper';

/** Servicios que la página principal debe completar al arrancar (ESP §2). */
export const CONTROL_CENTER_SERVICES: readonly ServiceDef[] = [
  SERVICES.usersCurrent,
  SERVICES.place,
  SERVICES.settingI18n,
  SERVICES.notificationUser,
  SERVICES.powerBiToken,
  SERVICES.shippingOrderIds,
];

export interface RootStartResult {
  /** Instante (epoch ms) en que se inició la navegación. */
  navigationStartedAt: number;
  current: Response;
  /** Respuestas del resto de servicios de la página, por clave de servicio. */
  services: Map<string, Response>;
}

export class ControlCenterPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly mainNavigation: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO selector (Bloque 0): confirmar encabezado/título visible "Informe operativo" (o data-testid, regla 8).
    this.heading = page.getByRole('heading', { name: /informe operativo/i }).first();
    // TODO selector (Bloque 0): confirmar landmark de navegación principal (menú lateral MUI Drawer).
    this.mainNavigation = page.getByRole('navigation').first();
  }

  /**
   * Navega a `path` (raíz por defecto) esperando `current` con el timeout real del frontend (30 s) y, si se pide, el
   * resto de servicios de la página principal. Las esperas se crean antes de navegar.
   */
  async start(path = '/', opts: { withServices?: boolean } = {}): Promise<RootStartResult> {
    const currentPromise = waitForService(this.page, SERVICES.usersCurrent, { timeout: FRONTEND_CURRENT_TIMEOUT_MS });
    const others = (opts.withServices ? CONTROL_CENTER_SERVICES.filter((s) => s !== SERVICES.usersCurrent) : []).map(
      (service) =>
        waitForService(this.page, service, { timeout: DEFAULT_SERVICE_TIMEOUT_MS }).then((r) => [service.key, r] as const),
    );
    const navigationStartedAt = Date.now();
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    const [current, ...entries] = await Promise.all([currentPromise, ...others]);
    return { navigationStartedAt, current, services: new Map(entries) };
  }

  /**
   * Condición de "app utilizable" (frontera `root_ready`, ESP §13.8): ruta de la página principal, encabezado y
   * navegación visibles y sin loaders MUI visibles. TODO(Bloque 0): confirmar que la raíz redirige a
   * /controlCenterShipper para el usuario de prueba.
   */
  async expectUsable(timeout = UI_READY_TIMEOUT_MS): Promise<void> {
    await expect(this.page, 'La raíz no llevó a la página principal').toHaveURL(/\/controlCenterShipper(?:[/?#]|$)/, {
      timeout,
    });
    await expect(this.heading, 'No se ve el encabezado "Informe operativo"').toBeVisible({ timeout });
    await expect(this.mainNavigation, 'No se ve la navegación principal').toBeVisible({ timeout });
    for (const selector of Object.values(MUI_LOADER_SELECTORS)) {
      await expect(this.page.locator(selector).filter({ visible: true }), `Loader visible (${selector})`).toHaveCount(0, {
        timeout,
      });
    }
  }
}
