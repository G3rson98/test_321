/**
 * Editor de programación (RF-PRG-02, ESP §13.5): la expresión cron y las ocurrencias vienen de la API
 * (`POST /schedules/preview`, aquí el handler MSW que usa @katalyst/shared/schedule). L–V 08:00–18:00 cada 30 min
 * ⇒ `0,30 8-17 * * 1-5` + `0 18 * * 1-5` = 21 ocurrencias por día (incluye 18:00, excluye 18:30).
 */
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CronEditor, CronPreview, DEFAULT_CRON, validateCron, type CronValue } from '@/features/schedules/cron-editor';
import { installFetch, loginAs, server } from './app-harness';

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  installFetch();
  await loginAs('qa');
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function Harness({ initial }: { initial: CronValue }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <CronEditor value={value} onChange={setValue} />
      <CronPreview value={value} />
    </>
  );
}
function renderEditor(initial: CronValue) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
}

const RANGE: CronValue = { ...DEFAULT_CRON, mode: 'intervalo', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', everyMinutes: 30 };

describe('editor de programación', () => {
  it('L–V 08:00–18:00 cada 30 min: dos expresiones y 21 ocurrencias por día desde la API', async () => {
    renderEditor(RANGE);
    const exprs = await screen.findByTestId('cron-expressions', {}, { timeout: 3000 });
    const lines = within(exprs).getAllByText(/\* \*/).map((n) => n.textContent);
    expect(lines).toEqual(['0,30 8-17 * * 1-5', '0 18 * * 1-5']);
    expect(lines).not.toContain('*/30 8-18 * * 1-5');
    expect(await screen.findByTestId('per-day')).toHaveTextContent('21 ejecuciones por día programado');
    expect(within(screen.getByTestId('next-runs')).getAllByRole('listitem')).toHaveLength(5);
  });

  it('al cambiar el fin a 17:30 la API recalcula (20 por día) sin calcular en el panel', async () => {
    const user = userEvent.setup();
    renderEditor(RANGE);
    expect(await screen.findByTestId('per-day', {}, { timeout: 3000 })).toHaveTextContent('21');
    const hasta = screen.getByLabelText('Hasta');
    await user.clear(hasta);
    await user.type(hasta, '17:30');
    await waitFor(() => expect(screen.getByTestId('per-day')).toHaveTextContent('20 ejecuciones'), { timeout: 3000 });
    const exprs = screen.getByTestId('cron-expressions');
    expect(exprs).toHaveTextContent('0,30 8-17 * * 1-5');
    expect(exprs).not.toHaveTextContent('0 18 * * 1-5');
  });

  it('hora fija con dos horas: una expresión por día con ambas horas', async () => {
    renderEditor({ ...DEFAULT_CRON, times: ['08:00', '14:30'] });
    const exprs = await screen.findByTestId('cron-expressions', {}, { timeout: 3000 });
    expect(exprs.textContent).toMatch(/1-5/);
    expect(await screen.findByTestId('per-day')).toHaveTextContent('2 ejecuciones');
  });

  it('valida en el cliente antes de pedir la vista previa (sin días, hora inválida)', async () => {
    expect(validateCron({ ...RANGE, days: [] }).days).toBeTruthy();
    expect(validateCron({ ...RANGE, start: '25:00' }).start).toBeTruthy();
    expect(Object.keys(validateCron(RANGE))).toHaveLength(0);
    renderEditor({ ...RANGE, days: [] });
    expect(await screen.findByText('Completa el horario para ver la expresión.')).toBeInTheDocument();
    expect(screen.queryByTestId('cron-expressions')).not.toBeInTheDocument();
  });
});
