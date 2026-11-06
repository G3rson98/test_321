/**
 * Configuración de seguridad de la ventana privilegiada (ESP §4: "sin Node en renderer, aislamiento de contexto y
 * protocolo local seguro"; ARQ: "sin contenido remoto privilegiado"). Pura y probada sin Electron.
 * - contextIsolation, sandbox, sin nodeIntegration (ni en workers/subframes), sin webview, webSecurity activo.
 * - Toda apertura de ventanas se deniega; la navegación fuera de la app se bloquea; permisos denegados.
 */
import type { BrowserWindowConstructorOptions, WebContents, WebPreferences } from 'electron';

export const REQUIRED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
  devTools: false,
} as const satisfies WebPreferences;

export function buildMainWindowOptions(
  preloadPath: string,
  opts: { devTools: boolean },
): BrowserWindowConstructorOptions {
  return {
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'Katalyst · Asistente de grabación',
    backgroundColor: '#f6f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      ...REQUIRED_WEB_PREFERENCES,
      devTools: opts.devTools,
      preload: preloadPath,
    },
  };
}

/** Verifica que unas webPreferences cumplan el mínimo exigido (se usa en pruebas y como aserción en runtime). */
export function assertSecureWebPreferences(prefs: WebPreferences | undefined): void {
  if (!prefs) throw new Error('webPreferences ausentes');
  for (const [k, v] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
    if (k === 'devTools') continue;
    if ((prefs as Record<string, unknown>)[k] !== v) throw new Error(`webPreferences.${k} debe ser ${String(v)}`);
  }
  if (prefs.preload && !/\.cjs$/.test(prefs.preload))
    throw new Error('El preload con sandbox debe ser CommonJS (.cjs)');
}

/**
 * ¿La URL pertenece a la app? En producción, el `index.html` empaquetado (file://); en desarrollo explícito,
 * el origen loopback del servidor Vite.
 */
export function isAppUrl(candidate: string, app: { indexFileUrl: string; devServerOrigin: string | null }): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol === 'file:') {
    const expected = new URL(app.indexFileUrl);
    return url.pathname === expected.pathname;
  }
  if (app.devServerOrigin) {
    return url.origin === app.devServerOrigin && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  }
  return false;
}

type HardenableContents = Pick<WebContents, 'setWindowOpenHandler' | 'on'>;

/** Endurece un WebContents: deniega ventanas nuevas, bloquea navegación/redirecciones y `<webview>`. */
export function hardenWebContents(contents: HardenableContents, isAllowed: (url: string) => boolean): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: { preventDefault: () => void }, url: string) => {
    if (!isAllowed(url)) event.preventDefault();
  };
  contents.on('will-navigate', block as never);
  contents.on('will-redirect', block as never);
  contents.on(
    'will-frame-navigate' as never,
    ((event: { preventDefault: () => void; url: string; isMainFrame?: boolean }) => {
      if (!isAllowed(event.url)) event.preventDefault();
    }) as never,
  );
  contents.on('will-attach-webview', ((event: { preventDefault: () => void }) => event.preventDefault()) as never);
}

/** Encabezados para respuestas servidas a la ventana (dev server). La CSP de build va en el `<meta>` del HTML. */
export function securityHeaders(csp: string): Record<string, string[]> {
  return {
    'Content-Security-Policy': [csp],
    'X-Content-Type-Options': ['nosniff'],
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Cross-Origin-Resource-Policy': ['same-origin'],
  };
}
