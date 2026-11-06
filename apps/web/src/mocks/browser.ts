/**
 * MSW en el navegador (solo VITE_USE_MOCKS=true). Usa Service Worker; si el entorno no permite registrarlo
 * (p. ej. vistas embebidas), cae a la intercepción de fetch en la página (`msw/native`, sin Service Worker).
 */
import { handlers } from './handlers';
import { startSimulation } from './sim';

async function tryServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    // Sondeo previo: algunas vistas embebidas rechazan el registro; no instanciar setupWorker en ese caso.
    await navigator.serviceWorker.register('/mockServiceWorker.js');
  } catch {
    return false;
  }
  try {
    const { setupWorker } = await import('msw/browser');
    const worker = setupWorker(...handlers);
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
    if (navigator.serviceWorker.controller) return true;
    worker.stop();
    return false;
  } catch {
    return false;
  }
}

export async function startMockWorker(): Promise<void> {
  let mode = 'service-worker';
  if (!(await tryServiceWorker())) {
    const { setupServer } = await import('msw/native');
    const server = setupServer(...handlers);
    server.listen({ onUnhandledRequest: 'bypass' });
    mode = 'fetch-interceptor';
  }
  (globalThis as { __katalystMocks?: string }).__katalystMocks = mode;
  startSimulation();
  console.warn('[katalyst] Modo mock activo (MSW). Usuarios de prueba en src/mocks/fixtures.ts.');
}
