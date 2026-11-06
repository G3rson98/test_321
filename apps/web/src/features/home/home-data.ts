/**
 * KPIs de inicio derivados de endpoints existentes (la API no tiene `/dashboard`): `GET /runs` (filtros de fecha y
 * estado), `GET /testrail/sections` (conteos por sección), `GET /schedules` (`nextOccurrence`) y `GET /environments`.
 * Los listados usan una página de 100: si hay más, el valor se muestra como mínimo ("100+").
 * PENDIENTE [WEB→API-B]: un resumen de inicio calculado en servidor evitaría la cota de 100.
 */
import { useQuery } from '@tanstack/react-query';
import { ACTIVE_RUN_STATUSES } from '@katalyst/shared/enums';
import { catalogApi, envApi, runsApi, schedulesApi } from '@/lib/api/endpoints';
import type { Page, RunSummary } from '@/lib/api/types';
import { qk } from '@/lib/query/keys';
import { startOfLocalDay } from '@/lib/format';

const DAY = 86_400_000;
const MAX = 100;

export interface CountValue {
  n: number;
  /** `true` si hay más de una página (valor mínimo). */
  more: boolean;
}
const countOf = (p: Page<unknown>): CountValue => ({ n: p.items.length, more: p.hasNext });
export const formatCount = (c: CountValue) => (c.more ? `${c.n}+` : String(c.n));

/** Proporción de corridas terminadas con resultado pasado o inestable. */
export function successRate(runs: readonly RunSummary[]): number | null {
  const done = runs.filter((r) => r.outcome !== null);
  if (done.length === 0) return null;
  return done.filter((r) => r.outcome === 'pasado' || r.outcome === 'inestable').length / done.length;
}

export function useSuccessRates(poll: number | false) {
  // Rango fijado al minuto para que la clave de caché sea estable.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const cur = { status: 'terminada', from: new Date(now - 7 * DAY).toISOString(), limit: MAX };
  const prev = { status: 'terminada', from: new Date(now - 14 * DAY).toISOString(), to: cur.from, limit: MAX };
  const a = useQuery({ queryKey: qk.home.successRate(cur), queryFn: ({ signal }) => runsApi.list(cur, signal), refetchInterval: poll });
  const b = useQuery({ queryKey: qk.home.successRate(prev), queryFn: ({ signal }) => runsApi.list(prev, signal) });
  return {
    isLoading: a.isLoading,
    isError: a.isError,
    current: a.data ? successRate(a.data.items) : null,
    previous: b.data ? successRate(b.data.items) : null,
  };
}

export function useRunCounts(poll: number | false) {
  const today = { from: startOfLocalDay().toISOString(), limit: MAX };
  const active = { status: [...ACTIVE_RUN_STATUSES], limit: MAX };
  const a = useQuery({ queryKey: qk.home.counts(today), queryFn: ({ signal }) => runsApi.list(today, signal), refetchInterval: poll });
  const b = useQuery({ queryKey: qk.home.counts({ active: true }), queryFn: ({ signal }) => runsApi.list(active, signal), refetchInterval: poll });
  return {
    isLoading: a.isLoading || b.isLoading,
    isError: a.isError || b.isError,
    today: a.data ? countOf(a.data) : null,
    running: b.data ? countOf(b.data) : null,
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

export interface Upcoming {
  scheduleId: string;
  name: string;
  environmentName: string;
  at: string;
}

/** Próximas 3 ocurrencias de programaciones activas (`nextOccurrence` lo calcula la API). */
export function useUpcoming() {
  const envs = useQuery({ queryKey: qk.environments.list(), queryFn: ({ signal }) => envApi.list(signal) });
  const q = useQuery({
    queryKey: qk.home.upcoming(),
    queryFn: ({ signal }) => schedulesApi.list({ enabled: 'true', limit: MAX }, signal),
  });
  const names = new Map((envs.data?.items ?? []).map((e) => [e.id, e.name]));
  const items: Upcoming[] = (q.data?.items ?? [])
    .filter((s) => s.nextOccurrence)
    .sort((a, b) => a.nextOccurrence!.localeCompare(b.nextOccurrence!))
    .slice(0, 3)
    .map((s) => ({ scheduleId: s.id, name: s.name, environmentName: names.get(s.environmentId) ?? '', at: s.nextOccurrence! }));
  return { ...q, items };
}
