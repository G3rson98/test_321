import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import './styles/globals.css';

async function enableMocks(): Promise<void> {
  // MSW solo con VITE_USE_MOCKS=true; en build de producción esta rama se elimina (dead code).
  if (import.meta.env.VITE_USE_MOCKS === 'true') {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker();
  }
}

void enableMocks().then(() => {
  const el = document.getElementById('root');
  if (!el) throw new Error('No se encontró #root');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
