/**
 * Datos que la API no expone directamente y el panel deriva de endpoints existentes (sin inventar contratos).
 * Cada derivación indica su pendiente en docs/pendientes-integracion.md ([WEB→API-*]) cuando convendría que el
 * servidor la entregue ya calculada.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { catalogApi } from '@/lib/api/endpoints';
import type { AutomatedTest, CaseRow, FlakyInfo, Section } from '@/lib/api/types';
import type { Classification } from '@katalyst/shared/enums';
import { qk } from '@/lib/query/keys';

/** Etiquetas iniciales mientras carga el listado de tests. */
export const DEFAULT_TAGS = ['@humo', '@oc', '@agendamiento', '@arranque', '@rendimiento'];

export interface CaseAutomation {
  tags: string[];
  classification: Classification | null;
  flaky: FlakyInfo | null;
}

/** Combina los tests aprobados de un caso: etiquetas (unión), clasificación más restrictiva y peor flaky. */
export function automationOf(tests: readonly AutomatedTest[]): CaseAutomation {
  const live = tests.filter((t) => t.status !== 'retirado');
  const tags = [...new Set(live.flatMap((t) => t.tags))].sort();
  const classification: Classification | null = live.length === 0
    ? null
    : live.some((t) => t.classification === 'escritura')
      ? 'escritura'
      : live.some((t) => t.classification === 'sin_clasificar')
        ? 'sin_clasificar'
        : 'lectura';
  const flaky = live.map((t) => t.flaky).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0] ?? null;
  return { tags, classification, flaky };
}

/**
 * Etiquetas, clasificación e inestabilidad por caso: `GET /tests?caseId=` por cada caso automatizado de la página
 * (≤ límite de página). PENDIENTE [WEB→API-A]: incluir `tags`/`flaky` en `TestRailCaseSummary` evitaría N consultas.
 */
export function useCaseAutomation(rows: readonly { id: string; automatedTestCount: number }[] | undefined) {
  const targets = (rows ?? []).filter((r) => r.automatedTestCount > 0);
  const results = useQueries({
    queries: targets.map((r) => ({
      queryKey: qk.catalog.tests({ caseId: r.id, limit: 20 }),
      queryFn: ({ signal }: { signal: AbortSignal }) => catalogApi.tests({ caseId: r.id, limit: 20 }, signal),
      staleTime: 60_000,
    })),
  });
  const map = new Map<string, CaseAutomation>();
  targets.forEach((r, i) => {
    const d = results[i]?.data;
    if (d) map.set(r.id, automationOf(d.items));
  });
  return map;
}

/** Etiquetas conocidas: unión de las de los tests vigentes (primera página, orden por título) y las iniciales. */
export function useKnownTags(): string[] {
  const q = useQuery({
    queryKey: qk.catalog.tags(),
    queryFn: ({ signal }) => catalogApi.tests({ status: 'aprobado', limit: 100 }, signal),
    staleTime: 5 * 60_000,
  });
  const fromTests = q.data?.items.flatMap((t) => t.tags) ?? [];
  return [...new Set([...DEFAULT_TAGS, ...fromTests])].sort();
}

/** Nombre de sección por ID (las secciones llegan en `GET /testrail/sections`). */
export function sectionNameMap(sections: readonly Section[] | undefined): Map<string, string> {
  return new Map((sections ?? []).map((s) => [s.id, s.name]));
}

/**
 * Casos por ID para selecciones traídas del catálogo (`GET /testrail/cases/:id` por ID, máximo `max`).
 * PENDIENTE [WEB→API-A]: un filtro `ids` en `GET /testrail/cases` resolvería la selección en una sola consulta.
 */
export function useCasesByIds(ids: readonly string[], max = 100) {
  const wanted = ids.slice(0, max);
  const results = useQueries({
    queries: wanted.map((id) => ({
      queryKey: qk.catalog.case(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => catalogApi.case(id, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const map = new Map<string, CaseRow>();
  wanted.forEach((id, i) => {
    const d = results[i]?.data;
    if (d) map.set(id, d);
  });
  return map;
}
