/**
 * KPIs de inicio. El éxito de 7 días, las corridas de hoy, las activas y las próximas programaciones llegan
 * calculados por el servidor (`GET /runs/summary`, D-054), sin la cota de página de `GET /runs`. La cobertura sigue
 * derivándose de `GET /testrail/sections` (conteos por sección).
 */
import { useQuery } from '@tanstack/react-query';
import { catalogApi, runsApi } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { startOfLocalDay } from '@/lib/format';

const MAX = 100;

/** Resumen del inicio; «hoy» usa el inicio del día local del navegador. */
export function useHomeSummary(poll: number | false) {
  const q = { todayFrom: startOfLocalDay().toISOString() };
  const query = useQuery({
    queryKey: qk.home.summary(q),
    queryFn: ({ signal }) => runsApi.summary(q, signal),
    refetchInterval: poll,
  });
  const d = query.data;
  return {
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    current: d?.successRate.current ?? null,
    previous: d?.successRate.previous ?? null,
    today: d?.runsToday ?? null,
    running: d?.running ?? null,
    upcoming: d?.upcoming ?? [],
  };
}

/** Cobertura: suma de `caseCount`/`automatedCount` por sección (casos no archivados). */
export function useCoverage() {
  return useQuery({
    queryKey: qk.home.coverage(),
    queryFn: async ({ signal }) => {
      const p = await catalogApi.sections({ limit: MAX }, signal);
      const total = p.items.reduce((a, s) => a + (s.caseCount ?? 0), 0);
      const automated = p.items.reduce((a, s) => a + (s.automatedCount ?? 0), 0);
      return { total, automated, more: p.hasNext };
    },
  });
}
